// Recorder: opens each map in the real MapMaker app, once, in a fresh browser (nothing cached),
// and writes down every request: when it started, when the first byte arrived, when it finished, and its size.
// It then clicks "Zoom in" twice and records what that costs too.
//
// Usage: node src/record.mjs [--shard 1/4] [--limit N] [--ids id1,id2]
// Output: results/traces/<id>.json.gz (one per map) and results/traces/_baseline.json.gz

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import zlib from "zlib";

const require = createRequire(import.meta.url);
export const { chromium } = require("playwright");

export { CACHEABLE_TYPES };
export const RECORDER_VERSION = "0.1.0";
const APP_URL = process.env.APP_URL || "https://www.arcgis.com/apps/instant/atlas/index.html?appid=0cd1cdee853c413a84bfe4b9a6931f0d";
const VIEWPORT = { width: 1366, height: 768 };        // common school Chromebook screen
const CROS_UA = "Mozilla/5.0 (X11; CrOS x86_64 15917.71.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IDLE_MS = 3000;          // map counts as loaded after 3 s with no network activity
const OPEN_CAP_MS = 120_000;   // give up waiting after 2 minutes
const ZOOM_CAP_MS = 60_000;
const HUNG_MS = 20_000;        // requests open longer than this (streams, polling) don't block "idle"
const CACHEABLE_TYPES = new Set(["script", "stylesheet", "font", "image", "manifest"]);
const OUT = process.env.TRACE_DIR || "results/traces";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => {
  if (x.startsWith("--")) a.push([x.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
  return a;
}, []));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => Math.round(x * 10) / 10;

function stripUrl(u) {
  try { const x = new URL(u); return { host: x.host, path: (x.pathname || "/").slice(0, 160) }; }
  catch { return { host: "", path: String(u).slice(0, 160) }; }
}

export async function recordOne(browser, target, appShellUrls, opts = {}) {
  const isBaseline = !target.id;
  const url = isBaseline ? APP_URL : `${APP_URL}&webmap=${target.id}`;
  const context = await browser.newContext({ viewport: VIEWPORT, userAgent: CROS_UA, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  if (opts.throttle) {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: opts.throttle.rtt_ms,
      downloadThroughput: (opts.throttle.mbps * 1e6) / 8, uploadThroughput: (opts.throttle.mbps * 1e6) / 8 });
  }
  const protoByHost = {};
  cdp.on("Network.responseReceived", (e) => {
    try { protoByHost[new URL(e.response.url).host] = e.response.protocol; } catch {}
  });

  let phase = "open";
  let lastActivity = Date.now();
  const inflight = new Map();   // request -> wall-clock start
  const done = [];
  const fullUrls = [];
  let sawMapData = isBaseline;

  context.on("request", (req) => {
    if (req.url().startsWith("data:") || req.url().startsWith("blob:")) return;
    inflight.set(req, { wall: Date.now(), phase });
    lastActivity = Date.now();
  });
  const settle = async (req, failed) => {
    const info = inflight.get(req); if (!info) return;
    inflight.delete(req); lastActivity = Date.now();
    const t = req.timing();
    let sizes = { responseBodySize: 0, responseHeadersSize: 0 };
    if (!failed) { try { sizes = await req.sizes(); } catch {} }
    let status = 0; try { status = (await req.response())?.status() ?? 0; } catch {}
    if (!isBaseline && /\/content\/items\/[0-9a-f]{32}\/data/.test(req.url()) && req.url().includes(target.id)) sawMapData = true;
    const start = t.startTime > 0 ? t.startTime : info.wall;
    const ttfb = t.responseStart >= 0 ? start + t.responseStart : start;
    const end = t.responseEnd >= 0 ? start + t.responseEnd : Date.now();
    const bytes = Math.max(0, sizes.responseBodySize) + Math.max(0, sizes.responseHeadersSize);
    const { host, path: p } = stripUrl(req.url());
    done.push({
      phase: info.phase, host, path: p, type: req.resourceType(), method: req.method(), status,
      startWall: start, ttfbWall: ttfb, endWall: end, bytes, failed: !!failed,
      fromCache: !failed && bytes === 0 && end - start < 2,
      appShell: !isBaseline && appShellUrls.has(req.url()) && CACHEABLE_TYPES.has(req.resourceType()),
    });
    fullUrls.push({ url: req.url(), type: req.resourceType() });
  };
  context.on("requestfinished", (req) => settle(req, false));
  context.on("requestfailed", (req) => settle(req, true));

  const waitIdle = async (t0, cap) => {
    for (;;) {
      await sleep(250);
      const now = Date.now();
      const blocking = [...inflight.values()].filter((v) => now - v.wall < HUNG_MS).length;
      if (blocking === 0 && sawMapData && now - lastActivity >= IDLE_MS) return false;
      if (now - t0 > cap) return true;
    }
  };

  const navStart = Date.now();
  let error = null, openTimedOut = false, zoom = { ok: false };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    openTimedOut = await waitIdle(navStart, opts.openCapMs || OPEN_CAP_MS);
  } catch (e) { error = String(e.message || e).slice(0, 300); }

  const canvas = await page.locator(".esri-view-surface canvas").count().catch(() => 0);
  let heapMB = null;
  try {
    const m = await cdp.send("Performance.getMetrics");
    const h = m.metrics.find((x) => x.name === "JSHeapUsedSize");
    heapMB = h ? r1(h.value / 1048576) : null;
  } catch {}

  if (!error && !isBaseline && !opts.skipZoom) {
    try {
      phase = "zoom";
      const zt0 = Date.now();
      const btn = page.locator("calcite-button.zoom-in").first();
      await btn.click({ timeout: 10_000 });
      await sleep(700);
      await btn.click({ timeout: 10_000 });
      const zTimedOut = await waitIdle(zt0, ZOOM_CAP_MS);
      zoom = { ok: true, t0: zt0 - navStart, timedOut: zTimedOut };
    } catch (e) { zoom = { ok: false, error: String(e.message || e).slice(0, 200) }; }
  }
  for (let i = 0; i < 20 && inflight.size; i++) await sleep(250); // let late finish events land
  await context.close();

  const requests = done
    .map((d) => ({
      phase: d.phase, host: d.host, path: d.path, type: d.type, method: d.method, status: d.status,
      start: r1(d.startWall - navStart), ttfb: r1(d.ttfbWall - navStart), end: r1(d.endWall - navStart),
      bytes: d.bytes, protocol: protoByHost[d.host] || "h2", appShell: d.appShell, fromCache: d.fromCache, failed: d.failed,
    }))
    .sort((a, b) => a.start - b.start);
  const lastEnd = (p) => Math.max(0, ...requests.filter((r) => r.phase === p).map((r) => r.end));
  if (zoom.ok) zoom.readyMs = r1(lastEnd("zoom") - zoom.t0);

  return {
    trace: {
      id: target.id || "_baseline", title: target.title || "MapMaker (default map)", kind: isBaseline ? "baseline" : "map",
      recorderVersion: RECORDER_VERSION, recordedAt: new Date(navStart).toISOString(), url, error,
      openTimedOut, canvas: canvas > 0, heapMB,
      phases: { open: { t0: 0, readyMs: r1(lastEnd("open")) }, zoom },
      requests,
    },
    fullUrls,
  };
}

async function numViews(id) {
  try {
    const r = await fetch(`https://www.arcgis.com/sharing/rest/content/items/${id}?f=json`);
    const j = await r.json();
    return typeof j.numViews === "number" ? j.numViews : null;
  } catch { return null; }
}

function save(trace) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${trace.id}.json.gz`), zlib.gzipSync(JSON.stringify(trace)));
}

async function main() {
  const { maps } = JSON.parse(fs.readFileSync(process.env.MAPS_FILE || "config/maps.json", "utf8"));
  let list = maps.map((m, i) => ({ ...m, i }));
  if (args.ids) { const want = new Set(args.ids.split(",")); list = list.filter((m) => want.has(m.id)); }
  if (args.limit && +args.limit > 0) list = list.slice(0, +args.limit);
  if (args.shard) { const [k, n] = args.shard.split("/").map(Number); list = list.filter((_, j) => j % n === k - 1); }

  const browser = await chromium.launch({ args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });

  // The default MapMaker view: tells us which files belong to the app itself (cached after first use).
  const base = await recordOne(browser, {}, new Set());
  const appShellUrls = new Set(base.fullUrls.filter((u) => CACHEABLE_TYPES.has(u.type)).map((u) => u.url));
  if (!args.shard || args.shard.startsWith("1/")) save(base.trace);
  console.log(`baseline: ${base.trace.requests.length} requests, ${(base.trace.requests.reduce((a, r) => a + r.bytes, 0) / 1e6).toFixed(1)} MB, app files ${appShellUrls.size}`);

  for (const m of list) {
    const t0 = Date.now();
    const { trace } = await recordOne(browser, m, appShellUrls);
    trace.numViews = await numViews(m.id);
    trace.stage1Score = m.stage1_score ?? null;
    save(trace);
    const mb = trace.requests.reduce((a, r) => a + r.bytes, 0) / 1e6;
    console.log(`${m.id} ${m.title.slice(0, 40).padEnd(40)} ${String(trace.requests.length).padStart(5)} req ${mb.toFixed(1).padStart(6)} MB  open ${(trace.phases.open.readyMs / 1000).toFixed(1)} s  zoom ${trace.phases.zoom.ok ? "ok" : "FAILED"}${trace.openTimedOut ? "  TIMED OUT" : ""}${trace.error ? "  ERROR " + trace.error : ""}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  await browser.close();
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
