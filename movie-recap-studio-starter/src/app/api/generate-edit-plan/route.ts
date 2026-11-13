import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 300;

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TIMEOUT_MS = 240_000;

function isValidYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\\./, "");
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

function parsePlan(raw: string) {
  const cleaned = raw.replace(/^`{3}(?:json)?\s*/i, "").replace(/\s*`{3}$/i, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed?.segments) || parsed.segments.length < 1 || parsed.segments.length > 40) {
    throw new Error("The AI did not return a usable scene list. Please try again.");
  }
  const segments = parsed.segments.map((item: any, index: number) => {
    const start = Number(item?.sourceStartSeconds);
    const end = Number(item?.sourceEndSeconds);
    const narration = String(item?.narrationText ?? "").trim();
    const reason = String(item?.sceneReason ?? "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 180) {
      throw new Error("The AI returned invalid scene timestamps. Please regenerate the scene plan.");
    }
    return {
      index: index + 1,
      sourceStartSeconds: Math.round(start * 10) / 10,
      sourceEndSeconds: Math.round(end * 10) / 10,
      narrationText: narration.slice(0, 1200),
      sceneReason: reason.slice(0, 300),
    };
  });
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
      "Create 8 to 24 concise segments, or fewer if the source does not contain enough distinct relevant scenes.",
      "Each source segment must be between 2 and 18 seconds. Segments must be within the actual source video duration, non-negative, and end after they start.",
      "Avoid repeating the same source moment unless it is genuinely relevant. Prefer scene changes and action that supports the narration.",
      "Editing style: " + style + ". Output aspect ratio: " + aspectRatio + ".",
      "Narration language: " + language + ".",
      "For each segment, include a short exact excerpt from the supplied narration that this footage should accompany, and a concise visual reason.",
      "Do not invent source events, dialogue, or timestamps. If the video is inaccessible or the scene cannot be verified, return an error object instead of guessing.",
      "Return ONLY valid JSON, no markdown, in this exact shape:",
      '{"segments":[{"sourceStartSeconds":12.5,"sourceEndSeconds":20.0,"narrationText":"short excerpt from the script","sceneReason":"what is visible and why it matches"}]}',
      "Narration script:",
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
          const plan = parsePlan(raw);
          return NextResponse.json({ success: true, provider: "Google Gemini API", model, aspectRatio, style, ...plan });
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
