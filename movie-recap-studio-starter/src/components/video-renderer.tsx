"use client";

import { useEffect, useRef, useState } from "react";
import type { FFmpeg as FFmpegInstance } from "@ffmpeg/ffmpeg";
import type { SceneEditPlan } from "@/components/scene-plan-builder";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type VideoRendererProps = {
  visualMode: "original_clips" | "ai_visuals";
  audioUrl: string;
  subtitleUrl?: string;
  projectTitle: string;
  expectedDuration: "3 min" | "5 min" | "10 min";
  sourceVideoUrl: string;
  scenePlan?: SceneEditPlan | null;
};

const CORE_BASE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 12;

function safeFilePart(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "movie-recap";
}

export function VideoRenderer({
  visualMode,
  audioUrl,
  subtitleUrl,
  projectTitle,
  expectedDuration,
  sourceVideoUrl,
  scenePlan,
}: VideoRendererProps) {
  const ffmpegRef = useRef<FFmpegInstance | null>(null);
  const ffmpegLoadedRef = useRef(false);
  const outputUrlRef = useRef("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [authorizedMediaUrl, setAuthorizedMediaUrl] = useState("");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [generatedImageFiles, setGeneratedImageFiles] = useState<File[]>([]);
  const [visualProgress, setVisualProgress] = useState({ completed: 0, total: 0 });
  const [audioDuration, setAudioDuration] = useState(0);
  const [isRendering, setIsRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [outputUrl, setOutputUrl] = useState("");

  useEffect(() => {
    setAudioDuration(0);
    const audio = new Audio(audioUrl);
    const updateDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setAudioDuration(audio.duration);
      }
    };
    audio.addEventListener("loadedmetadata", updateDuration);
    audio.load();
    return () => {
      audio.removeEventListener("loadedmetadata", updateDuration);
    };
  }, [audioUrl]);

  useEffect(() => () => {
    if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
    ffmpegRef.current?.terminate();
    ffmpegRef.current = null;
    ffmpegLoadedRef.current = false;
  }, []);

  function clearOutput() {
    if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
    outputUrlRef.current = "";
    setOutputUrl("");
  }

  useEffect(() => {
    setGeneratedImageFiles([]);
    setVisualProgress({ completed: 0, total: 0 });
  }, [sourceVideoUrl, scenePlan]);

  async function generateAiVisuals(): Promise<File[]> {
    if (!scenePlan?.segments.length) {
      throw new Error("Generate the AI Scene Selection plan first, then create AI visuals.");
    }
    if (!sourceVideoUrl) throw new Error("This project has no YouTube source URL for AI visual generation.");
    const supabase = getSupabaseBrowserClient();
    if (!supabase) throw new Error("Sign in is required to generate AI visuals.");
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session?.access_token) {
      throw new Error("Your session expired. Please sign in again.");
    }

    const segments = scenePlan.segments.slice(0, MAX_IMAGES);
    const files: File[] = [];
    setVisualProgress({ completed: 0, total: segments.length });
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      setStatus("Generating AI visual " + (index + 1) + " of " + segments.length + " from the YouTube scene plan…");
      const response = await fetch("/api/generate-ai-visual", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + sessionData.session.access_token,
        },
        body: JSON.stringify({
          videoUrl: sourceVideoUrl,
          segment,
          style: scenePlan.style,
          aspectRatio: scenePlan.aspectRatio,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success || typeof data.imageBase64 !== "string") {
        throw new Error(data?.error || "Could not generate AI visual " + (index + 1) + ".");
      }
      const binary = atob(data.imageBase64);
      const bytes = new Uint8Array(binary.length);
      for (let byteIndex = 0; byteIndex < binary.length; byteIndex += 1) {
        bytes[byteIndex] = binary.charCodeAt(byteIndex);
      }
      const mimeType = typeof data.mimeType === "string" ? data.mimeType : "image/png";
      const extension = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
      const imageBlob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
      files.push(new File([imageBlob], "ai-scene-" + (index + 1) + "." + extension, { type: mimeType }));
      setVisualProgress({ completed: index + 1, total: segments.length });
    }
    return files;
  }

  async function renderVideo() {
    if (!audioUrl || !audioDuration || isRendering) return;
    const useScenePlan = visualMode === "original_clips" && Boolean(scenePlan?.segments.length);
    if (visualMode === "original_clips" && !videoFile && !authorizedMediaUrl.trim()) {
      setError("Paste an authorized direct video-file URL or use the optional local-file fallback.");
      return;
    }
    if (visualMode === "ai_visuals" && imageFiles.length === 0 && generatedImageFiles.length === 0 && (!scenePlan?.segments.length || !sourceVideoUrl)) {
      setError("Generate AI Scene Selection first. The app will then create visuals from your YouTube link automatically, or you can upload your own images.");
      return;
    }
    if (videoFile && videoFile.size > MAX_VIDEO_BYTES) {
      setError("For browser rendering, please choose a video smaller than 500 MB.");
      return;
    }
    const existingRenderImages = imageFiles.length ? imageFiles : generatedImageFiles;
    if (existingRenderImages.some((file) => file.size > MAX_IMAGE_BYTES)) {
      setError("Each image must be smaller than 15 MB.");
      return;
    }
    if (existingRenderImages.length > MAX_IMAGES) {
      setError("Choose no more than 12 images for one render.");
      return;
    }

    setIsRendering(true);
    setProgress(0);
    setError("");
    setStatus("Preparing browser video renderer…");
    clearOutput();

    try {
      let renderImages = existingRenderImages;
      if (visualMode === "ai_visuals" && renderImages.length === 0) {
        renderImages = await generateAiVisuals();
        setGeneratedImageFiles(renderImages);
      }
      const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
        import("@ffmpeg/ffmpeg"),
        import("@ffmpeg/util"),
      ]);
      let ffmpeg = ffmpegRef.current;
      if (!ffmpeg) {
        ffmpeg = new FFmpeg();
        ffmpeg.on("progress", ({ progress: nextProgress }) => {
          setProgress(Math.max(0, Math.min(100, Math.round(nextProgress * 100))));
        });
        ffmpegRef.current = ffmpeg;
      }

      if (!ffmpegLoadedRef.current) {
        setStatus("Downloading the free FFmpeg engine (about 31 MB, first use only)…");
        await ffmpeg.load({
          coreURL: await toBlobURL(CORE_BASE_URL + "/ffmpeg-core.js", "text/javascript"),
          wasmURL: await toBlobURL(CORE_BASE_URL + "/ffmpeg-core.wasm", "application/wasm"),
        });
        ffmpegLoadedRef.current = true;
      }

      setStatus("Loading narration and visual files into your browser…");
      await ffmpeg.writeFile("narration.wav", await fetchFile(audioUrl));
      const duration = Math.max(1, Math.min(audioDuration, 600));
      const width = scenePlan?.aspectRatio === "9:16" ? 720 : 1280;
      const height = scenePlan?.aspectRatio === "9:16" ? 1280 : 720;
      const args: string[] = ["-y"];
      let audioInputIndex = 0;
      let subtitleInputIndex = -1;
      let videoMap: string;

      if (visualMode === "original_clips" && (videoFile || authorizedMediaUrl.trim())) {
        let sourceBlob: Blob;
        if (authorizedMediaUrl.trim()) {
          const mediaUrl = new URL(authorizedMediaUrl.trim());
          if (mediaUrl.protocol !== "https:") throw new Error("For safety, the direct media URL must use HTTPS.");
          const mediaHost = mediaUrl.hostname.toLowerCase().replace(/^www\\./, "");
          if (mediaHost === "youtube.com" || mediaHost === "m.youtube.com" || mediaHost === "youtu.be") {
            throw new Error("Paste a direct authorized video-file URL, not a YouTube watch/share link. The YouTube link is used separately for AI scene analysis.");
          }
          setStatus("Fetching the authorized direct video URL in your browser…");
          const mediaResponse = await fetch(mediaUrl.toString(), { mode: "cors", cache: "no-store" });
          if (!mediaResponse.ok) throw new Error("The direct video URL could not be read. Check that the link is public and allows browser CORS access.");
          const declaredSize = Number(mediaResponse.headers.get("content-length") || 0);
          if (declaredSize > MAX_VIDEO_BYTES) throw new Error("The direct video is larger than the 500 MB browser-rendering limit.");
          const mediaType = (mediaResponse.headers.get("content-type") || "").toLowerCase();
          if (mediaType && !mediaType.startsWith("video/") && !mediaType.includes("octet-stream")) {
            throw new Error("The direct URL did not return a video file. Use a direct MP4/MOV/WebM media URL, not a webpage or YouTube watch link.");
          }
          sourceBlob = await mediaResponse.blob();
          if (!sourceBlob.size || sourceBlob.size > MAX_VIDEO_BYTES) throw new Error("The downloaded video is empty or exceeds the 500 MB limit.");
        } else {
          sourceBlob = videoFile as File;
        }
        await ffmpeg.writeFile("source-video.mp4", await fetchFile(sourceBlob));
        if (useScenePlan && scenePlan?.segments.length) {
          const validSegments = scenePlan.segments
            .filter((segment) => Number.isFinite(segment.sourceStartSeconds) &&
              Number.isFinite(segment.sourceEndSeconds) &&
              Number.isFinite(segment.narrationStartSeconds) &&
              Number.isFinite(segment.narrationEndSeconds) &&
              segment.sourceStartSeconds >= 0 &&
              segment.sourceEndSeconds > segment.sourceStartSeconds &&
              segment.narrationStartSeconds >= 0 &&
              segment.narrationEndSeconds > segment.narrationStartSeconds &&
              segment.narrationStartSeconds < duration)
            .map((segment) => ({
              ...segment,
              narrationEndSeconds: Math.min(duration, segment.narrationEndSeconds),
            }))
            .filter((segment) => segment.narrationEndSeconds > segment.narrationStartSeconds)
            .sort((a, b) => a.narrationStartSeconds - b.narrationStartSeconds)
            .slice(0, 40);
          if (!validSegments.length) throw new Error("The AI scene plan has no usable timestamps within this narration's duration. Generate a new scene plan.");
          args.push("-stream_loop", "-1", "-t", duration.toFixed(3), "-i", "source-video.mp4");
          for (const segment of validSegments) {
            const sourceLength = segment.sourceEndSeconds - segment.sourceStartSeconds;
            args.push("-ss", segment.sourceStartSeconds.toFixed(3), "-t", sourceLength.toFixed(3), "-i", "source-video.mp4");
          }
          audioInputIndex = 1 + validSegments.length;
          const filters = ["[0:v]scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,crop=" + width + ":" + height + ",setsar=1,fps=30,format=yuv420p[base0]"];
          let previous = "base0";
          validSegments.forEach((segment, index) => {
            const inputIndex = index + 1;
            const sourceLength = segment.sourceEndSeconds - segment.sourceStartSeconds;
            const targetStart = segment.narrationStartSeconds;
            const targetLength = segment.narrationEndSeconds - segment.narrationStartSeconds;
            const clipLabel = "clip" + index;
            const outputLabel = "base" + (index + 1);
            filters.push(
              "[" + inputIndex + ":v]trim=duration=" + sourceLength.toFixed(3) +
              ",setpts=(PTS-STARTPTS)*" + (targetLength / sourceLength).toFixed(6) +
              "+" + targetStart.toFixed(3) + "/TB,scale=" + width + ":" + height +
              ":force_original_aspect_ratio=increase,crop=" + width + ":" + height +
              ",setsar=1,fps=30,format=yuv420p[" + clipLabel + "]"
            );
            filters.push(
              "[" + previous + "][" + clipLabel + "]overlay=eof_action=pass:shortest=0:enable='between(t," +
              targetStart.toFixed(3) + "," + segment.narrationEndSeconds.toFixed(3) + ")'[" + outputLabel + "]"
            );
            previous = outputLabel;
          });
          args.push("-filter_complex", filters.join(";"));
          videoMap = "[" + previous + "]";
        } else {
          args.push("-stream_loop", "-1", "-i", "source-video.mp4");
          audioInputIndex = 1;
          videoMap = "0:v:0";
        }
      } else {
        const imageCount = renderImages.length;
        const secondsPerImage = duration / imageCount;
        const filters: string[] = [];
        const concatInputs: string[] = [];
        for (let index = 0; index < imageCount; index += 1) {
          const file = renderImages[index];
          const extension = (file.name.split(".").pop() || "jpg").toLowerCase();
          const safeExtension = ["jpg", "jpeg", "png", "webp"].includes(extension) ? extension : "jpg";
          const inputName = "visual-" + index + "." + safeExtension;
          await ffmpeg.writeFile(inputName, await fetchFile(file));
          args.push("-loop", "1", "-framerate", "30", "-t", secondsPerImage.toFixed(3), "-i", inputName);
          filters.push(
            "[" + index + ":v]scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease," +
            "pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v" + index + "]"
          );
          concatInputs.push("[v" + index + "]");
        }
        filters.push(concatInputs.join("") + "concat=n=" + imageCount + ":v=1:a=0[vout]");
        args.push("-filter_complex", filters.join(";"));
        audioInputIndex = imageCount;
        videoMap = "[vout]";
      }

      args.push("-i", "narration.wav");
      if (subtitleUrl) {
        setStatus("Loading timed subtitles…");
        await ffmpeg.writeFile("captions.srt", await fetchFile(subtitleUrl));
        subtitleInputIndex = audioInputIndex + 1;
        args.push("-i", "captions.srt");
      }

      if (visualMode === "original_clips" && !useScenePlan) {
        args.push(
          "-vf",
          "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p"
        );
      }
      args.push(
        "-map", videoMap,
        "-map", audioInputIndex + ":a:0"
      );
      if (subtitleInputIndex >= 0) args.push("-map", subtitleInputIndex + ":0");
      args.push(
        "-t", duration.toFixed(3),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k"
      );
      if (subtitleInputIndex >= 0) args.push("-c:s", "mov_text");
      args.push("-movflags", "+faststart", "recap-output.mp4");

      setStatus("Rendering MP4 in this browser. Keep this tab open…");
      await ffmpeg.exec(args);
      setStatus("Preparing your MP4 download…");
      const data = await ffmpeg.readFile("recap-output.mp4");
      if (typeof data === "string") throw new Error("The renderer returned an invalid MP4 file.");
      const outputBytes = new Uint8Array(data);
      const blob = new Blob([outputBytes.buffer as ArrayBuffer], { type: "video/mp4" });
      if (!blob.size) throw new Error("The rendered MP4 is empty. Please try another source file.");
      const url = URL.createObjectURL(blob);
      outputUrlRef.current = url;
      setOutputUrl(url);
      setProgress(100);
      setStatus("MP4 is ready. Preview it below or download it.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Video rendering failed. Please try again.");
      setStatus("");
    } finally {
      setIsRendering(false);
    }
  }

  const durationLabel = audioDuration
    ? Math.floor(audioDuration / 60) + ":" + String(Math.floor(audioDuration % 60)).padStart(2, "0")
    : "Reading audio duration…";

  return (
    <section style={{ border: "1px solid #e7e7ed", borderRadius: 9, padding: 13, display: "grid", gap: 10 }}>
      <div>
        <h3 style={{ fontSize: 12, margin: "0 0 5px" }}>Video Rendering · MP4</h3>
        <p style={{ fontSize: 11, color: "#747484", margin: 0 }}>
          Free FFmpeg runs in your browser. Your media files are processed on this device and are not uploaded to a rendering server.
        </p>
      </div>

      {visualMode === "original_clips" ? (
        <>
          <label className="field-label">
            Direct authorized video URL
            <input
              type="url"
              value={authorizedMediaUrl}
              placeholder="https://media.example.com/authorized-video.mp4"
              onChange={(event) => { setAuthorizedMediaUrl(event.target.value); clearOutput(); }}
              disabled={isRendering}
            />
            <small style={{ display: "block", color: "#747484", fontWeight: 400, marginTop: 4 }}>
              Main source for automatic scene editing. Paste a direct HTTPS MP4/MOV/WebM file URL that you own or have permission to reuse. The file host must allow browser CORS access and the file must be 500 MB or smaller. A YouTube watch/share link is for AI analysis only; it is not a direct video-file URL.
            </small>
          </label>
          <details style={{ border: "1px solid #ececf1", borderRadius: 7, padding: 10 }}>
            <summary style={{ cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
              Optional fallback: choose a video file from this device
            </summary>
            <label className="field-label" style={{ marginTop: 10 }}>
              Authorized original video file
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm,.m4v"
                onChange={(event) => { setVideoFile(event.target.files?.[0] ?? null); clearOutput(); }}
                disabled={isRendering}
              />
              <small style={{ display: "block", color: "#747484", fontWeight: 400, marginTop: 4 }}>
                Use only a video you own or have permission to reuse. Maximum 500 MB. A pasted direct URL takes priority when both are provided.
              </small>
            </label>
          </details>
        </>
      ) : (
        <label className="field-label">
          AI-generated visual images
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            multiple
            onChange={(event) => { setImageFiles(Array.from(event.target.files ?? [])); setGeneratedImageFiles([]); clearOutput(); }}
            disabled={isRendering}
          />
          <small style={{ display: "block", color: "#747484", fontWeight: 400, marginTop: 4 }}>
            After AI Scene Selection, the app can generate up to 12 original scene illustrations from this YouTube link and arrange them into a slideshow. You can also upload your own images instead. Image generation uses your configured Gemini API quota and may incur charges.
          </small>
        </label>
      )}

      <div className="modal-note">
        Narration length: <strong>{durationLabel}</strong> · Project setting: <strong>{expectedDuration}</strong>{scenePlan ? " · AI edit plan: " + scenePlan.segments.length + " scenes · " + scenePlan.aspectRatio : ""}
        {subtitleUrl ? " · Timed SRT subtitles will be embedded as a selectable subtitle track." : " · No subtitle file is attached to this voiceover."}
      </div>

      <button
        type="button"
        className="primary-button"
        onClick={renderVideo}
        disabled={isRendering || !audioDuration || (visualMode === "original_clips" ? (!videoFile && !authorizedMediaUrl.trim()) : (imageFiles.length === 0 && generatedImageFiles.length === 0 && (!scenePlan?.segments.length || !sourceVideoUrl)))}
      >
        {isRendering ? "Working…" : visualMode === "ai_visuals" && imageFiles.length === 0 && generatedImageFiles.length === 0 ? "Generate AI visuals + Render MP4 →" : "Render MP4 video →"}
      </button>

      {isRendering && (
        <div className="modal-note" role="status" aria-live="polite" style={{ display: "grid", gap: 7 }}>
          <span>{status}</span>
          {visualProgress.total > 0 && visualMode === "ai_visuals" && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}><strong>AI visual generation</strong><strong>{visualProgress.completed}/{visualProgress.total}</strong></div>
              <progress value={visualProgress.completed} max={visualProgress.total} style={{ width: "100%", height: 9 }} />
            </>
          )}
          {progress > 0 ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                <strong>Render progress</strong><strong>{progress}%</strong>
              </div>
              <progress value={progress} max={100} style={{ width: "100%", height: 9 }} />
            </>
          ) : (
            <>
              <progress style={{ width: "100%", height: 9 }} />
              <small>Preparing files or starting FFmpeg. A percentage will appear when the renderer reports measurable progress.</small>
            </>
          )}
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!isRendering && status && <p className="modal-note" role="status">{status}</p>}

      {outputUrl && (
        <div style={{ display: "grid", gap: 9 }}>
          <video controls preload="metadata" src={outputUrl} style={{ width: "100%", borderRadius: 8, background: "#111" }} />
          <a
            className="primary-button"
            href={outputUrl}
            download={safeFilePart(projectTitle) + "-recap.mp4"}
            style={{ textDecoration: "none", textAlign: "center" }}
          >
            Download MP4
          </a>
        </div>
      )}
      <p className="modal-note" style={{ margin: 0 }}>
        First use downloads the FFmpeg engine (~31 MB). Longer videos can take several minutes and use significant device memory; keep this tab open until rendering finishes.
      </p>
    </section>
  );
}
