# Video to ASCII

Video to ASCII converts compatible videos into animated character art. The web application runs entirely in the browser and is ready for static hosting on Cloudflare Pages. The Python application plays the result in an ANSI terminal and can render an encoded file through FFmpeg.

No upload, account, API key, backend, or AI service is used.

## Web application

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
npm test
npm run build
```

Open the local URL printed by Vite. Select a browser-decodable MP4, WebM, or MOV. Codec support depends on the browser: H.264 MP4 and VP8/VP9 WebM are the most portable choices. Preview controls include character set, processing mode, color palette, grid resolution, ordered dithering, temporal smoothing, brightness, contrast, gamma, inversion, and edge weighting.

WebM export uses the browser's `MediaRecorder` and keeps timing through real-time canvas capture. It does not currently preserve audio. MP4 is enabled only when the browser exposes a real MP4/H.264 encoder. Animated GIF input supports partial frames, transparency, disposal methods, individual delays, seeking, and looping. GIF output is not connected yet, but GIF input can be exported as WebM or as MP4 when supported.

### Cloudflare Pages

- Build command: `npm run build`
- Output directory: `dist`
- Root directory: the repository root

The Vite build is static. Media never leaves the visitor's device. `public/_headers` adds conservative security headers.

## Python application

Requirements: Python 3.11+, and FFmpeg for export.

```bash
python -m pip install -r requirements.txt
python app.py
python app.py "C:\Videos\example.mp4"
python app.py example.webm --columns 100 --no-export
pytest
```

Without a path, `app.py` selects a random supported file from `public/input/`. Put personal MP4, WebM, MOV, or GIF files in that folder; `.gitkeep` preserves the directory while `.gitignore` prevents its media from being committed. A direct command-line path still overrides the folder. The default black/red Tkinter window provides Play/Pause, looping, live symbol-density control, and an Export button. Edit the commented configuration block at the start of the file to choose the style, colors, processing options, playback, and output behavior. Mutually exclusive settings are validated at startup.

On Windows, install FFmpeg with:

```powershell
winget install Gyan.FFmpeg
```

Restart the terminal afterward and verify with `ffmpeg -version`. Exports are written to `output/`. When enabled and available, video export pipes RGB frames directly to FFmpeg and maps the original audio into the result.

For a stable terminal presentation, select Courier New in Windows Terminal: Settings → Profile → Appearance → Font face. The script cannot change the terminal emulator's font. Exported frames use the system-installed Courier New and fall back to DejaVu Sans Mono. No proprietary font files are distributed.

## Conversion model

Pixels are sampled into a character grid whose row count is corrected for the measured cell aspect ratio:

```text
rows = round(columns × imageHeight / imageWidth × cellWidth / cellHeight)
```

The engine uses Rec. 709 luminance (`0.2126R + 0.7152G + 0.0722B`), density-ranked glyphs, local edge energy, deterministic Bayer dithering, nearest-palette color quantization, and exponential temporal stabilization that backs off on motion. The web engine also includes deterministic Floyd–Steinberg diffusion and Unicode Braille encoding primitives. Transparency is composed over black in the browser engine.

The modes share one engine and alter cost emphasis rather than duplicating the pipeline. Fast prioritizes density; Balanced adds sampling and temporal stability; Edge Art increases local-structure weight; Braille uses Unicode dot patterns. High Quality is intentionally an offline-oriented setting, although the preview remains available.

## Tests

TypeScript tests cover known luminance values, horizontal/vertical aspect correction, color quantization, Braille encoding, and deterministic Floyd–Steinberg dithering. Python tests cover aspect correction, luminance, conflicting configuration, and deterministic conversion. Synthetic arrays are generated in tests, so no licensed fixtures are required.

## Known limitations

- Browser codec support varies; an accepted extension does not imply its codec can be decoded.
- Browser WebM/MP4 export is real-time, video-only, and may be slower than playback at high resolutions.
- Animated GIF output is not connected; animated GIF input is supported.
- Python timing uses OpenCV's reported stream FPS; files with irregular per-frame timestamps may be normalized. GIF frame durations are subject to the decoder available in the installed OpenCV build.
- FFmpeg is required for Python video/GIF export and was not bundled.
- Structural glyph-mask matching and OKLab palette distances are not yet implemented; the current engine uses density, edge energy, and RGB distance.

## Dependencies and licenses

Vite, TypeScript, Vitest, gifuct-js, gifenc, NumPy, OpenCV, Pillow, and pytest retain their respective upstream licenses. Review their license files before redistribution.
