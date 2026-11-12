import "./style.css";
import { AsciiEngine, CHARSETS, rowsFor } from "./engine";
import { FrameCache } from "./frame-cache";
import { render } from "./renderer";
import { outputTimeline } from "./export-timing";
import { transcodeWebm, type ExportFormat } from "./export-transcode";
import type { AudioSample, BlobSource as MediaBlobSource, Input as MediaInput } from "mediabunny";
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
  previewAudioEnabled = true,
  sourceHasAudio = false,
  audioExportSupported = false,
  prepareGeneration = 0,
  loadingRaf = 0;
const sourceCanvas = document.createElement("canvas"),
  sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true })!;
const CACHE_BYTES = 192 * 1024 * 1024;
const frameCache = new FrameCache(CACHE_BYTES),
  pendingFrames = new Set<string>();
let cacheGeneration = 0;
window.setInterval(() => frameCache.prune(), 60_000);
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
  sourceHasAudio = false;
  audioExportSupported = false;
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
  sourceHasAudio = await detectAudioTrack(f);
  workspace();
  const preview = $("preview");
  preview.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  video.loop = loopEnabled;
  await prepareVideo();
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
async function detectAudioTrack(mediaFile: File) {
  const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(mediaFile), formats: ALL_FORMATS });
  try {
    const track=await input.getPrimaryAudioTrack();
    if(!track)return false;
    if(typeof AudioEncoder!=="undefined")audioExportSupported=(await AudioEncoder.isConfigSupported({codec:"opus",sampleRate:await track.getSampleRate(),numberOfChannels:await track.getNumberOfChannels(),bitrate:192_000})).supported===true;
    return true;
  }
  catch { return false; }
  finally { input.dispose(); }
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
  app.innerHTML = `${brand()}<section class="workspace"><div class="preview" id="preview"><canvas id="canvas" aria-label="ASCII video preview"></canvas><div class="player-overlay" id="playerOverlay" hidden><pre class="ascii-spinner" id="loadingSpinner" role="status" aria-label="Loading"></pre><span id="loadingText">Preparing ASCII frames… 0%</span><div class="loading-track"><span id="loadingFill"></span></div></div></div><div class="transport"><button id="play">Play</button><button id="loop" class="toggle" type="button" aria-pressed="${loopEnabled}">Loop ${loopEnabled ? "on" : "off"}</button><button id="audio" class="toggle" type="button" aria-pressed="${previewAudioEnabled}" ${video && sourceHasAudio ? "" : "disabled"}>${video && sourceHasAudio ? `Audio ${previewAudioEnabled ? "on" : "off"}` : "No audio"}</button><label class="playback-fps"><span>Playback</span><span class="select-control"><select id="playbackFps"><option value="15">15 FPS</option><option value="24">24 FPS</option><option value="30" selected>30 FPS</option><option value="60">60 FPS</option></select></span></label><input id="seek" type="range" min="0" max="1000" value="0" aria-label="Video position"><span id="time">0:00</span></div><div class="controls">
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
  )}${range("Smoothing", "smoothing", 0, 1, settings.smoothing, 0.05)}${range("Contrast", "contrast", 0.2, 2, settings.contrast, 0.05)}${range("Gamma", "gamma", 0.2, 3, settings.gamma, 0.05)}${range("Brightness", "brightness", -0.5, 0.5, settings.brightness, 0.05)}${range("Edge weight", "edgeWeight", 0, 2, settings.edgeWeight, 0.1)}<label class="field"><span>Custom set</span><input id="custom" type="text" value=" .oO0@#"></label><label class="field"><span>Invert</span><input id="invert" type="checkbox"></label></div></details><div class="export-options"><label class="export-field"><span>Export format</span><span class="select-control"><select id="format"><option value="webm">WebM</option><option value="mp4">MP4</option><option value="gif">GIF</option></select></span></label><label class="export-field"><span>Export FPS</span><span class="select-control"><select id="exportFps"><option value="10">10 FPS</option><option value="15">15 FPS</option><option value="24">24 FPS</option><option value="30" selected>30 FPS</option><option value="60">60 FPS</option></select></span></label><label class="export-field"><span>Frame blending</span><input id="frameBlending" type="checkbox" checked></label><label class="export-field"><span id="audioExportLabel">${sourceHasAudio&&!audioExportSupported ? "Include audio (unsupported)" : "Include audio"}</span><input id="includeAudio" type="checkbox" ${video && sourceHasAudio && audioExportSupported ? "checked" : "disabled"}></label></div><p class="export-hint">WebM uses explicit timestamps. MP4 and GIF are converted locally with FFmpeg WebAssembly; GIF has no audio.</p><div class="export-panel" id="progressPanel" hidden><div class="export-head"><span id="progressLabel">Preparing export</span><span id="progressPercent">0%</span></div><div class="export-track"><span id="progressFill"></span></div></div><p id="status" class="status"></p><div class="actions"><button id="download">Download</button><button id="cancel" hidden>Cancel export</button><button id="new">New file</button></div></section>`;
  bindBrand();
  bind();
  enhanceSelects();
}

function enhanceSelects() {
  document.querySelectorAll<HTMLSelectElement>(".select-control select").forEach((select) => {
    const control = select.parentElement!;
    const button = document.createElement("button");
    const menu = document.createElement("div");
    button.type = "button";
    button.className = "select-button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    menu.className = "select-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    const sync = () => {
      button.textContent = select.selectedOptions[0]?.textContent ?? "";
      menu.querySelectorAll<HTMLElement>("[role=option]").forEach((option) =>
        option.setAttribute("aria-selected", String(option.dataset.value === select.value)),
      );
    };
    Array.from(select.options).forEach((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "select-option";
      item.textContent = option.textContent;
      item.dataset.value = option.value;
      item.disabled = option.disabled;
      item.setAttribute("role", "option");
      item.onclick = () => {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        close();
        button.focus();
      };
      menu.appendChild(item);
    });
    const close = () => {
      menu.hidden = true;
      control.classList.remove("open", "open-up");
      button.setAttribute("aria-expanded", "false");
    };
    button.onclick = () => {
      const opening = menu.hidden;
      document.querySelectorAll<HTMLElement>(".select-control.open").forEach((other) => {
        if (other !== control) other.querySelector<HTMLButtonElement>(".select-button")?.click();
      });
      if (!opening) return close();
      menu.hidden = false;
      control.classList.add("open");
      button.setAttribute("aria-expanded", "true");
      const rect = control.getBoundingClientRect();
      if (window.innerHeight - rect.bottom < Math.min(menu.scrollHeight, 260) && rect.top > window.innerHeight - rect.bottom)
        control.classList.add("open-up");
      menu.querySelector<HTMLElement>("[aria-selected=true]")?.focus();
    };
    button.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (menu.hidden) button.click();
      }
      if (event.key === "Escape") close();
    };
    menu.onkeydown = (event) => {
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>(".select-option:not(:disabled)"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      } else if (event.key === "Escape") { close(); button.focus(); }
    };
    select.classList.add("native-select");
    select.addEventListener("change", sync);
    control.append(button, menu);
    sync();
  });
  document.addEventListener("pointerdown", (event) => {
    document.querySelectorAll<HTMLElement>(".select-control.open").forEach((control) => {
      if (!control.contains(event.target as Node)) control.querySelector<HTMLButtonElement>(".select-button")?.click();
    });
  });
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
  if (video) video.muted = !previewAudioEnabled;
  $("audio").onclick = () => {
    if (!video || !sourceHasAudio) return;
    previewAudioEnabled = !previewAudioEnabled;
    video.muted = !previewAudioEnabled;
    const button = $("audio");
    button.setAttribute("aria-pressed", String(previewAudioEnabled));
    button.textContent = `Audio ${previewAudioEnabled ? "on" : "off"}`;
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
  $<HTMLSelectElement>("format").onchange = (event) => {
    const gif = (event.target as HTMLSelectElement).value === "gif";
    const audio = $<HTMLInputElement>("includeAudio");
    audio.disabled = gif || !video || !sourceHasAudio || !audioExportSupported;
    $("audioExportLabel").textContent = gif
      ? "Include audio (GIF unsupported)"
      : sourceHasAudio && !audioExportSupported
        ? "Include audio (unsupported)"
        : "Include audio";
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
  const fmt = $<HTMLSelectElement>("format").value as ExportFormat;
  const exportFps = Number($<HTMLSelectElement>("exportFps").value);
  if (typeof VideoEncoder === "undefined") {
    $("status").textContent = "This browser does not provide WebCodecs VideoEncoder, so timestamp-safe offline export is unavailable.";
    return;
  }
  const config = structuredClone(settings);
  const codecOptions = [{codec:"vp09.00.10.08",bunny:"vp9" as const},{codec:"vp8",bunny:"vp8" as const}];
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
  let mediaInput:MediaInput<MediaBlobSource>|null=null, activeOutput:{state:string;cancel():Promise<void>}|null=null;
  try {
  const { ALL_FORMATS, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, CanvasSource, Input, Output, Quality, WebMOutputFormat } = await import("mediabunny");
  const target=new BufferTarget(), output=new Output({format:new WebMOutputFormat(),target});
  activeOutput=output;
  const videoSource=new CanvasSource(canvas,{codec:chosen.bunny,quality:new Quality({bitrate:5_000_000})});
  output.addVideoTrack(videoSource,{frameRate:exportFps});
  let audioSource:InstanceType<typeof AudioSampleSource>|null=null, audioIterator:AsyncIterator<AudioSample>|null=null, audioNext:IteratorResult<AudioSample>|null=null;
  const includeAudio=Boolean(fmt!=="gif"&&video&&file&&sourceHasAudio&&$<HTMLInputElement>("includeAudio").checked);
  if(includeAudio&&file){
    mediaInput=new Input({source:new BlobSource(file),formats:ALL_FORMATS});
    const audioTrack=await mediaInput.getPrimaryAudioTrack();
    if(audioTrack){audioSource=new AudioSampleSource({codec:"opus",quality:new Quality({bitrate:192_000})});output.addAudioTrack(audioSource);audioIterator=new AudioSampleSink(audioTrack).samples(0,sourceDuration)[Symbol.asyncIterator]();audioNext=await audioIterator.next()}
  }
  const feedAudioUntil=async(limit:number)=>{while(audioSource&&audioIterator&&audioNext&&!audioNext.done&&audioNext.value.timestamp<limit){const sample=audioNext.value;await audioSource.add(sample);sample.close();audioNext=await audioIterator.next()}};
  await output.start();
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
      await feedAudioUntil((timing.timestampUs+timing.durationUs)/1_000_000);
      await videoSource.add(timing.timestampUs/1_000_000,timing.durationUs/1_000_000,{keyFrame:timing.index%Math.max(1,Math.round(exportFps*2))===0});
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
      await videoSource.add(timing.timestampUs/1_000_000,timing.durationUs/1_000_000,{keyFrame:timing.index%Math.max(1,Math.round(exportFps*2))===0});
      exportProgress((timing.index+1)/timeline.length,"Rendering frames");
    }
  }
  if (!abortExport) { exportProgress(1, "Finalizing file"); await feedAudioUntil(Infinity); await output.finalize(); }
  else await output.cancel();
  if (!abortExport) {
    if(!target.buffer)throw new Error("The WebM muxer produced no output.");
    const webm = new Blob([target.buffer],{type:"video/webm"});
    let blob = webm;
    if (fmt !== "webm") {
      exportProgress(0, `Loading local ${fmt.toUpperCase()} converter`);
      blob = await transcodeWebm(webm, fmt, (ratio) =>
        exportProgress(Math.max(0, Math.min(1, ratio)), `Converting to ${fmt.toUpperCase()}`),
      );
    }
    const extension = fmt,
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
      `${extension.toUpperCase()} exported successfully${fmt === "gif" ? " (GIF does not support audio)" : audioSource ? " with audio" : " without audio"} (${(blob.size / 1024 / 1024).toFixed(1)} MB).`;
  } else {
    $("status").textContent = "Export cancelled.";
  }
  } catch(error) { if(activeOutput?.state==="started")await activeOutput.cancel(); $("status").textContent=`Export failed: ${error instanceof Error?error.message:String(error)}`; }
  finally { mediaInput?.dispose(); }
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
