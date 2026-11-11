---
title: Movie Recap Studio Myanmar TTS
sdk: docker
app_port: 7860
---

# MyanmarTTS inference service

A small authenticated FastAPI wrapper around [freococo/MyanmarTTS](https://huggingface.co/freococo/MyanmarTTS).

## Hugging Face Spaces setup

1. Create a new **Docker Space** and select the free **CPU Basic** hardware.
2. Upload this directory's files to the Space repository (or connect the GitHub subdirectory using your preferred deployment workflow).
3. In Space **Settings → Variables and secrets**, add a secret named `MYANMAR_TTS_SERVICE_TOKEN` with a long random value.
4. Wait for the first build. The first boot downloads the model weights from Hugging Face and loads them into memory.
5. Check `https://YOUR-SPACE.hf.space/health`. It should return `{"status":"ok","model_loaded":true}`.

Free CPU Spaces can sleep after inactivity. The first request after sleep may be slow while the container and model start. CPU inference is slower than GPU inference.

## Vercel setup

In the Vercel project, add these server-only environment variables:

- `MYANMAR_TTS_SERVICE_URL` = `https://YOUR-SPACE.hf.space` (no trailing slash)
- `MYANMAR_TTS_SERVICE_TOKEN` = the exact same secret used in the Space

Do not prefix either variable with `NEXT_PUBLIC_`. Redeploy Vercel after saving them.

The Next.js API authenticates the signed-in Supabase user, sends the saved Burmese script to this service, and stores the returned WAV in the private Supabase `voiceovers` bucket.

## API

- `GET /health` — readiness check, no secret required.
- `POST /tts` — requires `Authorization: Bearer <MYANMAR_TTS_SERVICE_TOKEN>`; JSON body: `{"text":"မြန်မာစာ","steps":8}`; returns `audio/wav`.

The service accepts Burmese text up to 3,500 characters and uses 8 Euler steps for a faster CPU-friendly first version. The model currently exposes one default reference voice; the app's Male/Female preference is not applied by this model.

## Cost and limitations

The model and generated audio are CC0. CPU Basic hardware has no hourly compute charge, but free Spaces sleep after inactivity and are not a guaranteed always-on production service. Hugging Face account/plan requirements may apply when creating a compute-backed Space. Heavy or long scripts may exceed Vercel's request duration; use short scripts for initial validation. For reliable high-volume production, move generation to a persistent job worker or paid GPU.

See the [model card](https://huggingface.co/freococo/MyanmarTTS) and [Hugging Face Spaces hardware/lifecycle documentation](https://huggingface.co/docs/hub/en/spaces-overview).
