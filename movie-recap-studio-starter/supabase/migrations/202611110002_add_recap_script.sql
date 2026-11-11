-- YouTube-only AI recap workflow.
-- Existing project rows remain valid; new columns are additive and safe to roll out.

alter table public.projects
  add column if not exists source_type text not null default 'youtube'
    check (source_type in ('youtube', 'upload')),
  add column if not exists storage_path text,
  add column if not exists script text;

comment on column public.projects.script is
  'AI-generated recap narration. Reuse this saved script instead of calling the paid model again.';
