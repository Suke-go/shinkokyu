-- TEST PHASE: anyone with the publishable key can read all data — before real experiments restrict select to authenticated researchers.
-- Paste into Supabase SQL Editor and run. Idempotent (safe to re-run).

create table if not exists sessions (
  session_id text primary key check (session_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  exp_id text not null check (exp_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  participant_id text not null check (participant_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  created_at timestamptz default now(),
  started_at double precision,        -- server UTC ms (set when session_start batch arrives)
  ended_at double precision,          -- server UTC ms
  client_ended_at double precision,   -- browser Date.now() at finish
  source_text text,
  final_text text,
  user_agent text
);

create table if not exists events (
  session_id text references sessions on delete cascade,
  seq integer,
  batch integer,
  ev jsonb not null,
  -- server receive time, UTC ms; used for offline offset estimation when browser clock sync failed
  recv_at double precision default (extract(epoch from clock_timestamp())*1000),
  primary key (session_id, seq)
);
create index if not exists events_session_seq on events (session_id, seq);

create table if not exists syncs (
  id bigserial primary key,
  session_id text references sessions on delete cascade,
  phase text,
  data jsonb not null,
  recv_at double precision default (extract(epoch from clock_timestamp())*1000)
);
create index if not exists syncs_session on syncs (session_id, id);

create or replace function server_time() returns double precision
  language sql volatile as $$ select extract(epoch from clock_timestamp())*1000 $$;
grant execute on function server_time() to anon, authenticated;

alter table sessions enable row level security;
alter table events enable row level security;
alter table syncs enable row level security;

drop policy if exists test_sessions_select on sessions;
drop policy if exists test_sessions_insert on sessions;
drop policy if exists test_sessions_update on sessions;
drop policy if exists test_events_select on events;
drop policy if exists test_events_insert on events;
drop policy if exists test_syncs_select on syncs;
drop policy if exists test_syncs_insert on syncs;

create policy test_sessions_select on sessions for select to anon, authenticated using (true);
create policy test_sessions_insert on sessions for insert to anon, authenticated with check (true);
create policy test_sessions_update on sessions for update to anon, authenticated using (true) with check (true);
create policy test_events_select on events for select to anon, authenticated using (true);
create policy test_events_insert on events for insert to anon, authenticated with check (true);
create policy test_syncs_select on syncs for select to anon, authenticated using (true);
create policy test_syncs_insert on syncs for insert to anon, authenticated with check (true);

grant select, insert on sessions, events, syncs to anon, authenticated;
grant update on sessions to anon, authenticated;
grant usage, select on sequence syncs_id_seq to anon, authenticated;
