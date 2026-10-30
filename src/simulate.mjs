// Classroom line simulator.
// Takes one recorded map load (a list of requests with timings and sizes) and plays it out for N students
// who share one classroom connection with limited bandwidth, latency, jitter and packet loss.
//
// Model (v0.1.0) — every simplification here is deliberate and listed in the README:
//  * Dependencies: request B waits for the request that finished most recently before B started in the
//    recording, plus the same gap (that gap is the browser's own work: parsing, drawing, deciding what to ask next).
//  * Each request costs: connection set-up (2 round trips, first use of a host only; per connection for HTTP/1.1,
//    max 6 per host), then 1 round trip + the server's recorded response time, then the download.
//  * The class's capacity is shared fairly between connections (TCP is fair per connection), and each connection is
//    also capped by the Mathis et al. (1997) loss formula: rate <= MSS / (RTT * sqrt(2p/3)). HTTP/2 requests to one
//    host share one connection; HTTP/1.1 requests each have their own.
//  * Packet loss near the end of a response cannot be repaired quickly, so each request has a chance of one
//    retransmission timeout stall (max(200 ms, 2 x RTT)).
//  * MapMaker's own files: first time = downloaded; usual lesson = a round trip each to check they haven't changed
//    (their cache lifetime is 30 minutes); same lesson = free.

export const SIMULATOR_VERSION = "0.2.0";
const MSS = 1460;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  peek() { return this.a[0]; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].t <= a[i].t) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].t < a[m].t) m = l;
        if (r < a.length && a[r].t < a[m].t) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/** Turn one phase's recorded requests into a dependency graph. Times in ms. */
export function buildDag(requests, phaseT0) {
  const sorted = [...requests].sort((a, b) => a.start - b.start);
  const reqs = sorted.map((r, k) => {
    let parent = -1, pend = -Infinity;
    for (let j = 0; j < k; j++) {
      const e = sorted[j].end;
      if (e <= r.start && e > pend) { pend = e; parent = j; }
    }
    const gap = Math.max(0, parent >= 0 ? r.start - pend : r.start - phaseT0);
    const serverMs = Math.max(0, (r.ttfb ?? r.start) - r.start);
    return { host: r.host, bytes: Math.max(0, r.bytes || 0), protocol: r.protocol || "h2",
             appShell: !!r.appShell, fromCache: !!r.fromCache, parent, gap, serverMs,
             inBaseline: r.inBaseline, cacheControl: r.cacheControl, validators: r.validators };
  });
  const children = reqs.map(() => []);
  const roots = [];
  reqs.forEach((r, k) => (r.parent >= 0 ? children[r.parent].push(k) : roots.push(k)));
  return { reqs, children, roots };
}

export function mathisBytesPerMs(rttMs, lossPct) {
  const p = lossPct / 100;
  if (p <= 0) return Infinity;
  return MSS / (rttMs * Math.sqrt((2 * p) / 3)); // bytes per ms
}

/** Fair share of `capacity` among flows with individual caps (water-filling). Returns rates aligned to caps. */
export function waterFill(caps, capacity) {
  const order = caps.map((c, i) => i).sort((a, b) => caps[a] - caps[b]);
  const rates = new Array(caps.length).fill(0);
  let remaining = capacity, n = caps.length;
  for (const i of order) {
    const share = remaining / n;
    const r = Math.min(caps[i], share);
    rates[i] = r; remaining -= r; n--;
  }
  return rates;
}

/**
 * Simulate one class.
 * phases: { open: dag, zoom: dag | null }
 * cache: "cold"       — first time on the device: everything downloaded as recorded
 *        "revalidate" — usual lesson: MapMaker's own files are in the browser cache but older than their
 *                       max-age (30 min), so each costs a "has it changed?" round trip and a ~300-byte reply
 *        "fresh"      — MapMaker was opened in the last 30 minutes: its own files cost nothing
 * Returns per-student { readyS, zoomS, bytes } (seconds; Infinity if not finished by maxS).
 */
export const REVALIDATE_BYTES = 300;
export function simulateClass({ phases, profile, students = 30, staggerS = 5, thinkBeforeZoomS = 2,
                                cache = "cold", cacheOf = null, warm, seed = 1, maxS = 600, setupRtts = 2 }) {
  if (warm === true) cache = "fresh";
  // cacheOf(r) -> "free" | "revalidate" | "download" overrides the simple modes below
  const simple = (r) => (!r.appShell || cache === "cold" ? "download" : cache === "fresh" ? "free" : "revalidate");
  const modeOf = cacheOf || simple;
  const modes = new Map();
  for (const p of ["open", "zoom"]) if (phases[p]) modes.set(p, phases[p].reqs.map((r) => modeOf(r)));
  const rand = mulberry32(seed);
  const capacity = (profile.capacity_mbps * 1e6) / 8 / 1000; // bytes per ms
  const baseRtt = profile.rtt_ms, jitter = profile.jitter_ms || 0, loss = profile.loss_pct || 0;
  const rto = Math.max(200, 2 * baseRtt);
  const connCap = mathisBytesPerMs(baseRtt, loss);
  const maxMs = maxS * 1000;
  const isH2 = (r) => r.protocol === "h2" || r.protocol === "h3";
  const instant = (p, k) => phases[p].reqs[k].fromCache || modes.get(p)[k] === "free";
  const bytesOf = (p, k) => (modes.get(p)[k] === "revalidate" ? Math.min(phases[p].reqs[k].bytes, REVALIDATE_BYTES) : phases[p].reqs[k].bytes);

  const phaseNames = ["open", "zoom"].filter((p) => phases[p]);
  const S = [];
  for (let s = 0; s < students; s++) {
    S.push({
      start: rand() * staggerS * 1000,
      h2Ready: new Map(), h1Open: new Map(), h1Active: new Map(), h1Queue: new Map(),
      phase: {}, bytes: 0,
    });
    for (const p of phaseNames) S[s].phase[p] = { done: 0, end: null, t0: null };
  }

  const timers = new MinHeap();   // { t, kind: 'eligible'|'latencyEnd', s, p, k }
  // Connections share the line fairly (TCP is fair per connection). Requests on one connection share it equally,
  // tracked with a per-connection "virtual service" counter so each step costs O(connections), not O(requests).
  const conns = new Map();        // key -> { V, n, heap of { t: target V, s, p, k } }
  let t = 0;

  const startPhase = (s, p, t0) => {
    const st = S[s].phase[p]; st.t0 = t0;
    const dag = phases[p];
    if (!dag.reqs.length) { st.end = t0; onPhaseDone(s, p); return; }
    for (const k of dag.roots) timers.push({ t: t0 + dag.reqs[k].gap, kind: "eligible", s, p, k });
  };

  const onPhaseDone = (s, p) => {
    if (p === "open" && phases.zoom) startPhase(s, "zoom", S[s].phase.open.end + thinkBeforeZoomS * 1000);
  };

  const finish = (s, p, k, when) => {
    const dag = phases[p], st = S[s].phase[p];
    const r = dag.reqs[k];
    if (!isH2(r) && !instant(p, k)) {
      const key = r.host;
      S[s].h1Active.set(key, S[s].h1Active.get(key) - 1);
      const q = S[s].h1Queue.get(key);
      if (q && q.length) { const nx = q.shift(); timers.push({ t: when, kind: "eligible", s, p: nx.p, k: nx.k, dequeued: true }); }
    }
    for (const c of dag.children[k]) timers.push({ t: when + dag.reqs[c].gap, kind: "eligible", s, p, k: c });
    st.done++;
    if (st.done === dag.reqs.length) { st.end = when; onPhaseDone(s, p); }
  };

  const begin = (ev) => {
    const { s, p, k } = ev;
    const r = phases[p].reqs[k], stu = S[s];
    if (instant(p, k)) { finish(s, p, k, ev.t); return; }
    let setup = 0, readyAt = ev.t;
    if (isH2(r)) {
      // every request to this host waits until its one connection is set up
      if (!stu.h2Ready.has(r.host)) stu.h2Ready.set(r.host, ev.t + setupRtts * baseRtt);
      readyAt = Math.max(ev.t, stu.h2Ready.get(r.host));
    } else {
      const active = stu.h1Active.get(r.host) || 0;
      if (!ev.dequeued && active >= 6) {
        if (!stu.h1Queue.has(r.host)) stu.h1Queue.set(r.host, []);
        stu.h1Queue.get(r.host).push({ p, k }); return;
      }
      stu.h1Active.set(r.host, active + 1);
      const open = stu.h1Open.get(r.host) || 0;
      if (open < 6 && active + 1 > open) { stu.h1Open.set(r.host, open + 1); setup = setupRtts * baseRtt; }
    }
    const rtt = baseRtt + rand() * jitter;
    const pkts = Math.max(1, Math.ceil(bytesOf(p, k) / MSS));
    const stall = rand() < 1 - Math.pow(1 - loss / 100, Math.min(pkts, 3)) ? rto : 0;
    timers.push({ t: readyAt + setup + rtt + r.serverMs + stall, kind: "latencyEnd", s, p, k });
  };

  for (let s = 0; s < students; s++) startPhase(s, "open", S[s].start);

  while ((timers.size || conns.size) && t < maxMs) {
    const G = [...conns.values()];
    const perConn = G.length ? Math.min(connCap, capacity / G.length) : 0; // equal caps, so water-filling is a min()
    let next = timers.size ? timers.peek().t : Infinity;
    for (const g of G) next = Math.min(next, t + ((g.heap.peek().t - g.V) * g.n) / perConn);
    if (!isFinite(next)) break;
    next = Math.min(Math.max(next, t), maxMs);
    const dt = next - t;
    for (const g of G) g.V += (perConn / g.n) * dt;
    t = next;

    for (const [key, g] of conns) {
      while (g.heap.size && g.heap.peek().t <= g.V + 1e-6) {
        const f = g.heap.pop(); g.n--;
        finish(f.s, f.p, f.k, t);
      }
      if (!g.n) conns.delete(key);
    }
    while (timers.size && timers.peek().t <= t + 1e-9) {
      const ev = timers.pop();
      if (ev.kind === "eligible") begin(ev);
      else {
        const r = phases[ev.p].reqs[ev.k];
        const b = bytesOf(ev.p, ev.k);
        S[ev.s].bytes += b;
        if (b <= 0) { finish(ev.s, ev.p, ev.k, ev.t); continue; }
        const key = isH2(r) ? `${ev.s}|${r.host}` : `${ev.s}|${ev.p}|${ev.k}`;
        let g = conns.get(key);
        if (!g) { g = { V: 0, n: 0, heap: new MinHeap() }; conns.set(key, g); }
        g.heap.push({ t: g.V + b, s: ev.s, p: ev.p, k: ev.k }); g.n++;
      }
    }
  }

  return S.map((stu) => {
    const o = stu.phase.open, z = stu.phase.zoom;
    return {
      readyS: o.end == null ? Infinity : (o.end - stu.start) / 1000,
      zoomS: !z ? null : z.end == null ? Infinity : (z.end - z.t0) / 1000,
      bytes: stu.bytes,
    };
  });
}

/** Seconds a response may be reused without asking; -1 = must not be stored. null = header not recorded. */
export function maxAgeOf(cc) {
  if (cc == null) return null;
  const c = String(cc).toLowerCase();
  if (/no-store/.test(c)) return -1;
  if (/no-cache/.test(c)) return 0;
  if (/immutable/.test(c)) return Infinity;
  const m = c.match(/(?:^|[,\s])max-age=(\d+)/);
  return m ? +m[1] : 0;
}

/**
 * Browser-cache rule for one request when MapMaker was last used `secondsSince` ago on this device.
 * Only files the default MapMaker view also fetched can be in the cache (a new map's own data never is).
 */
export function cacheRule(secondsSince) {
  return (r) => {
    if (!r.inBaseline && !(r.inBaseline === undefined && r.appShell)) return "download";
    const ma = maxAgeOf(r.cacheControl);
    if (ma == null) return r.appShell ? "revalidate" : "download";  // older recordings without headers
    if (ma < 0) return "download";
    if (ma >= secondsSince) return "free";
    return r.validators ? "revalidate" : "download";
  };
}

export function percentile(values, pct) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((pct / 100) * v.length) - 1));
  return v[idx];
}

export function summarise(results, key) {
  const v = results.map((r) => r[key]).filter((x) => x !== null && x !== undefined);
  if (!v.length) return null;
  return { median: percentile(v, 50), p90: percentile(v, 90), slowest: Math.max(...v) };
}

/** Build both phases from a recorded trace (see record.mjs for the format). */
export function phasesFromTrace(trace) {
  const by = (p) => trace.requests.filter((r) => r.phase === p);
  const open = buildDag(by("open"), 0);
  const zoom = trace.phases?.zoom?.ok ? buildDag(by("zoom"), trace.phases.zoom.t0) : null;
  return { open, zoom };
}
