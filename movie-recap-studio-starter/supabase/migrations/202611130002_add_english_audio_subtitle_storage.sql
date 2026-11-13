-- Keep the generated English narration and timed subtitles with each project.
alter table public.projects
  add column if not exists english_audio_path text,
  add column if not exists english_srt_path text;

-- The private voiceovers bucket also stores generated WAV and SRT assets.
update storage.buckets
set allowed_mime_types = array['audio/mpeg', 'audio/wav', 'text/plain']
where id = 'voiceovers';

comment on column public.projects.english_audio_path is
  'Private Storage path for the generated English WAV narration.';
comment on column public.projects.english_srt_path is
  'Private Storage path for the generated English timed SRT subtitles.';
