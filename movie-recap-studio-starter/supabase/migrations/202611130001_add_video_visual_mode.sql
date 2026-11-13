-- Persist the selected visual source for each recap project.
alter table public.projects
  add column if not exists video_visual_mode text not null default 'original_clips'
  check (video_visual_mode in ('original_clips', 'ai_visuals'));
