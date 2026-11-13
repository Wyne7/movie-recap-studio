"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type SceneEditSegment = {
  index: number;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  narrationStartSeconds: number;
  narrationEndSeconds: number;
  narrationText: string;
  sceneReason: string;
};

export type SceneEditPlan = {
  style: string;
  aspectRatio: "16:9" | "9:16";
  segments: SceneEditSegment[];
  timingSource?: "srt" | "estimated";
  sourceType?: "youtube" | "story";
  storyContext?: string;
};

type Props = {
  onPlanGenerated?: (plan: SceneEditPlan | null) => void;
  videoUrl: string;
  script: string;
  language: "Myanmar" | "English";
  audioUrl: string;
  subtitleUrl?: string;
};

function parseSrtCues(contents: string) {
  const toSeconds = (value: string) => {
    const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
    if (!match) return NaN;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
  };
  return contents.replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return [];
    const parts = lines[timingIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const startSeconds = toSeconds(parts[0] || "");
    const endSeconds = toSeconds(parts[1] || "");
    const text = lines.slice(timingIndex + 1).join(" ").trim();
    return Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds && text
      ? [{ startSeconds, endSeconds, text: text.slice(0, 1200) }]
      : [];
  });
}

function groupSubtitleCues(cues: ReturnType<typeof parseSrtCues>, audioDuration: number) {
  const targetSeconds = Math.max(8, audioDuration / 40);
  const groups: Array<{ startSeconds: number; endSeconds: number; text: string }> = [];
  let current: { startSeconds: number; endSeconds: number; text: string } | null = null;
  for (const cue of cues) {
    const boundedEnd = Math.min(audioDuration, cue.endSeconds);
    if (cue.startSeconds >= audioDuration || boundedEnd <= cue.startSeconds) continue;
    if (!current) {
      current = { startSeconds: cue.startSeconds, endSeconds: boundedEnd, text: cue.text };
    } else if (cue.startSeconds - current.startSeconds >= targetSeconds && groups.length < 39) {
      groups.push(current);
      current = { startSeconds: cue.startSeconds, endSeconds: boundedEnd, text: cue.text };
    } else {
      current.endSeconds = Math.max(current.endSeconds, boundedEnd);
      current.text = (current.text + " " + cue.text).slice(-2400);
    }
  }
  if (current) groups.push(current);
  return groups.slice(0, 40);
}

async function readAudioDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      const duration = audio.duration;
      cleanup();
      if (Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error("Could not read the WAV narration duration."));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not read the WAV narration."));
    };
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("error", onError);
    audio.load();
  });
}

function timestamp(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return String(Math.floor(whole / 3600)).padStart(2, "0") + ":" +
    String(Math.floor((whole % 3600) / 60)).padStart(2, "0") + ":" +
    String(whole % 60).padStart(2, "0");
}

export function ScenePlanBuilder({ videoUrl, script, language, audioUrl, subtitleUrl, onPlanGenerated }: Props) {
  const [style, setStyle] = useState("cinematic");
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [scenes, setScenes] = useState<SceneEditSegment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [model, setModel] = useState("");

  async function generatePlan() {
    if (busy || !script.trim()) return;
    setBusy(true);
    setError("");
    setScenes([]);
    onPlanGenerated?.(null);
    try {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) throw new Error("Supabase sign-in is required to generate a scene plan.");
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session?.access_token) {
        throw new Error("Your session expired. Please sign in again.");
      }
      if (!audioUrl || !subtitleUrl) throw new Error("Load the matching narration WAV and SRT before generating a precisely timed scene plan.");
      const [audioDuration, subtitleResponse] = await Promise.all([
        readAudioDuration(audioUrl),
        fetch(subtitleUrl, { cache: "no-store" }),
      ]);
      if (!subtitleResponse.ok) throw new Error("Could not read the SRT subtitles. Please reload the saved WAV + SRT files.");
      const subtitleCues = groupSubtitleCues(parseSrtCues(await subtitleResponse.text()), audioDuration);
      if (!subtitleCues.length) throw new Error("The SRT file contains no valid timed subtitle cues.");
      const response = await fetch("/api/generate-edit-plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + sessionData.session.access_token,
        },
        body: JSON.stringify({ videoUrl, script, language, style, aspectRatio, audioDuration, subtitleCues }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Could not generate the scene plan.");
      }
      setScenes(data.segments);
      onPlanGenerated?.({ style: data.style || style, aspectRatio: data.aspectRatio || aspectRatio, segments: data.segments, timingSource: data.timingSource || "srt" });
      setModel(data.model || "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate the scene plan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ border: "1px solid #e7e7ed", borderRadius: 9, padding: 13, display: "grid", gap: 10 }}>
      <div>
        <h3 style={{ fontSize: 12, margin: "0 0 5px" }}>AI Scene Selection · YouTube Link</h3>
        <p style={{ fontSize: 11, color: "#747484", margin: 0 }}>
          Gemini analyzes the YouTube video and matches relevant scenes to your narration. Choose Original Clips to edit footage you are authorized to use, or AI Visuals to create new illustrated scenes from the YouTube context without supplying the original video file.
        </p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 9 }}>
        <label className="field-label">Editing style
          <select value={style} onChange={(event) => setStyle(event.target.value)} disabled={busy}>
            <option value="cinematic">Cinematic</option>
            <option value="fast_paced">Fast-paced</option>
            <option value="documentary">Documentary</option>
          </select>
        </label>
        <label className="field-label">Aspect ratio
          <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as "16:9" | "9:16")} disabled={busy}>
            <option value="16:9">16:9 · YouTube</option>
            <option value="9:16">9:16 · Shorts / TikTok</option>
          </select>
        </label>
      </div>
      {!audioUrl || !subtitleUrl ? (
        <p className="modal-note" role="status">Precise WAV/SRT scene matching currently requires an English narration WAV and its matching SRT file to be loaded first.</p>
      ) : null}
      <button type="button" className="secondary-button" onClick={generatePlan} disabled={busy || script.trim().length < 80 || !audioUrl || !subtitleUrl}>
        {busy ? "AI is analyzing scenes…" : "Generate SRT-Synced Scene Edit Plan →"}
      </button>
      {busy && (
        <div className="modal-note" role="status" aria-live="polite" style={{ display: "grid", gap: 7 }}>
          <span>Step 1/2 · Gemini is analyzing the YouTube video and matching scenes to your narration. This may take a few minutes.</span>
          <progress style={{ width: "100%", height: 8 }} />
          <small>AI analysis does not provide a reliable percentage, so this bar shows activity rather than an invented percent.</small>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {scenes.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          <p className="modal-note" style={{ margin: 0 }}>
            {scenes.length} suggested scenes{model ? " · " + model : ""}. Scene timing follows your SRT cues and WAV duration.
          </p>
          {scenes.map((scene) => (
            <article key={scene.index} style={{ border: "1px solid #ececf1", borderRadius: 7, padding: 9, display: "grid", gap: 5 }}>
              <strong style={{ fontSize: 11 }}>
                Scene {scene.index} · Source {timestamp(scene.sourceStartSeconds)}–{timestamp(scene.sourceEndSeconds)} · Narration {timestamp(scene.narrationStartSeconds)}–{timestamp(scene.narrationEndSeconds)}
              </strong>
              <p style={{ fontSize: 11, margin: 0, lineHeight: 1.5 }}>{scene.sceneReason}</p>
              <p style={{ fontSize: 11, color: "#747484", margin: 0, lineHeight: 1.5 }}>{scene.narrationText}</p>
            </article>
          ))}
          <button
            type="button"
            className="primary-button"
            onClick={() => document.getElementById("video-rendering-section")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            Continue to Video Rendering ↓
          </button>
          <div className="modal-note" style={{ margin: 0, display: "grid", gap: 6 }}>
            <strong>Scene plan generated. What to do next:</strong>
            <ol style={{ margin: "0 0 0 18px", padding: 0, lineHeight: 1.7 }}>
              <li>Check the selected scene timestamps above.</li>
              <li>Scroll to Video Rendering · MP4.</li>
              <li>Choose Original Clips and provide a direct authorized MP4/MOV/WebM URL or select an authorized local video file. A YouTube watch link is not a downloadable video file.</li>
              <li>Or choose AI Visuals: press Generate AI visuals + Render MP4. The app creates up to 12 original images from your YouTube scene plan; no original video file is needed.</li>
              <li>Your existing narration WAV and SRT are reused automatically when loaded. Watch the progress bars while images are generated and the MP4 is rendered.</li>
              <li>Preview and download the finished MP4 when rendering completes.</li>
            </ol>
            <span>For Original Clips, scene overlays follow the exact SRT time windows on the WAV timeline. AI Visuals remains a still-image slideshow, so it does not yet provide frame-by-frame motion editing. Original Clips requires media you own or are authorized to reuse.</span>
          </div>
        </div>
      )}
    </section>
  );
}
