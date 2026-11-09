// E2E: drive headless Edge over CDP through login → start → IME + latin typing → finish, then verify server data.
// Usage: node server/server.js (別ターミナル) → node tools/e2e.mjs <作業用フォルダ>   ※参加者ID "E2E" のセッションが data/ に残ります
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const S = process.argv[2], BASE = 'http://127.0.0.1:8787';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9333', `--user-data-dir=${S}/edge-e2e`, '--window-size=1440,900', 'about:blank']);
const wait = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9333/json')).json(); const p = l.find(t => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {} await wait(250); }
  throw new Error('no cdp');
}
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return; await wait(100); } throw new Error('timeout: ' + expr); };
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${S}/${name}.png`, Buffer.from(r.result.data, 'base64')); };
const key = async (k, code, text) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, windowsVirtualKeyCode: k === 'Backspace' ? 8 : k.toUpperCase().charCodeAt(0) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: k === 'Backspace' ? 8 : k.toUpperCase().charCodeAt(0) }); };
try {
  ws = new WebSocket(await connect());
  await new Promise(r => ws.onopen = r);
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/experiment/' }); await until(`!!document.getElementById('expId')`); await wait(1500); // backend.js probes /api at import
  await ev(`document.getElementById('expId').value='demo-ja'; document.getElementById('pid').value='E2E'; document.getElementById('login-btn').click()`);
  await until(`!document.getElementById('s-ready').hidden`); await shot('e2e-ready');
  await ev(`document.getElementById('start-btn').click()`);
  await until(`!document.getElementById('s-task').hidden`, 20000);
  await ev(`document.getElementById('ed').focus()`);
  // IME: compose "きょう" → commit "今日"
  for (const s of ['k', 'き', 'きょ', 'きょう']) { await send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length }); await wait(80); }
  await send('Input.insertText', { text: '今日' }); await wait(200);
  for (const c of 'abc') { await key(c, 'Key' + c.toUpperCase(), c); await wait(120); }
  await key('Backspace', 'Backspace'); await wait(2600); // pause ≥2 s
  await send('Input.imeSetComposition', { text: 'は', selectionStart: 1, selectionEnd: 1 }); await send('Input.insertText', { text: 'は' }); await wait(300);
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:String.fromCharCode(13),windowsVirtualKeyCode:13}); await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}); await wait(200); await key('x','KeyX','x'); await wait(200); await shot('e2e-task');
  const ta = await ev(`document.getElementById('ed').value`);
  await ev(`document.getElementById('finish-btn').click()`); await wait(200); await shot('e2e-confirm');
  await ev(`document.getElementById('end-btn').click()`);
  await until(`!document.getElementById('s-done').hidden`, 20000); await shot('e2e-done');
  const sid = await ev(`document.getElementById('done-id').textContent`);
  console.log('textarea:', JSON.stringify(ta), 'done-id:', sid);
  const list = await (await fetch(BASE + '/api/sessions')).json();
  const s = await (await fetch(BASE + '/api/sessions/' + list.find(x => x.participantId === 'E2E').sessionId)).json();
  const ev2 = s.events, types = {};
  for (const e of ev2) types[e.type] = (types[e.type] || 0) + 1;
  const seqs = ev2.map(e => e.seq); const dup = seqs.length - new Set(seqs).size;
  console.log('events', ev2.length, 'dupSeq', dup, 'monotonic', seqs.every((v, i) => !i || v > seqs[i - 1]), types);
  console.log('inputs', ev2.filter(e => /input|composition/.test(e.type)).map(e => `${e.type}:${e.inputType ?? ''}:${e.isComposing}:${JSON.stringify(e.data)}`).join(' | '));
  console.log('syncs', s.meta.syncs.map(x => `${x.phase} off=${x.offset.toFixed(2)} d=${x.delay.toFixed(2)} q=${x.quality}`), 'finalText', JSON.stringify(s.meta.finalText), 'eventCount', s.meta.eventCount);
  const { computeTimeline } = await import('file:///C:/Users/kosuk/shinkokyu/public/shared/metrics.js');
  const { makeOffsetFn } = await import('file:///C:/Users/kosuk/shinkokyu/public/shared/clock.js');
  const tl = computeTimeline(ev2, makeOffsetFn(s.meta.syncs), { sourceText: s.meta.sourceText, finalText: s.meta.finalText });
  console.log('summary', JSON.stringify(tl.summary), 'points', tl.points.length, 'maxPR', Math.max(...tl.points.map(p => p.pr)).toFixed(2));
} finally { try { ws?.close(); } catch {} edge.kill(); }
