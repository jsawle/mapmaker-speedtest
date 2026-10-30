import test from "node:test";
import assert from "node:assert/strict";
import { buildDag, simulateClass, waterFill, mathisBytesPerMs, percentile } from "../src/simulate.mjs";

const prof = (o) => ({ capacity_mbps: 10, rtt_ms: 100, jitter_ms: 0, loss_pct: 0, ...o });
const near = (a, b, tol = 0.002) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const one = (bytes, extra = {}) => ({ host: "a", start: 0, ttfb: 0, end: 10, bytes, protocol: "h2", ...extra });

test("water-filling gives capped flows their cap and splits the rest", () => {
  assert.deepEqual(waterFill([1, 10, 10], 9), [1, 4, 4]);
  assert.deepEqual(waterFill([Infinity, Infinity], 10), [5, 5]);
});

test("one student, one request: setup + RTT + transfer", () => {
  const dag = buildDag([one(1_250_000)], 0); // 10 Mbit on a 10 Mbps line = 1 s
  const [r] = simulateClass({ phases: { open: dag }, profile: prof(), students: 1, staggerS: 0 });
  near(r.readyS, 0.2 + 0.1 + 1.0);
});

test("two students share the line", () => {
  const dag = buildDag([one(1_250_000)], 0);
  const res = simulateClass({ phases: { open: dag }, profile: prof(), students: 2, staggerS: 0 });
  for (const r of res) near(r.readyS, 0.3 + 2.0);
});

test("dependencies and recorded gaps are kept", () => {
  const reqs = [
    { host: "a", start: 0, ttfb: 50, end: 60, bytes: 0, protocol: "h2" },
    { host: "a", start: 160, ttfb: 160, end: 170, bytes: 0, protocol: "h2" }, // 100 ms after parent ended
  ];
  const dag = buildDag(reqs, 0);
  assert.equal(dag.reqs[1].parent, 0); near(dag.reqs[1].gap, 100, 1e-9); near(dag.reqs[0].serverMs, 50, 1e-9);
  const [r] = simulateClass({ phases: { open: dag }, profile: prof(), students: 1, staggerS: 0 });
  near(r.readyS, (200 + 100 + 50 + 100 + 100) / 1000); // setup+rtt+server, gap, rtt (connection reused)
});

test("loss caps a single connection (Mathis)", () => {
  const cap = mathisBytesPerMs(100, 1); // ~178.8 bytes/ms
  near(cap, 1460 / (100 * Math.sqrt(0.02 / 3)), 1e-9);
  const dag = buildDag([one(Math.round(cap * 1000))], 0);
  const [r] = simulateClass({ phases: { open: dag }, profile: prof({ capacity_mbps: 1000, loss_pct: 1 }), students: 1, staggerS: 0, seed: 7 });
  const base = 0.2 + 0.1 + 1.0;
  assert.ok(Math.abs(r.readyS - base) < 0.002 || Math.abs(r.readyS - (base + 0.2)) < 0.002, String(r.readyS));
});

test("HTTP/2 requests to one host share one connection's loss cap; HTTP/1.1 ones do not", () => {
  const two = (proto) => buildDag([one(178_800, { protocol: proto }), one(178_800, { protocol: proto })], 0);
  const p = prof({ capacity_mbps: 1000, loss_pct: 1 });
  const [h2] = simulateClass({ phases: { open: two("h2") }, profile: p, students: 1, staggerS: 0, seed: 3 });
  const [h1] = simulateClass({ phases: { open: two("http/1.1") }, profile: p, students: 1, staggerS: 0, seed: 3 });
  assert.ok(h2.readyS > h1.readyS + 0.5, `${h2.readyS} vs ${h1.readyS}`);
});

test("HTTP/1.1 is limited to 6 requests in flight per host", () => {
  const reqs = Array.from({ length: 12 }, () => ({ host: "a", start: 0, ttfb: 0, end: 10, bytes: 0, protocol: "http/1.1" }));
  const [r] = simulateClass({ phases: { open: buildDag(reqs, 0) }, profile: prof(), students: 1, staggerS: 0 });
  near(r.readyS, 0.2 + 0.1 + 0.1); // first 6 open connections; second 6 reuse them after one RTT
});

test("warm runs skip the app's own files", () => {
  const reqs = [one(1_250_000, { appShell: true }), { ...one(125_000), start: 20 }];
  const dag = buildDag(reqs, 0);
  const cold = simulateClass({ phases: { open: dag }, profile: prof(), students: 1, staggerS: 0 })[0].readyS;
  const warm = simulateClass({ phases: { open: dag }, profile: prof(), students: 1, staggerS: 0, warm: true })[0].readyS;
  assert.ok(cold > warm + 0.9, `${cold} vs ${warm}`);
  near(warm, 0.01 + 0.2 + 0.1 + 0.1); // gap 10 ms after the cached file, then setup, RTT, 0.1 s transfer
});

test("zoom phase starts after the map is ready plus thinking time", () => {
  const open = buildDag([one(0)], 0);
  const zoom = buildDag([{ ...one(1_250_000), start: 5000, ttfb: 5000, end: 5100 }], 5000);
  const [r] = simulateClass({ phases: { open, zoom }, profile: prof(), students: 1, staggerS: 0, thinkBeforeZoomS: 2 });
  near(r.readyS, 0.3); near(r.zoomS, 0.1 + 1.0); // connection already open
});

test("percentile picks the student at that rank", () => {
  const v = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(percentile(v, 90), 27); assert.equal(percentile(v, 50), 15);
});

test("30 students on poor wifi: a realistic 400-request map simulates quickly", () => {
  const reqs = Array.from({ length: 400 }, (_, i) => ({ host: `h${i % 5}`, start: Math.floor(i / 8) * 40, ttfb: Math.floor(i / 8) * 40 + 20, end: Math.floor(i / 8) * 40 + 35, bytes: 10_000, protocol: "h2" }));
  const t0 = Date.now();
  const res = simulateClass({ phases: { open: buildDag(reqs, 0) }, profile: prof({ jitter_ms: 40, loss_pct: 2, rtt_ms: 80 }), students: 30 });
  assert.ok(res.every((r) => isFinite(r.readyS)));
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
  // 30 x 4 MB on 10 Mbps cannot finish faster than ~96 s for the class as a whole
  assert.ok(Math.max(...res.map((r) => r.readyS)) > 90);
});

test("a class that cannot finish within the cap is reported as Infinity, not dropped", () => {
  const dag = buildDag([one(50_000_000)], 0); // 30 x 50 MB on 10 Mbps = 20 min
  const res = simulateClass({ phases: { open: dag }, profile: prof(), students: 30, maxS: 60 });
  assert.ok(res.every((r) => r.readyS === Infinity));
});
