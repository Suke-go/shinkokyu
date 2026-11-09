import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sntpSync, serverNow, getSntp } from './sntp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const MAX_BODY = 5 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// sessionId = expId_participantId_stamp can exceed 64 chars, so it gets a longer cap (same charset).
const SID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = msg => new HttpError(400, msg);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

const metaPath = id => path.join(DATA, id + '.json');
const eventsPath = id => path.join(DATA, id + '.events.jsonl');

// Per-session serialization: one promise chain per id.
const locks = new Map();
function locked(id, fn) {
  const p = (locks.get(id) || Promise.resolve()).then(fn);
  locks.set(id, p.catch(() => {}));
  return p;
}

const sessions = new Map(); // id -> { meta, seen:Set } (cache; disk is the source of truth)
async function load(id) {
  let s = sessions.get(id);
  if (s) return s;
  let meta;
  try { meta = JSON.parse(await fs.readFile(metaPath(id), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new HttpError(404, 'no such session'); throw e; }
  meta.batches ??= [];
  s = { meta, seen: new Set(meta.batches) };
  sessions.set(id, s);
  return s;
}

async function saveMeta(meta) {
  const f = metaPath(meta.sessionId), tmp = f + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(meta));
  await fs.rename(tmp, f); // atomic replace
}

async function experiments() {
  return JSON.parse(await fs.readFile(path.join(here, 'experiments.json'), 'utf8')); // re-read: editable without restart
}

async function readJson(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) throw new HttpError(413, 'body too large');
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw bad('invalid JSON'); }
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, headers);
  res.end(body);
};
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
const decode = s => { try { return decodeURIComponent(s); } catch { throw bad('bad URL encoding'); } };

const pad = n => String(n).padStart(2, '0');
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
const clockView = () => (({ ok, offset, delay, server, at }) => ({ ok, offset, delay, server, at }))(getSntp());

async function api(req, res, p, t1) {
  const m = req.method;
  if (p === '/api/time' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(`{"t1":${t1},"t2":${serverNow()}}`); // t2 taken as late as possible
  }
  if (p === '/api/server-clock' && m === 'GET') return json(res, 200, { sntp: clockView() });
  let r;
  if (m === 'GET' && (r = p.match(/^\/api\/experiments\/([^/]+)$/))) {
    const expId = decode(r[1]);
    if (!ID_RE.test(expId)) throw bad('invalid expId');
    const all = await experiments();
    if (!Object.hasOwn(all, expId)) throw new HttpError(404, 'unknown experiment');
    return json(res, 200, { expId, ...all[expId] });
  }
  if (p === '/api/sessions' && m === 'POST') {
    const b = await readJson(req);
    if (!isObj(b) || !ID_RE.test(b.expId) || !ID_RE.test(b.participantId)) throw bad('invalid expId/participantId');
    const all = await experiments();
    if (!Object.hasOwn(all, b.expId)) throw new HttpError(404, 'unknown experiment');
    const createdAt = serverNow();
    const base = `${b.expId}_${b.participantId}_${stamp(createdAt)}`;
    await fs.mkdir(DATA, { recursive: true });
    let sessionId = base;
    for (let i = 2; ; i++) { // same participant twice in one second: never overwrite
      const meta = {
        sessionId, expId: b.expId, participantId: b.participantId, createdAt, startedAt: null, endedAt: null,
        sourceText: all[b.expId].text, finalText: null, userAgent: String(req.headers['user-agent'] || ''),
        serverSntp: clockView(), syncs: [], eventCount: 0, batches: [],
      };
      try {
        await fs.writeFile(metaPath(sessionId), JSON.stringify(meta), { flag: 'wx' });
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        sessionId = `${base}-${i}`;
      }
    }
    return json(res, 200, { sessionId });
  }
  if (p === '/api/sessions' && m === 'GET') {
    let files = [];
    try { files = await fs.readdir(DATA); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const out = [];
    for (const f of files) {
      if (!/^[A-Za-z0-9_-]+\.json$/.test(f)) continue;
      try {
        const x = JSON.parse(await fs.readFile(path.join(DATA, f), 'utf8'));
        let eventCount = x.eventCount;
        if (!Number.isInteger(eventCount)) { // externally made session: count lines
          try { eventCount = (await fs.readFile(eventsPath(x.sessionId), 'utf8')).split('\n').filter(Boolean).length; } catch { eventCount = 0; }
        }
        out.push({ sessionId: x.sessionId, expId: x.expId, participantId: x.participantId, startedAt: x.startedAt, endedAt: x.endedAt, eventCount, createdAt: x.createdAt });
      } catch {} // skip half-written/corrupt file
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return json(res, 200, out.map(({ createdAt, ...x }) => x));
  }
  if ((r = p.match(/^\/api\/sessions\/([^/]+)(?:\/(sync|events|finish))?$/))) {
    const id = decode(r[1]), action = r[2];
    if (!SID_RE.test(id)) throw bad('invalid session id');
    if (!action && m === 'GET') {
      return json(res, 200, await locked(id, async () => {
        const { meta } = await load(id);
        let text = '';
        try { text = await fs.readFile(eventsPath(id), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const seqs = new Set(), events = [];
        for (const l of text.split('\n')) {
          let e;
          try { e = JSON.parse(l); } catch { continue; } // blank or corrupt (crash-truncated) line
          if (isObj(e) && Number.isInteger(e.seq)) { if (seqs.has(e.seq)) continue; seqs.add(e.seq); } // keep first
          events.push(e);
        }
        return { meta, events };
      }));
    }
    if (action && m === 'POST') {
      const b = await readJson(req);
      if (!isObj(b)) throw bad('body must be an object');
      if (action === 'sync' && !Number.isFinite(b.offset)) throw bad('offset must be a number');
      if (action === 'events') {
        if (!Number.isInteger(b.seq) || b.seq < 0) throw bad('seq must be a non-negative integer');
        if (!Array.isArray(b.events) || !b.events.every(isObj)) throw bad('events must be an array of objects');
      }
      if (action === 'finish' && typeof b.finalText !== 'string') throw bad('finalText must be a string');
      return json(res, 200, await locked(id, async () => {
        const { meta, seen } = await load(id);
        if (action === 'sync') {
          meta.syncs.push(b);
          await saveMeta(meta);
          return { ok: true };
        }
        if (action === 'events') {
          if (seen.has(b.seq)) return { ok: true, seq: b.seq }; // idempotent resend
          // Append events first: a crash before saveMeta yields a duplicate batch on retry (dedupable by seq), never a loss.
          if (b.events.length) {
            let lead = '';
            try { // a crash can leave a partial last line: start on a fresh line
              const fh = await fs.open(eventsPath(id), 'r');
              try {
                const { size } = await fh.stat();
                if (size) { const c = Buffer.alloc(1); await fh.read(c, 0, 1, size - 1); if (c[0] !== 10) lead = '\n'; }
              } finally { await fh.close(); }
            } catch (e) { if (e.code !== 'ENOENT') throw e; }
            await fs.appendFile(eventsPath(id), lead + b.events.map(e => JSON.stringify(e)).join('\n') + '\n');
          }
          seen.add(b.seq);
          meta.batches.push(b.seq);
          meta.eventCount += b.events.length;
          if (meta.startedAt == null && b.events.some(e => e.type === 'session_start')) meta.startedAt = serverNow();
          await saveMeta(meta);
          return { ok: true, seq: b.seq };
        }
        meta.finalText = b.finalText;
        meta.endedAt = serverNow();
        meta.clientEndedAt = Number.isFinite(b.endedAt) ? b.endedAt : null;
        await saveMeta(meta);
        return { ok: true };
      }));
    }
  }
  throw new HttpError(404, 'not found');
}

async function serveStatic(req, res, raw) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
  const p = decode(raw);
  if (p.includes('\0') || p.includes(':') || p.split(/[\\/]/).includes('..')) throw bad('bad path');
  let file = path.resolve(PUBLIC, '.' + p);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'forbidden');
  let st;
  try { st = await fs.stat(file); } catch { throw new HttpError(404, 'not found'); }
  if (st.isDirectory()) {
    if (!raw.endsWith('/')) return send(res, 302, '', { Location: raw.replace(/^[/\\]+/, '/') + '/' }); // single leading slash: no open redirect
    file = path.join(file, 'index.html');
  }
  let body;
  try { body = await fs.readFile(file); } catch { throw new HttpError(404, 'not found'); }
  send(res, 200, req.method === 'HEAD' ? undefined : body, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
}

async function handle(req, res) {
  const t1 = serverNow(); // first thing: request-received stamp for /api/time
  try {
    const raw = req.url.split('?')[0];
    if (raw === '/') return send(res, 302, '', { Location: '/experiment/' });
    if (raw.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      return await api(req, res, raw.replace(/\/+$/, ''), t1);
    }
    await serveStatic(req, res, raw);
  } catch (e) {
    const status = e.status || 500;
    if (!e.status) console.error(e);
    if (res.headersSent) return res.end();
    const h = { 'Content-Type': 'application/json; charset=utf-8' };
    if (status === 413) h.Connection = 'close';
    send(res, status, JSON.stringify({ error: e.status ? e.message : 'internal error' }), h);
  }
}

export function start(port, host = '127.0.0.1') {
  const server = http.createServer(handle);
  server.on('connection', s => s.setNoDelay(true));
  return server.listen(port, host);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1'; // HOST=0.0.0.0 to expose on a LAN
  start(port, host).on('listening', () => {
    console.log(`listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/ (bound to ${host}; data: ${DATA})`);
    const sync = async () => {
      const s = await sntpSync(); // not awaited at startup: offset=0 until first sync
      console.log(s.ok ? `SNTP ok: ${s.server} offset=${s.offset.toFixed(2)}ms delay=${s.delay.toFixed(2)}ms n=${s.n}` : 'WARNING: SNTP failed, using offset=0 (system clock)');
    };
    sync();
    setInterval(sync, 10 * 60 * 1000).unref();
  });
}
