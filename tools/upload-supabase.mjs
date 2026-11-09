// Upload local sessions (data/<id>.json + .events.jsonl, or a downloaded {meta, events} JSON) to Supabase.
// Usage: node tools/upload-supabase.mjs data/taskB_P00_demo.json [more.json ...]   (re-running is safe: duplicates are ignored)
import { readFile } from 'node:fs/promises';
import { SUPABASE } from '../public/shared/config.js';

const H = { apikey: SUPABASE.key, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' };
const post = async (table, rows) => {
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(`${SUPABASE.url}/rest/v1/${table}`, { method: 'POST', headers: H, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!r.ok) throw new Error(`${table}: ${r.status} ${await r.text()}`);
  }
};

for (const f of process.argv.slice(2)) {
  const j = JSON.parse(await readFile(f, 'utf8'));
  const meta = j.meta ?? j;
  const events = j.events ?? (await readFile(f.replace(/\.json$/, '.events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const id = meta.sessionId;
  await post('sessions', [{
    session_id: id, exp_id: meta.expId, participant_id: meta.participantId,
    created_at: new Date(meta.createdAt ?? meta.startedAt ?? Date.now()).toISOString(),
    started_at: meta.startedAt ?? null, ended_at: meta.endedAt ?? null, client_ended_at: meta.clientEndedAt ?? null,
    source_text: meta.sourceText ?? null, final_text: meta.finalText ?? null, user_agent: meta.userAgent ?? null,
  }]);
  const hasSyncs = (await (await fetch(`${SUPABASE.url}/rest/v1/syncs?session_id=eq.${encodeURIComponent(id)}&select=id&limit=1`, { headers: H })).json()).length > 0; // syncs has no natural key
  if (meta.syncs?.length && !hasSyncs) await post('syncs', meta.syncs.map((s) => ({ session_id: id, phase: s.phase ?? null, data: s })));
  await post('events', events.map((e) => ({ session_id: id, seq: e.seq, batch: e.batch ?? null, ev: e })));
  console.log(`${id}: ${events.length} events, ${meta.syncs?.length ?? 0} syncs`);
}
