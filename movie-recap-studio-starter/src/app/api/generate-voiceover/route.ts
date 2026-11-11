import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Buffer } from "node:buffer";

export const runtime = "nodejs";
// Vercel Hobby supports up to 300s with Fluid Compute; without Fluid Compute
// the plan's function duration limit may be lower.
export const maxDuration = 300;

const MAX_SCRIPT_CHARACTERS = 3500;
const SERVICE_TIMEOUT_MS = 240_000;

function getSupabaseClient(accessToken: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: "Bearer " + accessToken } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function bearerToken(request: NextRequest) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

export async function GET(request: NextRequest) {
  try {
    const accessToken = bearerToken(request);
    const supabase = accessToken ? getSupabaseClient(accessToken) : null;
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Sign in before opening a saved voiceover." }, { status: 401 });
    }
    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !authData.user) {
      return NextResponse.json({ success: false, error: "Your session is invalid or expired." }, { status: 401 });
    }
    const projectId = new URL(request.url).searchParams.get("projectId") || "";
    const { data: project, error } = await supabase
      .from("projects").select("id,voiceover_path")
      .eq("id", projectId).eq("user_id", authData.user.id).single();
    if (error || !project?.voiceover_path) {
      return NextResponse.json({ success: false, error: "No saved voiceover exists for this project yet." }, { status: 404 });
    }
    const { data, error: signedError } = await supabase.storage.from("voiceovers")
      .createSignedUrl(project.voiceover_path, 60 * 60);
    if (signedError || !data?.signedUrl) {
      return NextResponse.json({ success: false, error: "Could not open the saved voiceover." }, { status: 500 });
    }
    return NextResponse.json({ success: true, signedUrl: data.signedUrl });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Could not open the voiceover." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const accessToken = bearerToken(request);
    const supabase = accessToken ? getSupabaseClient(accessToken) : null;
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Sign in to your account before generating a voiceover." }, { status: 401 });
    }

    const serviceUrl = process.env.MYANMAR_TTS_SERVICE_URL?.replace(/\/$/, "");
    const serviceToken = process.env.MYANMAR_TTS_SERVICE_TOKEN;
    if (!serviceUrl || !serviceToken) {
      return NextResponse.json({
        success: false,
        error: "MyanmarTTS is not configured yet. Deploy the Myanmar TTS service and add MYANMAR_TTS_SERVICE_URL and MYANMAR_TTS_SERVICE_TOKEN to Vercel.",
      }, { status: 503 });
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !authData.user) {
      return NextResponse.json({ success: false, error: "Your session is invalid or expired. Please sign in again." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const projectId = String(body.projectId || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
      return NextResponse.json({ success: false, error: "A valid project ID is required." }, { status: 400 });
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,user_id,title,script,language,voice,voiceover_path")
      .eq("id", projectId)
      .eq("user_id", authData.user.id)
      .single();

    if (projectError || !project) {
      return NextResponse.json({ success: false, error: "Project not found in your account." }, { status: 404 });
    }

    if (project.language !== "Myanmar") {
      return NextResponse.json({
        success: false,
        error: "MyanmarTTS currently generates Burmese narration only. Change this project's narration language to Myanmar first.",
      }, { status: 400 });
    }

    const script = typeof project.script === "string" ? project.script.trim() : "";
    if (!script) {
      return NextResponse.json({ success: false, error: "Generate and save a recap script before creating its voiceover." }, { status: 400 });
    }
    if (script.length > MAX_SCRIPT_CHARACTERS) {
      return NextResponse.json({
        success: false,
        error: "This Burmese script is too long for one free CPU request (maximum 3,500 characters). Shorten it before generating voiceover.",
      }, { status: 413 });
    }

    let upstream: Response;
    try {
      upstream = await fetch(serviceUrl + "/tts", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + serviceToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: script, steps: 8 }),
        cache: "no-store",
        signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error && error.name === "TimeoutError"
        ? "MyanmarTTS took too long. The free CPU service may be waking up or processing a long script. Please retry with a shorter script."
        : "Could not reach the MyanmarTTS service. Check that your Hugging Face Space is running.";
      return NextResponse.json({ success: false, error: message }, { status: 504 });
    }

    if (!upstream.ok) {
      const errorText = await upstream.text();
      let detail = "MyanmarTTS returned HTTP " + upstream.status + ".";
      try {
        const parsed = JSON.parse(errorText);
        detail = parsed?.detail || parsed?.error || detail;
      } catch {
        if (errorText.trim()) detail = errorText.slice(0, 400);
      }
      return NextResponse.json({ success: false, error: detail }, {
        status: upstream.status === 401 ? 502 : upstream.status,
      });
    }

    const contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "audio/wav" && contentType !== "audio/x-wav") {
      await upstream.body?.cancel();
      return NextResponse.json({ success: false, error: "MyanmarTTS returned " + (contentType || "an unknown format") + " instead of WAV audio." }, { status: 502 });
    }

    const audioBytes = Buffer.from(await upstream.arrayBuffer());
    if (!audioBytes.length) {
      return NextResponse.json({ success: false, error: "MyanmarTTS returned an empty audio file." }, { status: 502 });
    }

    const voiceoverPath = authData.user.id + "/" + project.id + "/voiceover.wav";
    const storage = supabase.storage.from("voiceovers");
    const { error: uploadError } = await storage.upload(voiceoverPath, audioBytes, {
      contentType: "audio/wav",
      cacheControl: "3600",
      upsert: true,
    });
    if (uploadError) {
      return NextResponse.json({ success: false, error: "Audio was generated but could not be saved to private storage: " + uploadError.message }, { status: 500 });
    }

    const { error: updateError } = await supabase
      .from("projects")
      .update({
        voiceover_path: voiceoverPath,
        voiceover_model: "freococo/MyanmarTTS",
        voiceover_voice: "default",
        voiceover_generated_at: new Date().toISOString(),
      })
      .eq("id", project.id)
      .eq("user_id", authData.user.id);

    if (updateError) {
      await storage.remove([voiceoverPath]);
      return NextResponse.json({ success: false, error: "Audio was generated but its project record could not be updated: " + updateError.message }, { status: 500 });
    }

    const { data: signedData, error: signedError } = await storage.createSignedUrl(voiceoverPath, 60 * 60);
    if (signedError || !signedData?.signedUrl) {
      return NextResponse.json({ success: false, error: "Voiceover was saved, but a preview link could not be created. Reopen the project and try again." }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      voiceoverPath,
      signedUrl: signedData.signedUrl,
      model: "freococo/MyanmarTTS",
      voice: "default",
      mimeType: "audio/wav",
      characterCount: script.length,
    });
  } catch (error) {
    console.error("MyanmarTTS voiceover generation failed:", error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Could not generate the Burmese voiceover.",
    }, { status: 500 });
  }
}
