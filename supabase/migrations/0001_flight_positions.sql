-- Position snapshots written by the flights Edge Function (service role).
-- Read-only to browsers; rows older than 60 min are deleted by pg_cron.
create table public.flight_positions (
  id bigint generated always as identity primary key,
  hex text not null,
  ts timestamptz not null default now(),
  lat double precision not null,
  lon double precision not null,
  alt_ft integer,
  callsign text
);

create index flight_positions_hex_ts on public.flight_positions (hex, ts);
create index flight_positions_ts on public.flight_positions (ts);

alter table public.flight_positions enable row level security;

create policy "public read" on public.flight_positions
  for select to anon, authenticated using (true);

-- Hourly retention, enforced every 10 minutes.
create extension if not exists pg_cron;
select cron.schedule(
  'flight-positions-cleanup',
  '*/10 * * * *',
  $$delete from public.flight_positions where ts < now() - interval '60 minutes'$$
);
