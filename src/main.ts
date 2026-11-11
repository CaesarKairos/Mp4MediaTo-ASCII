import "./style.css";
import { AsciiEngine, CHARSETS, rowsFor } from "./engine";
import { FrameCache } from "./frame-cache";
import { render } from "./renderer";
import { outputTimeline } from "./export-timing";
import { AdaptiveQuality, QUALITY_CANDIDATES, percentile, selectQuality, type QualityMode } from "./quality";
import { WebMMuxer } from "./webm-muxer";
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
  requestedPlaybackFps = 30,
  sourceFps = 30,
  prepareGeneration = 0,
  loadingRaf = 0;
const sourceCanvas = document.createElement("canvas"),
  sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true })!;
const CACHE_BYTES = 192 * 1024 * 1024;
const frameCache = new FrameCache(CACHE_BYTES),
  pendingFrames = new Set<string>();
let cacheGeneration = 0;
let qualityMode: QualityMode = "auto", exportSettings: Settings;
const adaptiveQuality = new AdaptiveQuality(2, QUALITY_CANDIDATES.length - 1);
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
exportSettings = structuredClone(settings);

function home() {
  cleanup();
  app.innerHTML = `${brand()}<label class="drop" id="drop"><span>Drop a video or GIF here</span><span><button type="button" id="pick">Select file</button></span><input id="file" type="file" accept="video/mp4,video/webm,video/quicktime,image/gif"></label><p class="status" id="status">Processing stays on this device.</p>`;
  bindBrand();
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
function brand() {
  return '<h1><button class="brand" id="homeLink" type="button" aria-label="Return to the initial screen">Video to ASCII</button></h1>';
}
function bindBrand() {
  $("homeLink").onclick = () => void navigateHome();
}
async function navigateHome() {
  abortExport = true;
  while (exporting) await new Promise((resolve) => setTimeout(resolve, 30));
  home();
}
function $<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
function loadingSpinnerFrame(time: number) {
  const frames = ["[ | ]", "[ / ]", "[ - ]", "[ \\ ]"];
  return frames[Math.floor(time / 0.08) % frames.length];
}
function startLoadingSpinner() {
  cancelAnimationFrame(loadingRaf);
  const spinner = $<HTMLPreElement>("loadingSpinner"), started = performance.now();
  const tick = (now: number) => {
    spinner.textContent = loadingSpinnerFrame((now - started) / 1000);
    loadingRaf = requestAnimationFrame(tick);
  };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) spinner.textContent = loadingSpinnerFrame(0);
  else loadingRaf = requestAnimationFrame(tick);
}
function stopLoadingSpinner() { cancelAnimationFrame(loadingRaf); loadingRaf = 0; }
function cleanup() {
  cancelAnimationFrame(raf);
  stopLoadingSpinner();
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
  if (qualityMode === "auto") await runAutoQuality();
  video.onseeked = draw;
  video.onplay = () => {
    lastPreviewDraw = 0;
    observeSourceFps();
    loop();
  };
  video.onended = () => {
    $("play").textContent = "Play";
  };
  draw();
}
function observeSourceFps() {
  if (!video?.requestVideoFrameCallback) return;
  let previous = -1, samples = 0, sum = 0;
  const observe = (_now:number, metadata:VideoFrameCallbackMetadata) => {
    if (!video || video.paused || samples >= 30) return;
    if (previous >= 0 && metadata.mediaTime > previous) { sum += metadata.mediaTime - previous; samples++; sourceFps = Math.max(1,Math.min(240,samples/sum)); }
    previous = metadata.mediaTime; video.requestVideoFrameCallback(observe);
  };
  video.requestVideoFrameCallback(observe);
}
function workspace() {
  app.innerHTML = `${brand()}<section class="workspace"><div class="preview" id="preview"><canvas id="canvas" aria-label="ASCII video preview"></canvas><div class="player-overlay" id="playerOverlay" hidden><pre class="ascii-spinner" id="loadingSpinner" role="status" aria-label="Loading"></pre><span id="loadingText">Preparing ASCII frames… 0%</span><div class="loading-track"><span id="loadingFill"></span></div></div></div><div class="transport"><button id="play">Play</button><button id="loop" class="toggle" type="button" aria-pressed="${loopEnabled}">Loop ${loopEnabled ? "on" : "off"}</button><label class="playback-fps"><span>Playback</span><span class="select-control"><select id="playbackFps"><option value="15">15 FPS</option><option value="24">24 FPS</option><option value="30" selected>30 FPS</option><option value="60">60 FPS</option></select></span></label><input id="seek" type="range" min="0" max="1000" value="0" aria-label="Video position"><span id="time">0:00</span></div><div class="controls">
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
])}${select("Quality", "quality", [
  ["auto", "Auto"],
  ["performance", "Performance"],
  ["balanced", "Balanced"],
  ["quality", "Quality"],
  ["custom", "Custom"],
], qualityMode)}${select("Color", "color", [
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
</div><p class="quality-note" id="qualityNote">Auto tunes preview performance; export keeps your chosen settings.</p><details><summary>Advanced</summary><div class="controls">${select(
    "Dithering",
    "dither",
    [
      ["none", "None"],
      ["ordered", "Ordered (Bayer 4×4)"],
      ["floyd", "Floyd–Steinberg"],
    ],
  )}${range("Smoothing", "smoothing", 0, 1, settings.smoothing, 0.05)}${range("Contrast", "contrast", 0.2, 2, settings.contrast, 0.05)}${range("Gamma", "gamma", 0.2, 3, settings.gamma, 0.05)}${range("Brightness", "brightness", -0.5, 0.5, settings.brightness, 0.05)}${range("Edge weight", "edgeWeight", 0, 2, settings.edgeWeight, 0.1)}<label class="field"><span>Custom set</span><input id="custom" type="text" value=" .oO0@#"></label><label class="field"><span>Invert</span><input id="invert" type="checkbox"></label></div></details><div class="export-options"><label class="export-field"><span>Export format</span><span class="select-control"><select id="format"><option value="webm">WebM</option><option value="gif">GIF</option><option value="mp4" disabled>MP4 (offline muxer unavailable)</option></select></span></label><label class="export-field"><span>Export FPS</span><span class="select-control"><select id="exportFps"><option value="10">10 FPS</option><option value="15">15 FPS</option><option value="24">24 FPS</option><option value="30" selected>30 FPS</option><option value="60">60 FPS</option></select></span></label><label class="export-field"><span>Frame blending</span><input id="frameBlending" type="checkbox" checked></label><label class="export-field"><span>Use Auto for export</span><input id="autoExportQuality" type="checkbox"></label></div><p class="export-hint">WebM is encoded offline with explicit timestamps. Preview Auto does not reduce export quality unless requested.</p><div class="export-panel" id="progressPanel" hidden><div class="export-head"><span id="progressLabel">Preparing export</span><span id="progressPercent">0%</span></div><div class="export-track"><span id="progressFill"></span></div></div><p id="status" class="status"></p><div class="actions"><button id="download">Download</button><button id="cancel" hidden>Cancel export</button><button id="new">New file</button></div></section>`;
  bindBrand();
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
  const manualChange = () => {
    if (qualityMode !== "custom") {
      qualityMode = "custom";
      $<HTMLSelectElement>("quality").value = "custom";
    }
    exportSettings = structuredClone(settings);
    $("qualityNote").textContent = "Custom preview and export settings are aligned.";
  };
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
      manualChange();
      $(id + "Out").textContent = el.value;
      scheduleDraw();
    };
  });
  ["mode", "color", "dither"].forEach((id) => {
    $<HTMLSelectElement>(id).onchange = (e) => {
      (settings as any)[id] = (e.target as HTMLSelectElement).value;
      manualChange();
      engine.reset();
      draw();
    };
  });
  $<HTMLSelectElement>("background").onchange = (e) => {
    const white = (e.target as HTMLSelectElement).value === "white";
    settings.background = white
      ? { r: 255, g: 255, b: 255 }
      : { r: 0, g: 0, b: 0 };
    manualChange();
    engine.reset();
    draw();
  };
  $<HTMLSelectElement>("style").onchange = (e) => {
    const v = (e.target as HTMLSelectElement).value;
    settings.charset =
      v === "custom"
        ? $<HTMLInputElement>("custom").value
        : (CHARSETS as any)[v];
    manualChange();
    engine.reset();
    draw();
  };
  $<HTMLInputElement>("custom").oninput = (e) => {
    if ($<HTMLSelectElement>("style").value === "custom")
      settings.charset = (e.target as HTMLInputElement).value || " ";
    manualChange();
    scheduleDraw();
  };
  $<HTMLInputElement>("invert").onchange = (e) => {
    settings.invert = (e.target as HTMLInputElement).checked;
    manualChange();
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
  $<HTMLSelectElement>("playbackFps").onchange = (event) => {
    requestedPlaybackFps = Number((event.target as HTMLSelectElement).value);
    lastPreviewDraw = 0;
    engine.reset();
    draw();
  };
  $<HTMLSelectElement>("quality").onchange = async (event) => {
    qualityMode = (event.target as HTMLSelectElement).value as QualityMode;
    if (qualityMode === "auto") await runAutoQuality();
    else if (qualityMode !== "custom") {
      const index = qualityMode === "performance" ? 0 : qualityMode === "balanced" ? 2 : 4;
      applyPreviewCandidate(index);
      exportSettings = structuredClone(settings);
      $("qualityNote").textContent = `${qualityMode[0].toUpperCase()+qualityMode.slice(1)} preset applied to preview and export.`;
    }
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
  $("new").onclick = () => void navigateHome();
  $("download").onclick = exportFile;
  $("cancel").onclick = () => (abortExport = true);
}
function applyPreviewCandidate(index: number) {
  const candidate = QUALITY_CANDIDATES[index];
  settings.columns = candidate.columns; settings.mode = candidate.mode; settings.smoothing = candidate.smoothing;
  const columns = $<HTMLInputElement>("columns"); columns.value = String(candidate.columns);
  $("columnsOut").textContent = String(candidate.columns);
  $<HTMLSelectElement>("mode").value = candidate.mode;
  $<HTMLInputElement>("smoothing").value = String(candidate.smoothing);
  $("smoothingOut").textContent = String(candidate.smoothing);
  engine.reset(); draw();
}
async function runAutoQuality() {
  const size = sourceSize(); if (!size) return;
  $("qualityNote").textContent = "Auto is benchmarking representative frames…";
  const samples: ImageData[] = [], restore = video?.currentTime ?? 0;
  const moments = video ? [.15, .5, .85].map(r=>Math.max(0,Math.min(video!.duration-.001,video!.duration*r))) : [0];
  for (const moment of moments) {
    if (video) await seekVideo(moment);
    sourceCanvas.width=Math.min(size.width,960);sourceCanvas.height=Math.max(1,Math.round(size.height*sourceCanvas.width/size.width));
    sourceContext.drawImage(video ?? gifFrames[gifIndex].bitmap,0,0,sourceCanvas.width,sourceCanvas.height);
    samples.push(sourceContext.getImageData(0,0,sourceCanvas.width,sourceCanvas.height));
  }
  if (video) await seekVideo(restore);
  const results=QUALITY_CANDIDATES.map(candidate=>{
    const times:number[]=[]; const trial={...settings,...candidate}; let bytes=0;
    for(const sample of samples){const e=new AsciiEngine(),start=performance.now(),converted=e.convert(sample,trial);const c=document.createElement("canvas"),ctx=c.getContext("2d")!;render(ctx,converted.cells,candidate.columns,converted.rows,candidate.columns*4,converted.rows*8,trial.background);times.push(performance.now()-start);bytes=Math.max(bytes,c.width*c.height*4)}
    return {...candidate,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:percentile(times,.95),bytes};
  });
  const selected=selectQuality(results,requestedPlaybackFps,CACHE_BYTES) ?? results[0];
  applyPreviewCandidate(QUALITY_CANDIDATES.findIndex(c=>c.columns===selected.columns&&c.mode===selected.mode));
  $("qualityNote").textContent=`Auto preview: ${selected.columns} columns, ${selected.mode}, P95 ${selected.p95Ms.toFixed(1)} ms. Export settings remain independent.`;
}
function sourceSize() {
  if (video) return { width: video.videoWidth, height: video.videoHeight };
  const bitmap = gifFrames[gifIndex]?.bitmap;
  return bitmap ? { width: bitmap.width, height: bitmap.height } : null;
}
function basePreviewFps() {
  return requestedPlaybackFps;
}
function previewFps() {
  return requestedPlaybackFps;
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
  const renderStarted = performance.now();
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
  if (qualityMode === "auto" && !preparing && !exporting) {
    const change = adaptiveQuality.observe(performance.now() - renderStarted, 1000 / requestedPlaybackFps * .75);
    if (change) {
      applyPreviewCandidate(adaptiveQuality.level);
      $("qualityNote").textContent = `Auto adjusted preview to ${settings.columns} columns after a stable measurement window; export settings were not changed.`;
      return;
    }
  }
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
    fill = $("loadingFill");
  overlay.hidden = false;
  startLoadingSpinner();
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
    label.textContent = `Preparing ASCII frames… ${percent}%`;
    fill.style.width = `${percent}%`;
    if (i % 4 === 0) await new Promise(requestAnimationFrame);
  }
  if (generation !== prepareGeneration) {
    preparing = false;
    stopLoadingSpinner();
    return;
  }
  await seekVideo(0);
  preparing = false;
  engine.reset();
  draw();
  stopLoadingSpinner();
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
  config: Settings,
) {
  const sourceWidth = Math.min(width, Math.max(640, config.columns * 4)),
    scale = sourceWidth / width;
  buffer.width = Math.max(1, Math.round(width * scale));
  buffer.height = Math.max(1, Math.round(height * scale));
  bufferContext.clearRect(0, 0, buffer.width, buffer.height);
  bufferContext.drawImage(source, 0, 0, buffer.width, buffer.height);
  const result = exportEngine.convert(
      bufferContext.getImageData(0, 0, buffer.width, buffer.height),
      config,
    ),
    out = canvas.getContext("2d")!,
    cw = config.columns > 320 ? 3 : config.columns > 240 ? 4 : config.columns > 160 ? 5 : 6;
  render(
    out,
    result.cells,
    config.columns,
    result.rows,
    config.columns * cw,
    result.rows * cw * 2,
    config.background,
  );
}
async function seekMedia(element: HTMLVideoElement, time: number) {
  if (Math.abs(element.currentTime - time) < 0.001) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { element.removeEventListener("error", failed); resolve(); };
    const failed = () => { element.removeEventListener("seeked", done); reject(new Error("Could not seek during export.")); };
    element.addEventListener("seeked", done, { once: true });
    element.addEventListener("error", failed, { once: true });
    element.currentTime = time;
  });
}
async function exportFile() {
  if ((!video && !gifFrames.length) || exporting) return;
  const fmt = $<HTMLSelectElement>("format").value;
  const exportFps = Number($<HTMLSelectElement>("exportFps").value);
  if (fmt !== "webm") {
    $("status").textContent =
      fmt === "mp4" ? "Reliable offline MP4 muxing is unavailable in this build. Choose WebM; no real-time fallback will be used." : "Animated GIF output is not connected yet; choose WebM.";
    return;
  }
  if (typeof VideoEncoder === "undefined") {
    $("status").textContent = "This browser does not provide WebCodecs VideoEncoder, so timestamp-safe offline export is unavailable.";
    return;
  }
  const config = $<HTMLInputElement>("autoExportQuality").checked ? structuredClone(settings) : structuredClone(exportSettings);
  const codecOptions = [{codec:"vp09.00.10.08",webm:"V_VP9" as const},{codec:"vp8",webm:"V_VP8" as const}];
  exporting = true;
  abortExport = false;
  $("cancel").hidden = false;
  $("download").setAttribute("disabled", "");
  $("status").textContent = "";
  exportProgress(0, "Rendering frames");
  const canvas = document.createElement("canvas"),
    buffer = document.createElement("canvas"),
    blendCanvas = document.createElement("canvas"),
    bufferContext = buffer.getContext("2d", { willReadFrequently: true })!,
    exportEngine = new AsciiEngine(),
    size = sourceSize()!, cw = config.columns > 320 ? 3 : config.columns > 240 ? 4 : config.columns > 160 ? 5 : 6;
  canvas.width = config.columns * cw;
  canvas.height = rowsFor(size.width, size.height, config.columns) * cw * 2;
  blendCanvas.width=size.width;blendCanvas.height=size.height;
  let chosen: typeof codecOptions[number] | undefined;
  for(const option of codecOptions){if((await VideoEncoder.isConfigSupported({codec:option.codec,width:canvas.width,height:canvas.height,bitrate:5_000_000,framerate:exportFps})).supported){chosen=option;break}}
  if(!chosen){$("status").textContent="No VP8/VP9 WebCodecs encoder is available.";finishExport();return}
  const sourceDuration = video ? video.duration : gifDuration / 1000;
  const timeline = outputTimeline(sourceDuration, exportFps);
  const muxer = new WebMMuxer(canvas.width,canvas.height,chosen.webm,sourceDuration);
  let encodingError: Error | null = null;
  const encoder = new VideoEncoder({output:chunk=>muxer.add(chunk),error:error=>{encodingError=error}});
  encoder.configure({codec:chosen.codec,width:canvas.width,height:canvas.height,bitrate:5_000_000,framerate:exportFps,latencyMode:"quality"});
  try { if (video) {
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
    for (const timing of timeline) {
      if(abortExport)break;
      let exportSource:CanvasImageSource=exportVideo;
      if($<HTMLInputElement>("frameBlending").checked){
        const position=timing.sourceTime*sourceFps,a=Math.floor(position),alpha=position-a,b=Math.min(Math.ceil(sourceDuration*sourceFps)-1,a+1),blend=blendCanvas.getContext("2d")!;
        await seekMedia(exportVideo,Math.min(a/sourceFps,sourceDuration-.000001));blend.globalAlpha=1;blend.drawImage(exportVideo,0,0,blendCanvas.width,blendCanvas.height);
        if(b!==a&&alpha>0){await seekMedia(exportVideo,Math.min(b/sourceFps,sourceDuration-.000001));blend.globalAlpha=alpha;blend.drawImage(exportVideo,0,0,blendCanvas.width,blendCanvas.height);blend.globalAlpha=1}
        exportSource=blendCanvas;
      } else await seekMedia(exportVideo,timing.sourceTime);
      renderExportFrame(exportSource,exportVideo.videoWidth,exportVideo.videoHeight,canvas,exportEngine,buffer,bufferContext,config);
      const frame=new VideoFrame(canvas,{timestamp:timing.timestampUs,duration:timing.durationUs});
      encoder.encode(frame,{keyFrame:timing.index%Math.max(1,Math.round(exportFps*2))===0});frame.close();
      if(encoder.encodeQueueSize>8)await encoder.flush();
      exportProgress((timing.index+1)/timeline.length,"Rendering frames");
      if(timing.index%4===0)await new Promise(requestAnimationFrame);
    }
    exportVideo.pause();
    exportVideo.removeAttribute("src");
    exportVideo.load();
  } else {
    for (const timing of timeline) {
      if(abortExport)break;
      const elapsed = Math.min(timing.sourceTime * 1000, gifDuration - 1);
      const frame = gifFrames[frameAt(elapsed)];
      renderExportFrame(
        frame.bitmap,
        frame.bitmap.width,
        frame.bitmap.height,
        canvas,
        exportEngine,
        buffer,
        bufferContext,
        config,
      );
      const videoFrame=new VideoFrame(canvas,{timestamp:timing.timestampUs,duration:timing.durationUs});
      encoder.encode(videoFrame,{keyFrame:timing.index%Math.max(1,Math.round(exportFps*2))===0});videoFrame.close();
      if(encoder.encodeQueueSize>8)await encoder.flush();
      exportProgress((timing.index+1)/timeline.length,"Rendering frames");
    }
  }
  if (!abortExport) { exportProgress(1, "Finalizing file"); await encoder.flush(); }
  encoder.close();
  if(encodingError)throw encodingError;
  if (!abortExport) {
    const extension = "webm", blob = muxer.finalize(),
      a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `mp4mediato-ascii.${extension}`;
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
  } catch(error) { try{encoder.close()}catch{} $("status").textContent=`Export failed: ${error instanceof Error?error.message:String(error)}`; }
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
  const generation = prepareGeneration;
  file = f;
  app.innerHTML = `${brand()}<p class="status">Reading GIF locally…</p>`;
  bindBrand();
  try {
    const parsed = parseGIF(await f.arrayBuffer()),
      frames = decompressFrames(parsed, true);
    if (generation !== prepareGeneration) return;
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
      fill = $("loadingFill");
    overlay.hidden = false;
    startLoadingSpinner();
    label.textContent = "Preparing GIF frames… 0%";
    composite.width = width;
    composite.height = height;
    const context = composite.getContext("2d")!,
      patchContext = patch.getContext("2d")!;
    let start = 0;
    for (let i = 0; i < frames.length; i++) {
      if (generation !== prepareGeneration) {
        stopLoadingSpinner();
        return;
      }
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
      label.textContent = `Preparing GIF frames… ${percent}%`;
      fill.style.width = `${percent}%`;
      if (i % 10 === 0) await new Promise(requestAnimationFrame);
    }
    gifDuration = start;
    gifIndex = 0;
    gifElapsed = 0;
    stopLoadingSpinner();
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
