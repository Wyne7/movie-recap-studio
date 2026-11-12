import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const MODEL = "gemini-3.6-flash";
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

function isValidYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
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
    const recapType = body.recapType === "review" ? "review" : "full_recap";
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
      recapType === "review"
        ? "Create a movie review/commentary: briefly summarize the premise, then give original analysis of themes, characters, performances, pacing, strengths, weaknesses, and commentary. Do not retell every scene."
        : "Create a chronological full story recap from beginning to ending, covering major plot turns and character motivations in your own words.",
      "For non-movie videos, narrate the actual events and key points in sequence.",
      "Use natural spoken narration suitable for voice-over.",
      "Do not invent scenes, goals, dialogue, scores, or facts.",
      "Do not reproduce dialogue or distinctive copyrighted expression.",
      "If the video cannot be accessed or does not provide enough information, say so clearly rather than guessing.",
      "Project title: " + title + ".",
      "Return only the finished narration script."
    ].join("\\n");

    const models = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"];
    let upstream: Response | null = null;
    let data: any = null;
    let activeModel = models[0];
    let lastUpstreamMessage = "";

    // Retry transient overloads, then fall back to another currently supported
    // stable Flash model. Keep the same user request and video URL throughout.
    for (const model of models) {
      activeModel = model;
      let shouldTryFallback = false;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(GEMINI_INTERACTIONS_URL, {
          method: "POST",
          headers: {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: [
              { type: "video", uri: videoUrl },
              { type: "text", text: prompt },
            ],
          }),
          cache: "no-store",
        });

        const responseData = await response.json().catch(() => null);
        upstream = response;
        data = responseData;

        if (response.ok) {
          shouldTryFallback = false;
          break;
        }

        lastUpstreamMessage =
          responseData?.error?.message ||
          responseData?.message ||
          "Gemini returned HTTP " + response.status + ".";

        const transient = [429, 500, 502, 503, 504].includes(response.status);
        if (!transient) {
          shouldTryFallback = false;
          break;
        }

        shouldTryFallback = true;
        // Quota exhaustion is unlikely to clear within this request; switch models.
        if (response.status === 429) break;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }

      if (upstream?.ok) break;
      if (!shouldTryFallback) break;
    }

    if (!upstream) {
      throw new Error("Gemini did not return a response. Please try again.");
    }

    if (!upstream.ok) {
      const upstreamMessage = lastUpstreamMessage || "Gemini could not generate the recap.";
      const normalized = String(upstreamMessage).toLowerCase();

      if (normalized.includes("location") && (normalized.includes("not supported") || normalized.includes("unsupported"))) {
        return NextResponse.json(
          { success: false, error: "Gemini API is not available in the region detected by Google for this request. Check Google's supported-region rules; a VPN on your phone does not change the region of a Vercel server request." },
          { status: 403 }
        );
      }

      if (upstream.status === 429) {
        return NextResponse.json(
          { success: false, error: "Gemini free-tier quota/rate limit is currently exhausted across the available fallback models. Please wait for quota to reset and try again." },
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
        { success: false, error: "All configured Gemini models are temporarily unavailable. Last provider message: " + upstreamMessage },
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
      model: activeModel,
      title,
      language,
      duration,
      recapType,
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
