// Typing metrics: pure functions, no imports (SPEC §4, §5). Times: events are local ms; offsetFn maps to UTC ms.
export const PARAMS = { W: 10000, STEP: 1000, PAUSE: 2000, SLOW_RATIO: 0.5, SLOW_MIN: 5000, MERGE_GAP: 2000 };

const cp = (s) => [...(s ?? '')].length;
const isNL = (t) => t === 'insertParagraph' || t === 'insertLineBreak'; // textarea Enter = insertLineBreak

// last DP row: distances between all of x and each prefix of y
const lastRow = (x, y) => {
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev;
};
export const levenshtein = (a, b) => lastRow([...a], [...b]).at(-1);

const norm = (s) => (s ?? '').normalize('NFC').replace(/\r\n?/g, '\n').trimEnd();

// error rate in percent (SPEC §5): 100 * lev(P,T) / max(|P|,|T|).
// prefix=true: the untyped tail of T is free (unfinished task): T is cut at the best-matching prefix k.
export function errorRateDetail(typed, target, prefix = false) {
  const p = [...norm(typed)], t = [...norm(target)], row = lastRow(p, t);
  const k = prefix ? row.indexOf(Math.min(...row)) : t.length;
  const m = Math.max(p.length, k);
  return { rate: m === 0 ? 0 : (100 * row[k]) / m, k, tLen: t.length };
}
export const errorRate = (typed, target, prefix = false) => errorRateDetail(typed, target, prefix).rate;

const median = (a) => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n === 0 ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

// opts (addition to SPEC's signature): sourceText = task text (error rates null without it); finalText = meta.finalText
// (else replayed from events); finished=false (session not ended / no finalText) -> errorRate in prefix mode.
export function computeTimeline(events, offsetFn = (t) => t, opts = {}) {
  const { W, STEP, PAUSE, SLOW_RATIO, SLOW_MIN, MERGE_GAP } = PARAMS;
  const commits = [], act = [], kd = []; // kd: non-repeat keydown times (IKI, KSPC)
  let corrections = 0;
  for (const e of events) {
    const t = offsetFn(e.t);
    if (e.type === 'keydown' && !e.repeat) kd.push(t);
    if (e.type === 'keydown' ? !e.repeat : e.type === 'compositionupdate' || e.type === 'input') act.push(t);
    if (e.type === 'input' && !e.isComposing) {
      if (e.inputType === 'insertText') commits.push({ t, k: cp(e.data) });
      else if (isNL(e.inputType)) commits.push({ t, k: 1 });
      else if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') corrections++;
    } else if (e.type === 'compositionend') commits.push({ t, k: cp(e.data) });
  }
  act.sort((a, b) => a - b);
  commits.sort((a, b) => a.t - b.t);
  const empty = { points: [], base: 0, segments: [], summary: { meanCpm: 0, totalMs: 0, chars: 0, errorRate: null, errorRateFull: null, errorRatePrefix: null, coverage: null, errorPrefix: false, corrections, ikiMedianMs: null, kspc: null, correctionRate: null, startUtc: null, endUtc: null } };
  if (!act.length || !commits.length) return empty;

  const start = act[0], end = commits[commits.length - 1].t;
  // pause gaps (>= PAUSE) between consecutive activities
  const gaps = [];
  for (let i = 1; i < act.length; i++) if (act[i] - act[i - 1] >= PAUSE) gaps.push([act[i - 1], act[i]]);

  const points = [];
  let lo = 0;
  for (let s = start; s - STEP < end; s += STEP) {
    let n = 0;
    for (let i = lo; i < commits.length && commits[i].t <= s; i++) if (commits[i].t > s - W) n += commits[i].k;
    let paused = 0;
    for (const [a, b] of gaps) paused += Math.max(0, Math.min(b, s) - Math.max(a, s - W));
    const cpm = (60000 * n) / W;
    points.push({ t: s, cpm, wpm: cpm / 5, pr: paused / W, warmup: s - W < start });
  }

  const base = median(points.slice(0, -1).filter((p) => !p.warmup && p.cpm > 0).map((p) => p.cpm));
  const runs = [];
  for (const p of points.slice(0, -1)) {
    if (!p.warmup && base > 0 && p.cpm < SLOW_RATIO * base) {
      const r = runs[runs.length - 1];
      if (r && r.t1 === p.t) r.t1 = p.t + STEP; else runs.push({ t0: p.t, t1: p.t + STEP });
    }
  }
  const merged = [];
  for (const r of runs) {
    const m = merged[merged.length - 1];
    if (m && r.t0 - m.t1 < MERGE_GAP) m.t1 = r.t1; else merged.push({ ...r });
  }
  const segments = merged.filter((r) => r.t1 - r.t0 >= SLOW_MIN).map((r) => {
    const ps = points.filter((p) => p.t >= r.t0 && p.t < r.t1);
    const meanPr = ps.reduce((a, p) => a + p.pr, 0) / ps.length;
    return { ...r, kind: meanPr >= 0.5 ? 'hesitation' : 'slow', meanPr };
  });

  const chars = commits.reduce((a, c) => a + c.k, 0);
  const totalMs = end - start;
  const P = opts.finalText ?? makeReplayer(events, offsetFn).at(Infinity).text; // final transcribed text
  const nP = cp(P), ikis = kd.slice(1).map((t, i) => t - kd[i]).filter((g) => g < PAUSE); // gaps >= PAUSE excluded
  const hasErr = opts.sourceText != null && norm(P) !== '';
  const full = hasErr ? errorRateDetail(P, opts.sourceText) : null, pre = hasErr ? errorRateDetail(P, opts.sourceText, true) : null;
  const unfinished = opts.finished === false;
  const summary = {
    meanCpm: totalMs > 0 ? (60000 * chars) / totalMs : 0, totalMs, chars, corrections,
    ikiMedianMs: ikis.length ? median(ikis) : null,
    kspc: nP ? kd.length / nP : null, // keystrokes per char of the final text
    correctionRate: chars ? (100 * corrections) / chars : null, // corrections per 100 committed chars
    errorRateFull: full?.rate ?? null, errorRatePrefix: pre?.rate ?? null, coverage: pre && pre.tLen ? pre.k / pre.tLen : null,
    errorRate: (unfinished ? pre : full)?.rate ?? null, errorPrefix: hasErr && unfinished,
    startUtc: start, endUtc: end,
  };
  return { points, base, segments, summary };
}

// Replay: reconstruct the editor at UTC time t from snapshots + logged caret/len of each event.
// Snapshots taken inside a composition (live ta.value incl. uncommitted IME text) are not usable: detected
// by isComposing or by tracking compositionstart/end (old data). session_start/session_end always are.
// Forward playback is incremental; seeking back (or far ahead) restarts at the nearest usable snapshot.
// shortcut: historyUndo/Redo and other unknown input types are not replayed; the replay is marked stale (cuts
// limited to 1 char, no len reconciliation) until the next usable snapshot resyncs it.
export function makeReplayer(events, offsetFn = (t) => t) {
  const ts = events.map((e) => offsetFn(e.t));
  const fresh = () => ({ i: 0, text: '', caret: 0, comp: '', composing: false, stale: false });
  const usable = (e, composing) => (e.type === 'snapshot' ? !composing && !e.isComposing : e.type === 'session_start' || e.type === 'session_end') && typeof e.data === 'string';
  const snaps = []; // indices of usable snapshots
  for (let i = 0, c = false; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'compositionstart') c = true; else if (e.type === 'compositionend') c = false;
    if (usable(e, c)) snaps.push(i);
  }
  const upper = (arr, f, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (f(arr[m]) <= x) lo = m + 1; else hi = m; } return lo; };
  let st = fresh();

  const ins = (at, s) => { at = Math.max(0, Math.min(at, st.text.length)); st.text = st.text.slice(0, at) + s + st.text.slice(at); return at + s.length; };
  const cut = (at, n, del) => { if (st.stale) n = del ? 1 : 0; if (n > 0) st.text = st.text.slice(0, at) + [...st.text.slice(at)].slice(n).join(''); };
  const step = (e) => {
    if (usable(e, st.composing)) { st.text = e.data; st.caret = typeof e.caret === 'number' ? e.caret : e.data.length; st.comp = ''; st.composing = false; st.stale = false; return; }
    if (e.type === 'compositionstart') { st.composing = true; st.comp = ''; return; }
    if (e.type === 'compositionupdate') { st.composing = true; st.comp = e.data ?? ''; return; }
    if (e.type === 'compositionend') {
      st.composing = false; st.comp = '';
      if (e.data) cut(ins(e.caret - e.data.length, e.data), cp(st.text) - e.len);
      else cut(e.caret, cp(st.text) - e.len, true); // cancelled composition over a selection
      if (typeof e.caret === 'number') st.caret = e.caret;
      return;
    }
    if (e.type !== 'input') return;
    if (e.isComposing) { if (typeof e.caret === 'number') st.caret = Math.max(0, e.caret - st.comp.length); return; }
    const it = e.inputType ?? '';
    if (it === 'insertText' && e.data) cut(ins(e.caret - e.data.length, e.data), cp(st.text) - e.len); // extra chars = replaced selection
    else if (isNL(it)) cut(ins(e.caret - 1, '\n'), cp(st.text) - e.len);
    else if (it.startsWith('delete')) cut(e.caret, cp(st.text) - e.len, true); // n code points, BMP caret
    else st.stale = true; // historyUndo/Redo etc.: len no longer trustworthy until the next usable snapshot
    if (typeof e.caret === 'number') st.caret = e.caret;
  };

  return {
    at(tUtc) {
      const n = upper(ts, (x) => x, tUtc); // events [0,n) have happened
      const k = upper(snaps, (s) => s, n - 1) - 1; // last usable snapshot with index < n
      const s = k >= 0 ? snaps[k] : 0;
      if (n < st.i || s >= st.i) { st = fresh(); st.i = s; }
      while (st.i < n) step(events[st.i++]);
      return { text: st.text, caret: Math.min(st.caret, st.text.length), comp: st.comp, composing: st.composing };
    },
  };
}

export function textAt(events, tUtc, offsetFn = (t) => t) {
  return makeReplayer(events, offsetFn).at(tUtc).text;
}
