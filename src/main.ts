import "./style.css";
import { AsciiEngine, CHARSETS, rowsFor } from "./engine";
import { FrameCache } from "./frame-cache";
import { render } from "./renderer";
import { decompressFrames, parseGIF } from "gifuct-js";
import type { Settings } from "./types";

const app = document.querySelector<HTMLDivElement>("#app")!;
type GifFrame = { bitmap: ImageBitmap; delay: number; start: number };
const engine = new AsciiEngine();
let file: File | null = null,
  video: HTMLVideoElement | null = null,
  gifFrames: GifFrame[] = [],
  gifIndex = 0,
  gifDuration = 0,
  gifPlaying = false,
  gifClock = 0,
  gifElapsed = 0,
  raf = 0,
  objectUrl = "",
  exporting = false,
  abortExport = false,
  preparing = false,
  loopEnabled = true,
  lastPreviewDraw = 0,
  drawTimer = 0,
  activePreviewFps = 15,
  prepareGeneration = 0;
const sourceCanvas = document.createElement("canvas"),
  sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true })!;
const CACHE_BYTES = 192 * 1024 * 1024;
const frameCache = new FrameCache(CACHE_BYTES),
  pendingFrames = new Set<string>();
let cacheGeneration = 0;
window.setInterval(() => frameCache.prune(), 60_000);
const mp4Mime = () =>
  ["video/mp4;codecs=avc1.42E01E", "video/mp4"].find(
    (type) =>
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(type),
  );
const settings: Settings = {
  columns: 120,
  mode: "balanced",
  charset: CHARSETS.classic,
  color: "original",
  brightness: 0,
  contrast: 1,
  gamma: 1,
  invert: false,
  dither: "ordered",
  smoothing: 0.65,
  hysteresis: 0.06,
  edgeWeight: 0.8,
  background: { r: 0, g: 0, b: 0 },
};

function home() {
  cleanup();
  app.innerHTML = `<h1>Video to ASCII</h1><label class="drop" id="drop"><span>Drop a video or GIF here</span><span><button type="button" id="pick">Select file</button></span><input id="file" type="file" accept="video/mp4,video/webm,video/quicktime,image/gif"></label><p class="status" id="status">Processing stays on this device.</p>`;
  const input = $<HTMLInputElement>("file"),
    drop = $("drop");
  $("pick").onclick = (e) => {
    e.preventDefault();
    input.click();
  };
  input.onchange = () => input.files?.[0] && open(input.files[0]);
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("drag");
  };
  drop.ondragleave = () => drop.classList.remove("drag");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    const f = e.dataTransfer?.files[0];
    if (f) open(f);
  };
}
function $<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
function cleanup() {
  cancelAnimationFrame(raf);
  video?.pause();
  gifFrames.forEach((frame) => frame.bitmap.close());
  gifFrames = [];
  gifIndex = 0;
  gifDuration = 0;
  gifPlaying = false;
  gifElapsed = 0;
  frameCache.prune();
  pendingFrames.clear();
  cacheGeneration++;
  prepareGeneration++;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = "";
  video = null;
  engine.reset();
}
function valid(f: File) {
  return (
    f.type.startsWith("video/") ||
    f.type === "image/gif" ||
    /\.(mp4|webm|mov|gif)$/i.test(f.name)
  );
}
async function open(f: File) {
  if (!valid(f)) {
    alert("Unsupported file. Select MP4, WebM, MOV, or GIF.");
    return;
  }
  if (f.type === "image/gif" || f.name.toLowerCase().endsWith(".gif")) {
    await openGif(f);
    return;
  }
  cleanup();
  file = f;
  video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  objectUrl = URL.createObjectURL(f);
  video.src = objectUrl;
  video.onerror = () =>
    alert(
      "This browser cannot decode the video codec. Try WebM (VP8/VP9) or browser-compatible MP4 (H.264).",
    );
  await new Promise<void>((ok, bad) => {
    video!.onloadedmetadata = () => ok();
    video!.onerror = () => bad(new Error("Codec not supported"));
  }).catch((e) => {
    alert(e.message);
    home();
  });
  if (!video) return;
  workspace();
  const preview = $("preview");
  preview.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  video.loop = loopEnabled;
  await prepareVideo();
  video.onseeked = draw;
  video.onplay = () => {
    lastPreviewDraw = 0;
    loop();
  };
  video.onended = () => {
    $("play").textContent = "Play";
  };
  draw();
}
function workspace() {
  app.innerHTML = `<h1>Video to ASCII</h1><section class="workspace"><div class="preview" id="preview"><canvas id="canvas" aria-label="ASCII video preview"></canvas><div class="player-overlay" id="playerOverlay" hidden><span class="ascii-spinner" id="loadingSpinner" aria-hidden="true">[ | ]</span><span id="loadingText">Preparing ASCII frames… 0%</span><div class="loading-track"><span id="loadingFill"></span></div></div></div><div class="transport"><button id="play">Play</button><button id="loop" class="toggle" type="button" aria-pressed="${loopEnabled}">Loop ${loopEnabled ? "on" : "off"}</button><input id="seek" type="range" min="0" max="1000" value="0" aria-label="Video position"><span id="time">0:00</span></div><div class="controls">
${select("Style", "style", [
  ["classic", "Classic ASCII"],
  ["detailed", "Detailed ASCII"],
  ["blocks", "Blocks"],
  ["binary", "Binary"],
  ["custom", "Custom"],
])}${select("Mode", "mode", [
    ["fast", "Fast"],
    ["balanced", "Balanced"],
    ["high", "High Quality"],
    ["edge", "Edge Art"],
    ["braille", "Braille"],
  ])}${select("Color", "color", [
    ["original", "Original colors"],
    ["mono", "Grayscale"],
    ["green", "Terminal green"],
    ["amber", "Amber"],
    ["gameboy", "Game Boy"],
    ["purple", "Purple & Green"],
    ["red", "Red Terminal"],
    ["cyan", "Cyan Terminal"],
    ["bw", "Black & White"],
  ])}${select(
    "Background",
    "background",
    [
      ["black", "Black"],
      ["white", "White"],
    ],
    settings.background.r === 255 ? "white" : "black",
  )}${range("Symbols", "columns", 40, 400, settings.columns, 1)}
</div><details><summary>Advanced</summary><div class="controls">${select(
    "Dithering",
    "dither",
    [
      ["none", "None"],
      ["ordered", "Ordered (Bayer 4×4)"],
      ["floyd", "Floyd–Steinberg"],
    ],
  )}${range("Smoothing", "smoothing", 0, 1, settings.smoothing, 0.05)}${range("Contrast", "contrast", 0.2, 2, settings.contrast, 0.05)}${range("Gamma", "gamma", 0.2, 3, settings.gamma, 0.05)}${range("Brightness", "brightness", -0.5, 0.5, settings.brightness, 0.05)}${range("Edge weight", "edgeWeight", 0, 2, settings.edgeWeight, 0.1)}<label class="field"><span>Custom set</span><input id="custom" type="text" value=" .oO0@#"></label><label class="field"><span>Invert</span><input id="invert" type="checkbox"></label></div></details><label class="export-field"><span>Export format</span><span class="select-control"><select id="format"><option value="webm">WebM</option><option value="gif">GIF</option><option value="mp4" ${mp4Mime() ? "" : "disabled"}>${mp4Mime() ? "MP4" : "MP4 (encoder unavailable)"}</option></select></span></label><div class="export-panel" id="progressPanel" hidden><div class="export-head"><span id="progressLabel">Preparing export</span><span id="progressPercent">0%</span></div><div class="export-track"><span id="progressFill"></span></div></div><p id="status" class="status"></p><div class="actions"><button id="download">Download</button><button id="cancel" hidden>Cancel export</button><button id="new">New file</button></div></section>`;
  bind();
}
function select(
  label: string,
  id: string,
  opts: string[][],
  selected = String((settings as any)[id]),
) {
  return `<label class="field"><span>${label}</span><span class="select-control"><select id="${id}">${opts.map(([v, n]) => `<option value="${v}" ${selected === v ? "selected" : ""}>${n}</option>`).join("")}</select></span></label>`;
}
function range(
  label: string,
  id: string,
  min: number,
  max: number,
  value: number,
  step: number,
) {
  return `<label class="field range-field"><span>${label}</span><span class="range-control"><input id="${id}" type="range" min="${min}" max="${max}" value="${value}" step="${step}"><output id="${id}Out">${value}</output></span></label>`;
}
function scheduleDraw() {
  if (drawTimer) return;
  drawTimer = window.setTimeout(
    () => {
      drawTimer = 0;
      engine.reset();
      draw();
    },
    settings.columns > 240 ? 140 : 60,
  );
}
function bind() {
  [
    "columns",
    "smoothing",
    "contrast",
    "gamma",
    "brightness",
    "edgeWeight",
  ].forEach((id) => {
    const el = $<HTMLInputElement>(id);
    el.oninput = () => {
      (settings as any)[id] = Number(el.value);
      $(id + "Out").textContent = el.value;
      scheduleDraw();
    };
  });
  ["mode", "color", "dither"].forEach((id) => {
    $<HTMLSelectElement>(id).onchange = (e) => {
      (settings as any)[id] = (e.target as HTMLSelectElement).value;
      engine.reset();
      draw();
    };
  });
  $<HTMLSelectElement>("background").onchange = (e) => {
    const white = (e.target as HTMLSelectElement).value === "white";
    settings.background = white
      ? { r: 255, g: 255, b: 255 }
      : { r: 0, g: 0, b: 0 };
    engine.reset();
    draw();
  };
  $<HTMLSelectElement>("style").onchange = (e) => {
    const v = (e.target as HTMLSelectElement).value;
    settings.charset =
      v === "custom"
        ? $<HTMLInputElement>("custom").value
        : (CHARSETS as any)[v];
    engine.reset();
    draw();
  };
  $<HTMLInputElement>("custom").oninput = (e) => {
    if ($<HTMLSelectElement>("style").value === "custom")
      settings.charset = (e.target as HTMLInputElement).value || " ";
    scheduleDraw();
  };
  $<HTMLInputElement>("invert").onchange = (e) => {
    settings.invert = (e.target as HTMLInputElement).checked;
    draw();
  };
  $("play").onclick = () => {
    if (video) {
      if (video.paused) video.play();
      else video.pause();
      $("play").textContent = video.paused ? "Play" : "Pause";
    } else if (gifFrames.length) {
      gifPlaying ? pauseGif() : playGif();
    }
  };
  $("loop").onclick = () => {
    loopEnabled = !loopEnabled;
    if (video) video.loop = loopEnabled;
    const button = $("loop");
    button.setAttribute("aria-pressed", String(loopEnabled));
    button.textContent = `Loop ${loopEnabled ? "on" : "off"}`;
  };
  $<HTMLInputElement>("seek").oninput = (e) => {
    const ratio = Number((e.target as HTMLInputElement).value) / 1000;
    if (video) {
      video.currentTime = ratio * video.duration;
      engine.reset();
    } else if (gifFrames.length) {
      gifElapsed = ratio * gifDuration;
      gifIndex = frameAt(gifElapsed);
      engine.reset();
      draw();
    }
  };
  $("new").onclick = home;
  $("download").onclick = exportFile;
  $("cancel").onclick = () => (abortExport = true);
}
function sourceSize() {
  if (video) return { width: video.videoWidth, height: video.videoHeight };
  const bitmap = gifFrames[gifIndex]?.bitmap;
  return bitmap ? { width: bitmap.width, height: bitmap.height } : null;
}
function basePreviewFps() {
  return settings.columns > 320
    ? 6
    : settings.columns > 240
      ? 8
      : settings.columns > 160
        ? 12
        : 15;
}
function previewFps() {
  return video
    ? Math.min(activePreviewFps, basePreviewFps())
    : basePreviewFps();
}
function cellWidth() {
  return settings.columns > 320
    ? 3
    : settings.columns > 240
      ? 4
      : settings.columns > 160
        ? 5
        : 6;
}
function conversionKey() {
  const position = video
    ? `v${Math.floor(video.currentTime * previewFps())}`
    : `g${gifIndex}`;
  return `${file?.name}:${file?.size}:${file?.lastModified}|${position}|${settings.columns}|${settings.mode}|${settings.charset}|${settings.color}|${settings.background.r}|${settings.brightness}|${settings.contrast}|${settings.gamma}|${settings.invert}|${settings.dither}|${settings.smoothing}|${settings.hysteresis}|${settings.edgeWeight}`;
}
function updateFrameUi(rows: number, count: number) {
  $("columnsOut").textContent =
    `${settings.columns} × ${rows} · ${count.toLocaleString()} symbols`;
  if (preparing) return;
  if (video?.duration) {
    $<HTMLInputElement>("seek").value = String(
      (video.currentTime / video.duration) * 1000,
    );
    $("time").textContent =
      `${format(video.currentTime)} / ${format(video.duration)}`;
  } else if (gifFrames.length) {
    $<HTMLInputElement>("seek").value = String(
      (gifElapsed / gifDuration) * 1000,
    );
    $("time").textContent =
      `${format(gifElapsed / 1000)} / ${format(gifDuration / 1000)}`;
  }
}
function draw() {
  const size = sourceSize();
  if (!size || (video && video.readyState < 2)) return;
  const key = conversionKey(),
    cached = frameCache.get(key),
    canvas = $<HTMLCanvasElement>("canvas"),
    out = canvas.getContext("2d")!;
  if (cached) {
    canvas.width = cached.width;
    canvas.height = cached.height;
    out.drawImage(cached.bitmap, 0, 0);
    updateFrameUi(cached.rows, cached.count);
    engine.reset();
    return;
  }
  const sourceWidth = Math.min(size.width, Math.max(640, settings.columns * 4)),
    scale = sourceWidth / size.width;
  sourceCanvas.width = Math.max(1, Math.round(size.width * scale));
  sourceCanvas.height = Math.max(1, Math.round(size.height * scale));
  sourceContext.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  sourceContext.drawImage(
    video ?? gifFrames[gifIndex].bitmap,
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height,
  );
  const result = engine.convert(
      sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height),
      settings,
    ),
    cw = cellWidth();
  render(
    out,
    result.cells,
    settings.columns,
    result.rows,
    settings.columns * cw,
    result.rows * cw * 2,
    settings.background,
  );
  updateFrameUi(result.rows, result.cells.length);
  if (!pendingFrames.has(key)) {
    pendingFrames.add(key);
    const generation = cacheGeneration,
      width = canvas.width,
      height = canvas.height;
    createImageBitmap(canvas)
      .then((bitmap) => {
        pendingFrames.delete(key);
        if (generation !== cacheGeneration) {
          bitmap.close();
          return;
        }
        frameCache.set(key, {
          bitmap,
          width,
          height,
          rows: result.rows,
          count: result.cells.length,
        });
      })
      .catch(() => pendingFrames.delete(key));
  }
}
async function seekVideo(time: number) {
  const target = video;
  if (!target || Math.abs(target.currentTime - time) < 0.001) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
        target.removeEventListener("error", fail);
        resolve();
      },
      fail = () => {
        target.removeEventListener("seeked", done);
        reject(new Error("Could not seek video while preparing cache."));
      };
    target.addEventListener("seeked", done, { once: true });
    target.addEventListener("error", fail, { once: true });
    target.currentTime = time;
  });
}
async function prepareVideo() {
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
  const generation = ++prepareGeneration,
    rows = rowsFor(video.videoWidth, video.videoHeight, settings.columns),
    cw = cellWidth(),
    bytesPerFrame = settings.columns * cw * rows * cw * 2 * 4,
    maxFrames = Math.max(1, Math.floor(CACHE_BYTES / bytesPerFrame));
  activePreviewFps = Math.max(
    0.5,
    Math.min(basePreviewFps(), maxFrames / video.duration),
  );
  const total = Math.max(
      1,
      Math.min(maxFrames, Math.ceil(video.duration * activePreviewFps)),
    ),
    overlay = $("playerOverlay"),
    label = $("loadingText"),
    spinner = $("loadingSpinner"),
    fill = $("loadingFill"),
    spin = ["[ | ]", "[ / ]", "[ - ]", "[ \\ ]"];
  overlay.hidden = false;
  preparing = true;
  video.pause();
  $<HTMLInputElement>("seek").value = "0";
  $("time").textContent = `0:00 / ${format(video.duration)}`;
  engine.reset();
  for (let i = 0; i < total && generation === prepareGeneration; i++) {
    await seekVideo(Math.min(video.duration - 0.001, i / activePreviewFps));
    draw();
    const key = conversionKey();
    while (pendingFrames.has(key) && generation === prepareGeneration)
      await new Promise((resolve) => setTimeout(resolve, 0));
    const percent = Math.round(((i + 1) / total) * 100);
    spinner.textContent = spin[i % spin.length];
    label.textContent = `Preparing ASCII frames… ${percent}%`;
    fill.style.width = `${percent}%`;
    if (i % 4 === 0) await new Promise(requestAnimationFrame);
  }
  if (generation !== prepareGeneration) {
    preparing = false;
    return;
  }
  await seekVideo(0);
  preparing = false;
  engine.reset();
  draw();
  overlay.hidden = true;
}
function loop(now = performance.now()) {
  const fps = previewFps();
  if (now - lastPreviewDraw >= 1000 / fps) {
    draw();
    lastPreviewDraw = now;
  }
  if (video && !video.paused && !video.ended) raf = requestAnimationFrame(loop);
  else if ($("play")) $("play").textContent = "Play";
}
function frameAt(ms: number) {
  let index = gifFrames.length - 1;
  for (let i = 0; i < gifFrames.length; i++) {
    if (gifFrames[i].start + gifFrames[i].delay > ms) {
      index = i;
      break;
    }
  }
  return Math.max(0, index);
}
function playGif() {
  if (!gifFrames.length) return;
  if (gifElapsed >= gifDuration) {
    gifElapsed = 0;
    gifIndex = 0;
    engine.reset();
  }
  gifPlaying = true;
  gifClock = performance.now() - gifElapsed;
  $("play").textContent = "Pause";
  raf = requestAnimationFrame(gifLoop);
}
function pauseGif() {
  gifPlaying = false;
  cancelAnimationFrame(raf);
  $("play").textContent = "Play";
}
function gifLoop(now: number) {
  if (!gifPlaying) return;
  gifElapsed = now - gifClock;
  if (gifElapsed >= gifDuration) {
    if (loopEnabled) {
      gifElapsed %= gifDuration;
      gifClock = now - gifElapsed;
      engine.reset();
    } else {
      gifElapsed = gifDuration;
      gifIndex = gifFrames.length - 1;
      gifPlaying = false;
      draw();
      $("play").textContent = "Play";
      return;
    }
  }
  const next = frameAt(gifElapsed);
  if (next !== gifIndex) {
    gifIndex = next;
    draw();
  } else {
    $<HTMLInputElement>("seek").value = String(
      (gifElapsed / gifDuration) * 1000,
    );
    $("time").textContent =
      `${format(gifElapsed / 1000)} / ${format(gifDuration / 1000)}`;
  }
  raf = requestAnimationFrame(gifLoop);
}
const format = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function exportProgress(value: number, label: string) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  $("progressPanel").hidden = false;
  $("progressLabel").textContent = label;
  $("progressPercent").textContent = `${percent}%`;
  $("progressFill").style.width = `${percent}%`;
}
function renderExportFrame(
  source: CanvasImageSource,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
  exportEngine: AsciiEngine,
  buffer: HTMLCanvasElement,
  bufferContext: CanvasRenderingContext2D,
) {
  const sourceWidth = Math.min(width, Math.max(640, settings.columns * 4)),
    scale = sourceWidth / width;
  buffer.width = Math.max(1, Math.round(width * scale));
  buffer.height = Math.max(1, Math.round(height * scale));
  bufferContext.clearRect(0, 0, buffer.width, buffer.height);
  bufferContext.drawImage(source, 0, 0, buffer.width, buffer.height);
  const result = exportEngine.convert(
      bufferContext.getImageData(0, 0, buffer.width, buffer.height),
      settings,
    ),
    out = canvas.getContext("2d")!,
    cw = cellWidth();
  render(
    out,
    result.cells,
    settings.columns,
    result.rows,
    settings.columns * cw,
    result.rows * cw * 2,
    settings.background,
  );
}
async function exportFile() {
  if ((!video && !gifFrames.length) || exporting) return;
  const fmt = $<HTMLSelectElement>("format").value;
  if (fmt === "gif") {
    $("status").textContent =
      "Animated GIF output is not connected yet; choose WebM or a supported MP4 encoder.";
    return;
  }
  const mime =
    fmt === "mp4"
      ? mp4Mime()
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
          MediaRecorder.isTypeSupported,
        );
  if (!mime) {
    $("status").textContent =
      `${fmt.toUpperCase()} encoding is not supported by this browser.`;
    return;
  }
  exporting = true;
  abortExport = false;
  $("cancel").hidden = false;
  $("download").setAttribute("disabled", "");
  $("status").textContent =
    "Exporting locally in the background. The player remains independent.";
  exportProgress(0, "Rendering frames");
  const canvas = document.createElement("canvas"),
    buffer = document.createElement("canvas"),
    bufferContext = buffer.getContext("2d", { willReadFrequently: true })!,
    exportEngine = new AsciiEngine(),
    size = sourceSize()!,
    cw = cellWidth();
  canvas.width = settings.columns * cw;
  canvas.height = rowsFor(size.width, size.height, settings.columns) * cw * 2;
  const stream = canvas.captureStream(30),
    chunks: Blob[] = [];
  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 5_000_000,
  });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((ok) => (rec.onstop = () => ok()));
  if (video) {
    const exportVideo = document.createElement("video");
    exportVideo.muted = true;
    exportVideo.playsInline = true;
    exportVideo.preload = "auto";
    exportVideo.src = objectUrl;
    await new Promise<void>((resolve, reject) => {
      exportVideo.onloadeddata = () => resolve();
      exportVideo.onerror = () =>
        reject(new Error("Could not open the video for export."));
    });
    renderExportFrame(
      exportVideo,
      exportVideo.videoWidth,
      exportVideo.videoHeight,
      canvas,
      exportEngine,
      buffer,
      bufferContext,
    );
    rec.start(500);
    await exportVideo.play();
    while (
      !abortExport &&
      !exportVideo.ended &&
      exportVideo.currentTime < exportVideo.duration - 0.02
    ) {
      renderExportFrame(
        exportVideo,
        exportVideo.videoWidth,
        exportVideo.videoHeight,
        canvas,
        exportEngine,
        buffer,
        bufferContext,
      );
      exportProgress(
        exportVideo.currentTime / exportVideo.duration,
        "Rendering frames",
      );
      await new Promise((r) => setTimeout(r, 40));
    }
    exportVideo.pause();
    exportVideo.removeAttribute("src");
    exportVideo.load();
  } else {
    const started = performance.now();
    rec.start(500);
    while (!abortExport) {
      const elapsed = performance.now() - started;
      if (elapsed >= gifDuration) break;
      const frame = gifFrames[frameAt(elapsed)];
      renderExportFrame(
        frame.bitmap,
        frame.bitmap.width,
        frame.bitmap.height,
        canvas,
        exportEngine,
        buffer,
        bufferContext,
      );
      exportProgress(elapsed / gifDuration, "Rendering frames");
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  if (!abortExport) exportProgress(1, "Finalizing file");
  rec.stop();
  await done;
  if (!abortExport) {
    const extension = fmt === "mp4" ? "mp4" : "webm",
      blob = new Blob(chunks, { type: mime }),
      a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${file!.name.replace(/\.[^.]+$/, "")}-ascii.${extension}`;
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    exportProgress(1, "Download ready");
    $("status").textContent =
      `${extension.toUpperCase()} exported successfully (${(blob.size / 1024 / 1024).toFixed(1)} MB).`;
  } else {
    $("status").textContent = "Export cancelled.";
  }
  finishExport();
}
function finishExport() {
  exporting = false;
  $("cancel").hidden = true;
  $("download").removeAttribute("disabled");
  if (abortExport) $("progressPanel").hidden = true;
}
async function openGif(f: File) {
  cleanup();
  file = f;
  app.innerHTML =
    '<h1>Video to ASCII</h1><p class="status">Reading GIF locally…</p>';
  try {
    const parsed = parseGIF(await f.arrayBuffer()),
      frames = decompressFrames(parsed, true);
    if (!frames.length) throw new Error("No GIF frames were found.");
    const width = Math.max(
        ...frames.map((frame) => frame.dims.left + frame.dims.width),
      ),
      height = Math.max(
        ...frames.map((frame) => frame.dims.top + frame.dims.height),
      ),
      composite = document.createElement("canvas"),
      patch = document.createElement("canvas");
    workspace();
    $("preview").style.aspectRatio = `${width} / ${height}`;
    const overlay = $("playerOverlay"),
      label = $("loadingText"),
      spinner = $("loadingSpinner"),
      fill = $("loadingFill"),
      spin = ["[ | ]", "[ / ]", "[ - ]", "[ \\ ]"];
    overlay.hidden = false;
    label.textContent = "Preparing GIF frames… 0%";
    composite.width = width;
    composite.height = height;
    const context = composite.getContext("2d")!,
      patchContext = patch.getContext("2d")!;
    let start = 0;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i],
        before =
          frame.disposalType === 3
            ? context.getImageData(0, 0, width, height)
            : null;
      patch.width = frame.dims.width;
      patch.height = frame.dims.height;
      const patchPixels = Uint8ClampedArray.from(frame.patch);
      patchContext.putImageData(
        new ImageData(patchPixels, frame.dims.width, frame.dims.height),
        0,
        0,
      );
      context.drawImage(patch, frame.dims.left, frame.dims.top);
      const delay = Math.max(20, frame.delay || 100);
      gifFrames.push({
        bitmap: await createImageBitmap(composite),
        delay,
        start,
      });
      start += delay;
      if (frame.disposalType === 2)
        context.clearRect(
          frame.dims.left,
          frame.dims.top,
          frame.dims.width,
          frame.dims.height,
        );
      else if (frame.disposalType === 3 && before)
        context.putImageData(before, 0, 0);
      const percent = Math.round(((i + 1) / frames.length) * 100);
      spinner.textContent = spin[i % spin.length];
      label.textContent = `Preparing GIF frames… ${percent}%`;
      fill.style.width = `${percent}%`;
      if (i % 10 === 0) await new Promise(requestAnimationFrame);
    }
    gifDuration = start;
    gifIndex = 0;
    gifElapsed = 0;
    overlay.hidden = true;
    draw();
  } catch (error) {
    cleanup();
    home();
    alert(
      `Could not decode this GIF: ${error instanceof Error ? error.message : "invalid data"}`,
    );
  }
}
home();
