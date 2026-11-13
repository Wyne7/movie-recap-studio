"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import type { HeadTTS as HeadTTSClient } from "@met4citizen/headtts";
import { AuthPanel } from "@/components/auth-panel";
import { VideoRenderer } from "@/components/video-renderer";
import { ScenePlanBuilder, type SceneEditPlan } from "@/components/scene-plan-builder";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";

type ProjectStatus = "Draft" | "Analyzing" | "Ready to edit" | "Rendering" | "Completed";
type RecapProject = {
  id: string;
  title: string;
  sourceUrl: string;
  language: "Myanmar" | "English";
  duration: "3 min" | "5 min" | "10 min";
  voice: "Female" | "Male";
  videoVisualMode: "original_clips" | "ai_visuals";
  status: ProjectStatus;
  createdAt: string;
  script: string | null;
  voiceoverPath: string | null;
  englishAudioPath: string | null;
  englishSrtPath: string | null;
};

const STORAGE_KEY = "movie-recap-studio.projects.v1";

type ProjectRow = {
  id: string;
  title: string;
  source_url: string;
  language: "Myanmar" | "English";
  duration: "3 min" | "5 min" | "10 min";
  voice: "Female" | "Male";
  video_visual_mode: "original_clips" | "ai_visuals";
  status: ProjectStatus;
  created_at: string;
  source_type: "youtube";
  script: string | null;
  voiceover_path: string | null;
  english_audio_path: string | null;
  english_srt_path: string | null;
};

function fromProjectRow(row: ProjectRow): RecapProject {
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.source_url,
    language: row.language,
    script: row.script ?? null,
    voiceoverPath: row.voiceover_path ?? null,
    englishAudioPath: row.english_audio_path ?? null,
    englishSrtPath: row.english_srt_path ?? null,
    duration: row.duration,
    voice: row.voice,
    videoVisualMode: row.video_visual_mode ?? "original_clips",
    status: row.status,
    createdAt: row.created_at,
  };
}


type TimedWord = { text: string; start: number; end: number };

function audioBuffersToWav(buffers: AudioBuffer[]): Blob {
  if (buffers.length === 0) throw new Error("The voice engine did not return audio.");
  const sampleRate = buffers[0].sampleRate;
  const channels = buffers[0].numberOfChannels;
  const totalFrames = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = totalFrames * blockAlign;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  const writeText = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataSize, true);

  let outputFrame = 0;
  for (const buffer of buffers) {
    const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
    for (let frame = 0; frame < buffer.length; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
        const value = sample < 0 ? sample * 32768 : sample * 32767;
        view.setInt16(44 + (outputFrame * channels + channel) * bytesPerSample, value, true);
      }
      outputFrame += 1;
    }
  }
  return new Blob([output], { type: "audio/wav" });
}

function formatSrtTime(milliseconds: number): string {
  const safe = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safe / 3600000);
  const minutes = Math.floor((safe % 3600000) / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const millis = safe % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function timedWordsToSrt(words: TimedWord[]): string {
  const cues: Array<{ text: string; start: number; end: number }> = [];
  const validWords = words.filter((word) =>
    word.text.trim() && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start
  );
  let current: TimedWord[] = [];
  const flush = () => {
    if (!current.length) return;
    cues.push({
      text: current.map((word) => word.text).join(" ").replace(/\\s+([,.;!?])/g, "$1"),
      start: current[0].start,
      end: Math.max(current[0].start + 250, current[current.length - 1].end),
    });
    current = [];
  };

  for (const word of validWords) {
    current.push(word);
    const text = current.map((item) => item.text).join(" ");
    const last = word.text.trim();
    if (
      current.length >= 7 ||
      text.length >= 44 ||
      /[.!?]["')\\]]?$/.test(last) ||
      word.end - current[0].start >= 4500
    ) flush();
  }
  flush();

  return cues.map((cue, index) =>
    `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}`
  ).join("\n\n") + "\n";
}

function splitSpeechText(text: string, maxLength: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? current + " " + word : word;
    if (current && next.length > maxLength) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function downloadBlob(blobUrl: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function isValidYouTubeUrl(value: string) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }

    if (hostname === "youtu.be") {
      return parsed.pathname.length > 1;
    }

    if (hostname === "youtube.com" || hostname === "m.youtube.com") {
      return (
        (parsed.pathname === "/watch" && Boolean(parsed.searchParams.get("v"))) ||
        ["/shorts/", "/embed/", "/live/"].some(
          (prefix) => parsed.pathname.startsWith(prefix) && parsed.pathname.length > prefix.length
        )
      );
    }

    return false;
  } catch {
    return false;
  }
}

export default function HomePage() {
  const [projects, setProjects] = useState<RecapProject[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [language, setLanguage] = useState<"Myanmar" | "English">("Myanmar");
  const [duration, setDuration] = useState<"3 min" | "5 min" | "10 min">("5 min");
  const [recapType, setRecapType] = useState<"review" | "full_recap">("full_recap");
  const [videoVisualMode, setVideoVisualMode] = useState<"original_clips" | "ai_visuals">("original_clips");
  const [voice, setVoice] = useState<"Female" | "Male">("Female");
  const [formError, setFormError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [scriptProgress, setScriptProgress] = useState("");
  const [scriptElapsedSeconds, setScriptElapsedSeconds] = useState(0);
  const [generatedScript, setGeneratedScript] = useState("");
  const [selectedProject, setSelectedProject] = useState<RecapProject | null>(null);
  const [sceneEditPlan, setSceneEditPlan] = useState<SceneEditPlan | null>(null);
  const [voiceoverUrl, setVoiceoverUrl] = useState("");
  const [isGeneratingVoiceover, setIsGeneratingVoiceover] = useState(false);
  const [isPreviewingEnglish, setIsPreviewingEnglish] = useState(false);
  const [isGeneratingEnglishAudio, setIsGeneratingEnglishAudio] = useState(false);
  const [englishAudioUrl, setEnglishAudioUrl] = useState("");
  const [englishSrtUrl, setEnglishSrtUrl] = useState("");
  const [existingEnglishWav, setExistingEnglishWav] = useState<File | null>(null);
  const [existingEnglishSrt, setExistingEnglishSrt] = useState<File | null>(null);
  const [englishProgress, setEnglishProgress] = useState("");
  const [isLoadingEnglishAssets, setIsLoadingEnglishAssets] = useState(false);
  const englishLoadRequestRef = useRef(0);
  const headTtsRef = useRef<HeadTTSClient | null>(null);

  useEffect(() => {
    if (!isGenerating) {
      setScriptElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setScriptElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isGenerating]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setProjects(JSON.parse(saved) as RecapProject[]);
      } catch {
        setNotice("Could not load saved projects from this browser.");
      } finally {
        setAuthLoading(false);
        setHydrated(true);
      }
      return;
    }

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setAuthLoading(false);
      setHydrated(true);
      return;
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) setNotice(`Authentication check failed: ${error.message}`);
      setUser(data.session?.user ?? null);
      setAuthLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
      return;
    }
    if (authLoading) return;
    if (!user) {
      setProjects([]);
      setHydrated(true);
      return;
    }

    let active = true;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setHydrated(false);

    void supabase
      .from("projects")
      .select("id,title,source_url,source_type,language,duration,voice,video_visual_mode,status,created_at,script,voiceover_path,english_audio_path,english_srt_path")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setNotice(`Could not load cloud projects: ${error.message}`);
          setProjects([]);
        } else {
          setProjects(((data ?? []) as ProjectRow[]).map(fromProjectRow));
        }
        setHydrated(true);
      });

    return () => { active = false; };
  }, [user, authLoading]);

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => `${project.title} ${project.sourceUrl} ${project.language}`.toLowerCase().includes(query));
  }, [projects, search]);

  const completedCount = projects.filter((project) => project.status === "Completed").length;
  const inProgressCount = projects.filter((project) => project.status === "Analyzing" || project.status === "Rendering").length;

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isGenerating || isGeneratingVoiceover) return;

    setVoiceoverUrl("");
    setFormError("");
    setGeneratedScript("");

    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const generateAfterSave = submitter?.value === "generate";

    if (selectedProject) {
      if (!isValidYouTubeUrl(sourceUrl.trim())) {
        setFormError("Enter a valid YouTube video URL.");
        return;
      }

      const englishAssetsNeedRefresh = selectedProject.voice !== voice;
      const updatedProject: RecapProject = {
        ...selectedProject,
        englishAudioPath: englishAssetsNeedRefresh ? null : selectedProject.englishAudioPath,
        englishSrtPath: englishAssetsNeedRefresh ? null : selectedProject.englishSrtPath,
        title: title.trim() || "Untitled movie recap",
        sourceUrl: sourceUrl.trim(),
        language,
        duration,
        voice,
        videoVisualMode,
      };

      if (generateAfterSave) {
        await generateScriptForProject(updatedProject);
        return;
      }

      const supabase = getSupabaseBrowserClient();
      if (isSupabaseConfigured && (!supabase || !user)) {
        setFormError("Please sign in again before saving this project.");
        return;
      }

      if (isSupabaseConfigured && supabase && user) {
        const { error } = await supabase
          .from("projects")
          .update({
            title: updatedProject.title,
            source_url: updatedProject.sourceUrl,
            language: updatedProject.language,
            duration: updatedProject.duration,
            voice: updatedProject.voice,
            video_visual_mode: updatedProject.videoVisualMode,
            ...(englishAssetsNeedRefresh ? { english_audio_path: null, english_srt_path: null } : {}),
          })
          .eq("id", updatedProject.id)
          .eq("user_id", user.id);

        if (error) {
          setFormError("Could not update project: " + error.message);
          return;
        }
        if (englishAssetsNeedRefresh) {
          const oldAssets = [selectedProject.englishAudioPath, selectedProject.englishSrtPath].filter((path): path is string => Boolean(path));
          if (oldAssets.length) await supabase.storage.from("voiceovers").remove(oldAssets);
        }
      }

      setProjects((current) =>
        current.map((project) => project.id === updatedProject.id ? updatedProject : project)
      );
      setSelectedProject(updatedProject);
      if (englishAssetsNeedRefresh) {
        if (englishAudioUrl) URL.revokeObjectURL(englishAudioUrl);
        if (englishSrtUrl) URL.revokeObjectURL(englishSrtUrl);
        setEnglishAudioUrl("");
        setEnglishSrtUrl("");
      }
      setGeneratedScript(updatedProject.script ?? "");
      setModalOpen(false);
      setNotice("Project changes saved. No AI generation was performed.");
      window.setTimeout(() => setNotice(""), 5500);
      return;
    }

    if (!isValidYouTubeUrl(sourceUrl.trim())) {
      setFormError("Enter a valid YouTube video URL.");
      return;
    }

    const projectTitle = title.trim() || "Untitled movie recap";
    const supabase = getSupabaseBrowserClient();

    if (isSupabaseConfigured && (!supabase || !user)) {
      setFormError("Please sign in again before saving this project.");
      return;
    }

    let savedProject: RecapProject | null = null;

    try {
      if (generateAfterSave) {
        setIsGenerating(true);
        setScriptProgress("Saving your project and preparing the Gemini request...");
      }

      // Save the project once. Generating is a separate, explicitly paid action.
      if (isSupabaseConfigured && supabase && user) {
        const { data, error } = await supabase
          .from("projects")
          .insert({
            user_id: user.id,
            title: projectTitle,
            source_type: "youtube",
            source_url: sourceUrl.trim(),
            storage_path: null,
            language,
            duration,
            voice,
            video_visual_mode: videoVisualMode,
            status: generateAfterSave ? "Analyzing" : "Draft",
            script: null,
          })
          .select(
            "id,title,source_url,source_type,language,duration,voice,video_visual_mode,status,created_at,script,english_audio_path,english_srt_path"
          )
          .single();

        if (error) {
          throw new Error("Could not save project: " + error.message);
        }

        savedProject = fromProjectRow(data as ProjectRow);
      } else {
        savedProject = {
          id:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : String(Date.now()),
          title: projectTitle,
          sourceUrl: sourceUrl.trim(),
          language,
          duration,
          voice,
          videoVisualMode,
          status: generateAfterSave ? "Analyzing" : "Draft",
          createdAt: new Date().toISOString(),
          script: null,
          voiceoverPath: null,
          englishAudioPath: null,
          englishSrtPath: null,
        };
      }

      setProjects((current) => [savedProject as RecapProject, ...current]);

      if (!generateAfterSave) {
        setTitle("");
        setSourceUrl("");
        setLanguage("Myanmar");
        setDuration("5 min");
        setVoice("Female");
        setModalOpen(false);
        setNotice(
          isSupabaseConfigured
            ? "Project saved securely. Saving a project does not call the AI or incur model usage."
            : "Project saved as a local draft."
        );
        window.setTimeout(() => setNotice(""), 5500);
        return;
      }

      setScriptProgress("Sending the YouTube video link to Gemini...");
      setNotice("Gemini is analyzing the video and writing your recap. This may take a few minutes.");

      let accessToken: string | null = null;
      if (isSupabaseConfigured && supabase) {
        const { data: sessionData, error: sessionError } =
          await supabase.auth.getSession();
        if (sessionError) throw new Error(sessionError.message);
        accessToken = sessionData.session?.access_token ?? null;
      }

      if (!accessToken) {
        throw new Error("Sign in to your Supabase account before generating a paid AI recap.");
      }

      setScriptProgress("Waiting for Gemini to analyze the video and write your script...");
      const response = await fetch("/api/generate-recap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + accessToken,
        },
        body: JSON.stringify({
          title: projectTitle,
          videoUrl: sourceUrl.trim(),
          language,
          duration,
          recapType,
        }),
      });

      const result = await response.json().catch(() => null);

      if (!response.ok || !result?.success || typeof result.script !== "string") {
        throw new Error(
          result?.error || "AI generation failed (" + response.status + ")."
        );
      }

      const script = result.script.trim();
      if (!script) throw new Error("The AI returned an empty recap script.");

      setScriptProgress("Gemini finished. Saving your recap script...");
      // Save the completed script so reopening the project does not require another paid call.
      if (isSupabaseConfigured && supabase && user) {
        const { error: updateError } = await supabase
          .from("projects")
          .update({
            script,
            status: "Ready to edit",
          })
          .eq("id", savedProject.id)
          .eq("user_id", user.id);

        if (updateError) {
          throw new Error(
            "Script was generated but could not be saved: " + updateError.message
          );
        }
      }

      setGeneratedScript(script);
      const scriptedProject = { ...savedProject, script, status: "Ready to edit" as ProjectStatus };
      setSelectedProject(scriptedProject);
      setProjects((current) =>
        current.map((project) =>
          project.id === savedProject?.id ? scriptedProject : project
        )
      );

      const actualCost =
        typeof result.usageCost === "number"
          ? " Estimated provider usage: $" + result.usageCost.toFixed(6) + "."
          : "";

      setNotice("Recap script generated and saved." + actualCost);
      window.setTimeout(() => setNotice(""), 7000);
    } catch (caught) {
      if (savedProject) {
        if (isSupabaseConfigured && supabase && user) {
          await supabase
            .from("projects")
            .update({ status: "Draft" })
            .eq("id", savedProject.id)
            .eq("user_id", user.id);
        }

        setProjects((current) =>
          current.map((project) =>
            project.id === savedProject?.id
              ? { ...project, status: "Draft" }
              : project
          )
        );
      }

      setFormError(
        caught instanceof Error ? caught.message : "Something went wrong."
      );
      setNotice("");
    } finally {
      setIsGenerating(false);
      setScriptProgress("");
    }
  }

  async function generateScriptForProject(project: RecapProject) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !user) {
      setFormError("Please sign in again before generating a recap script.");
      return;
    }

    setIsGenerating(true);
    setScriptProgress("Preparing the saved project for Gemini...");
    setFormError("");
    setNotice("Sending the video link to Gemini. The analysis can take a few minutes.");

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw new Error(sessionError.message);
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("Your session expired. Please sign in again.");

      setScriptProgress("Waiting for Gemini to analyze the video and write your script...");
      const response = await fetch("/api/generate-recap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + accessToken,
        },
        body: JSON.stringify({
          title: project.title,
          videoUrl: project.sourceUrl,
          language: project.language,
          duration: project.duration,
        }),
      });

      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success || typeof result.script !== "string") {
        throw new Error(result?.error || "AI generation failed (" + response.status + ").");
      }

      const script = result.script.trim();
      if (!script) throw new Error("The AI returned an empty recap script.");

      setScriptProgress("Gemini finished. Saving your recap script...");
      const { error: updateError } = await supabase
        .from("projects")
        .update({ script, status: "Ready to edit", english_audio_path: null, english_srt_path: null })
        .eq("id", project.id)
        .eq("user_id", user.id);

      if (updateError) {
        throw new Error("Script was generated but could not be saved: " + updateError.message);
      }

      const oldEnglishAssets = [project.englishAudioPath, project.englishSrtPath].filter((path): path is string => Boolean(path));
      if (oldEnglishAssets.length) await supabase.storage.from("voiceovers").remove(oldEnglishAssets);
      const completedProject = { ...project, script, englishAudioPath: null, englishSrtPath: null, status: "Ready to edit" as ProjectStatus };
      setProjects((current) =>
        current.map((item) => item.id === project.id ? completedProject : item)
      );
      setSelectedProject(completedProject);
      setGeneratedScript(script);
      setNotice("Recap script generated and saved to this project.");
      window.setTimeout(() => setNotice(""), 7000);
    } catch (caught) {
      setNotice("");
      setFormError(caught instanceof Error ? caught.message : "Could not generate the recap script.");
    } finally {
      setIsGenerating(false);
      setScriptProgress("");
    }
  }

  function openProject(project: RecapProject) {
    const loadRequestId = ++englishLoadRequestRef.current;
    if (englishAudioUrl) URL.revokeObjectURL(englishAudioUrl);
    if (englishSrtUrl) URL.revokeObjectURL(englishSrtUrl);
    setSelectedProject(project);
    setTitle(project.title);
    setSourceUrl(project.sourceUrl);
    setLanguage(project.language);
    setDuration(project.duration);
    setVoice(project.voice);
    setVideoVisualMode(project.videoVisualMode ?? "original_clips");
    setGeneratedScript(project.script ?? "");
    setVoiceoverUrl("");
    setEnglishAudioUrl("");
    setEnglishSrtUrl("");
    setExistingEnglishWav(null);
    setExistingEnglishSrt(null);
    setFormError("");
    setEnglishProgress("");
    setIsLoadingEnglishAssets(Boolean(project.englishAudioPath || project.englishSrtPath));

    if (project.voiceoverPath) {
      void (async () => {
        const supabase = getSupabaseBrowserClient();
        const { data } = await supabase?.auth.getSession() ?? { data: { session: null } };
        const token = data.session?.access_token;
        if (!token) return;
        const response = await fetch("/api/generate-voiceover?projectId=" + encodeURIComponent(project.id), {
          headers: { Authorization: "Bearer " + token },
        });
        const result = await response.json().catch(() => null);
        if (response.ok && result?.success && typeof result.signedUrl === "string") setVoiceoverUrl(result.signedUrl);
      })();
    }

    if (project.englishAudioPath && project.englishSrtPath) {
      void (async () => {
        const supabase = getSupabaseBrowserClient();
        if (!supabase) {
          if (englishLoadRequestRef.current === loadRequestId) setIsLoadingEnglishAssets(false);
          return;
        }
        try {
          const [audioLink, srtLink] = await Promise.all([
            supabase.storage.from("voiceovers").createSignedUrl(project.englishAudioPath!, 60 * 60),
            supabase.storage.from("voiceovers").createSignedUrl(project.englishSrtPath!, 60 * 60),
          ]);
          if (audioLink.error) throw audioLink.error;
          if (srtLink.error) throw srtLink.error;
          if (!audioLink.data?.signedUrl || !srtLink.data?.signedUrl) {
            throw new Error("The saved English WAV or SRT file is missing from storage.");
          }
          const [audioResponse, srtResponse] = await Promise.all([
            fetch(audioLink.data.signedUrl),
            fetch(srtLink.data.signedUrl),
          ]);
          if (!audioResponse.ok) throw new Error("Could not download the saved WAV file.");
          if (!srtResponse.ok) throw new Error("Could not download the saved SRT file.");
          const [audioBlob, srtBlob] = await Promise.all([audioResponse.blob(), srtResponse.blob()]);
          if (englishLoadRequestRef.current !== loadRequestId) return;
          setEnglishAudioUrl(URL.createObjectURL(audioBlob));
          setEnglishSrtUrl(URL.createObjectURL(srtBlob));
          setNotice("Saved English WAV + SRT loaded. No voice generation was run.");
        } catch (error) {
          if (englishLoadRequestRef.current === loadRequestId) {
            setFormError(error instanceof Error ? error.message : "Could not load saved English files.");
          }
        } finally {
          if (englishLoadRequestRef.current === loadRequestId) setIsLoadingEnglishAssets(false);
        }
      })();
    } else {
      setIsLoadingEnglishAssets(false);
    }
    setModalOpen(true);
  }

  async function generateVoiceover() {
    if (!selectedProject || !generatedScript.trim() || isGeneratingVoiceover) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !user) {
      setFormError("Sign in before generating a voiceover.");
      return;
    }
    setIsGeneratingVoiceover(true);
    setFormError("");
    setVoiceoverUrl("");
    setNotice("Generating Burmese voiceover with MyanmarTTS. The free CPU service may take a few minutes; please do not click again.");
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw new Error(sessionError.message);
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Your session expired. Please sign in again.");
      const response = await fetch("/api/generate-voiceover", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ projectId: selectedProject.id }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success || typeof result.signedUrl !== "string") {
        throw new Error(result?.error || "Voiceover generation failed (" + response.status + ").");
      }
      setVoiceoverUrl(result.signedUrl);
      const updated = { ...selectedProject, voiceoverPath: result.voiceoverPath };
      setSelectedProject(updated);
      setProjects((current) => current.map((p) => p.id === updated.id ? updated : p));
      setNotice("Voiceover generated and saved privately. Open the audio player below to preview.");
      window.setTimeout(() => setNotice(""), 7000);
    } catch (error) {
      setNotice("");
      setFormError(error instanceof Error ? error.message : "Could not generate voiceover.");
    } finally {
      setIsGeneratingVoiceover(false);
    }
  }

  function previewEnglishVoiceover() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setFormError("This browser does not support built-in speech. Please try the latest Chrome or Edge.");
      return;
    }
    if (isPreviewingEnglish) {
      window.speechSynthesis.cancel();
      setIsPreviewingEnglish(false);
      return;
    }
    const text = generatedScript.trim();
    if (!text) {
      setFormError("Generate or open a saved English script first.");
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 0.96;
    // Select a real installed voice by its commonly used name. Pitch alone does
    // not turn one voice into a genuinely different male/female narrator.
    utterance.pitch = 1;
    const englishVoices = window.speechSynthesis
      .getVoices()
      .filter((item) => item.lang.toLowerCase().startsWith("en"));
    const preferredNames = voice === "Female"
      ? ["samantha", "victoria", "aria", "jenny", "zira", "ava", "susan", "female"]
      : ["daniel", "david", "mark", "guy", "christopher", "eric", "ryan", "male"];
    const preferred = englishVoices.find((item) =>
      preferredNames.some((name) => item.name.toLowerCase().includes(name))
    );
    const fallback = englishVoices.find((item) => item.lang.toLowerCase() === "en-us") ?? englishVoices[0];
    const selectedVoice = preferred ?? fallback;
    if (selectedVoice) utterance.voice = selectedVoice;

    utterance.onstart = () => {
      setIsPreviewingEnglish(true);
      setNotice(preferred
        ? `Playing the installed English ${voice.toLowerCase()} voice: ${selectedVoice.name}.`
        : `Your device does not expose a clearly labelled ${voice.toLowerCase()} English voice. Playing its default English voice instead.`);
    };
    utterance.onend = () => setIsPreviewingEnglish(false);
    utterance.onerror = () => {
      setIsPreviewingEnglish(false);
      setFormError("English speech preview failed. Try another voice or browser.");
    };
    setFormError("");
    window.speechSynthesis.speak(utterance);
  }


  async function generateEnglishAudioAndSubtitles() {
    const script = generatedScript.trim();
    if (!script || !selectedProject || selectedProject.language !== "English") {
      setFormError("Open an English project with a generated script first.");
      return;
    }
    if (isGeneratingEnglishAudio) return;

    setIsGeneratingEnglishAudio(true);
    setFormError("");
    setEnglishProgress("Loading the free Kokoro voice model. The first load may take a few minutes...");
    setNotice("");

    try {
      let engine = headTtsRef.current;
      if (!engine) {
        const headTtsModuleUrl = new URL("/headtts/modules/headtts.mjs", window.location.href).toString();
        const headTtsModule = await import(/* webpackIgnore: true */ headTtsModuleUrl) as typeof import("@met4citizen/headtts");
        const { HeadTTS } = headTtsModule;
        const voiceId = voice === "Female" ? "af_bella" : "am_fenrir";
        const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
          (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        engine = new HeadTTS({
          // iOS Safari's WebGPU availability varies by OS/device. Prefer the
          // more compatible WASM backend there; Android/desktop try WebGPU first.
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
          splitLength: 450,
        });
        await engine.connect(null, (event) => {
          if (event.total > 0) {
            setEnglishProgress(`Downloading voice model: ${Math.round((event.loaded / event.total) * 100)}%`);
          } else {
            setEnglishProgress("Loading voice model...");
          }
        });
        headTtsRef.current = engine;
      }

      const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      setEnglishProgress("Voice model loaded. Initializing the audio engine...");
      await engine.setup({
        voice: voice === "Female" ? "af_bella" : "am_fenrir",
        language: "en-us",
        speed: 0.96,
        audioEncoding: "wav",
      });

      // Smaller sequential requests keep peak work per inference lower on phones
      // and provide visible progress instead of appearing frozen at 100%.
      const chunks = splitSpeechText(script, isIOS ? 260 : 450);
      let messages: Awaited<ReturnType<HeadTTSClient["synthesize"]>> = [];
      for (let index = 0; index < chunks.length; index += 1) {
        setEnglishProgress(`Generating audio part ${index + 1} of ${chunks.length}...`);
        const partMessages = await engine.synthesize({ input: chunks[index] });
        messages = messages.concat(partMessages);
      }
      const audioMessages = messages.filter((message) =>
        message.type === "audio" && message.data?.audio instanceof AudioBuffer
      );
      const failedMessage = messages.find((message) => message.type === "error");
      if (audioMessages.length === 0) {
        throw new Error(failedMessage?.data?.error || "The voice model did not return an audio file. Please try again.");
      }

      const buffers = audioMessages.map((message) => message.data!.audio as AudioBuffer);
      const timedWords: TimedWord[] = [];
      let offsetMs = 0;
      for (const message of audioMessages) {
        const data = message.data;
        const audio = data?.audio as AudioBuffer;
        const words = data?.words ?? [];
        const starts = data?.wtimes ?? [];
        const durations = data?.wdurations ?? [];
        for (let index = 0; index < words.length; index += 1) {
          const text = words[index]?.trim();
          if (!text) continue;
          const rawStart = Number(starts[index]);
          if (!Number.isFinite(rawStart) || rawStart < 0) continue;
          const rawDuration = Number(durations[index]);
          const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 300;
          const start = offsetMs + rawStart;
          timedWords.push({
            text,
            start,
            end: start + Math.max(120, duration),
          });
        }
        offsetMs += audio.duration * 1000;
      }
      if (timedWords.length === 0) {
        throw new Error("Audio was generated, but word timing data was missing. Please try again.");
      }

      const wavBlob = audioBuffersToWav(buffers);
      const srtBlob = new Blob([timedWordsToSrt(timedWords)], { type: "text/plain;charset=utf-8" });
      let englishAudioPath = selectedProject.englishAudioPath;
      let englishSrtPath = selectedProject.englishSrtPath;
      const supabase = getSupabaseBrowserClient();
      if (isSupabaseConfigured) {
        if (!supabase || !user) throw new Error("Sign in again before saving the generated English files.");
        const projectFolder = user.id + "/" + selectedProject.id + "/";
        englishAudioPath = projectFolder + "english-voiceover.wav";
        englishSrtPath = projectFolder + "english-subtitles.srt";
        const { error: audioUploadError } = await supabase.storage.from("voiceovers").upload(englishAudioPath, wavBlob, {
          contentType: "audio/wav", cacheControl: "3600", upsert: true,
        });
        if (audioUploadError) throw new Error("WAV was generated but could not be saved: " + audioUploadError.message);
        const { error: srtUploadError } = await supabase.storage.from("voiceovers").upload(englishSrtPath, srtBlob, {
          contentType: "text/plain", cacheControl: "3600", upsert: true,
        });
        if (srtUploadError) throw new Error("SRT was generated but could not be saved: " + srtUploadError.message);
        const { error: updateError } = await supabase.from("projects").update({
          english_audio_path: englishAudioPath,
          english_srt_path: englishSrtPath,
        }).eq("id", selectedProject.id).eq("user_id", user.id);
        if (updateError) throw new Error("Files were uploaded but their project record could not be saved: " + updateError.message);
      }
      if (englishAudioUrl) URL.revokeObjectURL(englishAudioUrl);
      if (englishSrtUrl) URL.revokeObjectURL(englishSrtUrl);
      setEnglishAudioUrl(URL.createObjectURL(wavBlob));
      setEnglishSrtUrl(URL.createObjectURL(srtBlob));
      const updatedProject = { ...selectedProject, englishAudioPath, englishSrtPath };
      setSelectedProject(updatedProject);
      setProjects((current) => current.map((project) => project.id === updatedProject.id ? updatedProject : project));
      setEnglishProgress("");
      setNotice(isSupabaseConfigured
        ? "English WAV + SRT generated and saved privately. Reopen this project to reuse the same files without generating again."
        : "English WAV voiceover and audio-timed SRT subtitles are ready in this browser.");
    } catch (error) {
      headTtsRef.current = null;
      setEnglishProgress("");
      setFormError(error instanceof Error ? error.message : "Could not generate English voiceover and subtitles.");
    } finally {
      setIsGeneratingEnglishAudio(false);
    }
  }

  async function saveExistingEnglishAssets() {
    if (!selectedProject || !existingEnglishWav || !existingEnglishSrt) {
      setFormError("Choose both an existing WAV file and its matching SRT subtitle file.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (isSupabaseConfigured && (!supabase || !user)) {
      setFormError("Sign in again before saving the existing English files.");
      return;
    }
    setIsGeneratingEnglishAudio(true);
    setFormError("");
    setEnglishProgress("Saving your existing WAV and SRT files to this project...");
    try {
      let englishAudioPath: string | null = null;
      let englishSrtPath: string | null = null;
      if (isSupabaseConfigured && supabase && user) {
        const projectFolder = user.id + "/" + selectedProject.id + "/";
        englishAudioPath = projectFolder + "english-voiceover.wav";
        englishSrtPath = projectFolder + "english-subtitles.srt";
        const { error: audioError } = await supabase.storage.from("voiceovers").upload(englishAudioPath, existingEnglishWav, {
          contentType: "audio/wav", cacheControl: "3600", upsert: true,
        });
        if (audioError) throw new Error("Could not save the WAV file: " + audioError.message);
        const { error: srtError } = await supabase.storage.from("voiceovers").upload(englishSrtPath, existingEnglishSrt, {
          contentType: "text/plain", cacheControl: "3600", upsert: true,
        });
        if (srtError) throw new Error("Could not save the SRT file: " + srtError.message);
        const { error: updateError } = await supabase.from("projects").update({
          english_audio_path: englishAudioPath,
          english_srt_path: englishSrtPath,
        }).eq("id", selectedProject.id).eq("user_id", user.id);
        if (updateError) throw new Error("Files were uploaded but the project could not be updated: " + updateError.message);
      }
      if (englishAudioUrl) URL.revokeObjectURL(englishAudioUrl);
      if (englishSrtUrl) URL.revokeObjectURL(englishSrtUrl);
      setEnglishAudioUrl(URL.createObjectURL(existingEnglishWav));
      setEnglishSrtUrl(URL.createObjectURL(existingEnglishSrt));
      const updatedProject = { ...selectedProject, englishAudioPath, englishSrtPath };
      setSelectedProject(updatedProject);
      setProjects((current) => current.map((project) => project.id === updatedProject.id ? updatedProject : project));
      setExistingEnglishWav(null);
      setExistingEnglishSrt(null);
      setEnglishProgress("");
      setNotice(isSupabaseConfigured ? "Your existing English WAV + SRT are saved to this project. They will be reused without generating again." : "Existing WAV + SRT loaded in this browser.");
    } catch (error) {
      setEnglishProgress("");
      setFormError(error instanceof Error ? error.message : "Could not save the existing English files.");
    } finally {
      setIsGeneratingEnglishAudio(false);
    }
  }

  function downloadEnglishAudio() {
    if (!englishAudioUrl) return;
    const safeTitle = (selectedProject?.title || "movie-recap").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    downloadBlob(englishAudioUrl, `${safeTitle || "movie-recap"}-voiceover.wav`);
  }

  function downloadEnglishSubtitles() {
    if (!englishSrtUrl) return;
    const safeTitle = (selectedProject?.title || "movie-recap").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    downloadBlob(englishSrtUrl, `${safeTitle || "movie-recap"}-subtitles.srt`);
  }

  async function deleteProject(id: string) {
    if (isSupabaseConfigured) {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { error } = await supabase.from("projects").delete().eq("id", id);
      if (error) {
        setNotice(`Could not delete project: ${error.message}`);
        return;
      }
    }
    setProjects((current) => current.filter((project) => project.id !== id));
  }

  async function signOut() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) setNotice(`Could not sign out: ${error.message}`);
  }

  if (authLoading) {
    return <main className="auth-shell"><section className="auth-card"><div className="loader" /><p className="auth-subtitle">Connecting to your workspace…</p></section></main>;
  }
  if (isSupabaseConfigured && !user) return <AuthPanel />;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="Movie Recap Studio home">
          <span className="brand-mark">M</span>
          <span className="brand-copy"><strong>movie recap</strong><small>STUDIO</small></span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="nav-link active" href="#home"><span className="nav-icon">▦</span> Overview</a>
          <button className="nav-link" onClick={() => { setSelectedProject(null); setTitle(""); setSourceUrl(""); setLanguage("Myanmar"); setDuration("5 min"); setVoice("Female"); setGeneratedScript(""); setFormError(""); setModalOpen(true); }}><span className="nav-icon">＋</span> New project</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-orb">✦</span>
            <strong>Your creative workspace</strong>
            <p>Turn a permitted video source into a narrated recap.</p>
          </div>
          <div className="profile-row">
            <div className="avatar">O</div>
            <div className="profile-copy"><strong>My workspace</strong><small>Local preview</small></div>
            <span className="more-dots">···</span>
          </div>
        </div>
      </aside>

      <section className="main-panel" id="home">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> Overview</div>
          <div className="topbar-right"><span className="status-dot" /> {isSupabaseConfigured ? "Cloud workspace" : "Local development"} <span className="top-avatar">{user?.email?.[0]?.toUpperCase() || "O"}</span></div>
        </header>

        <div className="page-content">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">YOUR AI VIDEO WORKSPACE</div>
              <h1>Make every story <em>worth sharing.</em></h1>
              <p className="page-subtitle">Create clear, engaging movie recaps with narration and subtitles.</p>
            </div>
            <button className="primary-button" onClick={() => { setSelectedProject(null); setTitle(""); setSourceUrl(""); setLanguage("Myanmar"); setDuration("5 min"); setVoice("Female"); setGeneratedScript(""); setFormError(""); setModalOpen(true); }}><span>＋</span> Create project</button>
          </div>

          <div className="prototype-notice"><span className="notice-icon">ⓘ</span><span><strong>Foundation build</strong> — {isSupabaseConfigured ? "Your projects are saved in your private Supabase account." : "Draft projects are saved in this browser only. Configure Supabase to sync them across devices."} Voiceover generation is available for saved scripts; subtitles and video rendering are next.</span></div>

          <div className="stats-grid">
            <article className="stat-card"><div className="stat-top"><span>Total projects</span><span className="stat-icon purple">▦</span></div><div className="stat-number">{hydrated ? projects.length : "—"}</div><div className="stat-foot">In this browser workspace</div></article>
            <article className="stat-card"><div className="stat-top"><span>In progress</span><span className="stat-icon orange">◷</span></div><div className="stat-number">{hydrated ? inProgressCount : "—"}</div><div className="stat-foot">Analysis or rendering</div></article>
            <article className="stat-card"><div className="stat-top"><span>Completed</span><span className="stat-icon green">✓</span></div><div className="stat-number">{hydrated ? completedCount : "—"}</div><div className="stat-foot">Ready to download</div></article>
          </div>

          <section className="projects-section">
            <div className="section-heading"><div><h2>Recent projects</h2><p>Your latest recap projects in one place.</p></div><div className="project-tools"><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" /></label><button className="filter-button" onClick={() => setSearch("")} title="Clear search">↺</button></div></div>

            {!hydrated ? <div className="empty-state"><div className="loader"/><p>Loading your workspace…</p></div> : filteredProjects.length === 0 ? (
              <div className="empty-state">
                <div className="empty-art"><span className="art-spark">✦</span><span className="art-play">▶</span><span className="art-line" /></div>
                <h3>{projects.length === 0 ? "Your first recap starts here" : "No matching projects"}</h3>
                <p>{projects.length === 0 ? "Add a video link to create your first movie recap project." : "Try another title or clear your search."}</p>
                {projects.length === 0 && <button className="secondary-button" onClick={() => { setSelectedProject(null); setTitle(""); setSourceUrl(""); setLanguage("Myanmar"); setDuration("5 min"); setVoice("Female"); setGeneratedScript(""); setFormError(""); setModalOpen(true); }}>Create your first project <span>→</span></button>}
                {projects.length > 0 && <button className="secondary-button" onClick={() => setSearch("")}>Clear search</button>}
              </div>
            ) : (
              <div className="project-list">
                {filteredProjects.map((project) => (
                  <article className="project-card" key={project.id}>
                    <div className="project-thumb"><span className="thumb-play">▶</span><span className="thumb-label">VIDEO SOURCE</span></div>
                    <div className="project-info"><h3>{project.title}</h3><a href={project.sourceUrl} target="_blank" rel="noreferrer">{project.sourceUrl}</a><div className="project-meta"><span>{project.language}</span><i /> <span>{project.duration}</span><i /> <span>{project.voice} voice</span></div></div>
                    <div className="project-right"><span className={`status-pill ${project.status.toLowerCase().replaceAll(" ", "-")}`}>{project.status}</span><small>{formatDate(project.createdAt)}</small><button className="secondary-button" onClick={() => openProject(project)}>Open project</button><button className="delete-button" onClick={() => deleteProject(project.id)} aria-label={`Delete ${project.title}`}>Delete</button></div>
                  </article>
                ))}
              </div>
            )}
          </section>
          <footer className="app-footer"><span>Movie Recap Studio <b>·</b> Foundation 0.2</span><span>Built for original, licensed or otherwise authorized source media.</span></footer>
        </div>
      </section>

      {notice && <div className="toast" role="status"><span>✓</span>{notice}<button onClick={() => setNotice("")}>×</button></div>}

      {modalOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModalOpen(false); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
          <div className="modal-heading"><div><div className="eyebrow">{selectedProject ? "SAVED WORKSPACE PROJECT" : "NEW WORKSPACE PROJECT"}</div><h2 id="create-title">{selectedProject ? selectedProject.title : "Start a new recap"}</h2><p>{selectedProject ? "Review the saved settings and script, or generate a script for this project." : "Add a video source and choose your narration settings."}</p></div><button className="close-button" onClick={() => setModalOpen(false)} aria-label="Close">×</button></div>
          <form onSubmit={createProject} className="project-form">
            <label className="field-label">Project name <span>Optional</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. The hidden truth behind…" maxLength={90} /></label>
            <label className="field-label">Video URL <span>Required</span><input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." type="url" required /></label>
            <div className="form-two-col"><label className="field-label">Recap style<select value={recapType} onChange={(event) => setRecapType(event.target.value as "review" | "full_recap")}><option value="review">Movie Review / Commentary</option><option value="full_recap">Full Movie Recap</option></select></label><label className="field-label">Narration language<select value={language} onChange={(event) => setLanguage(event.target.value as "Myanmar" | "English")}><option>Myanmar</option><option>English</option></select></label></div>
            <label className="field-label">Video visuals<select value={videoVisualMode} onChange={(event) => setVideoVisualMode(event.target.value as "original_clips" | "ai_visuals")}><option value="original_clips">Original video clips (authorized footage)</option><option value="ai_visuals">AI-generated visuals</option></select><small style={{ display: "block", color: "#747484", fontWeight: 400, marginTop: 5 }}>Choose the visual source for your final recap video.</small></label>
            <label className="field-label">Recap length<select value={duration} onChange={(event) => setDuration(event.target.value as "3 min" | "5 min" | "10 min")}><option>3 min</option><option>5 min</option><option>10 min</option></select></label>
            <div className="field-label">Narrator voice</div><div className="voice-options"><button type="button" className={`voice-option ${voice === "Female" ? "selected" : ""}`} onClick={() => setVoice("Female")}><span className="voice-avatar">♀</span><span><strong>Female</strong><small>Warm narration</small></span><span className="radio-dot" /></button><button type="button" className={`voice-option ${voice === "Male" ? "selected" : ""}`} onClick={() => setVoice("Male")}><span className="voice-avatar male">♂</span><span><strong>Male</strong><small>Deep narration</small></span><span className="radio-dot" /></button></div><p className="modal-note">{language === "English" ? "English: the selected Male/Female option chooses a matching voice installed on this device when available. Voice names and gender labels vary by browser and operating system, so a default English voice may be used if no match is available." : "Myanmar: MyanmarTTS currently provides one built-in Burmese voice. The Male/Female setting does not change Burmese audio yet."}</p>
            {(isGenerating || isGeneratingVoiceover) && (
              <div className="modal-note" role="status" aria-live="polite">
                {isGeneratingVoiceover
                  ? "AI is generating your voiceover. Keep this window open; do not submit again."
                  : <>{scriptProgress || "Gemini is processing your video..."} Elapsed: {Math.floor(scriptElapsedSeconds / 60)}m {scriptElapsedSeconds % 60}s. Keep this window open; do not submit again.</>}
              </div>
            )}
            {selectedProject && !generatedScript && (
              <p className="modal-note" role="status">
                This saved project does not have a recap script yet. Choose Generate Recap Script when you are ready. Saving changes will not use AI.
              </p>
            )}
            {generatedScript && (
              <section
                aria-live="polite"
                style={{
                  border: "1px solid #e7e7ed",
                  borderRadius: 9,
                  padding: 13,
                  maxHeight: 300,
                  overflowY: "auto",
                }}
              >
                <h3 style={{ fontSize: 12, margin: "0 0 9px" }}>{recapType === "review" ? "Generated review / commentary script" : "Generated full movie recap script"}</h3>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    fontFamily: "inherit",
                    fontSize: 11,
                    lineHeight: 1.7,
                    margin: 0,
                  }}
                >
                  {generatedScript}
                </pre>
              </section>
            )}
            {selectedProject && selectedProject.language === "English" && (
              <section style={{ border: "1px solid #e7e7ed", borderRadius: 9, padding: 13, display: "grid", gap: 10 }}>
                <div>
                  <h3 style={{ fontSize: 12, margin: "0 0 5px" }}>English AI Voiceover + Timed Subtitles</h3>
                  <p style={{ fontSize: 11, color: "#747484", margin: 0 }}>Free, open-source Kokoro voice generation runs in this browser. Choose Male or Female in the project settings. The first use downloads the voice model; keep this page open until generation finishes.</p>
                </div>
                {isLoadingEnglishAssets && <p className="modal-note" role="status">Loading your saved English WAV + SRT files… Please wait. No voice generation is running.</p>}
                {selectedProject.englishAudioPath && selectedProject.englishSrtPath ? (
                  <>
                    <p className="modal-note" style={{ margin: 0 }}>{englishAudioUrl && englishSrtUrl ? "Your saved WAV + SRT are loaded and ready to use." : "This project already has saved WAV + SRT files. They load automatically when the project opens."}</p>
                    <button type="button" className="secondary-button" onClick={generateEnglishAudioAndSubtitles} disabled={!generatedScript || isGenerating || isGeneratingVoiceover || isGeneratingEnglishAudio || isLoadingEnglishAssets}>
                      {isGeneratingEnglishAudio ? "Generating new English voice + subtitles..." : "Regenerate English WAV + SRT"}
                    </button>
                  </>
                ) : (
                  <button type="button" className="secondary-button" onClick={generateEnglishAudioAndSubtitles} disabled={!generatedScript || isGenerating || isGeneratingVoiceover || isGeneratingEnglishAudio || isLoadingEnglishAssets}>
                    {isGeneratingEnglishAudio ? "Generating English voice + subtitles..." : "Generate English WAV + SRT →"}
                  </button>
                )}
                {isGeneratingEnglishAudio && <p className="modal-note" role="status">{englishProgress || "Preparing voice model..."}</p>}
                {(!selectedProject.englishAudioPath || !selectedProject.englishSrtPath) && (
                  <div style={{ display: "grid", gap: 7 }}>
                    <p className="modal-note" style={{ margin: 0 }}>Already generated these files earlier? Select your downloaded WAV and matching SRT here to save them without running voice generation again.</p>
                    <label className="field-label">Existing English WAV<input type="file" accept=".wav,audio/wav" onChange={(event) => setExistingEnglishWav(event.target.files?.[0] ?? null)} /></label>
                    <label className="field-label">Existing SRT subtitles<input type="file" accept=".srt,text/plain" onChange={(event) => setExistingEnglishSrt(event.target.files?.[0] ?? null)} /></label>
                    <button type="button" className="secondary-button" onClick={saveExistingEnglishAssets} disabled={!existingEnglishWav || !existingEnglishSrt || isGeneratingEnglishAudio}>Save existing WAV + SRT to project</button>
                  </div>
                )}
                {englishAudioUrl && (
                  <div style={{ display: "grid", gap: 9 }}>
                    <audio controls preload="metadata" src={englishAudioUrl} style={{ width: "100%" }}>Your browser does not support audio playback.</audio>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button type="button" className="secondary-button" onClick={downloadEnglishAudio}>Download WAV</button>
                      <button type="button" className="secondary-button" onClick={downloadEnglishSubtitles}>Download SRT subtitles</button>
                    </div>
                  </div>
                )}
                <p className="modal-note">Narrator: <strong>{voice}</strong> · {voice === "Female" ? "American English — Bella" : "American English — Fenrir"}. Subtitle timing comes from the generated speech timestamps. {selectedProject.englishAudioPath && selectedProject.englishSrtPath ? "Saved privately in your project and reused when you reopen it; no need to generate again." : isSupabaseConfigured ? "Generated files are saved privately to this project." : "Files are available in this browser only."}</p>
                <button type="button" className="secondary-button" onClick={previewEnglishVoiceover} disabled={isGenerating || isGeneratingVoiceover || isGeneratingEnglishAudio}>
                  {isPreviewingEnglish ? "Stop quick device preview ■" : "Quick preview using device voice"}
                </button>
              </section>
            )}
            {generatedScript && selectedProject && selectedProject.language === "Myanmar" && (
              <section style={{ border: "1px solid #e7e7ed", borderRadius: 9, padding: 13, display: "grid", gap: 10 }}>
                <div>
                  <h3 style={{ fontSize: 12, margin: "0 0 5px" }}>Myanmar Voiceover · Open Source</h3>
                  <p style={{ fontSize: 11, color: "#747484", margin: 0 }}>MyanmarTTS open-source Burmese model. Audio is saved in your private storage. The free CPU host may sleep between uses.</p>
                </div>
                {voiceoverUrl && <audio controls preload="none" src={voiceoverUrl} style={{ width: "100%" }}>Your browser does not support audio playback.</audio>}
                <button type="button" className="secondary-button" onClick={generateVoiceover} disabled={isGenerating || isGeneratingVoiceover}>
                  {isGeneratingVoiceover ? "Generating voiceover..." : selectedProject.voiceoverPath ? "Regenerate Voiceover" : "Generate Voiceover →"}
                </button>
                {isGeneratingVoiceover && <p className="modal-note">One voice generation request is running. The first request may take longer while the free service wakes up.</p>}
              </section>
            )}
                        {selectedProject && (
              (selectedProject.language === "English" && Boolean(englishAudioUrl)) ||
              (selectedProject.language === "Myanmar" && Boolean(voiceoverUrl))
            ) && (
              <VideoRenderer
                visualMode={selectedProject.videoVisualMode ?? "original_clips"}
                audioUrl={selectedProject.language === "English" ? englishAudioUrl : voiceoverUrl}
                subtitleUrl={selectedProject.language === "English" ? englishSrtUrl : undefined}
                projectTitle={selectedProject.title}
                expectedDuration={selectedProject.duration}
                scenePlan={sceneEditPlan}
              />
            )}
            {selectedProject && generatedScript && (
              <ScenePlanBuilder
                videoUrl={selectedProject.sourceUrl}
                script={generatedScript}
                language={selectedProject.language}
                onPlanGenerated={setSceneEditPlan}
              />
            )}
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="modal-note"><span>ⓘ</span><p>Save Project is free and only stores the YouTube link. Generate Recap Script sends the public video URL to Gemini's YouTube URL preview, which Google currently lists as no-charge. Free-tier rate limits and regional availability apply. Use media you own or are authorized to process.</p></div>
            <div className="modal-actions">
              <button type="button" className="cancel-button" onClick={() => setModalOpen(false)}>Close</button>
              <button type="submit" name="action" value="save" className="secondary-button" disabled={isGenerating || isGeneratingVoiceover}>
                {selectedProject ? "Save Changes" : "Save Project"}
              </button>
              <button type="submit" name="action" value="generate" className="primary-button" disabled={isGenerating || isGeneratingVoiceover}>
                {isGenerating ? "Analyzing..." : selectedProject?.script ? "Regenerate Recap Script →" : "Generate Recap Script →"}
              </button>
            </div>
          </form>
        </section>
      </div>}
    </main>
  );
}
