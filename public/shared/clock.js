// Browser -> server clock sync (SPEC §3.B). Pure ESM; runs in browser and Node.
// Test hooks (the only ones): options.fetchImpl, options.now.
// options.fetchTime: async () => ({t1,t2}) replaces the HTTP GET (supabase mode).

const defaultNow = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const within = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error("no answer"); })]);

async function oneRound({ url, n, gap, drop, fetchImpl, fetchTime, now, onProgress, round }) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    let got = null; // a request that fails or is not answered in 3 s is one sample fewer, not a sync that never ends
    try { got = await within(fetchTime ? fetchTime() : fetchImpl(url, { cache: "no-store" }).then((r) => r.json()), 3000); } catch { /* skip */ }
    const t3 = now();
    if (got && i >= drop) {
      const { t1, t2 } = got;
      samples.push({ t0, t1, t2, t3, offset: ((t1 - t0) + (t2 - t3)) / 2, delay: (t3 - t0) - (t2 - t1) });
    }
    if (onProgress) onProgress(i + 1, n, round);
    if (gap > 0 && i < n - 1) await sleep(gap);
  }
  if (!samples.length) throw new Error("no time sample");
  const byDelay = [...samples].sort((a, b) => a.delay - b.delay);
  const best = byDelay[0];
  const low = byDelay.slice(0, 5).map((s) => s.offset).sort((a, b) => a - b);
  return {
    offset: best.offset,
    delay: best.delay,
    medianLow5: low[low.length >> 1],
    spreadLow5: low[low.length - 1] - low[0],
    n: samples.length,
    at: best.t3,
    samples,
  };
}

export async function syncClock({
  phase, onProgress, fetchImpl, fetchTime, url = "/api/time", now = defaultNow, n = 20, gap = 100, drop = 3, maxRetries = 3,
  goodDelay = 50, goodSpread = 5, // internet RTT (supabase) needs looser thresholds
}) {
  fetchImpl = fetchImpl || ((...a) => fetch(...a));
  let best = null;
  let attempts = 0;
  let quality = "bad";
  for (; attempts <= maxRetries; ) {
    attempts++;
    const r = await oneRound({ url, n, gap, drop, fetchImpl, fetchTime, now, onProgress, round: attempts });
    if (!best || r.delay < best.delay) best = r;
    if (r.delay < goodDelay && r.spreadLow5 < goodSpread) { quality = "good"; best = r; break; }
  }
  const g = globalThis;
  return {
    phase, ...best, quality, attempts,
    timeOrigin: g.performance ? g.performance.timeOrigin : null,
    crossOriginIsolated: !!g.crossOriginIsolated,
    skew: g.performance ? g.performance.timeOrigin + g.performance.now() - Date.now() : null,
    ua: g.navigator ? g.navigator.userAgent : null,
  };
}

// syncs = meta.syncs. Returns (tLocal) => tUtc. Offset interpolated linearly by local time `at`.
export function makeOffsetFn(syncs) {
  const list = Array.isArray(syncs) ? syncs : [];
  const last = (p) => list.filter((s) => s && s.phase === p && Number.isFinite(s.offset)).pop();
  const a = last("start");
  const b = last("end");
  let fn;
  if (a && b && b.at !== a.at) {
    const slope = (b.offset - a.offset) / (b.at - a.at);
    fn = (t) => t + a.offset + slope * (t - a.at); // extrapolates linearly outside [a.at, b.at]
  } else if (a || b) {
    const o = (a || b).offset;
    fn = (t) => t + o;
  } else {
    fn = (t) => t;
    fn.unsynced = true;
  }
  return fn;
}
