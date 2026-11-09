// node tools/make-demo.js -> writes one synthetic session (SPEC §2/§4 format) into data/
// Types the first part of experiment taskB with IME-style phrase commits, immediate typo fixes, Enters at paragraph breaks.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'data');
const id = 'taskB_P00_demo';
const source = JSON.parse(readFileSync(join(root, 'server', 'experiments.json'), 'utf8')).taskB.text;
let rs = 42; const rnd = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const between = (a, b) => a + rnd() * (b - a);

const timeOrigin = 1762650000000.25, offStart = 1234.6, offEnd = 1236.9; // UTC = local + offset
const T0 = timeOrigin + 5000;
let now = T0, seq = 0, text = '', caret = 0, comp = ''; // comp = uncommitted IME text (live textarea value includes it)
const ev = [];
const push = (type, o = {}) => ev.push({ t: +now.toFixed(1), seq: seq++, type, key: null, code: null, isComposing: false, repeat: false, inputType: null, data: null, len: [...text].length, caret, selLen: 0, ...o });
const el = () => now - T0;
let nextSnap = T0 + 5000;
const tick = (ms) => { now += ms; while (now >= nextSnap) { const keep = now; now = nextSnap; push('snapshot', { data: text + comp, isComposing: comp !== '', len: [...text + comp].length, caret: [...text + comp].length }); now = keep; nextSnap += 5000; } };
const key = (k, composing) => { push('keydown', { key: k, code: k === 'Process' ? 'KeyK' : 'Key' + k.toUpperCase(), isComposing: composing }); tick(between(30, 60)); push('keyup', { key: k, code: 'KeyK', isComposing: composing }); };

let slow = false;
const delay = (a, b) => tick(slow ? between(500, 800) : between(a, b));

// type one phrase through the IME: Process keydowns, compositionupdate/input, convert key, compositionend
function commit(s) {
  push('compositionstart');
  const keys = Math.max(3, Math.round(s.length * 2.2));
  for (let i = 0; i < keys; i++) {
    key('Process', true);
    comp = s.slice(0, Math.ceil(((i + 1) / keys) * s.length));
    push('compositionupdate', { data: comp, isComposing: true });
    push('input', { inputType: 'insertCompositionText', data: comp, isComposing: true, len: [...text + comp].length, caret: [...text + comp].length });
    delay(70, 130);
  }
  key('Process', true); delay(150, 300); // Space: convert
  text += s; comp = ''; caret = text.length;
  push('compositionend', { data: s });
  tick(between(60, 120));
}
function backspace(n) {
  for (let i = 0; i < n; i++) {
    key('Backspace', false); text = text.slice(0, -1); caret = text.length;
    push('input', { inputType: 'deleteContentBackward' }); tick(between(110, 190));
  }
}

push('session_start', { data: '' });
tick(900);
let pos = 0, paused70 = false, paused150 = false, backspaced = 0, phrases = 0;
while (el() < 240000 && pos < source.length) {
  if (!paused70 && el() > 70000) { paused70 = true; tick(11500); }
  if (!paused150 && el() > 150000) { paused150 = true; tick(14200); }
  slow = el() > 190000 && el() < 206000;
  if (source[pos] === '\n') { // paragraph break
    key('Enter', false); text += '\n'; caret = text.length; push('input', { inputType: 'insertLineBreak' }); tick(between(300, 600)); pos++; continue;
  }
  let end = Math.min(pos + 2 + Math.floor(rnd() * 6), source.indexOf('\n', pos) < 0 ? source.length : source.indexOf('\n', pos));
  const s = source.slice(pos, end);
  phrases++;
  if (phrases % 12 === 7 && s.length > 2) { // typo: commit a wrong phrase, notice, delete it, retype
    const wrong = s.slice(0, -1) + 'あいうえおかきく'[Math.floor(rnd() * 8)];
    commit(wrong); tick(between(250, 500)); backspace([...wrong].length); backspaced += [...wrong].length;
  }
  // every 9th phrase keeps an uncorrected slip (error rate of a few %)
  commit(phrases % 9 === 4 && s.length > 2 ? s.slice(0, -1) + 'ん' : s); pos = end;
}
push('session_end', { data: text });
const endedAt = now + offEnd;

const sync = (phase, offset, at) => ({ phase, offset, delay: 3.1, medianLow5: offset + 0.2, spreadLow5: 0.6, n: 17, at, quality: 'good', attempts: 1, samples: [], timeOrigin, crossOriginIsolated: false, skew: 0.3, ua: 'demo' });
const batches = []; for (let b = 0; b <= Math.floor((endedAt - T0) / 1000); b++) batches.push(b);
const meta = {
  sessionId: id, expId: 'taskB', participantId: 'P00', createdAt: Math.round(T0 - 20000 + offStart), startedAt: Math.round(T0 + offStart), endedAt: null, // left unfinished on purpose: exercises the prefix error rate
  sourceText: source, finalText: null, userAgent: 'make-demo', serverSntp: { ok: true, offset: 2.4, delay: 21, server: 'time.google.com', at: Math.round(T0) },
  eventCount: ev.length, syncs: [sync('start', offStart, T0 - 2000), sync('end', offEnd, now + 800)], batches,
};
mkdirSync(dir, { recursive: true });
for (const f of ['demo-ja_P00_demo.json', 'demo-ja_P00_demo.events.jsonl']) rmSync(join(dir, f), { force: true }); // old demo
writeFileSync(join(dir, id + '.json'), JSON.stringify(meta, null, 1));
writeFileSync(join(dir, id + '.events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(`wrote ${id}: ${ev.length} events, ${(el() / 1000).toFixed(0)} s, ${[...text].length} chars, ${backspaced} backspaced`);
