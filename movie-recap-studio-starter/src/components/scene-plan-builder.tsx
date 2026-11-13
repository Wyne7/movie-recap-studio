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
};

type Props = {
  onPlanGenerated?: (plan: SceneEditPlan) => void;
  videoUrl: string;
  script: string;
  language: "Myanmar" | "English";
};

function timestamp(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return String(Math.floor(whole / 3600)).padStart(2, "0") + ":" +
    String(Math.floor((whole % 3600) / 60)).padStart(2, "0") + ":" +
    String(whole % 60).padStart(2, "0");
}

export function ScenePlanBuilder({ videoUrl, script, language, onPlanGenerated }: Props) {
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
    try {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) throw new Error("Supabase sign-in is required to generate a scene plan.");
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session?.access_token) {
        throw new Error("Your session expired. Please sign in again.");
      }
      const response = await fetch("/api/generate-edit-plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + sessionData.session.access_token,
        },
        body: JSON.stringify({ videoUrl, script, language, style, aspectRatio }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Could not generate the scene plan.");
      }
      setScenes(data.segments);
      onPlanGenerated?.({ style: data.style || style, aspectRatio: data.aspectRatio || aspectRatio, segments: data.segments });
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
          Gemini analyzes the linked video and matches relevant source timestamps to your recap narration. This creates an edit plan; it does not download or render the YouTube video.
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
      <button type="button" className="secondary-button" onClick={generatePlan} disabled={busy || script.trim().length < 80}>
        {busy ? "AI is analyzing scenes…" : "Generate AI Scene Edit Plan →"}
      </button>
      {busy && <p className="modal-note" role="status">Analyzing the YouTube video and matching scenes to narration. This may take a few minutes.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {scenes.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          <p className="modal-note" style={{ margin: 0 }}>
            {scenes.length} suggested scenes{model ? " · " + model : ""}. Review timestamps before using them in a final edit.
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
          <p className="modal-note" style={{ margin: 0 }}>
            These are AI-suggested timestamps, not a rendered MP4. Automatic cutting and final export from the YouTube source are a separate integration step and require an authorized way to access the video media.
          </p>
        </div>
      )}
    </section>
  );
}
