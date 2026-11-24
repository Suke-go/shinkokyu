import { syncClock } from "../shared/clock.js";
import * as be from "../shared/backend.js";

const $ = (id) => document.getElementById(id);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (id) => {
  for (const s of ["s-login", "s-ready", "s-task", "s-done"]) $(s).hidden = s !== id;
};

let exp = null, sessionId = null, pid = "", active = false;
const ta = $("ed");

/* ---------- event logging (SPEC §4) ---------- */
let seq = 0, buf = [], batchNo = 0;

function log(type, e, data = null) {
  const key = e && e instanceof KeyboardEvent;
  const t = performance.timeOrigin + (e ? e.timeStamp : performance.now());
  // caret/selLen are read synchronously in the handler: for keydown this is the state *before* the key applies.
  buf.push({
    t, seq: seq++, type,
    key: key ? e.key : null, code: key ? e.code : null,
    isComposing: !!(e && e.isComposing && (key || e instanceof InputEvent)),
    repeat: key ? e.repeat : null,
    inputType: e instanceof InputEvent ? e.inputType : null,
    data,
    len: [...ta.value].length, caret: ta.selectionStart, selLen: ta.selectionEnd - ta.selectionStart,
  });
}
let composing = false;
ta.addEventListener("compositionstart", () => { composing = true; }, true);
ta.addEventListener("compositionend", () => { composing = false; }, true);
const snapshot = (type = "snapshot") => {
  log(type, null, ta.value);
  if (type === "snapshot") buf[buf.length - 1].isComposing = composing; // dashboard skips composing snapshots
};

/* ---------- radar: only inside the desktop app (radar/app) ----------
   Heart/breathing estimates join this event log, so they share this page's clock, sync and upload. */
const tauri = window.__TAURI__;
const radar = (cmd, args) => { if (tauri) tauri.core.invoke(cmd, { session: sessionId, ...args }).catch(() => {}); };
// The app also keeps the session on this PC (meta + events, the typing server's file format), whatever the upload does.
let localMeta = null, localDir = "";
const saveLocal = (name, text, append) => {
  if (tauri && sessionId) tauri.core.invoke("save_typing", { session: sessionId, name, text, append }).then((dir) => { localDir = dir; }, () => {});
};
const saveLocalMeta = (patch) => {
  if (!localMeta) return;
  Object.assign(localMeta, patch);
  saveLocal("json", JSON.stringify(localMeta), false);
};
const pageNow = () => performance.timeOrigin + performance.now();
let recording = false; // the radar's estimates are being logged: from the start button to the end of the task
const task = { breaths: [], t0: 0 }; // the breaths counted while the task runs, for the line the experimenter reads at the end
const median = (v) => { const a = [...v].sort((x, y) => x - y); return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : null; };
if (tauri) {
  const bars = $("st-radar");
  const setBars = (q, title) => { bars.dataset.q = q; bars.title = title; };
  bars.hidden = $("ready-radar").hidden = false;
  let lastBreath = 0;
  tauri.event.listen("estimate", ({ payload: r }) => {
    if (!recording) return;
    log("vital", null, JSON.stringify({
      quality: r.quality, present: r.present, snr: r.snr_db, range: r.br_range_m,
      br: r.br_bpm, period: r.br_period_s, depth: r.br_depth_mm, regular: r.br_q, moving: r.br_moving,
      hr: r.hr_bpm, q: r.hr_q,
    }));
    buf[buf.length - 1].t = r.t; // the moment the estimate is for, already on this page's clock
    for (const b of r.breaths) { // each breath once, stamped with the moment it ended
      if (b.t <= lastBreath + 1000) continue;
      lastBreath = b.t;
      if (active) task.breaths.push(b);
      log("breath", null, JSON.stringify({ period: b.period_s, depth: b.depth_mm }));
      buf[buf.length - 1].t = b.t;
    }
    // 0 nothing reflects, 1 something does, 2 a person who breathes, 3 breaths cut steadily
    setBars(r.quality, ["何も映っていない", "呼吸の動きが見えない", "呼吸は見えているが、体が動いているか、まだ少ない", "安定して数えられている"][r.quality] || "");
  });
  tauri.event.listen("status", () => setBars(0, "レーダーに接続中")); // connecting or reconnecting
  window.addEventListener("pagehide", () => { if (sessionId) radar("stop"); });
}

/* ---------- command suppression: the task is typing characters only ---------- */
const IME_KEYS = new Set(["Process", "Convert", "NonConvert", "KanaMode", "Hankaku", "Zenkaku", "HankakuZenkaku", "Alphanumeric", "Romaji", "Hiragana", "Katakana", "Eisu"]);
const EDIT_KEYS = new Set(["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
function blockedInEditor(e) {
  if (e.isComposing || IME_KEYS.has(e.key) || e.keyCode === 229) return false;
  if (e.key === "Tab" || /^F([1-9]|1[0-2])$/.test(e.key)) return true;
  if (!(e.ctrlKey || e.metaKey || e.altKey)) return false;
  if (e.code === "Space" || e.code === "Backquote") return false; // IME toggles
  if (EDIT_KEYS.has(e.key)) return false;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && ["z", "y"].includes(e.key.toLowerCase())) return false;
  return true;
}
ta.addEventListener("keydown", (e) => {
  const b = blockedInEditor(e);
  if (b) e.preventDefault();
  log("keydown", e);
  if (b) buf[buf.length - 1].blocked = true;
}, true);
ta.addEventListener("keyup", (e) => log("keyup", e), true);
// Backstop while the task is on screen, even if focus is outside the editor.
// Ctrl+W/T/N cannot be blocked by browsers; fullscreen helps.
document.addEventListener("keydown", (e) => {
  if (!active || e.target === ta || e.isComposing) return;
  const k = e.key.toLowerCase(), cm = e.ctrlKey || e.metaKey;
  if ((cm && "spfghorujld".includes(k) && k.length === 1) || ["F5", "F3", "F7", "F12"].includes(e.key) ||
      (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"))) e.preventDefault();
}, true);
ta.addEventListener("input", (e) => {
  log("input", e, e.data);
  if (e.inputType && e.inputType.startsWith("history")) { snapshot(); } // undo/redo: let replay resync
}, true);
for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
  ta.addEventListener(type, (e) => log(type, e, e.data), true);
}
ta.addEventListener("paste", (e) => {
  e.preventDefault();
  log("paste", e, e.clipboardData ? e.clipboardData.getData("text") : null);
}, true);
ta.addEventListener("drop", (e) => e.preventDefault(), true);
ta.addEventListener("focus", (e) => log("focus", e), true);
ta.addEventListener("blur", (e) => log("blur", e), true);

/* ---------- batching: memory is the source of truth, localStorage is a best-effort mirror ---------- */
const mem = {};  // sid -> pending batches
const dead = {}; // sid -> batches the server permanently rejected (4xx)
const draining = new Set();
const backoff = {};
const list = (m, sid) => m[sid] || (m[sid] = []);
function mirror(prefix, m, sid) {
  try {
    if (m[sid] && m[sid].length) localStorage.setItem(prefix + sid, JSON.stringify(m[sid]));
    else localStorage.removeItem(prefix + sid);
  } catch { /* blocked/quota: memory copy still drives sending */ }
}
const pendingCount = (sid) => list(mem, sid).length;

async function drain(sid) {
  if (draining.has(sid)) return;
  draining.add(sid);
  try {
    for (;;) {
      const q = list(mem, sid);
      if (!q.length) { backoff[sid] = 1000; return; }
      const head = q[0];
      let status = 0;
      try { status = (await be.postEvents(sid, head.seq, head.events)).status; } catch { /* offline */ }
      if (status >= 200 && status < 300) {
        q.shift(); mirror("pending:", mem, sid); backoff[sid] = 1000;
      } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        list(dead, sid).push(q.shift()); mirror("dead:", dead, sid); mirror("pending:", mem, sid);
      } else {
        const d = backoff[sid] || 1000;
        backoff[sid] = Math.min(d * 2, 30000);
        await sleep(d);
      }
    }
  } finally { draining.delete(sid); }
}

function flush() {
  if (!sessionId) return;
  if (buf.length) {
    saveLocal("events.jsonl", buf.map((e) => JSON.stringify(e)).join("\n") + "\n", true);
    list(mem, sessionId).push({ seq: batchNo++, events: buf });
    buf = [];
    mirror("pending:", mem, sessionId);
  }
  drain(sessionId);
}
setInterval(flush, 1000);
setInterval(() => { if (active) snapshot(); }, 5000);
window.addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

// Recovery of leftovers from an earlier page load; only sessions no other tab is holding.
try {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("pending:")) continue;
    const sid = k.slice(8);
    const run = async (lock) => {
      if (!lock) return;
      try { mem[sid] = JSON.parse(localStorage.getItem(k)) || []; } catch { return; }
      await drain(sid);
    };
    if (navigator.locks) navigator.locks.request("session:" + sid, { ifAvailable: true }, run);
    else run(true);
  }
} catch { /* ignore */ }

// POST that must not be lost (sync results): retry until 2xx.
async function postRetry(sync, tries = 20) {
  if (localMeta) saveLocalMeta({ syncs: [...localMeta.syncs, sync] });
  for (let i = 0; i < tries; i++) {
    try { if ((await be.postSync(sessionId, sync)).ok) return true; } catch { /* retry */ }
    await sleep(1000);
  }
  return false;
}

window.addEventListener("beforeunload", (e) => {
  const pending = sessionId && (pendingCount(sessionId) || buf.length);
  if (active || recording || pending) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------- screens ---------- */
const form = $("login-form");
try { $("expId").value = localStorage.getItem("lastExpId") || ""; } catch { /* ignore */ }
{ const q = new URLSearchParams(location.search).get("exp"); if (q) $("expId").value = q; } // shareable ?exp=<id>

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const expId = $("expId").value.trim(), p = $("pid").value.trim();
  const err = $("login-err");
  err.textContent = "";
  if (!ID_RE.test(expId)) return fail("実験IDは英数字・「-」「_」のみ（64文字まで）で入力してください", "expId");
  if (!ID_RE.test(p)) return fail("参加者IDは英数字・「-」「_」のみ（64文字まで）で入力してください", "pid");
  $("login-btn").disabled = true;
  try {
    exp = await be.getExperiment(expId);
    if (!exp) return fail("実験IDが見つかりません", "expId");
    sessionId = await be.createSession(expId, p);
    if (tauri) {
      localMeta = { sessionId, expId, participantId: p, createdAt: pageNow(), startedAt: null, endedAt: null, sourceText: exp.text, finalText: null, userAgent: navigator.userAgent, backend: be.MODE, syncs: [] };
      saveLocalMeta({});
    }
    // hold the session lock for the page lifetime so other tabs' recovery never drains our queue
    if (navigator.locks) navigator.locks.request("session:" + sessionId, () => new Promise(() => {}));
    pid = p;
    try { localStorage.setItem("lastExpId", expId); } catch { /* ignore */ }
    $("ready-title").textContent = exp.title;
    show("s-ready");
    $("start-btn").focus();
  } catch {
    fail("サーバーに接続できませんでした。もう一度お試しください");
  } finally { $("login-btn").disabled = false; }

  function fail(msg, focusId) {
    err.textContent = msg;
    $("login-btn").disabled = false;
    if (focusId) $(focusId).focus();
  }
});

const fsOn = () => !!document.fullscreenElement;
const toggleFs = () => {
  const p = fsOn() ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  p && p.catch(() => {});
};
$("fs-btn").addEventListener("click", toggleFs);

function setDot(quality, s) {
  const d = $("st-dot");
  d.className = "dot " + (quality === "good" ? "good" : "bad");
  d.title = `時刻同期: ${quality === "good" ? "良好" : "精度低"}（往復遅延 ${s.delay.toFixed(1)} ms）`;
}
const qualityText = (s) =>
  `同期完了（${s.quality === "good" ? "良好" : "精度低"} / 遅延 ${s.delay.toFixed(1)} ms）`;

$("start-btn").addEventListener("click", async () => {
  const btn = $("start-btn"), line = $("sync-line");
  btn.disabled = true;
  try { await document.documentElement.requestFullscreen(); } catch { /* ignore */ }
  if (!be.timeUrl && !be.timeSource) {
    line.textContent = "時刻同期なし（静的版）";
    $("st-dot").className = "dot bad"; // amber
    $("st-dot").title = "時刻同期なし（静的版）";
  } else try {
    const s = await syncClock({
      phase: "start", url: be.timeUrl, ...be.timeSource,
      onProgress: (i, n, round) => { line.textContent = `時刻を同期しています ${i} / ${n}${round > 1 ? `（${round} 回目）` : ""}`; },
    });
    line.textContent = qualityText(s);
    postRetry(s);
    setDot(s.quality, s);
  } catch {
    $("ready-err").textContent = "時刻同期に失敗しました。続行します";
    $("st-dot").className = "dot bad";
  }
  recording = true;
  radar("start", { pageNow: pageNow() });
  $("doc-title").textContent = exp.title;
  $("doc-pid").textContent = "参加者 " + pid;
  $("src").textContent = exp.text;
  $("st-lang").textContent = exp.lang || "";
  show("s-task");
  active = true;
  updateCount();
  snapshot("session_start");
  saveLocalMeta({ startedAt: (task.t0 = pageNow()) });
  if (exp.limitMin > 0) setTimeout(() => finish(true), exp.limitMin * 60000); // the task ends by itself after this long
  ta.focus();
});

const updateCount = () => {
  $("st-count").textContent = `文字数 ${[...ta.value].length} / ${[...exp.text].length}`;
};
ta.addEventListener("input", updateCount);

const src = $("src");
for (const t of ["copy", "cut", "contextmenu", "selectstart", "dragstart"]) {
  src.addEventListener(t, (e) => e.preventDefault());
}

$("finish-btn").addEventListener("click", () => { $("confirm").hidden = false; $("back-btn").focus(); });
$("back-btn").addEventListener("click", () => { $("confirm").hidden = true; ta.focus(); });

$("end-btn").addEventListener("click", () => finish(false));
async function finish(timeUp) {
  if (!active) return; // already finishing: the limit and the button can both fire
  if (timeUp) {
    $("confirm-h").textContent = "時間になりました";
    $("confirm").hidden = false;
  }
  const line = $("end-line");
  $("end-btn").disabled = $("back-btn").disabled = true;
  const finalText = ta.value;
  snapshot();
  snapshot("session_end");
  active = recording = false;
  radar("stop");
  if (tauri) { // for the experimenter: how much of each part was inside a counted breath (sessions.csv: rest_counted, task_counted)
    const part = (name, seconds, breaths) => seconds > 0 ? `${name} ${Math.round(100 * Math.min(breaths.reduce((s, b) => s + b.period_s, 0) / seconds, 1))}%（${breaths.length} 回${breaths.length ? `、1 呼吸 ${median(breaths.map((b) => b.period_s)).toFixed(1)} 秒` : ""}）` : "";
    $("done-radar").textContent = "呼吸を数えられた時間: " + part("課題", (pageNow() - task.t0) / 1000, task.breaths);
  }
  line.textContent = "データを送信しています…";
  flush();
  saveLocalMeta({ finalText, endedAt: pageNow() });
  if (be.timeUrl || be.timeSource) try {
    const s = await syncClock({ phase: "end", url: be.timeUrl, ...be.timeSource });
    await postRetry(s);
  } catch { /* end sync is best effort */ }
  const endedAt = Date.now();
  const deadline = Date.now() + 60000;
  let fin = false;
  while (!fin && Date.now() < deadline) {
    try { fin = (await be.finish(sessionId, { finalText, endedAt })).ok; } catch { /* retry */ }
    if (!fin) await sleep(2000);
  }
  flush();
  while ((pendingCount(sessionId) || draining.has(sessionId)) && Date.now() < deadline) { await sleep(300); flush(); }
  if (!fin || pendingCount(sessionId) || list(dead, sessionId).length) {
    line.textContent = `送信できなかったデータがあります。実験者に連絡してください。(${sessionId})`;
    return;
  }
  if (fsOn()) document.exitFullscreen().catch(() => {});
  $("done-id").textContent = sessionId + (localDir ? `\nこの PC の保存先: ${localDir}` : "");
  if (be.MODE === "static" && !tauri) {
    $("dl-btn").hidden = false;
    await download();
  }
  show("s-done");
}

async function download() {
  try {
    const d = await be.getSession(sessionId);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d)], { type: "application/json" }));
    a.download = sessionId + ".json";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch { /* the record stays in IndexedDB; the button retries */ }
}
$("dl-btn").addEventListener("click", download);
