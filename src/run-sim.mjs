// Runs the classroom simulation over every recorded map and writes results/results.json, results/results.csv
// and docs/results.json (for the results page).
// Usage: node src/run-sim.mjs [--traces results/traces]

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { simulateClass, phasesFromTrace, summarise, cacheRule, SIMULATOR_VERSION } from "./simulate.mjs";
import { categorise, CATEGORY_LABELS, CATEGORIES_VERSION } from "./categories.mjs";
const APP_ID = "0cd1cdee853c413a84bfe4b9a6931f0d";
const SOURCES = Object.keys(CATEGORY_LABELS);

export const APP_VERSION = "0.3.0";
const CACHEABLE = new Set(["script", "stylesheet", "font", "image", "manifest"]);
// a request the map itself cancelled (e.g. tiles no longer needed after a zoom) is normal, not a broken layer
const isCancelled = (r) => r.failed && (!r.failure || /ABORTED|cancel/i.test(r.failure)) && !(r.status >= 400);
const isError = (r) => !isCancelled(r) && (r.failed || r.status >= 400);
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => {
  if (x.startsWith("--")) a.push([x.slice(2), all[i + 1]]);
  return a;
}, []));
const TRACES = args.traces || "results/traces";
const cfg = JSON.parse(fs.readFileSync("config/profiles.json", "utf8"));
const usualRule = cacheRule((cfg.usual_lesson_days_since_last_use ?? 7) * 86400);
const sameLessonRule = cacheRule((cfg.same_lesson_minutes_since_last_use ?? 10) * 60);

const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const round = (x) => (x == null ? null : x === Infinity ? null : Math.round(x * 10) / 10);

export function rating(p90) {
  if (p90 == null || p90 === Infinity) return "Did not finish";
  if (p90 <= cfg.threshold_s) return "OK";
  if (p90 <= cfg.threshold_s * 3) return "Slow";
  return "Very slow";
}

function simulateTrace(trace) {
  const reqs = trace.requests;
  reqs.forEach((r) => { r.cat = categorise(r, { appId: APP_ID, mapId: trace.id }); });
  const phases = phasesFromTrace(trace);
  const openReqs = reqs.filter((r) => r.phase === "open");
  const out = {
    id: trace.id, title: trace.title, numViews: trace.numViews ?? null, stage1Score: trace.stage1Score ?? null,
    recordedAt: trace.recordedAt, recorderVersion: trace.recorderVersion,
    error: trace.error, openTimedOut: trace.openTimedOut, zoomOk: !!trace.phases.zoom?.ok, canvas: trace.canvas,
    requests: reqs.filter((r) => r.phase === "open").length,
    mbCold: round(reqs.filter((r) => r.phase === "open").reduce((a, r) => a + r.bytes, 0) / 1e6),
    mbWarm: round(reqs.filter((r) => r.phase === "open" && !r.appShell).reduce((a, r) => a + r.bytes, 0) / 1e6),
    mbZoom: round(reqs.filter((r) => r.phase === "zoom").reduce((a, r) => a + r.bytes, 0) / 1e6),
    heapMB: trace.heapMB, hosts: [...new Set(reqs.map((r) => r.host))].length,
    mbBySource: Object.fromEntries(SOURCES.map((c) => [c, round(openReqs.filter((r) => r.cat === c).reduce((a, r) => a + r.bytes, 0) / 1e6)])),
    requestsBySource: Object.fromEntries(SOURCES.map((c) => [c, openReqs.filter((r) => r.cat === c).length])),
    bigFiles: openReqs.filter((r) => r.cat === "data" && r.bytes > 1e6).sort((a, b) => b.bytes - a.bytes).slice(0, 3)
      .map((r) => ({ host: r.host, path: r.path, mb: round(r.bytes / 1e6) })),
    failedRequests: reqs.filter(isError).length,
    cancelledRequests: reqs.filter(isCancelled).length,
    errorHosts: [...new Set(reqs.filter(isError).map((r) => r.host))],
    profiles: {},
  };
  for (const prof of cfg.profiles) {
    const base = { phases, profile: prof, students: cfg.students, staggerS: cfg.start_stagger_s,
                   thinkBeforeZoomS: cfg.think_before_zoom_s, seed: hash(trace.id + prof.id) };
    const usual = simulateClass({ ...base, cacheOf: usualRule });
    const first = simulateClass({ ...base, cache: "cold" });
    const fresh = simulateClass({ ...base, cacheOf: sameLessonRule });
    const alone = simulateClass({ ...base, cacheOf: usualRule, students: 1, staggerS: 0 })[0];
    const pick = (s) => s && { median: round(s.median), p90: round(s.p90), slowest: round(s.slowest) };
    const u = summarise(usual, "readyS"), c = summarise(first, "readyS"), f = summarise(fresh, "readyS");
    // How much sooner 9 in 10 students would be ready if one source cost nothing (usual lesson).
    // Sources overlap in time, so these don't add up to the total.
    const bySource = {};
    for (const src of SOURCES) {
      const without = summarise(simulateClass({ ...base, cacheOf: (r) => (r.cat === src ? "free" : usualRule(r)) }), "readyS");
      bySource[src] = u && without ? round(Math.max(0, u.p90 - without.p90)) : null;
    }
    const mainCause = Object.entries(bySource).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]?.[0] ?? null;
    out.profiles[prof.id] = {
      usual: pick(u), first: pick(c), fresh: pick(f), zoom: pick(summarise(usual, "zoomS")), aloneS: round(alone.readyS),
      rating: rating(u?.p90), ratingFirst: rating(c?.p90), ratingFresh: rating(f?.p90),
      bySource, mainCause,
    };
  }
  return out;
}

function main() {
  const files = fs.readdirSync(TRACES).filter((f) => f.endsWith(".json.gz") && !f.startsWith("_"));
  const rows = [];
  for (const f of files) {
    const trace = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(TRACES, f))));
    try { rows.push(simulateTrace(trace)); }
    catch (e) { rows.push({ id: trace.id, title: trace.title, error: "simulation failed: " + e.message, profiles: {} }); }
  }
  const order = { "Did not finish": 0, "Very slow": 1, Slow: 2, OK: 3 };
  rows.sort((a, b) => (order[a.profiles.poor?.rating] ?? 9) - (order[b.profiles.poor?.rating] ?? 9)
    || (b.profiles.poor?.usual?.p90 ?? 0) - (a.profiles.poor?.usual?.p90 ?? 0));

  // MapMaker's own default map, as a reference point: no map can be faster than the app itself
  let baseline = null;
  const bf = path.join(TRACES, "_baseline.json.gz");
  if (fs.existsSync(bf)) {
    const b = JSON.parse(zlib.gunzipSync(fs.readFileSync(bf)));
    b.requests.forEach((r) => { r.appShell = CACHEABLE.has(r.type); r.inBaseline = true; });
    b.phases.zoom = { ok: false };
    baseline = simulateTrace(b);
    baseline.title = "MapMaker on its own (default map)";
    baseline.appFiles = b.requests.filter((r) => r.appShell).length;
    baseline.appFilesMB = round(b.requests.filter((r) => r.appShell).reduce((a, r) => a + r.bytes, 0) / 1e6);
    const cc = [...new Set(b.requests.filter((r) => r.appShell && r.cacheControl).map((r) => r.cacheControl))];
    if (cc.length) baseline.appCacheControl = cc.slice(0, 5);
  }
  if (baseline) for (const r of rows) for (const [pid, v] of Object.entries(r.profiles || {})) {
    const b = baseline.profiles[pid];
    if (b && v.usual && b.usual) v.extraS = round(v.usual.p90 - b.usual.p90);
    if (b && v.first && b.first) v.extraFirstS = round(v.first.p90 - b.first.p90);
    if (b && v.fresh && b.fresh) v.extraFreshS = round(v.fresh.p90 - b.fresh.p90);
  }
  const result = {
    generatedAt: new Date().toISOString(),
    versions: { app: APP_VERSION, recorder: rows[0]?.recorderVersion ?? null, simulator: SIMULATOR_VERSION, profiles: cfg.profiles_version, sources: CATEGORIES_VERSION },
    sourceLabels: CATEGORY_LABELS,
    settings: { students: cfg.students, start_stagger_s: cfg.start_stagger_s, threshold_s: cfg.threshold_s,
                usual_lesson_days_since_last_use: cfg.usual_lesson_days_since_last_use,
                same_lesson_minutes_since_last_use: cfg.same_lesson_minutes_since_last_use,
                threshold_percentile: cfg.threshold_percentile, profiles: cfg.profiles },
    baseline, maps: rows,
  };
  fs.mkdirSync("results", { recursive: true });
  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync("results/results.json", JSON.stringify(result, null, 1));
  fs.writeFileSync("docs/results.json", JSON.stringify(result));

  const cols = ["id", "title", "numViews", "stage1Score", "requests", "mbCold", "mbWarm", "mbZoom", "heapMB", "failedRequests", "cancelledRequests", "openTimedOut", "zoomOk", "error"];
  const srcCols = SOURCES.map((src) => [`mb_${src}`, (r) => r.mbBySource?.[src]]);
  const pcols = [];
  for (const p of cfg.profiles) pcols.push(
    [`${p.id}_rating`, (r) => r.profiles[p.id]?.rating],
    [`${p.id}_usual_median_s`, (r) => r.profiles[p.id]?.usual?.median], [`${p.id}_usual_p90_s`, (r) => r.profiles[p.id]?.usual?.p90],
    [`${p.id}_usual_slowest_s`, (r) => r.profiles[p.id]?.usual?.slowest],
    [`${p.id}_first_time_p90_s`, (r) => r.profiles[p.id]?.first?.p90], [`${p.id}_same_lesson_p90_s`, (r) => r.profiles[p.id]?.fresh?.p90],
    [`${p.id}_extra_over_mapmaker_s`, (r) => r.profiles[p.id]?.extraS],
    [`${p.id}_main_cause`, (r) => CATEGORY_LABELS[r.profiles[p.id]?.mainCause] ?? ""],
    ...SOURCES.map((src) => [`${p.id}_saving_if_no_${src}_s`, (r) => r.profiles[p.id]?.bySource?.[src]]),
    [`${p.id}_zoom_p90_s`, (r) => r.profiles[p.id]?.zoom?.p90], [`${p.id}_one_student_s`, (r) => r.profiles[p.id]?.aloneS]);
  const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  pcols.unshift(...srcCols);
  const csv = [cols.concat(pcols.map((c) => c[0])).join(",")]
    .concat((baseline ? [{ ...baseline, id: "_baseline" }, ...rows] : rows).map((r) => cols.map((c) => esc(r[c])).concat(pcols.map(([, f]) => esc(f(r)))).join(",")));
  fs.writeFileSync("results/results.csv", csv.join("\n") + "\n");
  const counts = rows.reduce((a, r) => ((a[r.profiles.poor?.rating ?? "n/a"] = (a[r.profiles.poor?.rating ?? "n/a"] || 0) + 1), a), {});
  console.log(`${rows.length} maps simulated. Poor wifi:`, counts);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
