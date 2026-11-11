import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Buffer } from "node:buffer";

export const runtime = "nodejs";
export const maxDuration = 60;

const OPENROUTER_TTS_URL = "https://openrouter.ai/api/v1/audio/speech";
const TTS_MODEL = "google/gemini-3.8-flash-tts";
const MAX_SCRIPT_CHARACTERS = 10_000;

export async function POST(request: NextRequest) {
  try {
    const authorization = request.headers.get("authorization") || "";
    const accessToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    if (!accessToken || !supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { success: false, error: "Sign in to your account before generating a voiceover." },
        { status: 401 }
      );
    }

    if (!openRouterKey) {
      return NextResponse.json(
        { success: false, error: "OPENROUTER_API_KEY is not configured. Add it to the server environment variables." },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: "Bearer " + accessToken } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !authData.user) {
      return NextResponse.json(
        { success: false, error: "Your session is invalid or expired. Please sign in again." },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const projectId = String(body.projectId || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
      return NextResponse.json(
        { success: false, error: "A valid project ID is required." },
        { status: 400 }
      );
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,user_id,title,script,voice,voiceover_path")
      .eq("id", projectId)
      .eq("user_id", authData.user.id)
      .single();

    if (projectError || !project) {
      return NextResponse.json(
        { success: false, error: "Project not found in your account." },
        { status: 404 }
      );
    }

    const script = typeof project.script === "string" ? project.script.trim() : "";
    if (!script) {
      return NextResponse.json(
        { success: false, error: "Generate and save a recap script before creating its voiceover." },
        { status: 400 }
      );
    }

    if (script.length > MAX_SCRIPT_CHARACTERS) {
      return NextResponse.json(
        { success: false, error: "This script is too long for one voiceover request. Shorten the script or split it into scenes before generating audio." },
        { status: 413 }
      );
    }

    // Gemini's Lite speech model is the budget-oriented OpenRouter TTS option.
    // Keep voice selection tied to the saved project setting, not client input.
    const voice = project.voice === "Male" ? "Charon" : "Kore";
    const upstream = await fetch(OPENROUTER_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + openRouterKey,
        "Content-Type": "application/json",
        "X-Title": "Movie Recap Studio",
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: script,
        voice,
        response_format: "mp3",
        speed: 1,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(52_000),
    });

    if (!upstream.ok) {
      const errorText = await upstream.text();
      let message = "OpenRouter TTS returned HTTP " + upstream.status + ".";
      try {
        const errorData = JSON.parse(errorText);
        message = errorData?.error?.message || errorData?.message || message;
      } catch {
        if (errorText.trim()) message = errorText.slice(0, 500);
      }

      return NextResponse.json(
        { success: false, error: message },
        { status: upstream.status >= 500 ? 502 : upstream.status }
      );
    }

    const audioBytes = Buffer.from(await upstream.arrayBuffer());
    if (!audioBytes.length) {
      return NextResponse.json(
        { success: false, error: "OpenRouter returned an empty audio file." },
        { status: 502 }
      );
    }

    const voiceoverPath = authData.user.id + "/" + project.id + "/voiceover.mp3";
    const storage = supabase.storage.from("voiceovers");
    const { error: uploadError } = await storage.upload(voiceoverPath, audioBytes, {
      contentType: "audio/mpeg",
      cacheControl: "3600",
      upsert: true,
    });

    if (uploadError) {
      return NextResponse.json(
        { success: false, error: "Audio was generated but could not be saved to private storage: " + uploadError.message },
        { status: 500 }
      );
    }

    const { error: updateError } = await supabase
      .from("projects")
      .update({
        voiceover_path: voiceoverPath,
        voiceover_model: TTS_MODEL,
        voiceover_voice: voice,
        voiceover_generated_at: new Date().toISOString(),
      })
      .eq("id", project.id)
      .eq("user_id", authData.user.id);

    if (updateError) {
      await storage.remove([voiceoverPath]);
      return NextResponse.json(
        { success: false, error: "Audio was generated but its project record could not be updated: " + updateError.message },
        { status: 500 }
      );
    }

    const { data: signedData, error: signedError } = await storage.createSignedUrl(voiceoverPath, 60 * 60);
    if (signedError || !signedData?.signedUrl) {
      return NextResponse.json(
        { success: false, error: "Voiceover was saved, but a preview link could not be created. Reopen the project and try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      voiceoverPath,
      signedUrl: signedData.signedUrl,
      model: TTS_MODEL,
      voice,
      mimeType: "audio/mpeg",
      generationId: upstream.headers.get("x-generation-id"),
      characterCount: script.length,
    });
  } catch (error) {
    console.error("Voiceover generation failed:", error);
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "Voice generation took too long. Please try again; no audio was saved."
        : error instanceof Error
          ? error.message
          : "Could not generate the voiceover.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
