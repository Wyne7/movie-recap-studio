import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Buffer } from "node:buffer";

export const runtime = "nodejs";
export const maxDuration = 300;

type PcmWav = {
  pcm: Buffer;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
};

function readPcmWav(bytes: Buffer): PcmWav {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("The Burmese voice service returned an invalid WAV file.");
  }
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let pcm: Buffer | null = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) break;
    if (id === "fmt " && size >= 16) {
      audioFormat = bytes.readUInt16LE(start);
      channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
      bitsPerSample = bytes.readUInt16LE(start + 14);
    }
    if (id === "data") pcm = bytes.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (audioFormat !== 1 || !channels || !sampleRate || bitsPerSample !== 16 || !pcm?.length) {
    throw new Error("MyanmarTTS returned an unsupported WAV format. Expected 16-bit PCM audio.");
  }
  return { pcm, channels, sampleRate, bitsPerSample };
}

function combinePcmWavs(parts: PcmWav[]): { wav: Buffer; duration: number } {
  const first = parts[0];
  if (!first) throw new Error("MyanmarTTS did not return any audio.");
  if (parts.some((part) => part.channels !== first.channels || part.sampleRate !== first.sampleRate ||
      part.bitsPerSample !== first.bitsPerSample)) {
    throw new Error("MyanmarTTS returned audio parts with different WAV formats. Please retry.");
  }
  const pcm = Buffer.concat(parts.map((part) => part.pcm));
  const blockAlign = first.channels * (first.bitsPerSample / 8);
  const byteRate = first.sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(first.channels, 22);
  header.writeUInt32LE(first.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(first.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return { wav: Buffer.concat([header, pcm]), duration: pcm.length / byteRate };
}

function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const fraction = ms % 1000;
  return [h, m, s].map((value) => String(value).padStart(2, "0")).join(":") + "," + String(fraction).padStart(3, "0");
}

function wrapCaption(value: string) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? current + " " + word : word;
    if (current && next.length > 42) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines.slice(0, 3).join("\n");
}

export async function POST(request: NextRequest) {
  try {
    const authorization = request.headers.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceUrl = process.env.MYANMAR_TTS_SERVICE_URL?.replace(/\/$/, "");
    const serviceToken = process.env.MYANMAR_TTS_SERVICE_TOKEN;
    if (!token || !supabaseUrl || !supabaseKey) {
      return NextResponse.json({ success: false, error: "Sign in before generating a story voiceover." }, { status: 401 });
    }
    if (!serviceUrl || !serviceToken) {
      return NextResponse.json({ success: false, error: "MyanmarTTS is not configured on the server yet." }, { status: 503 });
    }
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: "Bearer " + token } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) {
      return NextResponse.json({ success: false, error: "Your session expired. Please sign in again." }, { status: 401 });
    }

    const body = await request.json();
    const storyId = String(body.storyId ?? "");
    const scenes = Array.isArray(body.scenes) ? body.scenes : [];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storyId) ||
        scenes.length < 4 || scenes.length > 12) {
      return NextResponse.json({ success: false, error: "A valid story ID and 4–12 story scenes are required." }, { status: 400 });
    }
    const texts = scenes.map((scene: any) => String(scene?.narrationText ?? "").trim());
    if (texts.some((text: string) => text.length < 20 || text.length > 900) ||
        texts.join(" ").length > 3500) {
      return NextResponse.json({ success: false, error: "The Burmese story must be 3,500 characters or fewer, with 4–12 complete scenes." }, { status: 413 });
    }

    const wavParts: PcmWav[] = [];
    const sceneTimings: Array<{ index: number; startSeconds: number; endSeconds: number }> = [];
    const cues: Array<{ startSeconds: number; endSeconds: number; text: string }> = [];
    let offset = 0;
    for (let index = 0; index < texts.length; index += 1) {
      const upstream = await fetch(serviceUrl + "/tts", {
        method: "POST",
        headers: { Authorization: "Bearer " + serviceToken, "Content-Type": "application/json" },
        body: JSON.stringify({ text: texts[index], steps: 8 }),
        cache: "no-store",
        signal: AbortSignal.timeout(45_000),
      });
      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 250);
        throw new Error("MyanmarTTS failed on story scene " + (index + 1) + ": " + (detail || "HTTP " + upstream.status));
      }
      const contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (contentType !== "audio/wav" && contentType !== "audio/x-wav") {
        await upstream.body?.cancel();
        throw new Error("MyanmarTTS returned " + (contentType || "an unknown format") + " instead of WAV audio.");
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const part = readPcmWav(bytes);
      const byteRate = part.sampleRate * part.channels * (part.bitsPerSample / 8);
      const partDuration = part.pcm.length / byteRate;
      wavParts.push(part);
      sceneTimings.push({ index: index + 1, startSeconds: offset, endSeconds: offset + partDuration });
      cues.push({ startSeconds: offset, endSeconds: offset + partDuration, text: texts[index] });
      offset += partDuration;
    }

    const combined = combinePcmWavs(wavParts);
    const srt = cues.map((cue, index) =>
      (index + 1) + "\n" + srtTime(cue.startSeconds) + " --> " + srtTime(cue.endSeconds) + "\n" + wrapCaption(cue.text)
    ).join("\n\n") + "\n";

    const folder = authData.user.id + "/story-studio/" + storyId + "/";
    const audioPath = folder + "story-voiceover.wav";
    const srtPath = folder + "story-subtitles.srt";
    const storage = supabase.storage.from("voiceovers");
    const [audioUpload, srtUpload] = await Promise.all([
      storage.upload(audioPath, combined.wav, { contentType: "audio/wav", cacheControl: "3600", upsert: true }),
      storage.upload(srtPath, Buffer.from(srt, "utf8"), { contentType: "text/plain", cacheControl: "3600", upsert: true }),
    ]);
    if (audioUpload.error || srtUpload.error) {
      return NextResponse.json({ success: false, error: "Voiceover was generated but could not be saved: " +
        (audioUpload.error?.message || srtUpload.error?.message || "Storage upload failed.") }, { status: 500 });
    }
    const [audioSigned, srtSigned] = await Promise.all([
      storage.createSignedUrl(audioPath, 60 * 60),
      storage.createSignedUrl(srtPath, 60 * 60),
    ]);
    if (audioSigned.error || srtSigned.error || !audioSigned.data?.signedUrl || !srtSigned.data?.signedUrl) {
      return NextResponse.json({ success: false, error: "Story audio was saved but preview links could not be created." }, { status: 500 });
    }
    return NextResponse.json({
      success: true,
      audioUrl: audioSigned.data.signedUrl,
      subtitleUrl: srtSigned.data.signedUrl,
      audioDuration: combined.duration,
      sceneTimings,
      audioPath,
      subtitlePath: srtPath,
      model: "freococo/MyanmarTTS",
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json({ success: false, error: timedOut
      ? "MyanmarTTS took too long while generating the story. Try fewer scenes or a shorter story."
      : error instanceof Error ? error.message : "Could not generate the Burmese story voiceover." }, { status: timedOut ? 504 : 500 });
  }
}
