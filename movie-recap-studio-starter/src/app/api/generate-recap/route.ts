import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const MODEL = "google/gemini-3-flash-preview";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function isValidYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return false;
    }

    if (hostname === "youtu.be") {
      return url.pathname.length > 1;
    }

    if (hostname === "youtube.com" || hostname === "m.youtube.com") {
      return (
        (url.pathname === "/watch" && Boolean(url.searchParams.get("v"))) ||
        /^\/(shorts|embed|live)\/[^/]+/.test(url.pathname)
      );
    }

    return false;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "OPENROUTER_API_KEY is not configured on the server." },
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

    const maxTokens =
      duration === "3 min" ? 1800 : duration === "5 min" ? 3000 : 5200;

    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
        "X-OpenRouter-Title": "Movie Recap Studio",
      },
      body: JSON.stringify({
        model: MODEL,
        provider: {
          only: ["google-ai-studio"],
          allow_fallbacks: false,
        },
        messages: [
          {
            role: "system",
            content: [
              "You are a careful professional video recap writer.",
              "Write a narration script in " + language + " for a target runtime of " + duration + ".",
              "Analyze the actual supplied YouTube video, not just its title.",
              "For a movie, explain the main story in chronological order.",
              "For a sports/highlights video, narrate the actual events in sequence.",
              "Explain key people, events, turning points, and the ending where available.",
              "Use natural spoken narration suitable for voice-over.",
              "Do not invent scenes, goals, dialogue, scores, or facts.",
              "If the video cannot be accessed or does not provide enough information, say so clearly rather than guessing.",
              "Return only the finished narration script."
            ].join("\\n"),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Analyze this YouTube video and create a " + duration +
                  " recap narration in " + language + ". Video title: " + title +
                  ". Identify what the video actually contains; do not infer the content from the title alone.",
              },
              {
                type: "video_url",
                video_url: {
                  url: videoUrl,
                  processing: "agentic",
                },
              },
            ],
          },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      cache: "no-store",
    });

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      const upstreamMessage =
        data?.error?.message ||
        data?.message ||
        "OpenRouter returned HTTP " + upstream.status + ".";

      const status = upstream.status === 402 ? 402 :
        upstream.status === 429 ? 429 :
        upstream.status >= 500 ? 502 : upstream.status;

      return NextResponse.json(
        {
          success: false,
          error: status === 402
            ? "OpenRouter balance or account limit is too low for video analysis. Check your OpenRouter credits and usage limits."
            : status === 429
              ? "OpenRouter rate limit reached. Please wait before trying again."
              : upstreamMessage,
        },
        { status }
      );
    }

    const content = data?.choices?.[0]?.message?.content;
    const script =
      typeof content === "string"
        ? content.trim()
        : Array.isArray(content)
          ? content
              .filter((part: { type?: string }) => part.type === "text")
              .map((part: { text?: string }) => part.text || "")
              .join("\\n")
              .trim()
          : "";

    if (!script) {
      return NextResponse.json(
        { success: false, error: "The AI returned an empty recap script." },
        { status: 502 }
      );
    }

    const usageCost =
      typeof data?.usage?.cost === "number" ? data.usage.cost : null;

    return NextResponse.json({
      success: true,
      provider: "Google AI Studio via OpenRouter",
      model: MODEL,
      title,
      language,
      duration,
      script,
      usageCost,
    });
  } catch (error) {
    console.error("YouTube recap generation failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error
          ? error.message
          : "Could not generate the recap script.",
      },
      { status: 500 }
    );
  }
}
