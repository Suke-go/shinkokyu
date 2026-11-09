# Clock sync survey (Node SNTP + browser HTTP + performance.now)

Date: 2026-11-09. "Verified" = I read the source/doc via fetch this session. "Unverified" = from memory, check before citing.

## 1. Repos read

| Repo | URL | Algorithm (verified) | License |
|---|---|---|---|
| timesync (enmasseio / josdejong) | https://github.com/enmasseio/timesync (src/timesync.js) | Per sample: `offset = serverTs - end + (end-start)/2` (Cristian, local `Date.now`). Defaults: `repeat=5` samples/peer, `delay=1000ms` between, `timeout=10000`, `interval=1h` (null disables). Outlier filter: drop samples with `roundtrip >= median(rt)+std(rt)`, then **mean** of remaining offsets. Peers combined by mean. First-ever offset applied from a single sample immediately. No drift model: each sync just replaces offset; hourly resync bounds drift. | MIT |
| ServerDate (NodeGuy) | https://github.com/NodeGuy/server-date (serverDate.js) | 10 sequential `HEAD` fetches of own URL (`cache:'no-store'`), no spacing, no resync. Uses `Date`, not performance.now. Picks sample with **lowest uncertainty** = rtt/2 + 500ms (Date header is whole seconds, so +/-500ms, server time +500). Output `{date, offset, uncertainty}`. Failures skipped. | MPL-2.0 |
| @hapi/sntp (hueniverse/sntp, now hapijs/sntp) | https://github.com/hapijs/sntp (lib/index.js) | 48-byte request, byte0=0x23 (v4, mode 3). Parses LI/VN/mode, stratum, ref/orig/recv/xmit timestamps (offsets 16/24/32/40); NTP epoch `2208988800`. `d=(T4-T1)-(T3-T2)`, `t=((T2-T1)+(T3-T4))/2`. Validation: length==48, version 4, mode server, stratum not reserved, nonzero orig/recv/xmit, **originate must echo what we sent**. Defaults host `time.google.com`, port 123; **one packet per call, no retries, no sample filtering**; `start()` refresh 24h. `offset()` returns rounded ms only (delay stays on message as `d`). | BSD-3-Clause |
| node-ntp-client (moonpyk) | https://github.com/moonpyk/node-ntp-client (lib/ntp-client.js) | Only reads the **transmit timestamp** (bytes 40-47) of the reply and returns it as a Date: **no offset/delay computation, no RTT compensation** (error up to ~RTT/2). Timeout 10s. Not suitable as-is; copy only the packet layout. | MIT |
| fullalive/timesync, webtimesync | https://github.com/fullalive/timesync , npm webtimesync | Found via search only (fork / dedicated endpoint). Not read. | - |

Notes
- The original Date-header ServerDate (2012) was seen only via search; the NodeGuy rewrite above is what I read. A Date-header approach is limited to 1 s resolution: unusable for ms-level work. Use a JSON endpoint returning fractional ms.
- Takeaways: (a) all use the same 4-timestamp/midpoint formula; (b) timesync filters by RTT (median+std) then averages; ServerDate keeps min-uncertainty (= min RTT); (c) nobody models drift, they just resync (1h); (d) hapi/sntp's originate-echo check is worth copying; (e) none discards a warm-up sample - we should.

## 2. Pitfalls

### performance.now() vs Date.now()
- `Date.now()` follows the OS wall clock and can step (NTP step, manual change, VM resume). `performance.now()` is monotonic and "not affected by clock adjustments" (MDN, verified).
- Precision (MDN, verified): `performance.now()` is coarsened to **100 us** in non-cross-origin-isolated contexts and **5 us** in cross-origin-isolated ones (`crossOriginIsolated === true`; needs COOP `same-origin` + COEP `require-corp`, which our Node server can send). Both are fine for keystrokes.
- Firefox (unverified, memory): `privacy.reduceTimerPrecision` is on by default at ~1 ms; with `privacy.resistFingerprinting` it becomes 100 ms or more plus jitter. Tell participants not to use RFP/Tor/strict-fingerprinting browsers; log `crossOriginIsolated` and measure effective resolution at startup (spin until `performance.now()` changes, record the smallest delta).
- Prefer `event.timeStamp` (DOMHighResTimeStamp on the same clock) over calling `performance.now()` inside the handler: it is the event creation time, excluding handler queueing delay.
- Sleep: MDN (verified) says the monotonic clock may not tick during OS sleep except on Windows browsers, so `timeOrigin+now()` can lag true time on other OS. Mitigation: resync at end; log `skew = (timeOrigin+performance.now()) - Date.now()` at each sync as a consistency check.
- `performance.timeOrigin` is captured once at navigation (MDN: may differ from Date.now() at the time origin). Over a long session the monotonic clock drifts against UTC at crystal rates (rule of thumb 10-50 ppm = 36-180 ms/hour; unverified for these machines). A 30-60 min session can accumulate ~100 ms: not negligible, so sync at start AND end and interpolate linearly.
- Do the browser exchange in the monotonic domain (`t0 = timeOrigin + performance.now()`), so a mid-session wall-clock step cannot corrupt the offset. Same on the server (see code).

### HTTP pitfalls
- The first request pays TCP/DNS/JIT cost; keep-alive reuse makes later RTT lower and more symmetric. **Discard the first 3 samples.** Use same-origin `fetch(..., {cache:'no-store'})`, tiny JSON, `socket.setNoDelay(true)` on the server.
- Asymmetry error is bounded by delay/2; the min-delay sample gives the tightest bound (loopback ~0.2-1 ms, LAN ~1-5 ms; typical, unverified).
- Server handler must take t1 first thing and t2 as late as possible, with fractional ms (not integer `Date.now()`).
- If browser and server run on the same machine they share the OS clock, so offset is ~0 +/- 1 ms. Still run the exchange (cheap, validates).

### SNTP packet (RFC 4330; checked against hapi/sntp and node-ntp-client)
- 48 bytes. Byte0 = LI(2b)|VN(3b)|Mode(3b): client v4 = `0x23` (v3 = `0x1B`).
- Timestamps are 64-bit: 32-bit seconds since 1900-01-01 + 32-bit fraction. Reference@16, Originate@24, Receive@32, **Transmit@40**.
- Unix ms = `(sec - 2208988800)*1000 + frac/2^32*1000`. (Era 0 ends 2036-02-07.)
- Client puts its own T1 in the Transmit field (40-47); server echoes it as Originate (24-31): verify the match (replay/spoof guard).
- Validate: length 48, mode==4, stratum 1..15 (0 = kiss-o'-death), LI!=3 (unsynchronized), T2/T3 nonzero.
- time.google.com smears leap seconds, pool/cloudflare do not (memory): do not mix them in one run; pick one family. Keep <= ~10 packets per server per sync, >= 250 ms apart (pool may send KoD to abusive clients).

## 3. Recommendation (one algorithm)

Two stages, everything stored raw, correction done offline.

**Stage A - Node server SNTP**, at server start, every 10 min, and at each session end.
- Host `time.google.com` (fallback `pool.ntp.org`); one family per run.
- 8 samples, 300 ms apart, 1 s timeout, **discard the first**. Per sample `theta=((T2-T1)+(T3-T4))/2`, `delta=(T4-T1)-(T3-T2)`. Reject if delta<0 or >500 ms, or invalid packet.
- Offset = theta of the **minimum-delta** sample (NTP clock-filter idea, RFC 5905 s10). Also store median theta and all raw samples.
- T1/T4 come from a monotonic-anchored clock so a wall-clock step during the 3 s cannot poison it.

**Stage B - browser<->server HTTP**, at page load (before task starts), at session end, and every 5 min in background when idle.
- 20 samples, 100 ms apart, sequential, **discard first 3**, keep 17. `offset=((t1-t0)+(t2-t3))/2`, `delay=(t3-t0)-(t2-t1)`, all fractional ms.
- Browser offset = offset of the **min-delay** sample (error <= delay_min/2). Also report median of the 5 lowest-delay offsets and their spread.
- Accept only if `delay_min < 50 ms` and spread of the 5 lowest < 5 ms; else retry up to 3 times, else `quality:"bad"`.
- Event time: `utc = performance.timeOrigin + e.timeStamp + browserOffset(t) + serverNtpOffset`. Both offsets stored separately.
- Drift: with start/end syncs `(t_a,off_a)`, `(t_b,off_b)`: `off(t)=off_a+(off_b-off_a)*(t-t_a)/(t_b-t_a)`; with the 5-min syncs fit a least-squares line (robust to one bad point). Never alter stamps online.

### Node SNTP client (node:dgram)
```js
import dgram from 'node:dgram';
const NTP_EPOCH = 2208988800;
const now = () => performance.timeOrigin + performance.now();      // fractional ms
const toNtp = ms => { const s = Math.floor(ms/1000); return [s + NTP_EPOCH, Math.floor((ms/1000 - s) * 2**32)]; };
const fromNtp = (b, o) => (b.readUInt32BE(o) - NTP_EPOCH) * 1000 + b.readUInt32BE(o+4) / 2**32 * 1000;

function sntpOnce(host, timeout = 1000) {
  return new Promise((res, rej) => {
    const sock = dgram.createSocket('udp4'), pkt = Buffer.alloc(48);
    pkt[0] = 0x23;                                      // LI=0, VN=4, mode=3
    const T1 = now(); const [s, f] = toNtp(T1);
    pkt.writeUInt32BE(s, 40); pkt.writeUInt32BE(f, 44); // transmit ts @40
    const timer = setTimeout(() => { sock.close(); rej(new Error('timeout')); }, timeout);
    sock.once('message', m => {
      const T4 = now(); clearTimeout(timer); sock.close();
      if (m.length < 48 || (m[0] & 7) !== 4 || m[1] === 0 || (m[0] >> 6) === 3) return rej(new Error('bad pkt'));
      if (m.readUInt32BE(24) !== s || m.readUInt32BE(28) !== f) return rej(new Error('origin mismatch'));
      const T2 = fromNtp(m, 32), T3 = fromNtp(m, 40);
      res({ theta: ((T2 - T1) + (T3 - T4)) / 2, delta: (T4 - T1) - (T3 - T2), stratum: m[1], host, T1, T2, T3, T4 });
    });
    sock.send(pkt, 123, host, e => e && rej(e));
  });
}
export async function sntpSync(host = 'time.google.com', n = 8, gap = 300) {
  const ok = [], all = [];
  for (let i = 0; i < n; i++) {
    try { const r = await sntpOnce(host); all.push(r); if (i > 0 && r.delta >= 0 && r.delta < 500) ok.push(r); }
    catch (e) { all.push({ err: String(e) }); }
    await new Promise(r => setTimeout(r, gap));
  }
  if (!ok.length) throw new Error('sntp failed');
  const best = ok.reduce((a, b) => b.delta < a.delta ? b : a);
  const th = ok.map(r => r.theta).sort((a, b) => a - b);
  return { host, offset: best.theta, delay: best.delta, median: th[th.length >> 1], n: ok.length, at: now(), all };
}
// serverNow() = now() + ntp.offset  (apply to the same clock expression everywhere on the server)
```

### Server endpoint + browser sync
```js
// server (node:http): fractional ms from the same now(); t2 taken as late as possible
if (req.url.startsWith('/sync')) {
  const t1 = now();
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
  return res.end(`{"t1":${t1},"t2":${now()}}`);
}
// browser
const clk = () => performance.timeOrigin + performance.now();
async function httpSync({ n = 20, gap = 100, drop = 3 } = {}) {
  const S = [];
  for (let i = 0; i < n; i++) {
    const t0 = clk();
    const { t1, t2 } = await (await fetch('/sync', { cache: 'no-store' })).json();
    const t3 = clk();
    if (i >= drop) S.push({ offset: ((t1 - t0) + (t2 - t3)) / 2, delay: (t3 - t0) - (t2 - t1), t0, t3 });
    await new Promise(r => setTimeout(r, gap));
  }
  S.sort((a, b) => a.delay - b.delay);
  const best = S[0], low = S.slice(0, 5).map(s => s.offset).sort((a, b) => a - b);
  return { offset: best.offset, delay: best.delay, medianLow5: low[2], spreadLow5: low[4] - low[0],
           n: S.length, at: best.t3, samples: S, crossOriginIsolated, ua: navigator.userAgent };
}
// keystroke record (never mutated): { seq, type, key, code, perf: e.timeStamp, origin: performance.timeOrigin }
```

### What to store (JSONL)
- `kind:"ntp"`: `host, offset, delay, median, n, at, all[]` (each T1..T4, theta, delta, stratum).
- `kind:"http"`: `phase: start|periodic|end, offset, delay, medianLow5, spreadLow5, n, at, samples[], quality`.
- Environment: `timeOrigin`, `crossOriginIsolated`, measured timer resolution, UA/OS, `skew` check at each sync.
- Keystrokes: raw `perf` (e.timeStamp), `origin`, `key`, `code`, `type`, `seq`. Not pre-corrected UTC only. Offline: `utc = origin + perf + off(t) + ntp.offset`.
- Expected accuracy: browser<->server <= delay_min/2 (sub-ms loopback, ~1-3 ms LAN); server<->UTC ~ SNTP delta_min/2 (typically 5-30 ms over internet); residual drift after linear correction a few ms. Cross-machine alignment is bounded by SNTP (~10-30 ms); within-machine timing is far better. State this in the paper.

## 4. Not verified
- Firefox timer-precision prefs (from memory); measure at runtime.
- Drift ppm figures are rules of thumb; run a 30-min start/end test on the real machines.
- Not read: Lamport/Marzullo reference impls, socket.io time-sync libs; RFC 4330 / 5905 cited from memory.
