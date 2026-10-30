// Checks the simulator against reality for a handful of maps.
// For each map: (1) record it normally (fast line), (2) load it again in a real browser throttled to a slow line,
// (3) ask the simulator to predict (2) from (1) for one student on the same line. Big gaps = the model needs work.
// Usage: node src/validate.mjs [--limit 10] [--ids a,b]
// Output: results/validation.csv and results/validation.json

import fs from "fs";
import { recordOne, chromium, CACHEABLE_TYPES } from "./record.mjs";
import { simulateClass, phasesFromTrace } from "./simulate.mjs";

export const VALIDATOR_VERSION = "0.1.0";
// Lines to test: a single student's share of poor classroom wifi, and a far-away school.
// No packet loss or jitter here: the browser's throttling can't produce them, so this checks bandwidth, latency
// and the request-dependency model only.
const LINES = [
  { id: "slow", mbps: 2, rtt_ms: 80 },
  { id: "far", mbps: 5, rtt_ms: 250 },
];

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => {
  if (x.startsWith("--")) a.push([x.slice(2), all[i + 1]]);
  return a;
}, []));

async function main() {
  const { maps } = JSON.parse(fs.readFileSync(process.env.MAPS_FILE || "config/maps.json", "utf8"));
  let list = maps;
  if (args.ids) { const want = new Set(args.ids.split(",")); list = list.filter((m) => want.has(m.id)); }
  else {
    // spread across the stage-1 scores so light and heavy maps are both checked
    const n = +(args.limit || 10);
    const sorted = [...maps].sort((a, b) => (b.stage1_score ?? 0) - (a.stage1_score ?? 0));
    list = Array.from({ length: Math.min(n, sorted.length) }, (_, i) => sorted[Math.floor((i * sorted.length) / n)]);
  }
  const browser = await chromium.launch({ args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  const base = await recordOne(browser, {}, new Set(), { skipZoom: true });
  const appShell = new Set(base.fullUrls.filter((u) => CACHEABLE_TYPES.has(u.type)).map((u) => u.url));
  appShell.all = new Set(base.fullUrls.map((u) => u.url));

  const rows = [];
  for (const m of list) {
    const fast = (await recordOne(browser, m, appShell, { skipZoom: true })).trace;
    const phases = phasesFromTrace(fast);
    for (const line of LINES) {
      const real = (await recordOne(browser, m, appShell, { skipZoom: true, throttle: line, openCapMs: 600_000 })).trace;
      const [pred] = simulateClass({ phases, students: 1, staggerS: 0, warm: false, setupRtts: 0, seed: 1,
        profile: { capacity_mbps: line.mbps, rtt_ms: line.rtt_ms, jitter_ms: 0, loss_pct: 0 } });
      const realS = real.phases.open.readyMs / 1000;
      const row = {
        id: m.id, title: m.title, line: line.id, mbps: line.mbps, rtt_ms: line.rtt_ms,
        requests_fast: fast.requests.filter((r) => r.phase === "open").length,
        requests_slow: real.requests.filter((r) => r.phase === "open").length,
        real_s: Math.round(realS * 10) / 10, predicted_s: Math.round(pred.readyS * 10) / 10,
        ratio: Math.round((pred.readyS / realS) * 100) / 100, real_timed_out: real.openTimedOut, error: real.error || fast.error || "",
      };
      rows.push(row);
      console.log(`${m.title.slice(0, 40).padEnd(40)} ${line.id.padEnd(5)} real ${String(row.real_s).padStart(6)} s  predicted ${String(row.predicted_s).padStart(6)} s  ratio ${row.ratio}`);
    }
  }
  await browser.close();
  fs.mkdirSync("results", { recursive: true });
  fs.writeFileSync("results/validation.json", JSON.stringify({ validatorVersion: VALIDATOR_VERSION, lines: LINES, rows }, null, 1));
  const cols = Object.keys(rows[0] || { id: 1 });
  fs.writeFileSync("results/validation.csv", [cols.join(",")].concat(rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))).join("\n") + "\n");
  const ratios = rows.filter((r) => !r.real_timed_out && isFinite(r.ratio)).map((r) => r.ratio).sort((a, b) => a - b);
  if (ratios.length) console.log(`predicted/real: median ${ratios[Math.floor(ratios.length / 2)]}, range ${ratios[0]}–${ratios[ratios.length - 1]}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
