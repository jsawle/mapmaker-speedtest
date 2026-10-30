// Runs the classroom simulation over every recorded map and writes results/results.json, results/results.csv
// and docs/results.json (for the results page).
// Usage: node src/run-sim.mjs [--traces results/traces]

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { simulateClass, phasesFromTrace, summarise, SIMULATOR_VERSION } from "./simulate.mjs";

export const APP_VERSION = "0.1.0";
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => {
  if (x.startsWith("--")) a.push([x.slice(2), all[i + 1]]);
  return a;
}, []));
const TRACES = args.traces || "results/traces";
const cfg = JSON.parse(fs.readFileSync("config/profiles.json", "utf8"));

const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const round = (x) => (x == null ? null : x === Infinity ? null : Math.round(x * 10) / 10);

export function rating(p90) {
  if (p90 == null || p90 === Infinity) return "Did not finish";
  if (p90 <= cfg.threshold_s) return "OK";
  if (p90 <= cfg.threshold_s * 3) return "Slow";
  return "Very slow";
}

function simulateTrace(trace) {
  const phases = phasesFromTrace(trace);
  const reqs = trace.requests;
  const out = {
    id: trace.id, title: trace.title, numViews: trace.numViews ?? null, stage1Score: trace.stage1Score ?? null,
    recordedAt: trace.recordedAt, recorderVersion: trace.recorderVersion,
    error: trace.error, openTimedOut: trace.openTimedOut, zoomOk: !!trace.phases.zoom?.ok, canvas: trace.canvas,
    requests: reqs.filter((r) => r.phase === "open").length,
    mbCold: round(reqs.filter((r) => r.phase === "open").reduce((a, r) => a + r.bytes, 0) / 1e6),
    mbWarm: round(reqs.filter((r) => r.phase === "open" && !r.appShell).reduce((a, r) => a + r.bytes, 0) / 1e6),
    mbZoom: round(reqs.filter((r) => r.phase === "zoom").reduce((a, r) => a + r.bytes, 0) / 1e6),
    heapMB: trace.heapMB, hosts: [...new Set(reqs.map((r) => r.host))].length,
    failedRequests: reqs.filter((r) => r.failed || r.status >= 400).length,
    profiles: {},
  };
  for (const prof of cfg.profiles) {
    const base = { phases, profile: prof, students: cfg.students, staggerS: cfg.start_stagger_s,
                   thinkBeforeZoomS: cfg.think_before_zoom_s, seed: hash(trace.id + prof.id) };
    const warm = simulateClass({ ...base, warm: true });
    const cold = simulateClass({ ...base, warm: false });
    const alone = simulateClass({ ...base, warm: true, students: 1, staggerS: 0 })[0];
    const w = summarise(warm, "readyS"), c = summarise(cold, "readyS"), z = summarise(warm, "zoomS");
    const pick = (s) => s && { median: round(s.median), p90: round(s.p90), slowest: round(s.slowest) };
    out.profiles[prof.id] = {
      warm: pick(w), cold: pick(c), zoom: pick(z), aloneS: round(alone.readyS),
      rating: rating(w?.p90), ratingFirstLesson: rating(c?.p90),
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
    || (b.profiles.poor?.warm?.p90 ?? 0) - (a.profiles.poor?.warm?.p90 ?? 0));

  let baseline = null;
  const bf = path.join(TRACES, "_baseline.json.gz");
  if (fs.existsSync(bf)) {
    const b = JSON.parse(zlib.gunzipSync(fs.readFileSync(bf)));
    baseline = { requests: b.requests.length, mb: round(b.requests.reduce((a, r) => a + r.bytes, 0) / 1e6), recordedAt: b.recordedAt };
  }
  const result = {
    generatedAt: new Date().toISOString(),
    versions: { app: APP_VERSION, recorder: rows[0]?.recorderVersion ?? null, simulator: SIMULATOR_VERSION, profiles: cfg.profiles_version },
    settings: { students: cfg.students, start_stagger_s: cfg.start_stagger_s, threshold_s: cfg.threshold_s,
                threshold_percentile: cfg.threshold_percentile, profiles: cfg.profiles },
    baseline, maps: rows,
  };
  fs.mkdirSync("results", { recursive: true });
  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync("results/results.json", JSON.stringify(result, null, 1));
  fs.writeFileSync("docs/results.json", JSON.stringify(result));

  const cols = ["id", "title", "numViews", "stage1Score", "requests", "mbCold", "mbWarm", "mbZoom", "heapMB", "failedRequests", "openTimedOut", "zoomOk", "error"];
  const pcols = [];
  for (const p of cfg.profiles) pcols.push(
    [`${p.id}_rating`, (r) => r.profiles[p.id]?.rating], [`${p.id}_warm_median_s`, (r) => r.profiles[p.id]?.warm?.median],
    [`${p.id}_warm_p90_s`, (r) => r.profiles[p.id]?.warm?.p90], [`${p.id}_warm_slowest_s`, (r) => r.profiles[p.id]?.warm?.slowest],
    [`${p.id}_first_lesson_p90_s`, (r) => r.profiles[p.id]?.cold?.p90], [`${p.id}_zoom_p90_s`, (r) => r.profiles[p.id]?.zoom?.p90],
    [`${p.id}_one_student_s`, (r) => r.profiles[p.id]?.aloneS]);
  const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.concat(pcols.map((c) => c[0])).join(",")]
    .concat(rows.map((r) => cols.map((c) => esc(r[c])).concat(pcols.map(([, f]) => esc(f(r)))).join(",")));
  fs.writeFileSync("results/results.csv", csv.join("\n") + "\n");
  const counts = rows.reduce((a, r) => ((a[r.profiles.poor?.rating ?? "n/a"] = (a[r.profiles.poor?.rating ?? "n/a"] || 0) + 1), a), {});
  console.log(`${rows.length} maps simulated. Poor wifi:`, counts);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
