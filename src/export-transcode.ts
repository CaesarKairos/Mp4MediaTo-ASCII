import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

export type ExportFormat = "webm" | "mp4" | "gif";

const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
let ffmpeg: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

export function transcodeArguments(format: Exclude<ExportFormat, "webm">) {
  if (format === "mp4") {
    return [
      "-i", "input.webm", "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart", "output.mp4",
    ];
  }
  return [
    "-i", "input.webm", "-filter_complex",
    "[0:v]split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a",
    "-loop", "0", "output.gif",
  ];
}

async function loadFfmpeg(onProgress: (ratio: number) => void) {
  if (ffmpeg?.loaded) return ffmpeg;
  if (!loading) {
    loading = (async () => {
      const instance = new FFmpeg();
      instance.on("progress", ({ progress }) => onProgress(progress));
      await instance.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      });
      ffmpeg = instance;
      return instance;
    })().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

export async function transcodeWebm(
  input: Blob,
  format: Exclude<ExportFormat, "webm">,
  onProgress: (ratio: number) => void,
) {
  const instance = await loadFfmpeg(onProgress);
  const outputName = `output.${format}`;
  await instance.writeFile("input.webm", await fetchFile(input));
  try {
    const result = await instance.exec(transcodeArguments(format));
    if (result !== 0) throw new Error(`FFmpeg exited with code ${result}.`);
    const data = await instance.readFile(outputName);
    if (typeof data === "string") throw new Error("FFmpeg returned an invalid media file.");
    return new Blob([data.slice().buffer], {
      type: format === "mp4" ? "video/mp4" : "image/gif",
    });
  } finally {
    await Promise.allSettled([
      instance.deleteFile("input.webm"),
      instance.deleteFile(outputName),
    ]);
  }
}
