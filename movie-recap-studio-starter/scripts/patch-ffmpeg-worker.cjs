const fs = require("node:fs");
const path = require("node:path");

const target = path.join(
  process.cwd(),
  "node_modules",
  "@ffmpeg",
  "ffmpeg",
  "dist",
  "esm",
  "classes.js"
);

if (!fs.existsSync(target)) {
  console.error("[ffmpeg-worker-fix] Could not find @ffmpeg/ffmpeg classes.js at:", target);
  process.exit(1);
}

const original = "new URL(classWorkerURL, import.meta.url)";
const compatible = "new URL(classWorkerURL, Object(import.meta).url)";
const source = fs.readFileSync(target, "utf8");

if (source.includes(compatible)) {
  console.log("[ffmpeg-worker-fix] Worker URL compatibility patch is already applied.");
} else if (source.includes(original)) {
  fs.writeFileSync(target, source.replace(original, compatible), "utf8");
  console.log("[ffmpeg-worker-fix] Applied Next.js-compatible FFmpeg worker URL patch.");
} else {
  console.error("[ffmpeg-worker-fix] Unexpected @ffmpeg/ffmpeg source; refusing to modify it.");
  process.exit(1);
}
