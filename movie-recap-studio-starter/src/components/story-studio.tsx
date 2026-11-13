"use client";

import { useRef, useState } from "react";
import { VideoRenderer } from "@/components/video-renderer";
import type { SceneEditPlan, SceneEditSegment } from "@/components/scene-plan-builder";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type StoryScene = { index: number; narrationText: string; visualPrompt: string; mood: string };
type StoryResult = {
  title: string;
  logline: string;
  characterBible: string;
  script: string;
  scenes: StoryScene[];
  visualStyle: string;
};
type TimedWord = { text: string; start: number; end: number };

function audioBuffersToWav(buffers: AudioBuffer[]): Blob {
  if (!buffers.length) throw new Error("The voice model did not return audio.");
  const sampleRate = buffers[0].sampleRate;
  const channels = buffers[0].numberOfChannels;
  const totalFrames = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const blockAlign = channels * 2;
  const dataSize = totalFrames * blockAlign;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataSize, true);
  let frameOffset = 0;
  for (const buffer of buffers) {
    const channelsData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
    for (let frame = 0; frame < buffer.length; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = Math.max(-1, Math.min(1, channelsData[channel][frame]));
        view.setInt16(44 + (frameOffset * channels + channel) * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
      }
      frameOffset += 1;
    }
  }
  return new Blob([output], { type: "audio/wav" });
}

function srtTime(milliseconds: number) {
  const ms = Math.max(0, Math.round(milliseconds));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return [h, m, s].map((value) => String(value).padStart(2, "0")).join(":") + "," + String(ms % 1000).padStart(3, "0");
}

function timedWordsToSrt(words: TimedWord[]) {
  const valid = words.filter((word) => word.text.trim() && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  const cues: TimedWord[] = [];
  let current: TimedWord[] = [];
  const flush = () => {
    if (!current.length) return;
    cues.push({
      text: current.map((word) => word.text).join(" ").replace(/\s+([,.;!?])/g, "$1"),
      start: current[0].start,
      end: Math.max(current[0].start + 250, current[current.length - 1].end),
    });
    current = [];
  };
  for (const word of valid) {
    current.push(word);
    const text = current.map((item) => item.text).join(" ");
    if (current.length >= 7 || text.length >= 44 || /[.!?]["')\]]?$/.test(word.text.trim()) ||
        word.end - current[0].start >= 4500) flush();
  }
  flush();
  return cues.map((cue, index) =>
    (index + 1) + "\n" + srtTime(cue.start) + " --> " + srtTime(cue.end) + "\n" + cue.text
  ).join("\n\n") + "\n";
}

function timestamp(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return String(Math.floor(value / 60)).padStart(2, "0") + ":" + String(value % 60).padStart(2, "0");
}

export function StoryStudio() {
  const [idea, setIdea] = useState("");
  const [language, setLanguage] = useState<"Myanmar" | "English">("Myanmar");
  const [genre, setGenre] = useState("adventure");
  const [durationSeconds, setDurationSeconds] = useState(90);
  const [narrator, setNarrator] = useState<"Female" | "Male">("Female");
  const [visualStyle, setVisualStyle] = useState("cinematic");
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("9:16");
  const [story, setStory] = useState<StoryResult | null>(null);
  const [script, setScript] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [subtitleUrl, setSubtitleUrl] = useState("");
  const [scenePlan, setScenePlan] = useState<SceneEditPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const engineRef = useRef<any>(null);
  const localUrlsRef = useRef<string[]>([]);

  function clearVoiceAssets() {
    localUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    localUrlsRef.current = [];
    setAudioUrl("");
    setSubtitleUrl("");
    setScenePlan(null);
  }

  async function generateStory() {
    if (busy || idea.trim().length < 8) return;
    setBusy(true);
    setError("");
    setStory(null);
    setScript("");
    clearVoiceAssets();
    setProgress("AI is writing an original story and planning its scenes…");
    try {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) throw new Error("Please sign in before creating an AI story.");
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !data.session?.access_token) throw new Error("Your session expired. Please sign in again.");
      const response = await fetch("/api/generate-story", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + data.session.access_token },
        body: JSON.stringify({ idea, language, genre, durationSeconds, visualStyle }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success || !Array.isArray(result.scenes)) {
        throw new Error(result?.error || "Could not generate the story.");
      }
      const nextStory: StoryResult = {
        title: result.title,
        logline: result.logline,
        characterBible: result.characterBible,
        script: result.script,
        scenes: result.scenes,
        visualStyle,
      };
      setStory(nextStory);
      setScript(nextStory.script);
      setProgress("Story and scene plan are ready. Generate narration next.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Story generation failed.");
      setProgress("");
    } finally {
      setBusy(false);
    }
  }

  async function generateEnglishVoiceover(currentStory: StoryResult) {
    let engine = engineRef.current;
    if (!engine) {
      setProgress("Loading the free Kokoro English voice model. The first load may take a few minutes…");
      const moduleUrl = new URL("/headtts/modules/headtts.mjs", window.location.href).toString();
      const module = await import(/* webpackIgnore: true */ moduleUrl) as any;
      const voiceId = narrator === "Female" ? "af_bella" : "am_fenrir";
      const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const HeadTTS = module.HeadTTS;
      engine = new HeadTTS({
        endpoints: isIOS ? ["wasm"] : ["webgpu", "wasm"],
        workerModule: new URL("/headtts/modules/worker-tts.mjs", window.location.href).toString(),
        dictionaryURL: new URL("/headtts/dictionaries/", window.location.href).toString(),
        voices: [voiceId],
        defaultVoice: voiceId,
        defaultLanguage: "en-us",
        defaultSpeed: 0.96,
        defaultAudioEncoding: "wav",
        dtypeWebgpu: "q8",
        dtypeWasm: "q4",
        splitSentences: true,
        splitLength: 420,
      });
      await engine.connect(null, (event: any) => {
        setProgress(event.total > 0
          ? "Downloading voice model: " + Math.round(event.loaded / event.total * 100) + "%"
          : "Loading voice model…");
      });
      engineRef.current = engine;
    }
    const voiceId = narrator === "Female" ? "af_bella" : "am_fenrir";
    await engine.setup({ voice: voiceId, language: "en-us", speed: 0.96, audioEncoding: "wav" });

    const buffers: AudioBuffer[] = [];
    const words: TimedWord[] = [];
    const segments: SceneEditSegment[] = [];
    let offsetMs = 0;
    for (let index = 0; index < currentStory.scenes.length; index += 1) {
      const scene = currentStory.scenes[index];
      setProgress("Generating English narration for scene " + (index + 1) + " of " + currentStory.scenes.length + "…");
      const messages = await engine.synthesize({ input: scene.narrationText });
      const audioMessages = messages.filter((message: any) => message.type === "audio" && message.data?.audio instanceof AudioBuffer);
      if (!audioMessages.length) {
        const failed = messages.find((message: any) => message.type === "error");
        throw new Error(failed?.data?.error || "The voice model returned no audio for scene " + (index + 1) + ".");
      }
      const startSeconds = offsetMs / 1000;
      for (const message of audioMessages) {
        const audio = message.data.audio as AudioBuffer;
        buffers.push(audio);
        const data = message.data;
        for (let wordIndex = 0; wordIndex < (data.words ?? []).length; wordIndex += 1) {
          const text = String(data.words[wordIndex] ?? "").trim();
          const rawStart = Number(data.wtimes?.[wordIndex]);
          const rawDuration = Number(data.wdurations?.[wordIndex]);
          if (!text || !Number.isFinite(rawStart) || rawStart < 0) continue;
          words.push({
            text,
            start: offsetMs + rawStart,
            end: offsetMs + rawStart + (Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 300),
          });
        }
        offsetMs += audio.duration * 1000;
      }
      segments.push({
        index: index + 1,
        sourceStartSeconds: 0,
        sourceEndSeconds: 2,
        narrationStartSeconds: startSeconds,
        narrationEndSeconds: offsetMs / 1000,
        narrationText: scene.narrationText,
        sceneReason: scene.visualPrompt,
      });
    }
    if (!words.length) throw new Error("The English voice model did not return word timing data, so timed subtitles cannot be made.");
    const wavBlob = audioBuffersToWav(buffers);
    const srtBlob = new Blob([timedWordsToSrt(words)], { type: "text/plain;charset=utf-8" });
    const wavUrl = URL.createObjectURL(wavBlob);
    const srtUrl = URL.createObjectURL(srtBlob);
    localUrlsRef.current.push(wavUrl, srtUrl);
    setAudioUrl(wavUrl);
    setSubtitleUrl(srtUrl);
    setScenePlan({
      style: currentStory.visualStyle,
      aspectRatio,
      sourceType: "story",
      storyContext: currentStory.characterBible,
      segments,
    });
  }

  async function generateMyanmarVoiceover(currentStory: StoryResult, token: string) {
    setProgress("Generating Burmese narration scene by scene and aligning SRT timings…");
    const storyId = crypto.randomUUID();
    const response = await fetch("/api/generate-story-voiceover", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ storyId, scenes: currentStory.scenes.map((scene) => ({ narrationText: scene.narrationText })) }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.success || !result.audioUrl || !result.subtitleUrl || !Array.isArray(result.sceneTimings)) {
      throw new Error(result?.error || "Could not generate Burmese story narration.");
    }
    const segments = currentStory.scenes.map((scene, index) => {
      const timing = result.sceneTimings[index];
      return {
        index: index + 1,
        sourceStartSeconds: 0,
        sourceEndSeconds: 2,
        narrationStartSeconds: Number(timing.startSeconds),
        narrationEndSeconds: Number(timing.endSeconds),
        narrationText: scene.narrationText,
        sceneReason: scene.visualPrompt,
      };
    });
    setAudioUrl(result.audioUrl);
    setSubtitleUrl(result.subtitleUrl);
    setScenePlan({
      style: currentStory.visualStyle,
      aspectRatio,
      sourceType: "story",
      storyContext: currentStory.characterBible,
      segments,
    });
  }

  async function generateVoiceover() {
    if (!story || voiceBusy) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError("Please sign in before generating narration.");
      return;
    }
    setVoiceBusy(true);
    setError("");
    clearVoiceAssets();
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !data.session?.access_token) throw new Error("Your session expired. Please sign in again.");
      if (language === "English") await generateEnglishVoiceover(story);
      else await generateMyanmarVoiceover(story, data.session.access_token);
      setProgress("Narration and timed subtitles are ready. Continue to AI visuals and MP4 rendering below.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Voiceover generation failed.");
      setProgress("");
    } finally {
      setVoiceBusy(false);
    }
  }

  return (
    <section id="story-studio-section" style={{ border: "1px solid #e4e4eb", borderRadius: 14, padding: 18, display: "grid", gap: 14, marginTop: 24 }}>
      <div>
        <div className="eyebrow">A SEPARATE CREATION WORKFLOW</div>
        <h2 style={{ margin: "4px 0 6px", fontSize: 20 }}>AI Story Studio</h2>
        <p className="page-subtitle" style={{ margin: 0 }}>Create an original short story, generate its voiceover and timed subtitles, illustrate each story scene, and render a complete MP4.</p>
      </div>
      <label className="field-label">What story should AI create?
        <textarea value={idea} onChange={(event) => setIdea(event.target.value)} rows={3} maxLength={1200} placeholder="ဥပမာ — မိုးရွာတဲ့ညမှာ ပျောက်ဆုံးနေတဲ့ ကြောင်လေးကို ရှာဖွေတဲ့ ကလေးတစ်ယောက်အကြောင်း…" disabled={busy || voiceBusy} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 10 }}>
        <label className="field-label">Story language
          <select value={language} onChange={(event) => { setLanguage(event.target.value as "Myanmar" | "English"); setStory(null); clearVoiceAssets(); }} disabled={busy || voiceBusy}>
            <option value="Myanmar">Myanmar</option><option value="English">English</option>
          </select>
        </label>
        <label className="field-label">Genre
          <select value={genre} onChange={(event) => setGenre(event.target.value)} disabled={busy || voiceBusy}>
            <option value="adventure">Adventure</option><option value="mystery">Mystery</option><option value="fantasy">Fantasy</option><option value="romance">Romance</option><option value="horror">Horror (mild)</option><option value="comedy">Comedy</option><option value="inspirational">Inspirational</option>
          </select>
        </label>
        <label className="field-label">Length
          <select value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value))} disabled={busy || voiceBusy}>
            <option value={60}>1 minute</option><option value={90}>1.5 minutes</option><option value={120}>2 minutes</option><option value={180}>3 minutes</option>
          </select>
        </label>
        <label className="field-label">Narrator
          <select value={narrator} onChange={(event) => {
            setNarrator(event.target.value as "Female" | "Male");
            clearVoiceAssets();
          }} disabled={busy || voiceBusy || language === "Myanmar"}>
            <option value="Female">Female</option><option value="Male">Male</option>
          </select>
          {language === "Myanmar" ? <small style={{ color: "#747484" }}>MyanmarTTS currently uses its default voice.</small> : null}
        </label>
        <label className="field-label">Visual style
          <select value={visualStyle} onChange={(event) => {
              const nextStyle = event.target.value;
              setVisualStyle(nextStyle);
              setStory((current) => current ? { ...current, visualStyle: nextStyle } : current);
              setScenePlan((current) => current ? { ...current, style: nextStyle } : current);
            }} disabled={busy || voiceBusy}>
            <option value="cinematic">Cinematic</option><option value="storybook">Storybook illustration</option><option value="anime-inspired">Anime-inspired</option><option value="3d-animation">3D animation</option>
          </select>
        </label>
        <label className="field-label">Video ratio
          <select value={aspectRatio} onChange={(event) => {
              const nextRatio = event.target.value as "16:9" | "9:16";
              setAspectRatio(nextRatio);
              setScenePlan((current) => current ? { ...current, aspectRatio: nextRatio } : current);
            }} disabled={busy || voiceBusy}>
            <option value="16:9">16:9 · YouTube</option><option value="9:16">9:16 · Shorts</option>
          </select>
        </label>
      </div>
      <button type="button" className="primary-button" onClick={generateStory} disabled={busy || voiceBusy || idea.trim().length < 8}>
        {busy ? "Writing story and storyboard…" : "Generate Original Story + Scenes →"}
      </button>
      {busy && <div className="modal-note" role="status" style={{ display: "grid", gap: 6 }}><span>{progress}</span><progress style={{ width: "100%" }} /></div>}
      {story && (
        <div style={{ border: "1px solid #e7e7ed", borderRadius: 10, padding: 13, display: "grid", gap: 10 }}>
          <div><h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{story.title}</h3><p style={{ margin: 0, color: "#747484", fontSize: 12 }}>{story.logline}</p></div>
          <label className="field-label">Generated narration script
            <textarea value={script} readOnly rows={8} />
          </label>
          <div style={{ display: "grid", gap: 7 }}>
            <strong style={{ fontSize: 12 }}>Storyboard · {story.scenes.length} scenes</strong>
            {story.scenes.map((scene) => (
              <article key={scene.index} style={{ padding: 10, border: "1px solid #ececf1", borderRadius: 8, display: "grid", gap: 4 }}>
                <strong style={{ fontSize: 11 }}>Scene {scene.index} · {scene.mood || "Story beat"}</strong>
                <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>{scene.narrationText}</p>
                <small style={{ color: "#747484", lineHeight: 1.5 }}>{scene.visualPrompt}</small>
              </article>
            ))}
          </div>
          <button type="button" className="secondary-button" onClick={generateVoiceover} disabled={voiceBusy}>
            {voiceBusy ? "Generating narration and subtitles…" : "Generate " + language + " Voiceover + Timed SRT →"}
          </button>
          {voiceBusy && <div className="modal-note" role="status" style={{ display: "grid", gap: 6 }}><span>{progress}</span><progress style={{ width: "100%" }} /></div>}
          {audioUrl && subtitleUrl && (
            <div style={{ display: "grid", gap: 9 }}>
              <strong style={{ fontSize: 12 }}>Voiceover preview</strong>
              <audio controls preload="metadata" src={audioUrl} style={{ width: "100%" }}>Your browser does not support audio playback.</audio>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <a className="secondary-button" href={audioUrl} download="story-voiceover.wav">Download WAV</a>
                <a className="secondary-button" href={subtitleUrl} download="story-subtitles.srt">Download SRT</a>
              </div>
              <VideoRenderer
                visualMode="ai_visuals"
                audioUrl={audioUrl}
                subtitleUrl={subtitleUrl}
                projectTitle={story.title}
                expectedDuration={durationSeconds === 60 ? "1 min" : durationSeconds === 90 ? "1.5 min" : durationSeconds === 120 ? "2 min" : "3 min"}
                sourceVideoUrl=""
                scenePlan={scenePlan}
                sectionId="story-video-rendering-section"
              />
            </div>
          )}
        </div>
      )}
      {progress && !busy && !voiceBusy && <p className="modal-note" role="status" style={{ margin: 0 }}>{progress}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="modal-note" style={{ margin: 0 }}>AI scripts and scene images are generated from your idea. English narration uses the free browser Kokoro model; Burmese narration uses your configured MyanmarTTS service. AI visuals are still images assembled into a narrated slideshow, not generated moving footage.</p>
    </section>
  );
}
