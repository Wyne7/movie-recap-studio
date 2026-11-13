import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 300;

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const IMAGE_MODEL = "gemini-3.1-flash-image";

function isValidYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (hostname === "youtu.be") return url.pathname.length > 1;
    if (hostname === "youtube.com" || hostname === "m.youtube.com") {
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

function getImage(data: any): { imageBase64: string; mimeType: string } | null {
  const direct = data?.output_image;
  if (typeof direct?.data === "string") {
    return { imageBase64: direct.data, mimeType: String(direct.mime_type || "image/png") };
  }
  if (Array.isArray(data?.steps)) {
    for (const step of [...data.steps].reverse()) {
      if (!Array.isArray(step?.content)) continue;
      for (const part of step.content) {
        if (part?.type === "image" && typeof part.data === "string") {
          return { imageBase64: part.data, mimeType: String(part.mime_type || "image/png") };
        }
      }
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const authorization = request.headers.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!token || !supabaseUrl || !supabaseKey) {
      return NextResponse.json({ success: false, error: "Sign in before generating AI visuals." }, { status: 401 });
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
    const segment = body.segment ?? {};
    const sourceStart = Number(segment.sourceStartSeconds);
    const sourceEnd = Number(segment.sourceEndSeconds);
    const narrationText = String(segment.narrationText ?? "").trim().slice(0, 1200);
    const sceneReason = String(segment.sceneReason ?? "").trim().slice(0, 300);
    const style = ["cinematic", "fast_paced", "documentary"].includes(body.style) ? body.style : "cinematic";
    const aspectRatio = body.aspectRatio === "9:16" ? "9:16" : "16:9";

    if (!isValidYouTubeUrl(videoUrl)) {
      return NextResponse.json({ success: false, error: "Enter a valid public YouTube URL for AI visual generation." }, { status: 400 });
    }
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceStart < 0 || sourceEnd <= sourceStart || sourceEnd - sourceStart > 18) {
      return NextResponse.json({ success: false, error: "The selected scene has invalid source timestamps. Generate the scene plan again." }, { status: 400 });
    }
    if (!narrationText || !sceneReason) {
      return NextResponse.json({ success: false, error: "The scene plan is missing its visual description or narration excerpt." }, { status: 400 });
    }

    const prompt = [
      "Create one high-quality, original cinematic illustration for a movie recap video.",
      "Use the supplied public video as visual context and focus on the scene around source timestamp " +
        sourceStart.toFixed(1) + " to " + sourceEnd.toFixed(1) + " seconds.",
      "What should be depicted: " + sceneReason,
      "Narration this image accompanies: " + narrationText,
      "Editing style: " + style + ".",
      "Make a coherent, visually rich, story-relevant image with strong composition and no text, captions, logos, watermarks, borders, or UI.",
      "Create a new illustrative interpretation. Do not reproduce an exact video frame, poster, trademark, or distinctive copyrighted character design.",
      "The image is one still in a larger sequence, so avoid title-card layouts.",
    ].join("\n\n");

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        input: [
          { type: "video", uri: videoUrl, mime_type: "video/mp4" },
          { type: "text", text: prompt },
        ],
        response_format: { type: "image", aspect_ratio: aspectRatio },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(240_000),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(data?.error?.message ?? data?.message ?? "Gemini image generation failed.");
      const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status;
      return NextResponse.json({
        success: false,
        error: response.status === 429
          ? "Gemini image-generation quota is currently unavailable or exhausted. Please wait and try again."
          : message,
      }, { status });
    }

    const image = getImage(data);
    if (!image) {
      return NextResponse.json({
        success: false,
        error: "Gemini did not return an image for this scene. Try again or upload your own image.",
      }, { status: 502 });
    }

    return NextResponse.json({ success: true, ...image, model: IMAGE_MODEL });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json({
      success: false,
      error: timedOut
        ? "AI visual generation took too long. Please try this scene again."
        : error instanceof Error ? error.message : "Could not generate an AI visual.",
    }, { status: timedOut ? 504 : 500 });
  }
}
