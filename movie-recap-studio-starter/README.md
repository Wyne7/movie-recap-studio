# Movie Recap Studio — Foundation 0.2

A Next.js + TypeScript starter for Movie Recap Studio. This milestone adds optional Supabase email/password authentication and cloud project persistence protected by PostgreSQL Row Level Security (RLS).

## Requirements

- Node.js 20.9 or newer
- npm
- Visual Studio Code
- A Supabase project (optional for local-preview mode)

## Run locally

```powershell
npm install
npm run dev
```

Open http://localhost:3000.

## Supabase setup

1. Create a project at https://supabase.com/dashboard.
2. In the Supabase project, open **SQL Editor**, create a new query, paste the contents of `supabase/migrations/202611110001_create_projects.sql`, and run it.
3. Open **Project Settings → API** (or the API Keys section). Copy the Project URL and the **publishable** key. Do not use a secret/service-role key in the browser.
4. In the project root, create a file named `.env.local` (next to `package.json`) with:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

5. In Supabase, open **Authentication → URL Configuration**. Set the Site URL to `http://localhost:3000`. Add `http://localhost:3000/**` to the Redirect URLs list for local development.
6. Restart Next.js after changing `.env.local`:

```powershell
# Stop the current dev server with Ctrl+C, then:
npm run dev
```

7. Open http://localhost:3000, create an account, and confirm the email if email confirmation is enabled for the project. Then sign in. New projects are stored in Supabase and scoped to the signed-in user.

## Local preview without Supabase

If `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is missing, the app stays in local-preview mode and stores draft projects in the current browser's localStorage.

## What's included

- Responsive dashboard and create-project modal
- Source URL validation
- Myanmar / English narration selection
- Female / Male voice selection
- Recap length selection
- Project list, search, and delete
- Optional Supabase email/password authentication
- User-owned `projects` table with RLS policies
- LocalStorage fallback for UI development without Supabase

## Security notes

- The Supabase publishable key is designed for use in browser apps. It is not a secret; RLS is mandatory and enabled by the included migration.
- Never put a Supabase secret/service-role key, Gemini API key, Azure Speech key, or R2 secret in a `NEXT_PUBLIC_` variable.
- The migration grants authenticated users access only to rows whose `user_id` equals `auth.uid()`.
- Use only original, licensed or otherwise authorized video and audio media. This starter does not download or scrape video sources.

## Current limitations

This milestone saves project metadata only. It does not yet analyze video, generate narration, time subtitles, upload source files, or render MP4 files. Those are the next milestones.

## MyanmarTTS voiceover (open source)

The authenticated `/api/generate-voiceover` route calls the separately hosted Python service in `myanmar-tts-service/`. It uses `freococo/MyanmarTTS` for Burmese-only narration and stores WAV output in the existing private Supabase `voiceovers` bucket.

### Deployment

1. Create a **Docker Space** on Hugging Face and upload the contents of `myanmar-tts-service/`.
2. Add a Space secret named `MYANMAR_TTS_SERVICE_TOKEN` with a long random value.
3. Wait for the model to load, then check `https://YOUR-SPACE.hf.space/health`.
4. In Vercel Environment Variables, add server-only `MYANMAR_TTS_SERVICE_URL` (Space URL) and `MYANMAR_TTS_SERVICE_TOKEN` (same secret).
5. Redeploy Vercel.
6. Open a saved project with a Myanmar-language script and choose **Generate Voiceover**.

Never prefix either service variable with `NEXT_PUBLIC_`. The service token must remain server-side.

### Free-tier and operational caveats

- The model and generated audio are CC0. The model supports Burmese only and currently has one built-in voice; the app's Male/Female preference does not change the synthesized voice.
- The model card says CPU inference is supported but slower. Hugging Face lists CPU Basic as 2 vCPU / 16 GB RAM with no hourly compute charge, and Spaces can sleep after inactivity.
- **Important:** Hugging Face documentation also says creating compute-backed Docker/Gradio Spaces may require a paid Hugging Face plan, even when CPU Basic has no hourly compute price. Confirm your account's eligibility before relying on this as a zero-cost host.
- Vercel Hobby function duration and memory limits apply. This route requests up to 300 seconds; actual limits depend on Fluid Compute and the Vercel plan. Long scripts on CPU can time out.
- The synchronous integration is capped at 3,500 characters. Reliable longer recaps should move to an asynchronous job queue with chunked synthesis.

### Security

The Next.js route validates the signed-in Supabase user and project ownership. The Python service requires a private bearer token. Generated audio is uploaded to private Supabase Storage and played with a one-hour signed URL.
