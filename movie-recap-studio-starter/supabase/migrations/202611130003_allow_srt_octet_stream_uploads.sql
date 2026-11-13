-- Some browsers label selected .srt files as application/octet-stream.
-- Allow that MIME type in the private voiceovers bucket as well as text/plain.
update storage.buckets
set allowed_mime_types = array[
  'audio/mpeg',
  'audio/wav',
  'text/plain',
  'application/octet-stream'
]
where id = 'voiceovers';
