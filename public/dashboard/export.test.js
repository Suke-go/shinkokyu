import assert from 'node:assert/strict';
import { csvCell, csvRow, exportSession, SESSION_HEADER, EVENT_HEADER } from './export.js';

assert.equal(csvCell(null), '');
assert.equal(csvCell(12.5), '12.5');
assert.equal(csvCell('a,b'), '"a,b"');
assert.equal(csvCell('say "hi"'), '"say ""hi"""');
assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
assert.equal(csvCell('今日は'), '今日は');
assert.equal(csvRow(['a', 'b,c', null]), 'a,"b,c",\r\n');

const ev = (t, o) => ({ t, seq: 0, type: 'input', inputType: 'insertText', isComposing: false, data: 'a', len: 1, caret: 1, selLen: 0, ...o });
const { sessionRow, eventsCsv } = exportSession({
  meta: { sessionId: 's1', expId: 'e', participantId: 'P', startedAt: 1700000000000, syncs: [] },
  events: [ev(0), ev(500, { data: 'x,"y"' })],
});
assert.equal(sessionRow.length, SESSION_HEADER.length);
const rows = eventsCsv.split('\r\n');
assert.equal(rows[0].split(',').length, EVENT_HEADER.length);
assert.equal(sessionRow[3], '2023-11-14T22:13:20.000Z');
assert.equal(sessionRow[SESSION_HEADER.indexOf('syncQuality')], 'none');
assert.equal(sessionRow[SESSION_HEADER.indexOf('eventCount')], 2);
assert.equal(sessionRow[SESSION_HEADER.indexOf('kspc')], 0);
assert.equal(eventsCsv.includes('"x,""y"""'), true);
assert.equal(rows.length, 3); // 2 events + trailing empty
assert.equal(sessionRow[SESSION_HEADER.indexOf('errorRatePrefix')], '');
console.log('export tests ok');
