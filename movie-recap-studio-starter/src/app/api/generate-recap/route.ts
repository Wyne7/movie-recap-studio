import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const MODEL = "gemini-3.6-flash";
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

function isValidYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www[.] /, "");
    const normalizedHost = hostname.startsWith("www.") ? hostname.slice(4) : hostname;

    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (normalizedHost === "youtu.be") return url.pathname.length > 1;

    if (normalizedHost === "youtube.com" || normalizedHost === "m.youtube.com") {
      return (
        (url.pathname === "/watch" && Boolean(url.searchParams.get("v"))) ||
        ["/shorts/", "/embed/", "/live/"].some(
          (prefix) => url.pathname.startsWith(prefix) && url.pathname.length > prefix.length
        )
      );
    }

    return false;
  } catch {
    return false;
  }
}

function extractGeneratedText(data: any): string {
  if (typeof data?.output_text === "string") return data.output_text.trim();

  if (Array.isArray(data?.steps)) {
    return data.steps
      .flatMap((step: any) => Array.isArray(step?.content) ? step.content : [])
      .filter((part: any) => typeof part?.text === "string")
      .map((part: any) => part.text)
      .join("\\n")
      .trim();
  }

  return "";
}

export async function POST(request: NextRequest) {
  try {
    const authorization = request.headers.get("authorization") || "";
    const accessToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabasePublishableKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!accessToken || !supabaseUrl || !supabasePublishableKey) {
      return NextResponse.json(
        { success: false, error: "Sign in to your account before generating a recap." },
        { status: 401 }
      );
    }

    const supabase = createClient(supabaseUrl, supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !authData.user) {
      return NextResponse.json(
        { success: false, error: "Your session is invalid or expired. Please sign in again." },
        { status: 401 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "GEMINI_API_KEY is not configured. Add your Gemini API key to the server environment variables." },
        { status: 500 }
      );
    }

    const body = await request.json();
    const videoUrl = String(body.videoUrl || "").trim();
    const title = String(body.title || "").trim() || "YouTube video";
    const language = body.language === "English" ? "English" : "Burmese";
    const allowedDurations = ["3 min", "5 min", "10 min"];
    const duration = allowedDurations.includes(body.duration) ? body.duration : "5 min";

    if (!isValidYouTubeUrl(videoUrl)) {
      return NextResponse.json(
        { success: false, error: "Enter a valid public YouTube video URL." },
        { status: 400 }
      );
    }

    if (title.length > 90) {
      return NextResponse.json(
        { success: false, error: "Project title must be 90 characters or fewer." },
        { status: 400 }
      );
    }

    const prompt = [
      "You are a careful professional video recap writer.",
      "Analyze the actual public YouTube video supplied immediately before this instruction. Do not infer the content from its title alone.",
      "Write a narration script in " + language + " for a target runtime of " + duration + ".",
      "For a movie, explain the main story in chronological order.",
      "For sports or highlights, narrate the actual events in sequence.",
      "Explain key people, events, turning points, and the ending where available.",
      "Use natural spoken narration suitable for voice-over.",
      "Do not invent scenes, goals, dialogue, scores, or facts.",
      "If the video cannot be accessed or does not provide enough information, say so clearly rather than guessing.",
      "Project title: " + title + ".",
      "Return only the finished narration script."
    ].join("\\n");

    const upstream = await fetch(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { type: "video", uri: videoUrl },
          { type: "text", text: prompt },
        ],
      }),
      cache: "no-store",
    });

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      const upstreamMessage =
        data?.error?.message ||
        data?.message ||
        "Gemini returned HTTP " + upstream.status + ".";
      const normalized = String(upstreamMessage).toLowerCase();

      if (normalized.includes("location") && (normalized.includes("not supported") || normalized.includes("unsupported"))) {
        return NextResponse.json(
          { success: false, error: "Gemini API is not available in the region detected by Google for this request. Check Google's supported-region rules; a VPN on your phone does not change the region of a Vercel server request." },
          { status: 403 }
        );
      }

      if (upstream.status === 429) {
        return NextResponse.json(
          { success: false, error: "Gemini free-tier rate limit reached. Please wait for the quota to reset before trying again." },
          { status: 429 }
        );
      }

      if (upstream.status === 401 || upstream.status === 403) {
        return NextResponse.json(
          { success: false, error: "Gemini rejected the API key or project access. Check that GEMINI_API_KEY is valid and that the project can use the Gemini API." },
          { status: upstream.status }
        );
      }

      return NextResponse.json(
        { success: false, error: upstreamMessage },
        { status: upstream.status >= 500 ? 502 : upstream.status }
      );
    }

    const script = extractGeneratedText(data);
    if (!script) {
      return NextResponse.json(
        { success: false, error: "Gemini returned no text. The YouTube video may be private, unavailable, or unsupported." },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      provider: "Google Gemini API",
      model: MODEL,
      title,
      language,
      duration,
      script,
      usageCost: 0,
    });
  } catch (error) {
    console.error("YouTube recap generation failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Could not generate the recap script." },
      { status: 500 }
    );
  }
}
