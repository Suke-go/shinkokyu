import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shinkokyu-test-'));
process.env.DATA_DIR = dir; // must be set before server.js loads
const { start } = await import('./server.js');
const { parsePacket, sntpOnce } =await import('./sntp.js');

// --- SNTP packet parse (no network) ---
{
  const NTP = 2208988800;
  const put = (b, o, ms) => { const s = Math.floor(ms / 1000); b.writeUInt32BE(s + NTP, o); b.writeUInt32BE(Math.floor((ms / 1000 - s) * 2 ** 32), o + 4); };
  const s = 123456, f = 789;
  const mk = () => {
    const b = Buffer.alloc(48);
    b[0] = 0x24; b[1] = 2; // LI=0 VN=4 mode=4, stratum 2
    b.writeUInt32BE(s, 24); b.writeUInt32BE(f, 28);
    put(b, 32, 1731139200500); put(b, 40, 1731139200750);
    return b;
  };
  const r = parsePacket(mk(), s, f);
  assert.equal(r.stratum, 2);
  assert.ok(Math.abs(r.T2 - 1731139200500) < 0.01 && Math.abs(r.T3 - 1731139200750) < 0.01);
  const tweak = fn => { const b = mk(); fn(b); return b; };
  assert.throws(() => parsePacket(mk(), s, f + 1), /originate/);
  assert.throws(() => parsePacket(tweak(b => (b[0] = 0x23)), s, f), /server mode/);
  assert.throws(() => parsePacket(tweak(b => (b[1] = 0)), s, f), /stratum/);
  assert.throws(() => parsePacket(tweak(b => (b[0] = 0xe4)), s, f), /LI=3/);
  assert.throws(() => parsePacket(mk().subarray(0, 40), s, f), /short/);
}

const server = start(0);
await new Promise(r => server.once('listening', r));
const port = server.address().port;

const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
    const c = [];
    res.on('data', d => c.push(d));
    res.on('end', () => {
      const text = Buffer.concat(c).toString();
      let j; try { j = JSON.parse(text); } catch {}
      resolve({ status: res.statusCode, headers: res.headers, text, json: j });
    });
  });
  req.on('error', reject);
  if (body !== undefined && body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
});

try {
  // time / clock
  let r = await call('GET', '/api/time');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(typeof r.json.t1 === 'number' && typeof r.json.t2 === 'number' && r.json.t1 <= r.json.t2);
  r = await call('GET', '/api/server-clock');
  assert.equal(typeof r.json.sntp.ok, 'boolean');

  // experiments
  r = await call('GET', '/api/experiments/demo-ja');
  assert.equal(r.status, 200);
  assert.equal(r.json.lang, 'ja');
  assert.ok(r.json.text.length > 200);
  assert.equal((await call('GET', '/api/experiments/nope')).status, 404);
  assert.equal((await call('GET', '/api/experiments/a%20b')).status, 400);

  // session lifecycle
  assert.equal((await call('POST', '/api/sessions', { expId: 'demo-ja', participantId: 'a/b' })).status, 400);
  assert.equal((await call('POST', '/api/sessions', { expId: '../x', participantId: 'p1' })).status, 400);
  assert.equal((await call('POST', '/api/sessions', 'not json')).status, 400);
  assert.equal((await call('POST', '/api/sessions', { expId: 'nope', participantId: 'p1' })).status, 404);
  r = await call('POST', '/api/sessions', { expId: 'demo-ja', participantId: 'p1' });
  assert.equal(r.status, 200);
  const id = r.json.sessionId;
  assert.match(id, /^demo-ja_p1_\d{8}-\d{6}$/);

  assert.equal((await call('POST', `/api/sessions/${id}/sync`, { offset: 'x' })).status, 400);
  assert.equal((await call('POST', `/api/sessions/${id}/sync`, { phase: 'start', offset: 1.5, delay: 0.4 })).status, 200);

  const b0 = { seq: 0, events: [{ t: 1, seq: 0, type: 'session_start' }, { t: 2, seq: 1, type: 'keydown' }] };
  const b1 = { seq: 1, events: [{ t: 3, seq: 2, type: 'input' }] };
  assert.deepEqual((await call('POST', `/api/sessions/${id}/events`, b0)).json, { ok: true, seq: 0 });
  assert.deepEqual((await call('POST', `/api/sessions/${id}/events`, b0)).json, { ok: true, seq: 0 }); // resend
  assert.deepEqual((await call('POST', `/api/sessions/${id}/events`, b1)).json, { ok: true, seq: 1 });
  assert.equal((await call('POST', `/api/sessions/${id}/events`, { seq: 2, events: 'x' })).status, 400);
  assert.equal((await call('POST', `/api/sessions/nosuch_p_1/events`, b0)).status, 404);

  assert.equal((await call('POST', `/api/sessions/${id}/finish`, { finalText: 'hello', endedAt: 12345 })).status, 200);

  r = await call('GET', `/api/sessions/${id}`);
  assert.equal(r.status, 200);
  const { meta, events } = r.json;
  assert.equal(typeof meta.startedAt, 'number');
  assert.equal(typeof meta.endedAt, 'number');
  assert.ok(meta.endedAt >= meta.startedAt);
  assert.equal(meta.finalText, 'hello');
  assert.equal(meta.clientEndedAt, 12345);
  assert.equal(meta.eventCount, 3);
  assert.deepEqual(meta.batches, [0, 1]);
  assert.equal(meta.syncs.length, 1);
  assert.ok(meta.sourceText.length > 0);
  assert.deepEqual(events.map(e => e.seq), [0, 1, 2]);

  r = await call('GET', '/api/sessions');
  assert.equal(r.status, 200);
  const row = r.json.find(s => s.sessionId === id);
  assert.ok(row && row.expId === 'demo-ja' && row.participantId === 'p1' && row.eventCount === 3 && row.endedAt);

  // invalid / traversal
  assert.equal((await call('GET', '/api/sessions/bad%20id')).status, 400);
  assert.equal((await call('GET', '/api/sessions/..%2f..%2fserver/')).status, 400);
  assert.equal((await call('GET', '/api/sessions/..%2f..%2fserver')).status, 400);
  assert.equal((await call('GET', '/api/sessions/nosuch_p_1')).status, 404);
  for (const p of ['/../server/server.js', '/..%2fserver%2fserver.js', '/%2e%2e/server/server.js', '/..\\server\\server.js', '/experiment/../../server/server.js']) {
    r = await call('GET', p);
    assert.ok(r.status >= 400 && !r.text.includes('createServer'), `${p} -> ${r.status}`);
  }

  // crash-damaged JSONL: partial last line, then a new batch; duplicate seq; corrupt line skipped
  r = await call('POST', '/api/sessions', { expId: 'demo-en', participantId: 'p2' });
  const id2 = r.json.sessionId;
  await fs.writeFile(path.join(dir, id2 + '.events.jsonl'), '{"t":1,"seq":0,"type":"a"}\n{"t":2,"seq":1,"ty');
  await call('POST', `/api/sessions/${id2}/events`, { seq: 0, events: [{ t: 3, seq: 2, type: 'b' }, { t: 4, seq: 0, type: 'dup' }] });
  r = await call('GET', `/api/sessions/${id2}`);
  assert.deepEqual(r.json.events.map(e => e.seq), [0, 2]);
  assert.equal(r.json.events[0].type, 'a');

  // externally made session without eventCount: falls back to counting lines
  await fs.writeFile(path.join(dir, 'ext_p_1.json'), JSON.stringify({ sessionId: 'ext_p_1', expId: 'demo-en', participantId: 'p', createdAt: 1 }));
  await fs.writeFile(path.join(dir, 'ext_p_1.events.jsonl'), '{"seq":0}\n{"seq":1}\n');
  r = await call('GET', '/api/sessions');
  assert.equal(r.json.find(s => s.sessionId === 'ext_p_1').eventCount, 2);

  // sntpOnce must reject (not crash) on an unresolvable host, even after the timeout already fired
  await assert.rejects(sntpOnce('nonexistent.invalid', 1));
  await assert.rejects(sntpOnce('nonexistent.invalid', 3000));
  await new Promise(r => setTimeout(r, 50));

  // open redirect
  for (const p of ['//experiment', '///experiment', '/\\experiment']) {
    r = await call('GET', p);
    // POSIX treats "\" as a filename char → 404 (no redirect at all); Windows redirects. Either way never to "//host".
    if (r.status === 404) assert.equal(r.headers.location, undefined, p);
    else assert.equal(r.headers.location, '/experiment/', p);
  }

  // body limit (declared length is checked before reading)
  r = await call('POST', '/api/sessions', null, { 'Content-Length': String(6 * 1024 * 1024) });
  assert.equal(r.status, 413);

  // static + redirects
  r = await call('GET', '/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/experiment/');
  r = await call('GET', '/experiment');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/experiment/');
  assert.equal((await call('GET', '/nonexistent.js')).status, 404);

  console.log('all tests passed');
} finally {
  server.closeAllConnections();
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
}
