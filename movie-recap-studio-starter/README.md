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
