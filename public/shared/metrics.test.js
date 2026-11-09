import assert from 'node:assert/strict';
import { PARAMS, computeTimeline, textAt, makeReplayer, levenshtein, errorRate } from './metrics.js';

const ins = (t, data, extra = {}) => ({ t, type: 'input', inputType: 'insertText', isComposing: false, data, ...extra });
const kd = (t, key = 'a', extra = {}) => ({ t, type: 'keydown', key, repeat: false, isComposing: false, ...extra });

// levenshtein
assert.equal(levenshtein('', ''), 0);
assert.equal(levenshtein('kitten', 'sitting'), 3);
assert.equal(levenshtein('今日は', '今日わ'), 1);
assert.equal(levenshtein('😀a', 'a'), 1); // code points

// error rate: NFC, trailing whitespace, CRLF
assert.equal(errorRate('が', 'が'), 0); // decomposed vs composed
assert.equal(errorRate('abc \n', 'abc'), 0);
assert.equal(errorRate('a\r\nb', 'a\nb'), 0);
assert.equal(errorRate('abcd', 'abxd'), 25);

// steady stream: 1 char / 200 ms for 30 s -> 300 CPM after warmup, no pauses
{
  const ev = [];
  for (let t = 0; t <= 30000; t += 200) ev.push(kd(t), ins(t, 'a'));
  const r = computeTimeline(ev);
  const p = r.points.find((q) => q.t === 20000);
  assert.equal(p.warmup, false);
  assert.equal(p.cpm, 300);
  assert.equal(p.pr, 0);
  assert.equal(r.points[0].warmup, true);
  assert.equal(r.base, 300);
  assert.equal(r.segments.length, 0);
  assert.ok(Math.abs(r.summary.meanCpm - 300) < 10);
}

// pause: 12 s gap -> PR = 1 for a window fully inside; slowdown labelled hesitation
{
  const ev = [];
  for (let t = 0; t <= 30000; t += 200) ev.push(kd(t), ins(t, 'a'));
  for (let t = 42000; t <= 60000; t += 200) ev.push(kd(t), ins(t, 'a'));
  const r = computeTimeline(ev);
  // window (32000, 42000] vs gap (30000, 42000)
  assert.equal(r.points.find((q) => q.t === 42000).pr, 1);
  assert.equal(r.points.find((q) => q.t === 36000).pr, 0.6);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].kind, 'hesitation');
  assert.ok(r.segments[0].t0 >= 40000 && r.segments[0].t0 <= 41000 || r.segments[0].t0 >= 30000);
}

// slow (not paused): 1 char / 1.5 s stretch in the middle of 300 CPM typing
{
  const ev = [];
  for (let t = 0; t <= 30000; t += 200) ev.push(kd(t), ins(t, 'a'));
  for (let t = 31500; t <= 60000; t += 1500) ev.push(kd(t), ins(t, 'a'));
  for (let t = 60200; t <= 90000; t += 200) ev.push(kd(t), ins(t, 'a'));
  const r = computeTimeline(ev);
  assert.ok(r.segments.length >= 1);
  assert.ok(r.segments.every((s) => s.kind === 'slow'));
}

// IME: Process keydowns are activity (no pause), compositionend "今日は" = 3 chars
{
  const ev = [];
  for (let t = 0; t <= 3000; t += 500) ev.push(kd(t, 'Process', { isComposing: true }));
  ev.push({ t: 3100, type: 'compositionend', data: '今日は', isComposing: false });
  ev.push({ t: 3200, type: 'input', inputType: 'insertCompositionText', isComposing: true, data: 'x' }); // not a commit
  const r = computeTimeline(ev);
  assert.equal(r.summary.chars, 3);
  assert.equal(r.points.at(-1).pr, 0); // gaps all < 2 s
  assert.equal(r.points.at(-1).cpm, 60000 * 3 / PARAMS.W);
}

// corrections counted, not commits
{
  const ev = [kd(0), ins(0, 'a'), { t: 100, type: 'input', inputType: 'deleteContentBackward', isComposing: false, data: null }, kd(2000), ins(2000, 'b')];
  const r = computeTimeline(ev);
  assert.equal(r.summary.corrections, 1);
  assert.equal(r.summary.chars, 2);
}

// offsetFn applied: points in UTC
{
  const r = computeTimeline([kd(0), ins(0, 'a'), kd(1000), ins(1000, 'b')], (t) => t + 5000);
  assert.equal(r.points[0].t, 5000);
}

// textAt: snapshot + replay with carets, offsetFn
{
  const ev = [
    { t: 0, type: 'session_start', data: '' },
    ins(100, 'a', { caret: 1, len: 1 }),
    { t: 200, type: 'compositionstart' },
    { t: 250, type: 'input', inputType: 'insertCompositionText', isComposing: true, data: 'k', caret: 2, len: 2 },
    { t: 300, type: 'compositionend', data: '今日', caret: 3, len: 3 },
    ins(400, 'b', { caret: 1, len: 4 }), // insert at start
    { t: 500, type: 'input', inputType: 'deleteContentBackward', isComposing: false, caret: 0, len: 3 },
    { t: 600, type: 'snapshot', data: 'zz' },
  ];
  assert.equal(textAt(ev, 150), 'a');
  assert.equal(textAt(ev, 260), 'a');
  assert.equal(textAt(ev, 350), 'a今日');
  assert.equal(textAt(ev, 450), 'ba今日');
  assert.equal(textAt(ev, 550), 'a今日');
  assert.equal(textAt(ev, 700), 'zz');
  assert.equal(textAt(ev, 150, (t) => t + 1000), '');
}

// insertLineBreak (textarea Enter): commit k=1 and newline in replay; a, Enter, b, Backspace -> "a newline"
{
  const nl = { type: 'input', inputType: 'insertLineBreak', isComposing: false, data: null };
  const ev = [
    { t: 0, type: 'session_start', data: '' },
    ins(100, 'a', { caret: 1, len: 1 }),
    { t: 200, ...nl, caret: 2, len: 2 },
    ins(300, 'b', { caret: 3, len: 3 }),
    { t: 400, type: 'input', inputType: 'deleteContentBackward', isComposing: false, caret: 2, len: 2 },
  ];
  assert.equal(textAt(ev, 400), 'a\n');
  assert.equal(computeTimeline(ev).summary.chars, 3);
}

// snapshot taken mid-composition is skipped (flag, or compositionstart/end for old data)
{
  const mid = (t, extra) => ({ t, type: 'snapshot', data: '漢かん', ...extra });
  const base = [
    { t: 0, type: 'session_start', data: '' },
    { t: 100, type: 'compositionstart' },
    mid(200, { isComposing: true }),
    { t: 300, type: 'compositionend', data: '漢', caret: 1, len: 1 },
  ];
  assert.equal(textAt(base, 250), '');
  assert.equal(textAt(base, 350), '漢');
  const old = [base[0], base[1], mid(200), base[3]]; // no isComposing flag
  assert.equal(textAt(old, 250), '');
  assert.equal(textAt(old, 350), '漢');
}

// other deletes, code points, selection replace
{
  const del = (t, it, caret, len) => ({ t, type: 'input', inputType: it, isComposing: false, caret, len });
  const ev = [{ t: 0, type: 'session_start', data: 'ab😀cd' }, del(10, 'deleteByCut', 2, 4), del(20, 'deleteWordBackward', 0, 3)];
  assert.equal(textAt(ev, 15), 'abcd');
  assert.equal(textAt(ev, 25), 'bcd');
  // typing "X" over a selected "bc" in "abcd": len 3, caret 2
  const rep = [{ t: 0, type: 'session_start', data: 'abcd' }, ins(10, 'X', { caret: 2, len: 3 })];
  assert.equal(textAt(rep, 20), 'aXd');
}

// single-point session does not break
{
  const r = computeTimeline([ins(5, 'a', { caret: 1, len: 1 })]);
  assert.equal(r.points.length, 1);
  assert.ok(Number.isFinite(r.points[0].cpm) && Number.isFinite(r.summary.meanCpm));
}


// makeReplayer: composition state, caret, incremental forward + backward seek == fresh replay
{
  const ev = [
    { t: 0, type: 'session_start', data: 'ab', caret: 2, len: 2 },
    { t: 100, type: 'compositionstart' },
    { t: 150, type: 'compositionupdate', data: 'か', isComposing: true },
    { t: 160, type: 'input', inputType: 'insertCompositionText', isComposing: true, data: 'か', caret: 3, len: 3 },
    { t: 200, type: 'snapshot', data: 'abかん', isComposing: true },
    { t: 250, type: 'compositionupdate', data: 'かん', isComposing: true },
    { t: 300, type: 'compositionend', data: '漢', caret: 3, len: 3 },
    { t: 400, type: 'input', inputType: 'insertText', isComposing: false, data: 'c', caret: 4, len: 4 },
    { t: 500, type: 'snapshot', data: 'ab漢c', caret: 4 },
    { t: 600, type: 'input', inputType: 'deleteContentBackward', isComposing: false, caret: 3, len: 3 },
  ];
  const r = makeReplayer(ev);
  let s = r.at(180);
  assert.deepEqual([s.text, s.caret, s.comp, s.composing], ['ab', 2, 'か', true]);
  s = r.at(260);
  assert.deepEqual([s.text, s.caret, s.comp, s.composing], ['ab', 2, 'かん', true]);
  s = r.at(350);
  assert.deepEqual([s.text, s.caret, s.comp, s.composing], ['ab漢', 3, '', false]);
  s = r.at(650);
  assert.deepEqual([s.text, s.caret], ['ab漢', 3]);
  // forward, backward, jumps: always identical to a from-scratch replay
  for (const t of [0, 99, 170, 320, 450, 520, 700, 250, 10, 650, 180, 180, 1000, 300]) {
    const a = r.at(t), b = makeReplayer(ev).at(t);
    assert.deepEqual(a, b, 't=' + t);
    assert.equal(textAt(ev, t), b.text);
  }
}

// makeReplayer on the generated demo session (skipped if data/ has no demo): final text matches, random seeks consistent
{
  const { existsSync, readFileSync } = await import('node:fs');
  const base = new URL('../../data/taskB_P00_demo', import.meta.url);
  if (existsSync(base.pathname.slice(1) + '.json')) {
    const meta = JSON.parse(readFileSync(base.pathname.slice(1) + '.json', 'utf8'));
    const ev = readFileSync(base.pathname.slice(1) + '.events.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
    const r = makeReplayer(ev, (t) => t + 1235);
    assert.equal(r.at(1e18).text, ev.at(-1).data); // session_end snapshot
    const t0 = ev[0].t + 1235, t1 = ev.at(-1).t + 1235;
    let x = 7;
    for (let i = 0; i < 40; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      const t = t0 + (x / 0x7fffffff) * (t1 - t0);
      assert.deepEqual(r.at(t), makeReplayer(ev, (u) => u + 1235).at(t));
    }
  }
}

// IKI median (gaps >= PAUSE excluded), KSPC, correction rate
{
  const ev = [kd(0), ins(0, 'a'), kd(100), ins(100, 'b'), kd(300), ins(300, 'c'), kd(5000), ins(5000, 'd'), 
    kd(5200, 'Backspace'), { t: 5200, type: 'input', inputType: 'deleteContentBackward', isComposing: false }, kd(5300, 'e', { repeat: true })];
  const s = computeTimeline(ev, (t) => t, { finalText: 'abcd' }).summary;
  assert.equal(s.ikiMedianMs, 200); // gaps 100, 200, 200 (4700 excluded)
  assert.equal(s.kspc, 5 / 4);
  assert.equal(s.correctionRate, 25);
}

// unfinished transcription: untyped tail of the source is not an error; a mid-text omission still is
{
  assert.equal(errorRate('abcd', 'abcdefgh'), 50);
  assert.equal(errorRate('abcd', 'abcdefgh', true), 0);
  assert.equal(errorRate('abXd', 'abcdefgh', true), 25);
  assert.equal(errorRate('abdefgh', 'abcdefgh', true), 100 / 8 );
  const o = { sourceText: 'abcdefgh', finalText: 'abc' };
  const fin = computeTimeline([kd(0), ins(0, 'a')], (t) => t, o).summary; // finished: full MSD
  assert.equal(fin.errorRate, fin.errorRateFull);
  assert.ok(fin.errorRate > 50 && !fin.errorPrefix);
  const unf = computeTimeline([kd(0), ins(0, 'a')], (t) => t, { ...o, finished: false }).summary; // unfinished: prefix
  assert.equal(unf.errorRate, 0);
  assert.equal(unf.errorPrefix, true);
  assert.equal(unf.coverage, 3 / 8);
  assert.equal(unf.errorRateFull, fin.errorRateFull);
  // empty typed text -> null
  const none = computeTimeline([kd(0), ins(0, 'a')], (t) => t, { sourceText: 'abc', finalText: '' }).summary;
  assert.equal(none.errorRate, null);
}

// KSPC denominator = final text length; null when empty. IKI null without gaps.
{
  const s = computeTimeline([kd(0), ins(0, 'a')], (t) => t, { finalText: '' }).summary;
  assert.equal(s.kspc, null);
  assert.equal(s.ikiMedianMs, null);
}

// final text fallback ignores mid-composition snapshots
{
  const ev = [{ t: 0, type: 'session_start', data: '', caret: 0 }, kd(10, 'Process', { isComposing: true }), { t: 20, type: 'compositionstart' },
    { t: 30, type: 'compositionupdate', data: 'かん', isComposing: true }, { t: 40, type: 'snapshot', data: 'かん', isComposing: true },
    { t: 50, type: 'compositionend', data: '漢', caret: 1, len: 1 }];
  assert.equal(computeTimeline(ev, (t) => t, { sourceText: '漢' }).summary.errorRate, 0);
}

// undo/redo: stale until the next snapshot, no garbage from len reconciliation; snapshot resyncs exactly
{
  const typ = (t, d, caret, len) => ({ t, type: 'input', inputType: 'insertText', isComposing: false, data: d, caret, len });
  const ev = [
    { t: 0, type: 'session_start', data: 'abcdef', caret: 6, len: 6 },
    typ(10, 'X', 7, 7), typ(20, 'Y', 8, 8),
    { t: 30, type: 'input', inputType: 'historyUndo', isComposing: false, caret: 6, len: 6 },
    typ(40, 'Q', 2, 7), // clicked at 1, typed Q: real text 'aQbcdef'
    { t: 50, type: 'snapshot', data: 'aQbcdef', caret: 2 },
  ];
  assert.equal(textAt(ev, 20), 'abcdefXY');
  assert.equal(textAt(ev, 45), 'aQbcdefXY'); // stale tail XY kept, but nothing eaten
  assert.equal(textAt(ev, 60), 'aQbcdef');
}

// compositionend with empty data over a selection reconciles length
{
  const ev = [
    { t: 0, type: 'session_start', data: 'abcd', caret: 4, len: 4 },
    { t: 10, type: 'compositionstart' },
    { t: 20, type: 'compositionend', data: '', caret: 1, len: 1 }, // selection 'bcd' was replaced by the (cancelled) composition
  ];
  assert.equal(textAt(ev, 5), 'abcd');
  assert.equal(textAt(ev, 30), 'a');
}

console.log('metrics tests ok');
