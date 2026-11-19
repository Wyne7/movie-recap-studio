import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 180;

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

function getOutputText(data: any): string {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  if (Array.isArray(data?.steps)) {
    return data.steps.flatMap((step: any) => Array.isArray(step?.content) ? step.content : [])
      .filter((part: any) => typeof part?.text === "string")
      .map((part: any) => part.text).join("\n").trim();
  }
  return "";
}

function parseStory(raw: string, durationSeconds: number) {
  const cleaned = raw.replace(/^`{3}(?:json)?\s*/i, "").replace(/\s*`{3}$/, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Repair the malformed pattern: "visualPrompt":,"A man ..."
    const repaired = cleaned.replace(/(:\s*),\s*(?=")/g, "$1");
    parsed = JSON.parse(repaired);
  }
  const title = String(parsed?.title ?? "").trim().slice(0, 100);
  const logline = String(parsed?.logline ?? "").trim().slice(0, 500);
  const characterBible = String(parsed?.characterBible ?? "").trim().slice(0, 2000);
  if (!title || !logline || !characterBible || !Array.isArray(parsed?.scenes) ||
      parsed.scenes.length < 4 || parsed.scenes.length > 12) {
    throw new Error("The AI did not return a complete story with 4–12 scenes. Please try again.");
  }
  const scenes = parsed.scenes.map((scene: any, index: number) => ({
    index: index + 1,
    narrationText: String(scene?.narrationText ?? "").trim().slice(0, 900),
    visualPrompt: String(scene?.visualPrompt ?? "").trim().slice(0, 700),
    mood: String(scene?.mood ?? "").trim().slice(0, 80),
  }));
  if (scenes.some((scene: any) => scene.narrationText.length < 20 || scene.visualPrompt.length < 20)) {
    throw new Error("One or more story scenes are missing narration or visual descriptions. Please regenerate.");
  }
  const script = scenes.map((scene: any) => scene.narrationText).join("\n\n");
  if (script.length > 7000) {
    throw new Error("The generated story is too long. Please choose a different duration.");
  }
  const wordCount = script.trim().split(/\s+/).filter(Boolean).length;
  const wordTargets: Record<number, [number, number]> = {
    60: [105, 165],
    90: [160, 230],
    120: [220, 310],
    180: [330, 450],
  };
  const [minimumWords, maximumWords] = wordTargets[durationSeconds] ?? [105, 165];
  if (wordCount < minimumWords || wordCount > maximumWords) {
    throw new Error(
      "The story narration has " + wordCount + " words, but a " +
      Math.round(durationSeconds / 60) + "-minute story needs about " +
      minimumWords + "–" + maximumWords + " words. Please regenerate."
    );
  }
  return { title, logline, characterBible, script, scenes };
}

export async function POST(request: NextRequest) {
  try {
    const authorization = request.headers.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!token || !supabaseUrl || !supabaseKey) {
      return NextResponse.json({ success: false, error: "Sign in before creating an AI story." }, { status: 401 });
    }
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) {
      return NextResponse.json({ success: false, error: "Your session expired. Please sign in again." }, { status: 401 });
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ success: false, error: "GEMINI_API_KEY is not configured." }, { status: 500 });

    const body = await request.json();
    const idea = String(body.idea ?? "").trim().slice(0, 1200);
    const language = body.language === "English" ? "English" : "Myanmar";
    const genre = ["adventure", "mystery", "fantasy", "romance", "horror", "comedy", "inspirational"].includes(body.genre)
      ? body.genre : "adventure";
    const durationSeconds = [60, 90, 120, 180].includes(Number(body.durationSeconds)) ? Number(body.durationSeconds) : 90;
    const visualStyle = ["cinematic", "storybook", "anime-inspired", "3d-animation"].includes(body.visualStyle)
      ? body.visualStyle : "cinematic";
    if (idea.length < 8) {
      return NextResponse.json({ success: false, error: "Describe the story idea in at least 8 characters." }, { status: 400 });
    }

    const sceneCount = durationSeconds <= 90 ? "4–5" : durationSeconds <= 120 ? "5–6" : "6–8";
    const wordRange = durationSeconds === 60 ? "120–145" : durationSeconds === 90 ? "180–210" : durationSeconds === 120 ? "250–290" : "380–420";
    const prompt = [
      "Write an original, engaging short story and a matching visual storyboard. Do not adapt existing copyrighted works or characters.",
      "Language: " + language + ". Genre: " + genre + ". Target spoken duration: " + durationSeconds + " seconds.",
      "CRITICAL NARRATION LENGTH: The complete spoken narration MUST contain " + wordRange + " words. This is mandatory; do not write a summary or a short version. Target a natural narration pace of about 130–140 words per minute.",
      "Use a strong opening, clear character motivation, rising action, one meaningful emotional turn, and a satisfying ending.",
      "Create " + sceneCount + " sequential scenes. Distribute the full word target evenly across scenes. For a 3-minute story, each of 6–8 scenes should usually contain about 50–65 spoken words, not just 1–2 short sentences.",
      "Each narrationText should be a complete, detailed voiceover passage with enough natural spoken content to reach the required total word count. Do not use filler or repeat ideas.",
      "Keep character appearance and clothing consistent. characterBible: one concise appearance guide.",
      "Each visualPrompt: one concise image prompt matching its narration, including subject/action, setting, framing, and lighting. No text, logos, or watermark.",
      "Keep the story suitable for a general audience.",
      "Before returning JSON, check that all narrationText fields combined contain " + wordRange + " words. Expand scenes if needed.",
      "Return ONLY valid JSON, no markdown, using this exact shape:",
      '{"title":"Short title","logline":"One sentence","characterBible":"Concise character appearance guide","scenes":[{"narrationText":"A full voiceover passage with sufficient words for the requested duration.","visualPrompt":"Concise scene image prompt.","mood":"wonder"}]}',
      "Story idea: " + idea,
    ].join("\n");

    let lastMessage = "";
    for (const model of ["gemini-3.5-flash-lite", "gemini-3.7-flash"]) {
      const response = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: [{ type: "text", text: prompt }] }),
        cache: "no-store",
        signal: AbortSignal.timeout(65_000),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        const raw = getOutputText(data);
        if (!raw) return NextResponse.json({ success: false, error: "Gemini returned an empty story. Please try again." }, { status: 502 });
        try {
          return NextResponse.json({ success: true, model, language, genre, durationSeconds, visualStyle, ...parseStory(raw, durationSeconds) });
        } catch (error) {
          lastMessage = error instanceof Error ? error.message : "The AI story format was invalid.";
          // Retry with the fallback model if this response is malformed.
          continue;
        }
      }
      lastMessage = String(data?.error?.message ?? data?.message ?? "Gemini request failed.");
      if (![500, 502, 503, 504].includes(response.status)) {
        return NextResponse.json({ success: false, error: lastMessage }, { status: response.status });
      }
      if (response.status === 429) break;
    }
    const invalidJson = /json|unexpected token|complete story|scene/i.test(lastMessage);
    return NextResponse.json({ success: false, error: invalidJson
      ? "Gemini returned an incomplete story format twice. Please try again."
      : lastMessage.toLowerCase().includes("quota")
        ? "Gemini free-tier quota is exhausted. Please wait and try again."
        : "Gemini could not create the story right now. " + lastMessage }, { status: invalidJson ? 502 : 429 });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json({ success: false, error: timedOut
      ? "Story generation took too long. Please try again."
      : error instanceof Error ? error.message : "Could not generate the story." }, { status: timedOut ? 504 : 500 });
  }
}
