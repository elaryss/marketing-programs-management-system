-- Per-user saved custom views for the Toolkit Manager.
-- Each row is one named column-set owned by the auth user who created it.
-- Applied to the remote DB via Supabase MCP on 2026-07-20; this file mirrors it.
create table if not exists public.toolkit_user_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  column_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists toolkit_user_views_user_id_idx
  on public.toolkit_user_views(user_id);

alter table public.toolkit_user_views enable row level security;

-- Unlike the other tables in this project (which grant blanket anon/authenticated
-- CRUD behind the password gate), custom views are genuinely per-user, so scope
-- every policy by auth.uid().
drop policy if exists "own views select" on public.toolkit_user_views;
drop policy if exists "own views insert" on public.toolkit_user_views;
drop policy if exists "own views update" on public.toolkit_user_views;
drop policy if exists "own views delete" on public.toolkit_user_views;

create policy "own views select" on public.toolkit_user_views
  for select to authenticated using (user_id = auth.uid());
create policy "own views insert" on public.toolkit_user_views
  for insert to authenticated with check (user_id = auth.uid());
create policy "own views update" on public.toolkit_user_views
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own views delete" on public.toolkit_user_views
  for delete to authenticated using (user_id = auth.uid());

-- Keep updated_at fresh on edits.
create or replace function public.touch_toolkit_user_views_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_toolkit_user_views on public.toolkit_user_views;
create trigger trg_touch_toolkit_user_views
  before update on public.toolkit_user_views
  for each row execute function public.touch_toolkit_user_views_updated_at();
