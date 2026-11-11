-- Movie Recap Studio: user-owned projects with Row Level Security.
-- Run this migration in the Supabase SQL Editor or with the Supabase CLI.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 90),
  source_url text not null check (source_url ~* '^https?://'),
  language text not null check (language in ('Myanmar', 'English')),
  duration text not null check (duration in ('3 min', '5 min', '10 min')),
  voice text not null check (voice in ('Female', 'Male')),
  status text not null default 'Draft' check (status in ('Draft', 'Analyzing', 'Ready to edit', 'Rendering', 'Completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_created_at_idx
  on public.projects (user_id, created_at desc);

alter table public.projects enable row level security;

grant usage on schema public to authenticated;
revoke all on table public.projects from anon, authenticated;
grant select, insert, update, delete on table public.projects to authenticated;

drop policy if exists "Users can read their own projects" on public.projects;
create policy "Users can read their own projects"
  on public.projects for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own projects" on public.projects;
create policy "Users can create their own projects"
  on public.projects for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own projects" on public.projects;
create policy "Users can update their own projects"
  on public.projects for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own projects" on public.projects;
create policy "Users can delete their own projects"
  on public.projects for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();
