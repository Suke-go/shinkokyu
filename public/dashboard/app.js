import { computeTimeline, makeReplayer, PARAMS } from '../shared/metrics.js';
import { makeOffsetFn } from '../shared/clock.js';
import { listSessions, getSession, MODE } from '../shared/backend.js';
import { csvRow, exportSession, SESSION_HEADER, EVENT_HEADER } from './export.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const M = { L: 52, R: 20, T: 28, B: 26, GAP: 14 };
const SPEEDS = [1, 2, 4, 8];
let S = null; // current session: { meta, events, off, tl, rp, T0, T1, t }
let G = null; // chart geometry of the last draw
let playing = false, speed = 1, lastFrame = 0, loadSeq = 0;

const mk = (tag, attrs, parent, text) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  parent?.appendChild(e);
  return e;
};
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const niceStep = (v) => { const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= v); };
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (ms) => { if (!ms) return '—'; const d = new Date(ms); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// ---------- session picker (custom listbox) ----------
const pk = { btn: $('pk-btn'), list: $('pk-list'), sessions: [], cur: -1, act: -1 };
const CHECK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5 5.5 10.5 11.5 3.5"/></svg>';

const sub = (s) => `${s.expId} · ${fmtDate(s.startedAt)}${s.source === 'file' ? ' · ファイル' : ''}`;
function pkRender() {
  pk.list.replaceChildren();
  pk.sessions.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'pk-opt'; li.id = 'pk-opt-' + i; li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', i === pk.cur);
    const d = document.createElement('div');
    const a = document.createElement('div'), b = document.createElement('div');
    a.className = 'l1'; a.textContent = s.participantId;
    b.className = 'l2'; b.textContent = sub(s);
    d.append(a, b);
    li.append(d);
    li.insertAdjacentHTML('beforeend', CHECK);
    li.onpointermove = () => pkActive(i);
    li.onclick = () => pkChoose(i);
    pk.list.append(li);
  });
  const foot = document.createElement('li');
  foot.className = 'pk-foot'; foot.setAttribute('role', 'presentation');
  foot.innerHTML = '<button type="button" tabindex="-1">ファイルを開く</button>';
  foot.firstChild.onclick = () => { pkClose(false); $('file').click(); };
  pk.list.append(foot);
}
function pkActive(i) {
  const n = pk.sessions.length;
  pk.act = Math.max(0, Math.min(n - 1, i));
  const opts = [...pk.list.querySelectorAll('.pk-opt')];
  opts.forEach((li, k) => li.classList.toggle('active', k === pk.act));
  const el = opts[pk.act];
  pk.list.setAttribute('aria-activedescendant', el.id);
  el.scrollIntoView({ block: 'nearest' });
}
function pkOpen() {
  pk.list.hidden = false;
  pk.btn.setAttribute('aria-expanded', 'true');
  pk.list.focus();
  pkActive(pk.cur);
}
function pkClose(refocus = true) {
  pk.list.hidden = true;
  pk.btn.setAttribute('aria-expanded', 'false');
  if (refocus) pk.btn.focus();
}
function pkChoose(i, seekSec) {
  pk.cur = i;
  const s = pk.sessions[i];
  $('pk-id').textContent = s.participantId;
  $('pk-sub').textContent = sub(s);
  pk.list.querySelectorAll('.pk-opt').forEach((li, k) => li.setAttribute('aria-selected', k === i));
  if (!pk.list.hidden) pkClose();
  history.replaceState(null, '', '#' + s.sessionId);
  load(s.sessionId, seekSec);
}
pk.btn.onclick = () => (pk.list.hidden ? pkOpen() : pkClose());
pk.btn.onkeydown = (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pkOpen(); } };
pk.list.onkeydown = (e) => {
  const k = e.key;
  if (k === 'ArrowDown') pkActive(pk.act + 1);
  else if (k === 'ArrowUp') pkActive(pk.act - 1);
  else if (k === 'Home') pkActive(0);
  else if (k === 'End') pkActive(pk.sessions.length - 1);
  else if (k === 'Enter' || k === ' ') pkChoose(pk.act);
  else if (k === 'Escape') pkClose();
  else if (k === 'Tab') { pkClose(false); return; } // let focus move on naturally
  else return;
  e.preventDefault();
};
document.addEventListener('pointerdown', (e) => { if (!pk.list.hidden && !$('picker').contains(e.target)) pkClose(false); });

const files = new Map(); // sessions opened from a file in this page session
const fetchSession = async (id) => files.get(id) ?? (await getSession(id));
const showEmpty = (b) => { $('main').hidden = b; $('empty').hidden = !b; };
const note = (msg) => { $('sentence').textContent = msg; $('empty-msg').textContent = msg; };

async function init() {
  const list = await listSessions();
  pk.sessions = list;
  if (!list.length) { $('empty-hint').hidden = MODE !== 'server'; showEmpty(true); return; }
  const [id, sec] = decodeURIComponent(location.hash.slice(1)).split('@');
  const i = Math.max(0, list.findIndex((s) => s.sessionId === id));
  pk.cur = i;
  pkRender();
  pkChoose(i, sec != null ? Number(sec) : undefined);
}

// <sessionId>.json containing { meta, events } (drag-drop or file picker)
function addFile(obj, name) {
  const { meta, events } = obj ?? {};
  if (!meta || !Array.isArray(events)) throw new Error('not a session file');
  const m = { ...meta, sessionId: meta.sessionId || 'file-' + name.replace(/\W+/g, '_') };
  files.set(m.sessionId, { meta: m, events });
  const row = { sessionId: m.sessionId, expId: m.expId ?? '—', participantId: m.participantId ?? name, startedAt: m.startedAt, endedAt: m.endedAt, eventCount: events.length, source: 'file' };
  pk.sessions = [row, ...pk.sessions.filter((x) => x.sessionId !== m.sessionId)];
  showEmpty(false); pkRender(); pkChoose(0);
}
async function openFiles(list) {
  for (const f of list) {
    try { addFile(JSON.parse(await f.text()), f.name); } catch { note(`${f.name} を読み込めませんでした。`); }
  }
}
$('file').onchange = (e) => { openFiles([...e.target.files]); e.target.value = ''; };
$('open-file').onclick = () => $('file').click();
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drop'); openFiles([...e.dataTransfer.files]); });

// ---------- loading ----------
async function load(id, seekSec) {
  const my = ++loadSeq;
  pause();
  try {
    const d = await fetchSession(id);
    if (!d) throw new Error('not found');
    const { meta, events } = d;
    if (my !== loadSeq) return; // picker changed meanwhile
    const off = makeOffsetFn(meta.syncs || []);
    const tl = computeTimeline(events, off, { sourceText: meta.sourceText, finalText: meta.finalText ?? undefined, finished: meta.endedAt != null && meta.finalText != null });
    let T0 = events.length ? off(events[0].t) : 0, T1 = events.length ? off(events[events.length - 1].t) : 1;
    if (tl.points.length) { T0 = Math.min(T0, tl.points[0].t); T1 = Math.max(T1, tl.points[tl.points.length - 1].t); }
    if (T1 <= T0) T1 = T0 + PARAMS.STEP; // single-point session: avoid divide by zero
    S = { meta, events, off, tl, rp: makeReplayer(events, off), T0, T1, t: T0 };
    hero(); figs();
    $('seek').max = T1 - T0;
    shown = null;
    draw();
    seek(seekSec != null && Number.isFinite(seekSec) ? T0 + seekSec * 1000 : T0);
  } catch (err) {
    if (my !== loadSeq) return;
    S = null; G = null;
    $('sentence').textContent = 'このセッションを読み込めませんでした。';
    $('figs').replaceChildren(); $('chart').replaceChildren(); $('sheet').replaceChildren();
  }
}

function hero() {
  const { tl, meta } = S, sm = tl.summary;
  $('sentence').textContent = tl.points.length
    ? [meta.participantId, meta.expId, fmt(S.T1 - S.T0), `${sm.chars}字`].join(' · ')
    : `${meta.participantId} · 入力は記録されていません`;
  // only speak up when the clock sync is not trustworthy
  const syncs = meta.syncs || [], bad = syncs.filter((s) => s.quality !== 'good'), w = $('syncwarn');
  w.hidden = syncs.length > 0 && !bad.length;
  w.title = !syncs.length ? '同期データなし（端末時計のまま）' : bad.map((s) => `${s.phase}: ${s.quality}, 遅延 ${(s.delay ?? 0).toFixed(1)}ms`).join(' / ');
}

function figs() {
  const sm = S.tl.summary;
  const f = (v, u, l) => `<div class="fig"><div class="l">${l}</div><div class="v">${v == null ? '—' : v}<small>${v == null ? '' : u}</small></div></div>`;
  $('figs').innerHTML =
    f(Math.round(sm.meanCpm), 'CPM', '速度') +
    f(sm.ikiMedianMs == null ? null : Math.round(sm.ikiMedianMs), 'ms', 'IKI 中央値') +
    f(sm.kspc?.toFixed(2), '', 'KSPC') +
    f(sm.correctionRate?.toFixed(1), '%', '訂正率') +
    f(sm.errorRate?.toFixed(1), '%', sm.errorPrefix ? '誤り率 (途中まで)' : '誤り率');
}

// ---------- chart ----------
function draw() {
  const box = $('chart'), W = box.clientWidth, H = box.clientHeight;
  if (!S || !W || !H) return;
  const { tl, T0, T1 } = S, pts = tl.points;
  box.replaceChildren();
  G = null;
  if (!pts.length) return;
  const inner = H - M.T - M.B - M.GAP, h1 = Math.round(inner * 0.6), h2 = inner - h1;
  const y1 = M.T, y2 = M.T + h1 + M.GAP, yEnd = y2 + h2, pw = W - M.L - M.R;
  const x = (t) => M.L + ((t - T0) / (T1 - T0)) * pw;

  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' }, box);
  box.setAttribute('aria-label', `タイピング速度（CPM）と停止率の時系列。左右の矢印キーで1秒ずつ移動。${$('sentence').textContent}`);
  const defs = mk('defs', {}, svg);
  for (const [id, y, h] of [['c1', y1, h1], ['c2', y2, h2]]) mk('rect', { x: M.L, y, width: pw, height: h }, mk('clipPath', { id }, defs));

  const cmax = Math.max(...pts.map((p) => p.cpm), tl.base * 1.1, 10);
  const step = niceStep(cmax / 3), top = step * Math.ceil(cmax / step);
  const ys1 = (v) => y1 + h1 - (v / top) * h1, ys2 = (v) => y2 + h2 - v * h2;
  G = { W, H, x, y1, yEnd, pw, ys1, ys2 };

  const wend = pts.filter((p) => p.warmup).pop();
  if (wend) {
    const a = x(pts[0].t), b = x(wend.t);
    if (b > a) {
      for (const [y, h] of [[y1, h1], [y2, h2]]) mk('rect', { class: 'warm', x: a, y, width: b - a, height: h }, svg);
      mk('text', { class: 'tick', x: a + 4, y: y2 + h2 - 4 }, svg, '準備');
    }
  }
  let chipEnd = -1;
  for (const s of tl.segments) {
    const a = x(s.t0), b = x(s.t1), hes = s.kind === 'hesitation';
    mk('rect', { class: hes ? 'band-hesitation' : 'band-slow', x: a, y: y1, width: b - a, height: yEnd - y1 }, svg);
    const label = `${hes ? '停止' : '低速'} ${Math.round((s.t1 - s.t0) / 1000)}s`, cw = label.length * 11 + 14;
    const cx = Math.min(Math.max((a + b) / 2 - cw / 2, M.L), M.L + pw - cw);
    if (cx > chipEnd) {
      mk('rect', { class: 'chip', x: cx, y: 4, width: cw, height: 18, rx: 9 }, svg);
      mk('text', { class: 'chip-text' + (hes ? ' h' : ''), x: cx + cw / 2, y: 16.5, 'text-anchor': 'middle' }, svg, label);
      chipEnd = cx + cw + 4;
    }
  }

  for (let v = 0; v <= top + 1e-9; v += step) {
    mk('line', { class: v ? 'grid' : 'ax', x1: M.L, x2: M.L + pw, y1: ys1(v), y2: ys1(v) }, svg);
    mk('text', { class: 'tick', x: M.L - 8, y: ys1(v) + 4, 'text-anchor': 'end' }, svg, v);
  }
  for (const v of [0, 0.5, 1]) {
    mk('line', { class: v === 0 ? 'ax' : 'grid', x1: M.L, x2: M.L + pw, y1: ys2(v), y2: ys2(v) }, svg);
    mk('text', { class: 'tick', x: M.L - 8, y: ys2(v) + 4, 'text-anchor': 'end' }, svg, v * 100 + '%');
  }
  mk('text', { class: 'lane-title', x: M.L + 8, y: y1 + 14 }, svg, '速度 CPM');
  mk('text', { class: 'lane-title', x: M.L + 8, y: y2 + 14 }, svg, '停止率');

  const lane = (clip, val, ys, ac, lc) => {
    const g = mk('g', { 'clip-path': `url(#${clip})` }, svg), base = ys(0);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${ys(p[val]).toFixed(1)}`).join('');
    mk('path', { class: ac, d: `${d}L${x(pts[pts.length - 1].t).toFixed(1)},${base}L${x(pts[0].t).toFixed(1)},${base}Z` }, g);
    mk('path', { class: lc, d }, g);
  };
  lane('c1', 'cpm', ys1, 'area-speed', 'line-speed');
  lane('c2', 'pr', ys2, 'area-pr', 'line-pr');
  if (tl.base > 0) {
    const yb = ys1(tl.base), label = `基準 ${Math.round(tl.base)} CPM`, w = label.length * 6.5 + 14;
    mk('line', { class: 'base', x1: M.L, x2: M.L + pw, y1: yb, y2: yb }, svg);
    const px = Math.min(Math.max(wend ? x(wend.t) + 8 : M.L + 8, M.L + 8), M.L + pw - w);
    mk('rect', { class: 'pill', x: px, y: yb - 9, width: w, height: 18, rx: 9 }, svg);
    mk('text', { class: 'tick', x: px + w / 2, y: yb + 4, 'text-anchor': 'middle' }, svg, label);
  }

  const spanS = (T1 - T0) / 1000;
  const st = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800].find((s) => s >= spanS / Math.max(2, pw / 90)) || 1800;
  for (let k = 0; T0 + k * st * 1000 <= T1; k++) {
    const t = T0 + k * st * 1000;
    mk('line', { class: 'ax', x1: x(t), x2: x(t), y1: yEnd, y2: yEnd + 4 }, svg);
    mk('text', { class: 'tick', x: x(t), y: yEnd + 17, 'text-anchor': 'middle' }, svg, fmt(t - T0));
  }

  // hover crosshair (values only) + playhead + hit layer
  G.cross = mk('line', { class: 'cross', y1, y2: yEnd, visibility: 'hidden', 'pointer-events': 'none' }, svg);
  const ph = mk('g', { 'pointer-events': 'none' }, svg);
  G.line = mk('line', { class: 'playhead', y1: y1 - 4, y2: yEnd }, ph);
  G.knob = mk('circle', { class: 'playknob', r: 5, cy: yEnd }, ph);
  const hit = mk('rect', { class: 'hit', x: M.L, y: 0, width: pw, height: H }, svg);
  const tOf = (e) => Math.min(T1, Math.max(T0, T0 + ((e.clientX - svg.getBoundingClientRect().left - M.L) / pw) * (T1 - T0)));
  const segAt = (t) => tl.segments.find((s) => t >= s.t0 && t <= s.t1);
  let down = null; // { x, band }
  hit.onpointerdown = (e) => {
    hit.setPointerCapture(e.pointerId);
    const s = segAt(tOf(e));
    down = { x: e.clientX, band: !!s };
    seek(s ? s.t0 : tOf(e));
    box.focus({ preventScroll: true });
  };
  hit.onpointermove = (e) => {
    const t = tOf(e);
    hit.style.cursor = segAt(t) ? 'pointer' : 'crosshair';
    if (down && (!down.band || Math.abs(e.clientX - down.x) > 4)) { down.band = false; seek(t); }
    hover(t);
  };
  hit.onpointerup = () => { down = null; };
  hit.onpointerleave = () => hover(null);
  updatePlayhead();
}

function hover(t) {
  const tip = $('tip');
  if (t == null || !G) { G?.cross.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
  const pts = S.tl.points, i = Math.round((t - pts[0].t) / PARAMS.STEP), p = pts[i];
  const cx = G.x(t);
  G.cross.setAttribute('x1', cx); G.cross.setAttribute('x2', cx); G.cross.setAttribute('visibility', 'visible');
  tip.textContent = p ? `${fmt(t - S.T0)}  ·  ${Math.round(p.cpm)} CPM  ·  停止 ${Math.round(p.pr * 100)}%` : fmt(t - S.T0);
  tip.hidden = false;
  const box = $('chart'), w = tip.offsetWidth;
  tip.style.left = box.offsetLeft + Math.min(Math.max(cx - w / 2, M.L), G.W - w - 4) + 'px';
  tip.style.top = box.offsetTop + G.y1 + 22 + 'px';
}

function updatePlayhead() {
  if (!G || !S) return;
  const x = G.x(S.t);
  G.line.setAttribute('x1', x); G.line.setAttribute('x2', x);
  G.knob.setAttribute('cx', x);
}

// ---------- replay ----------
let shown = null; // last rendered state key
function renderSheet() {
  const sheet = $('sheet'), st = S.rp.at(S.t), key = `${st.caret}|${st.comp}|${st.text}`;
  if (key === shown) return;
  shown = key;
  const keep = sheet.scrollTop;
  const caret = document.createElement('span');
  caret.className = 'caret';
  const nodes = [st.text.slice(0, st.caret)];
  if (st.comp) { const u = document.createElement('span'); u.className = 'ime'; u.textContent = st.comp; nodes.push(u); }
  nodes.push(caret, st.text.slice(st.caret));
  sheet.replaceChildren(...nodes);
  sheet.scrollTop = keep;
  const c = caret.offsetTop;
  if (c < sheet.scrollTop + 24 || c + 40 > sheet.scrollTop + sheet.clientHeight - 24) sheet.scrollTop = c - sheet.clientHeight * 0.6;
}

function updateTransport() {
  const seek = $('seek'), d = S.T1 - S.T0, v = S.t - S.T0;
  seek.value = v;
  seek.style.setProperty('--p', (d ? (100 * v) / d : 0) + '%');
  $('time').textContent = `${fmt(v)} / ${fmt(d)}`;
}

function seek(t) {
  if (!S) return;
  S.t = Math.min(S.T1, Math.max(S.T0, t));
  renderSheet(); updatePlayhead(); updateTransport();
}

const ICON = {
  play: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3.5 2v10l8-5z"/></svg>',
  pause: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="3" y="2" width="3" height="10" rx="1"/><rect x="8" y="2" width="3" height="10" rx="1"/></svg>',
};
function setPlaying(p) {
  playing = p;
  $('play').innerHTML = p ? ICON.pause : ICON.play;
  $('play').setAttribute('aria-label', p ? '一時停止' : '再生');
}
function pause() { setPlaying(false); }
function play() {
  if (!S) return;
  if (S.t >= S.T1) seek(S.T0);
  setPlaying(true);
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}
function frame(now) {
  if (!playing || !S) return;
  const dt = Math.min(now - lastFrame, 250);
  lastFrame = now;
  seek(S.t + dt * speed);
  if (S.t >= S.T1) pause(); else requestAnimationFrame(frame);
}

for (const sp of SPEEDS) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = sp + '×';
  b.setAttribute('aria-pressed', sp === speed);
  b.onclick = () => { speed = sp; [...$('speeds').children].forEach((c, i) => c.setAttribute('aria-pressed', SPEEDS[i] === sp)); };
  $('speeds').append(b);
}
setPlaying(false);
$('play').onclick = () => (playing ? pause() : play());
$('seek').oninput = (e) => { if (S) seek(S.T0 + Number(e.target.value)); };
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.target.closest('button, #pk-list')) return;
  e.preventDefault();
  if (!e.repeat) playing ? pause() : play();
});
$('chart').addEventListener('keydown', (e) => {
  if (!S || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  e.preventDefault();
  seek(S.t + (e.key === 'ArrowRight' ? 1000 : -1000));
});
new ResizeObserver(draw).observe($('chart'));
$('fs').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());

// ---------- bulk export ----------
// Two plain download links in a popover (a delayed second programmatic download can be blocked by the browser).
let dlUrls = [];
const kb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1048576).toFixed(1)}MB`);
function closeDl() { $('dl').hidden = true; dlUrls.forEach((u) => URL.revokeObjectURL(u)); dlUrls = []; }
function dlLink(name, str) {
  const blob = new Blob(['\ufeff', str], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); dlUrls.push(a.href);
  a.download = name; a.textContent = `${name} · ${kb(blob.size)}`;
  return a;
}
document.addEventListener('pointerdown', (e) => { if (!$('dl').hidden && !$('dl').parentElement.contains(e.target)) closeDl(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('dl').hidden) closeDl(); });
// copy a link to this session at the playhead (#sessionId@sec) — recipients see the same data in supabase/server mode
$('share').onclick = async () => {
  const s = pk.sessions[pk.cur], label = $('share-label');
  if (!s || !S) return;
  const say = (m) => { label.textContent = m; clearTimeout(say.t); say.t = setTimeout(() => (label.textContent = 'リンクをコピー'), 2000); };
  if (s.source === 'file' || MODE === 'static') return say('このセッションは共有できません');
  const url = location.href.split('#')[0] + '#' + encodeURIComponent(s.sessionId) + '@' + ((S.t - S.T0) / 1000).toFixed(1);
  history.replaceState(null, '', url);
  try { await navigator.clipboard.writeText(url); say('コピーしました'); }
  catch { prompt('リンク', url); }
};

$('export').onclick = async () => {
  const btn = $('export'), label = $('export-label'), list = pk.sessions;
  closeDl();
  if (!list.length) return;
  btn.disabled = true;
  try {
    let sess = csvRow(SESSION_HEADER), evs = csvRow(EVENT_HEADER); // one string per file, appended per session
    for (let i = 0; i < list.length; i++) {
      label.textContent = `取得中 ${i + 1}/${list.length}`;
      const d = await fetchSession(list[i].sessionId);
      if (!d) throw new Error('missing ' + list[i].sessionId);
      const r = exportSession(d);
      sess += csvRow(r.sessionRow); evs += r.eventsCsv;
    }
    $('dl').replaceChildren(dlLink('sessions.csv', sess), dlLink('events.csv', evs));
    $('dl').hidden = false;
    label.textContent = 'エクスポート';
  } catch (err) {
    label.textContent = '失敗';
    setTimeout(() => { label.textContent = 'エクスポート'; }, 2000);
  }
  btn.disabled = false;
};

init().catch(() => { $('sentence').textContent = 'データを読み込めませんでした。'; });
