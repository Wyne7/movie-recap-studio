-- OpenRouter TTS output: store private voiceover objects per authenticated user.
alter table public.projects
  add column if not exists voiceover_path text,
  add column if not exists voiceover_model text,
  add column if not exists voiceover_voice text,
  add column if not exists voiceover_generated_at timestamptz;

comment on column public.projects.voiceover_path is
  'Path to the private generated voiceover object in the voiceovers storage bucket.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voiceovers', 'voiceovers', false, 104857600, array['audio/mpeg'])
on conflict (id) do update
set public = false,
    file_size_limit = 104857600,
    allowed_mime_types = array['audio/mpeg'];

drop policy if exists "Users can read their own voiceovers" on storage.objects;
create policy "Users can read their own voiceovers"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'voiceovers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can upload their own voiceovers" on storage.objects;
create policy "Users can upload their own voiceovers"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'voiceovers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can update their own voiceovers" on storage.objects;
create policy "Users can update their own voiceovers"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'voiceovers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'voiceovers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their own voiceovers" on storage.objects;
create policy "Users can delete their own voiceovers"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'voiceovers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
