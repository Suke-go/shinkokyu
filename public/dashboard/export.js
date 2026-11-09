// Pure CSV builders for the bulk export (no DOM). Excel-friendly: caller prepends a BOM and uses CRLF rows.
import { computeTimeline } from '../shared/metrics.js';
import { makeOffsetFn } from '../shared/clock.js';

export const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvRow = (r) => r.map(csvCell).join(',') + '\r\n';

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');

export const SESSION_HEADER = ['sessionId', 'expId', 'participantId', 'startedAt', 'durationSec', 'chars', 'meanCpm', 'ikiMedianMs', 'kspc', 'correctionRate', 'errorRateFull', 'errorRatePrefix', 'coverage', 'corrections', 'pauseSegments', 'pauseSegmentSec', 'slowSegments', 'syncQuality', 'syncDelayMs', 'eventCount'];
export const EVENT_HEADER = ['sessionId', 'seq', 'utcMs', 'utcISO', 'tLocal', 'type', 'key', 'code', 'isComposing', 'repeat', 'inputType', 'data', 'len', 'caret', 'selLen'];

// one session -> { sessionRow (cells), eventsCsv (one string, rows built as we go) }
export function exportSession({ meta, events }) {
  const off = makeOffsetFn(meta.syncs || []);
  const tl = computeTimeline(events, off, { sourceText: meta.sourceText, finalText: meta.finalText ?? undefined, finished: meta.endedAt != null && meta.finalText != null });
  const hes = tl.segments.filter((s) => s.kind === 'hesitation'), sm = tl.summary, syncs = meta.syncs || [];
  const r1 = (x) => (x == null ? '' : Math.round(x * 10) / 10);
  const sessionRow = [meta.sessionId, meta.expId, meta.participantId, iso(meta.startedAt), r1(sm.totalMs / 1000), sm.chars ?? 0, r1(sm.meanCpm), r1(sm.ikiMedianMs), sm.kspc == null ? '' : Math.round(sm.kspc * 100) / 100, r1(sm.correctionRate), r1(sm.errorRateFull), r1(sm.errorRatePrefix), sm.coverage == null ? '' : Math.round(sm.coverage * 1000) / 1000, sm.corrections,
    hes.length, r1(hes.reduce((a, s) => a + s.t1 - s.t0, 0) / 1000), tl.segments.length - hes.length,
    !syncs.length ? 'none' : syncs.every((s) => s.quality === 'good') ? 'good' : 'bad',
    syncs.length ? r1(Math.max(...syncs.map((s) => s.delay ?? 0))) : '', events.length];
  let eventsCsv = '';
  for (const e of events) {
    const u = off(e.t);
    eventsCsv += csvRow([meta.sessionId, e.seq, Math.round(u * 10) / 10, iso(u), e.t, e.type, e.key, e.code, e.isComposing, e.repeat, e.inputType, e.data, e.len, e.caret, e.selLen]);
  }
  return { sessionRow, eventsCsv };
}
