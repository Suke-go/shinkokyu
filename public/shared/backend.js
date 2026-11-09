// Single seam for all storage/time I/O. MODE "server" = Node server /api; "static" = GitHub Pages
// (experiments from ../data, sessions in this browser's IndexedDB + bundled ../data/index.json).
// A third mode (supabase) would add one more branch per function.

const q = new URLSearchParams(location.search).get("backend");
export const MODE = await (async () => {
  if (q === "static" || q === "server") return q;
  try {
    const r = await fetch("/api/time", { cache: "no-store" });
    if (r.ok && Number.isFinite((await r.json()).t1)) return "server";
  } catch { /* no server */ }
  return "static";
})();
export const timeUrl = MODE === "server" ? "/api/time" : null;

const data = (p) => new URL("../data/" + p, import.meta.url);
const OK = { ok: true, status: 200 };
const post = async (path, body) => {
  const r = await fetch("/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status };
};
const getJson = async (url) => {
  const r = await fetch(url, { cache: "no-store" });
  return r.ok ? r.json() : null;
};

/* ---------- IndexedDB (static mode) ---------- */
let dbP;
const db = () => dbP || (dbP = new Promise((res, rej) => {
  const o = indexedDB.open("shinkokyu", 1);
  o.onupgradeneeded = () => {
    o.result.createObjectStore("sessions", { keyPath: "sessionId" });
    o.result.createObjectStore("events", { keyPath: ["sessionId", "seq"] });
  };
  o.onsuccess = () => res(o.result);
  o.onerror = () => rej(o.error);
}));
const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
// run fn(stores...) in one transaction; resolves once it commits (data durable)
async function tx(names, mode, fn) {
  const t = (await db()).transaction(names, mode);
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); });
  const out = await fn(...names.map((n) => t.objectStore(n)));
  await done;
  return out;
}
const upd = (id, fn) => tx(["sessions"], "readwrite", async (s) => {
  const meta = await rq(s.get(id));
  if (!meta) throw new Error("no such session");
  fn(meta);
  s.put(meta);
});
const safe = async (p) => { try { await p; return OK; } catch { return { ok: false, status: 500 }; } };

const pad = (n) => String(n).padStart(2, "0");
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

/* ---------- API ---------- */
export async function getExperiment(expId) {
  if (MODE === "server") {
    const r = await fetch("/api/experiments/" + encodeURIComponent(expId), { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }
  const all = await getJson(data("experiments.json"));
  if (!all) throw new Error("experiments.json");
  return Object.hasOwn(all, expId) ? { expId, ...all[expId] } : null;
}

export async function createSession(expId, participantId) {
  if (MODE === "server") {
    const r = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expId, participantId }) });
    if (!r.ok) throw new Error(r.status);
    return (await r.json()).sessionId;
  }
  const exp = await getExperiment(expId);
  if (!exp) throw new Error("unknown experiment");
  const createdAt = Date.now(), base = `${expId}_${participantId}_${stamp(createdAt)}`;
  return tx(["sessions"], "readwrite", async (s) => {
    let sessionId = base;
    for (let i = 2; await rq(s.getKey(sessionId)) !== undefined; i++) sessionId = `${base}-${i}`;
    s.put({
      sessionId, expId, participantId, createdAt, startedAt: null, endedAt: null, sourceText: exp.text, finalText: null,
      userAgent: navigator.userAgent, serverSntp: null, syncs: [], eventCount: 0, batches: [],
    });
    return sessionId;
  });
}

export async function postSync(sessionId, sync) {
  if (MODE === "server") return post(`/sessions/${sessionId}/sync`, sync);
  return safe(upd(sessionId, (m) => m.syncs.push(sync)));
}

export async function postEvents(sessionId, seq, events) {
  if (MODE === "server") return post(`/sessions/${sessionId}/events`, { seq, events });
  return safe(tx(["sessions", "events"], "readwrite", async (s, e) => {
    const meta = await rq(s.get(sessionId));
    if (!meta) throw new Error("no such session");
    if (meta.batches.includes(seq)) return; // idempotent resend
    e.put({ sessionId, seq, events });
    meta.batches.push(seq);
    meta.eventCount += events.length;
    if (meta.startedAt == null && events.some((x) => x.type === "session_start")) meta.startedAt = Date.now();
    s.put(meta);
  }));
}

export async function finish(sessionId, { finalText, endedAt }) {
  if (MODE === "server") return post(`/sessions/${sessionId}/finish`, { finalText, endedAt });
  return safe(upd(sessionId, (m) => { m.finalText = finalText; m.endedAt = Date.now(); m.clientEndedAt = Number.isFinite(endedAt) ? endedAt : null; }));
}

const brief = (m, source) =>
  ({ sessionId: m.sessionId, expId: m.expId, participantId: m.participantId, startedAt: m.startedAt, endedAt: m.endedAt, eventCount: m.eventCount, source });

export async function listSessions() {
  if (MODE === "server") {
    const r = await fetch("/api/sessions", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    return (await r.json()).map((x) => ({ ...x, source: "server" }));
  }
  const out = [], seen = new Set();
  try {
    for (const m of await tx(["sessions"], "readonly", (s) => rq(s.getAll()))) {
      out.push({ ...brief(m, "local"), _c: m.createdAt || 0 });
      seen.add(m.sessionId);
    }
  } catch { /* IndexedDB unavailable */ }
  try {
    for (const x of (await getJson(data("index.json"))) || []) {
      if (!seen.has(x.sessionId)) out.push({ ...x, source: "bundled", _c: x.startedAt || 0 });
    }
  } catch { /* no bundled index */ }
  out.sort((a, b) => b._c - a._c);
  return out.map(({ _c, ...x }) => x);
}

export async function getSession(id) {
  if (MODE === "server") {
    const r = await fetch("/api/sessions/" + encodeURIComponent(id), { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }
  try {
    const got = await tx(["sessions", "events"], "readonly", async (s, e) => {
      const meta = await rq(s.get(id));
      if (!meta) return null;
      return { meta, rows: await rq(e.getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))) };
    });
    if (got) return { meta: got.meta, events: got.rows.flatMap((r) => r.events) };
  } catch { /* fall through to bundled */ }
  const meta = await getJson(data(encodeURIComponent(id) + ".json"));
  if (!meta) return null;
  const r = await fetch(data(encodeURIComponent(id) + ".events.jsonl"), { cache: "no-store" });
  const events = [], seqs = new Set();
  for (const l of r.ok ? (await r.text()).split("\n") : []) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e && Number.isInteger(e.seq)) { if (seqs.has(e.seq)) continue; seqs.add(e.seq); }
    events.push(e);
  }
  return { meta, events };
}
