import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 300;

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TIMEOUT_MS = 240_000;

function isValidYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const host = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (host === "youtu.be") return url.pathname.length > 1;
    if (host === "youtube.com" || host === "m.youtube.com") {
      return (url.pathname === "/watch" && Boolean(url.searchParams.get("v"))) ||
        ["/shorts/", "/embed/", "/live/"].some((prefix) =>
          url.pathname.startsWith(prefix) && url.pathname.length > prefix.length
        );
    }
    return false;
  } catch {
    return false;
  }
}

function getOutputText(data: any): string {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  if (Array.isArray(data?.steps)) {
    return data.steps.flatMap((step: any) => Array.isArray(step?.content) ? step.content : [])
      .filter((part: any) => typeof part?.text === "string")
      .map((part: any) => part.text)
      .join("\n").trim();
  }
  return "";
}

function parsePlan(raw: string, cueGroups: Array<{ startSeconds: number; endSeconds: number; text: string }> = []) {
  const cleaned = raw.replace(/^`{3}(?:json)?\s*/i, "").replace(/\s*`{3}$/i, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed?.segments) || parsed.segments.length < 1 || parsed.segments.length > 40) {
    throw new Error("The AI did not return a usable scene list. Please try again.");
  }
  const usedCueIndexes = new Set<number>();
  const segments = parsed.segments.map((item: any, index: number) => {
    const start = Number(item?.sourceStartSeconds);
    const end = Number(item?.sourceEndSeconds);
    const cueIndex = Number(item?.cueIndex);
    const cue = cueGroups.length && Number.isInteger(cueIndex) ? cueGroups[cueIndex] : null;
    const narrationStart = cue ? cue.startSeconds : Number(item?.narrationStartSeconds);
    const narrationEnd = cue ? cue.endSeconds : Number(item?.narrationEndSeconds);
    const narration = cue ? cue.text : String(item?.narrationText ?? "").trim();
    const reason = String(item?.sceneReason ?? "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start < 1 || end - start > 18) {
      throw new Error("The AI returned invalid source-scene timestamps. Please regenerate the scene plan.");
    }
    if (cueGroups.length && (!Number.isInteger(cueIndex) || !cue || cueIndex < 0 || cueIndex >= cueGroups.length || usedCueIndexes.has(cueIndex))) {
      throw new Error("The AI returned a missing or duplicate SRT time window. Please regenerate the scene plan.");
    }
    if (cueGroups.length) usedCueIndexes.add(cueIndex);
    if (!Number.isFinite(narrationStart) || !Number.isFinite(narrationEnd) || narrationStart < 0 || narrationEnd <= narrationStart || narrationEnd - narrationStart > 180) {
      throw new Error("The AI returned invalid narration timing. Please regenerate the scene plan.");
    }
    if (!narration || !reason) {
      throw new Error("The AI returned an incomplete scene description. Please regenerate the scene plan.");
    }
    return {
      index: index + 1,
      sourceStartSeconds: Math.round(start * 10) / 10,
      sourceEndSeconds: Math.round(end * 10) / 10,
      narrationStartSeconds: Math.round(narrationStart * 1000) / 1000,
      narrationEndSeconds: Math.round(narrationEnd * 1000) / 1000,
      narrationText: narration.slice(0, 1200),
      sceneReason: reason.slice(0, 300),
    };
  });
  if (cueGroups.length && usedCueIndexes.size !== cueGroups.length) {
    throw new Error("The AI did not select a scene for every SRT time window. Please regenerate the scene plan.");
  }
  return { segments };
}

export async function POST(request: NextRequest) {
  try {
    const authorization = request.headers.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!token || !supabaseUrl || !supabaseKey) {
      return NextResponse.json({ success: false, error: "Sign in before generating a scene plan." }, { status: 401 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) {
      return NextResponse.json({ success: false, error: "Your session expired. Please sign in again." }, { status: 401 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ success: false, error: "GEMINI_API_KEY is not configured on the server." }, { status: 500 });
    }

    const body = await request.json();
    const videoUrl = String(body.videoUrl ?? "").trim();
    const script = String(body.script ?? "").trim();
    const language = body.language === "English" ? "English" : "Burmese";
    const style = ["cinematic", "fast_paced", "documentary"].includes(body.style) ? body.style : "cinematic";
    const aspectRatio = body.aspectRatio === "9:16" ? "9:16" : "16:9";
    const audioDuration = Number(body.audioDuration);
    const rawCueGroups = Array.isArray(body.subtitleCues) ? body.subtitleCues : [];
    const cueGroups = rawCueGroups.slice(0, 40).map((cue: any) => ({
      startSeconds: Number(cue?.startSeconds),
      endSeconds: Number(cue?.endSeconds),
      text: String(cue?.text ?? "").trim().slice(0, 2400),
    })).filter((cue: any) => Number.isFinite(cue.startSeconds) && Number.isFinite(cue.endSeconds) &&
      cue.startSeconds >= 0 && cue.endSeconds > cue.startSeconds && cue.endSeconds <= audioDuration + 0.1 && cue.text);

    if (!Number.isFinite(audioDuration) || audioDuration <= 0 || audioDuration > 600 ||
      cueGroups.length < 1 || cueGroups.length !== rawCueGroups.length) {
      return NextResponse.json({ success: false, error: "A valid WAV duration and up to 40 matching SRT time windows are required." }, { status: 400 });
    }

    if (!isValidYouTubeUrl(videoUrl)) {
      return NextResponse.json({ success: false, error: "Enter a valid public YouTube URL." }, { status: 400 });
    }
    if (script.length < 80 || script.length > 30000) {
      return NextResponse.json({ success: false, error: "A generated recap script between 80 and 30,000 characters is required." }, { status: 400 });
    }

    const prompt = [
      "You are a professional film editor creating a timestamped edit decision list for a recap video.",
      "Analyze the actual YouTube video supplied with this request. Do not infer scenes from its title or from outside knowledge.",
      "Match source footage to the supplied narration in chronological narration order. Select visually relevant moments; do not simply choose evenly spaced timestamps.",
      "Use source timestamps in seconds measured from the beginning of the YouTube video.",
      "Create one concise segment for every supplied SRT cue group. The cue group count is authoritative.",
      "Each source segment must be between 1 and 18 seconds. Segments must be within the actual source video duration, non-negative, and end after they start.",
      "Avoid repeating the same source moment unless it is genuinely relevant. Prefer scene changes and action that supports the narration.",
      "Editing style: " + style + ". Output aspect ratio: " + aspectRatio + ".",
      "Narration language: " + language + ".",
      "The supplied SRT time windows are authoritative. They are exact positions on the existing WAV narration timeline, not estimates.",
      "Return exactly one scene per supplied cue group, preserving each cueIndex exactly once. Do not change or estimate narration start/end times.",
      "For every cue group, select source footage that visually matches its subtitle text and the nearby narration script. Use only source timestamps you can verify in the actual video.",
      "Each source segment must be between 1 and 18 seconds. Do not reuse the same source moment unless necessary.",
      "Return sourceStartSeconds, sourceEndSeconds, cueIndex, and sceneReason for each item. Do not return narration timing fields.",
      "If the video is inaccessible or a scene cannot be verified, return an error object instead of guessing.",
      "Return ONLY valid JSON, no markdown, in this exact shape:",
      '{"segments":[{"cueIndex":0,"sourceStartSeconds":12.5,"sourceEndSeconds":20.0,"sceneReason":"what is visible and why it matches"}]}',
      "Exact SRT windows (seconds from the start of the WAV) and their text:",
      JSON.stringify(cueGroups),
      "Narration script for additional context:",
      script,
    ].join("\n\n");

    const models = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"];
    let lastMessage = "";
    for (const model of models) {
      let response: Response;
      try {
        response = await fetch(GEMINI_URL, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            input: [
              { type: "video", uri: videoUrl },
              { type: "text", text: prompt },
            ],
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return NextResponse.json({
          success: false,
          error: timedOut ? "Video scene analysis exceeded the 4-minute limit. Please try again later." :
            "Could not connect to Gemini to analyze the YouTube video.",
        }, { status: timedOut ? 504 : 502 });
      }

      const data = await response.json().catch(() => null);
      if (response.ok) {
        const raw = getOutputText(data);
        if (!raw) return NextResponse.json({ success: false, error: "Gemini returned no scene plan. The video may be private or unavailable." }, { status: 502 });
        try {
          const plan = parsePlan(raw, cueGroups);
          return NextResponse.json({ success: true, provider: "Google Gemini API", model, aspectRatio, style, timingSource: "srt", ...plan });
        } catch (error) {
          return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Gemini returned an invalid scene plan." }, { status: 502 });
        }
      }

      lastMessage = String(data?.error?.message ?? data?.message ?? "Gemini request failed.");
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        return NextResponse.json({ success: false, error: lastMessage }, { status: response.status });
      }
      if (response.status !== 429) continue;
    }

    return NextResponse.json({
      success: false,
      error: lastMessage.toLowerCase().includes("quota")
        ? "Gemini free-tier quota is currently exhausted. Please wait and try again."
        : "Gemini could not analyze the video right now. " + lastMessage,
    }, { status: 429 });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Could not generate the AI scene plan.",
    }, { status: 500 });
  }
}
