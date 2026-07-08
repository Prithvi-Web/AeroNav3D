-- Starred flights per signed-in user. RLS: owners only.
create table public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  hex text not null,
  callsign text,
  created_at timestamptz not null default now(),
  unique (user_id, hex)
);

alter table public.favorites enable row level security;

create policy "own rows select" on public.favorites
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows insert" on public.favorites
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own rows delete" on public.favorites
  for delete to authenticated using ((select auth.uid()) = user_id);
