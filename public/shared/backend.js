// Single seam for all storage/time I/O. MODE "server" = Node server /api; "static" = GitHub Pages
// (experiments from ../data, sessions in this browser's IndexedDB + bundled ../data/index.json).
// "supabase" = Supabase PostgREST (plain fetch, see supabase/schema.sql); chosen when config.js has a url and no /api server answers.
import { SUPABASE } from "./config.js";

const params = new URLSearchParams(location.search);
const q = params.get("backend");
const local = ["localhost", "127.0.0.1"].includes(location.hostname);
const SB_URL = ((local && params.get("sburl")) || SUPABASE.url || "").replace(/\/+$/, ""); // ?sburl= is a localhost-only dev override
export const MODE = await (async () => {
  if (q === "static" || q === "server" || (q === "supabase" && SB_URL)) return q;
  try {
    const r = await fetch("/api/time", { cache: "no-store" });
    if (r.ok && Number.isFinite((await r.json()).t1)) return "server";
  } catch { /* no server */ }
  return SB_URL ? "supabase" : "static";
})();
export const timeUrl = MODE === "server" ? "/api/time" : null;

/* ---------- Supabase (PostgREST) ---------- */
// Per https://supabase.com/docs/guides/api/api-keys: sb_publishable_ keys are not JWTs and go in the `apikey`
// header only, "not on Authorization: Bearer" (anything verifying them as a JWT fails). So no Authorization header.
const sbHeaders = (extra) => ({ apikey: SUPABASE.key, "Content-Type": "application/json", ...extra });
const sb = (path, { method = "GET", body, prefer } = {}) =>
  fetch(SB_URL + "/rest/v1" + path, {
    method, cache: "no-store", headers: sbHeaders(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const sbTime = async () => {
  const r = await sb("/rpc/server_time", { method: "POST", body: {} });
  if (!r.ok) throw new Error("server_time " + r.status);
  return Number(await r.json());
};
const st = (r) => ({ ok: r.ok, status: r.status });
const eq = (v) => "eq." + encodeURIComponent(v);
// supabase mode: syncClock gets its samples from the rpc (t1=t2: no server-side processing time to subtract)
export const timeSource = MODE === "supabase"
  ? { fetchTime: async () => { const n = await sbTime(); return { t1: n, t2: n }; }, goodDelay: 300, goodSpread: 20 }
  : null;

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
  const all = await getJson(data("experiments.json")); // static + supabase: experiments live in the repo
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
  if (MODE === "supabase") {
    const base = `${expId}_${participantId}_${stamp(Date.now())}`;
    for (let i = 1; i < 50; i++) {
      const sessionId = i === 1 ? base : `${base}-${i}`;
      const r = await sb("/sessions", {
        method: "POST", prefer: "return=minimal",
        body: { session_id: sessionId, exp_id: expId, participant_id: participantId, source_text: exp.text, user_agent: navigator.userAgent },
      });
      if (r.ok) return sessionId;
      if (r.status !== 409) throw new Error(r.status);
    }
    throw new Error("session id collision");
  }
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
  if (MODE === "supabase") return st(await sb("/syncs", { method: "POST", prefer: "return=minimal", body: { session_id: sessionId, phase: sync.phase ?? null, data: sync } }));
  return safe(upd(sessionId, (m) => m.syncs.push(sync)));
}

export async function postEvents(sessionId, seq, events) {
  if (MODE === "server") return post(`/sessions/${sessionId}/events`, { seq, events });
  if (MODE === "supabase") {
    // ignore-duplicates makes a re-sent batch a no-op (idempotent); the whole call is safe to retry
    const r = await sb("/events", {
      method: "POST", prefer: "resolution=ignore-duplicates,return=minimal",
      body: events.map((ev) => ({ session_id: sessionId, seq: ev.seq, batch: seq, ev })),
    });
    if (!r.ok || !events.some((x) => x.type === "session_start")) return st(r);
    return st(await sb(`/sessions?session_id=${eq(sessionId)}&started_at=is.null`, { method: "PATCH", prefer: "return=minimal", body: { started_at: await sbTime() } }));
  }
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
  if (MODE === "supabase") {
    return st(await sb(`/sessions?session_id=${eq(sessionId)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: { ended_at: await sbTime(), client_ended_at: Number.isFinite(endedAt) ? endedAt : null, final_text: finalText },
    }));
  }
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
  if (MODE === "supabase") { // eventCount is null here (counting per session is too slow); getSession has the real count
    const r = await sb("/sessions?select=session_id,exp_id,participant_id,created_at,started_at,ended_at&order=created_at.desc&limit=1000");
    if (!r.ok) throw new Error(r.status);
    return (await r.json()).map((x) => ({ sessionId: x.session_id, expId: x.exp_id, participantId: x.participant_id, startedAt: x.started_at, endedAt: x.ended_at, eventCount: null, source: "supabase" }));
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
  if (MODE === "supabase") return sbGetSession(id);
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

// keyset pagination (key > last): PostgREST caps rows per request (default 1000), so loop until a page comes back empty
async function sbPaged(base, key) {
  const rows = [];
  for (let last = -1; ;) {
    const r = await sb(`${base}&${key}=gt.${last}&order=${key}.asc&limit=1000`);
    if (!r.ok) throw new Error(r.status);
    const page = await r.json();
    if (!page.length) return rows;
    rows.push(...page);
    last = page[page.length - 1][key];
  }
}
async function sbGetSession(id) {
  const r = await sb(`/sessions?session_id=${eq(id)}&select=*`);
  if (!r.ok) throw new Error(r.status);
  const m = (await r.json())[0];
  if (!m) return null;
  const [syncs, rows] = await Promise.all([
    sbPaged(`/syncs?session_id=${eq(id)}&select=id,data`, "id"),
    sbPaged(`/events?session_id=${eq(id)}&select=seq,batch,recv_at,ev`, "seq"),
  ]);
  const byBatch = new Map();
  for (const x of rows) {
    const b = byBatch.get(x.batch) || { seq: x.batch, recvAt: x.recv_at, lastT: null, n: 0 };
    b.recvAt = Math.min(b.recvAt, x.recv_at);
    b.n++;
    if (Number.isFinite(x.ev.t)) b.lastT = Math.max(b.lastT ?? -Infinity, x.ev.t);
    byBatch.set(x.batch, b);
  }
  const meta = {
    sessionId: m.session_id, expId: m.exp_id, participantId: m.participant_id, createdAt: Date.parse(m.created_at),
    startedAt: m.started_at, endedAt: m.ended_at, clientEndedAt: m.client_ended_at, sourceText: m.source_text, finalText: m.final_text,
    userAgent: m.user_agent, syncs: syncs.map((x) => x.data), eventCount: rows.length,
    batchRecv: [...byBatch.values()].sort((a, b) => a.seq - b.seq),
  };
  return { meta, events: rows.map((x) => x.ev) };
}
