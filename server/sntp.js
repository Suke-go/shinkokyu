import dgram from 'node:dgram';
import dns from 'node:dns/promises';

const NTP_EPOCH = 2208988800;
const HOSTS = ['time.google.com', 'pool.ntp.org'];
const SAMPLES = 8, GAP = 300, TIMEOUT = 1000, MAX_DELTA = 500;

// Monotonic-anchored clock: immune to wall-clock steps during a sync.
const mono = () => performance.timeOrigin + performance.now();

let state = { ok: false, offset: 0, delay: null, server: null, at: null };
export const getSntp = () => ({ ...state });
export const serverNow = () => mono() + state.offset;

const fromNtp = (b, o) => (b.readUInt32BE(o) - NTP_EPOCH) * 1000 + (b.readUInt32BE(o + 4) / 2 ** 32) * 1000;

// Validate a reply; (s, f) are the transmit seconds/fraction we sent. Returns server T2/T3 in unix ms.
export function parsePacket(m, s, f) {
  if (m.length < 48) throw new Error('short packet');
  if ((m[0] & 7) !== 4) throw new Error('not server mode');
  if (m[0] >> 6 === 3) throw new Error('unsynchronized (LI=3)');
  if (m[1] === 0 || m[1] > 15) throw new Error('bad stratum');
  if (m.readUInt32BE(24) !== s || m.readUInt32BE(28) !== f) throw new Error('originate mismatch');
  if (!m.readUInt32BE(32) || !m.readUInt32BE(40)) throw new Error('zero timestamp');
  return { T2: fromNtp(m, 32), T3: fromNtp(m, 40), stratum: m[1] };
}

export function sntpOnce(host, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const pkt = Buffer.alloc(48);
    pkt[0] = 0x23; // LI=0, VN=4, mode=3
    const T1 = mono();
    const sec = Math.floor(T1 / 1000);
    const s = sec + NTP_EPOCH, f = Math.floor((T1 / 1000 - sec) * 2 ** 32);
    pkt.writeUInt32BE(s, 40);
    pkt.writeUInt32BE(f, 44);
    let fin = false; // timeout, send error and message can race
    const done = (fn, v) => { if (fin) return; fin = true; clearTimeout(timer); try { sock.close(); } catch {} fn(v); };
    const timer = setTimeout(() => done(reject, new Error('timeout')), timeout);
    sock.on('error', e => done(reject, e));
    sock.once('message', m => {
      const T4 = mono();
      try {
        const { T2, T3 } = parsePacket(m, s, f);
        done(resolve, { theta: ((T2 - T1) + (T3 - T4)) / 2, delta: (T4 - T1) - (T3 - T2) });
      } catch (e) { done(reject, e); }
    });
    sock.send(pkt, 123, host, e => e && done(reject, e));
  });
}

async function trySync(host) {
  const ok = [];
  let ip; // resolve once: keeps DNS out of T1 and pins one pool member per sync
  try { ip = (await dns.lookup(host, { family: 4 })).address; } catch { return ok; }
  for (let i = 0; i < SAMPLES; i++) {
    try {
      const r = await sntpOnce(ip);
      if (i > 0 && r.delta >= 0 && r.delta <= MAX_DELTA) ok.push(r); // first sample discarded
    } catch {}
    if (i < SAMPLES - 1) await new Promise(r => setTimeout(r, GAP));
  }
  return ok;
}

let running = null;
// Never throws: on total failure keeps serving with offset=0, ok=false.
export function sntpSync() {
  return (running ??= (async () => {
    try {
      for (const host of HOSTS) {
        const ok = await trySync(host); // one host per sync, never mixed
        if (!ok.length) continue;
        const best = ok.reduce((a, b) => (b.delta < a.delta ? b : a));
        const th = ok.map(r => r.theta).sort((a, b) => a - b);
        state = { ok: true, offset: best.theta, delay: best.delta, server: host, at: mono() + best.theta, median: th[th.length >> 1], n: ok.length };
        return getSntp();
      }
      // keep the last good offset if one exists (stale); 0 only if never synced
      state = state.server ? { ...state, ok: false, stale: true } : { ...state, ok: false, offset: 0, delay: null, at: mono() };
      return getSntp();
    } finally { running = null; }
  })());
}
