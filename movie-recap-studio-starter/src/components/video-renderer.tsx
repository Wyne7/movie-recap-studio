"use client";

import { useEffect, useRef, useState } from "react";
import type { FFmpeg as FFmpegInstance } from "@ffmpeg/ffmpeg";
import type { SceneEditPlan } from "@/components/scene-plan-builder";

type VideoRendererProps = {
  visualMode: "original_clips" | "ai_visuals";
  audioUrl: string;
  subtitleUrl?: string;
  projectTitle: string;
  expectedDuration: "3 min" | "5 min" | "10 min";
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
  scenePlan,
}: VideoRendererProps) {
  const ffmpegRef = useRef<FFmpegInstance | null>(null);
  const ffmpegLoadedRef = useRef(false);
  const outputUrlRef = useRef("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [authorizedMediaUrl, setAuthorizedMediaUrl] = useState("");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
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

  async function renderVideo() {
    if (!audioUrl || !audioDuration || isRendering) return;
    const useScenePlan = visualMode === "original_clips" && Boolean(scenePlan?.segments.length);
    if (visualMode === "original_clips" && !videoFile && !(useScenePlan && authorizedMediaUrl.trim())) {
      setError(useScenePlan ? "Paste a CORS-enabled authorized direct video URL or choose an authorized video file." : "Choose an authorized video file before rendering.");
      return;
    }
    if (visualMode === "ai_visuals" && imageFiles.length === 0) {
      setError("Choose at least one AI-generated image before rendering.");
      return;
    }
    if (videoFile && videoFile.size > MAX_VIDEO_BYTES) {
      setError("For browser rendering, please choose a video smaller than 500 MB.");
      return;
    }
    if (imageFiles.some((file) => file.size > MAX_IMAGE_BYTES)) {
      setError("Each image must be smaller than 15 MB.");
      return;
    }
    if (imageFiles.length > MAX_IMAGES) {
      setError("Choose no more than 12 images for one render.");
      return;
    }

    setIsRendering(true);
    setProgress(0);
    setError("");
    setStatus("Preparing browser video renderer…");
    clearOutput();

    try {
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
          args.push("-f", "lavfi", "-i", "color=c=black:s=" + width + "x" + height + ":r=30:d=" + duration.toFixed(3));
          for (const segment of validSegments) {
            const sourceLength = segment.sourceEndSeconds - segment.sourceStartSeconds;
            args.push("-ss", segment.sourceStartSeconds.toFixed(3), "-t", sourceLength.toFixed(3), "-i", "source-video.mp4");
          }
          audioInputIndex = 1 + validSegments.length;
          const filters = ["[0:v]format=yuv420p[base0]"];
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
        const imageCount = imageFiles.length;
        const secondsPerImage = duration / imageCount;
        const filters: string[] = [];
        const concatInputs: string[] = [];
        for (let index = 0; index < imageCount; index += 1) {
          const file = imageFiles[index];
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
        <label className="field-label">
          Authorized original video file
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/webm,.m4v"
            onChange={(event) => { setVideoFile(event.target.files?.[0] ?? null); clearOutput(); }}
            disabled={isRendering}
          />
          <small style={{ display: "block", color: "#747484", fontWeight: 400, marginTop: 4 }}>
            Choose a video you own or have permission to reuse. One file per render; maximum 500 MB. When an AI scene plan is available, you can instead paste a direct media URL below.
          </small>
        </label>
      ) : (
        <label className="field-label">
          AI-generated visual images
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            multiple
            onChange={(event) => { setImageFiles(Array.from(event.target.files ?? [])); clearOutput(); }}
            disabled={isRendering}
          />
          <small style={{ display: "block", color: "#747484", fontWeight: 400, marginTop: 4 }}>
            Upload up to 12 AI-generated images. They will be arranged as a {scenePlan?.aspectRatio === "9:16" ? "9:16" : "16:9"} slideshow. This version renders images you provide; automatic AI image generation is a separate future feature.
          </small>
        </label>
      )}

      {visualMode === "original_clips" && scenePlan?.segments.length ? (
        <label className="field-label">
          Authorized direct video URL (optional)
          <input
            type="url"
            value={authorizedMediaUrl}
            placeholder="https://media.example.com/authorized-video.mp4"
            onChange={(event) => { setAuthorizedMediaUrl(event.target.value); clearOutput(); }}
            disabled={isRendering}
          />
          <small style={{ display: "block", color: "#747484", fontWeight: 400, marginTop: 4 }}>
            Use a direct HTTPS media-file link you are authorized to process. The host must allow browser CORS access; YouTube watch/share links are not direct media files. If this link cannot be fetched, use the authorized video file picker above.
          </small>
        </label>
      ) : null}

      <div className="modal-note">
        Narration length: <strong>{durationLabel}</strong> · Project setting: <strong>{expectedDuration}</strong>{scenePlan ? " · AI edit plan: " + scenePlan.segments.length + " scenes · " + scenePlan.aspectRatio : ""}
        {subtitleUrl ? " · Timed SRT subtitles will be embedded as a selectable subtitle track." : " · No subtitle file is attached to this voiceover."}
      </div>

      <button
        type="button"
        className="primary-button"
        onClick={renderVideo}
        disabled={isRendering || !audioDuration || (visualMode === "original_clips" ? (!videoFile && !(scenePlan?.segments.length && authorizedMediaUrl.trim())) : imageFiles.length === 0)}
      >
        {isRendering ? "Rendering MP4…" : "Render MP4 video →"}
      </button>

      {isRendering && (
        <div className="modal-note" role="status" aria-live="polite">
          {status} {progress > 0 ? progress + "%" : ""}
          <div style={{ height: 6, background: "#ececf1", borderRadius: 9, overflow: "hidden", marginTop: 8 }}>
            <div style={{ width: progress + "%", height: "100%", background: "#6858df", transition: "width .2s" }} />
          </div>
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
