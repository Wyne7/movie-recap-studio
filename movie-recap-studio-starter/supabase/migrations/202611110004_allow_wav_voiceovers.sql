-- MyanmarTTS returns WAV audio. Keep the bucket private and allow both
-- legacy MP3 files and the new WAV output during the provider transition.
update storage.buckets
set allowed_mime_types = array['audio/mpeg', 'audio/wav']
where id = 'voiceovers';
