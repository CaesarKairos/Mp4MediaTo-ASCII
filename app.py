"""Video to ASCII — local Tkinter player, terminal player, and exporter."""
from __future__ import annotations
import argparse, atexit, io, os, random, shutil, subprocess, sys, threading, time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageTk

# ==========================================
# VIDEO TO ASCII — CONFIGURATION
# ==========================================
INPUT_FOLDER = "public/input"       # Folder scanned for local MP4, WebM, MOV, or GIF files.
COLUMNS = 500                       # Maximum symbol density for the highest level of detail.
FPS = 24                            # Fallback playback rate when the source does not report one.
FONT_NAME = "Courier New"           # Preferred monospaced font used in rendered exports.
FONT_SIZE = 16                      # Base font size used when Pillow draws exported frames.
PREVIEW_WIDTH = 1100                # Maximum width of the Tkinter preview in pixels.
PREVIEW_HEIGHT = 680                # Maximum height of the Tkinter preview in pixels.
SHOW_WINDOW = True                  # Opens the black Tkinter result window when app.py starts.
PLAY_IN_TERMINAL = False            # Also plays ANSI ASCII in the terminal when enabled.
USE_CLASSIC_ASCII = False           # Uses the compact classic density character ramp.
USE_DETAILED_ASCII = True           # Uses the longest character ramp for maximum tonal detail.
USE_BLOCKS = False                  # Uses Unicode block-shading characters.
USE_BRAILLE = False                 # Uses a Unicode Braille density ramp.
USE_BINARY = False                  # Uses only spaces, zeroes, and ones.
USE_CUSTOM_CHARSET = False          # Uses CUSTOM_CHARSET instead of a preset character ramp.
CUSTOM_CHARSET = " .oO0@#"         # Characters ordered from darkest to brightest.
USE_ORIGINAL_COLORS = True          # Preserves the average source color of every symbol.
USE_MONOCHROME = False              # Renders every symbol in white.
USE_TERMINAL_GREEN = False          # Renders every symbol in terminal green.
USE_AMBER = False                   # Renders every symbol in amber.
USE_CUSTOM_PALETTE = False          # Enables CUSTOM_PALETTE color quantization.
CUSTOM_BACKGROUND = "#000000"       # Background used by the window and exported frames.
CUSTOM_PALETTE = ["#000000", "#A855F7", "#22C55E", "#FFFFFF"]  # Custom quantization colors.
USE_EDGE_DETECTION = True           # Strengthens local edges before glyph selection.
USE_TEMPORAL_SMOOTHING = True       # Reduces flicker between neighboring video frames.
USE_DITHERING = True                # Applies deterministic Bayer dithering to preserve gradients.
BRIGHTNESS = 0.0                    # Adds brightness in the range -1.0 to 1.0.
CONTRAST = 1.0                      # Multiplies contrast; 1.0 leaves it unchanged.
GAMMA = 1.0                         # Applies gamma correction; 1.0 leaves it unchanged.
INVERT = False                      # Reverses the luminance-to-character mapping.
EXPORT_VIDEO = True                 # Automatically exports in the background when the window opens.
EXPORT_GIF = False                  # Exports GIF instead of video when enabled.
PRESERVE_AUDIO = True               # Maps original audio into FFmpeg video exports when possible.
OUTPUT_FORMAT = "mp4"               # FFmpeg video container used for export.
OUTPUT_WIDTH = 1920                 # Full HD target width for prepared and exported ASCII frames.
LOOP_PLAYBACK = True                # Restarts optional terminal playback; the window always loops.

CLASSIC = " .:-=+*#%@"
DETAILED = " `.^\",:;Il!i~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"
BLOCKS = " ░▒▓█"
BINARY = " 01"
BRAILLE = "⠀⠁⠃⠇⡇⣇⣧⣿"
RESET = "\033[0m"; HOME = "\033[H"; HIDE = "\033[?25l"; SHOW = "\033[?25h"

def validate_config() -> None:
    styles = [USE_CLASSIC_ASCII, USE_DETAILED_ASCII, USE_BLOCKS, USE_BRAILLE, USE_BINARY, USE_CUSTOM_CHARSET]
    colors = [USE_ORIGINAL_COLORS, USE_MONOCHROME, USE_TERMINAL_GREEN, USE_AMBER, USE_CUSTOM_PALETTE]
    if sum(styles) != 1: raise ValueError("Enable exactly one character style in CONFIGURATION.")
    if sum(colors) != 1: raise ValueError("Enable exactly one color mode in CONFIGURATION.")
    if not 8 <= COLUMNS <= 500: raise ValueError("COLUMNS must be between 8 and 500.")
    if FPS <= 0: raise ValueError("FPS must be positive.")

def charset() -> str:
    return BRAILLE if USE_BRAILLE else DETAILED if USE_DETAILED_ASCII else BLOCKS if USE_BLOCKS else BINARY if USE_BINARY else CUSTOM_CHARSET if USE_CUSTOM_CHARSET else CLASSIC

def rows_for(width:int,height:int,columns:int,cell_w:float=8,cell_h:float=16)->int:
    return max(1, round(columns*(height/width)*(cell_w/cell_h)))

def adjust_luminance(rgb:np.ndarray)->np.ndarray:
    lum=rgb[...,0]*.2126+rgb[...,1]*.7152+rgb[...,2]*.0722
    lum=np.clip((lum-127.5)*CONTRAST+127.5+BRIGHTNESS*255,0,255)
    lum=np.power(lum/255,max(.01,GAMMA))*255
    return 255-lum if INVERT else lum

class Engine:
    def __init__(self): self.previous=None
    def reset(self): self.previous=None
    def convert(self,bgr:np.ndarray,columns:int|None=None):
        columns=columns or COLUMNS; h,w=bgr.shape[:2]; rows=rows_for(w,h,columns)
        rgb=cv2.cvtColor(cv2.resize(bgr,(columns,rows),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2RGB)
        lum=adjust_luminance(rgb)
        if USE_DITHERING:
            bayer=np.array([[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]],dtype=np.float32)
            thresholds=np.tile(bayer,(int(np.ceil(rows/4)),int(np.ceil(columns/4))))[:rows,:columns]
            lum=np.clip(lum+(thresholds/15-.5)*32,0,255)
        if USE_EDGE_DETECTION:
            edge=cv2.Laplacian(lum.astype(np.uint8),cv2.CV_32F);lum=np.clip(lum+np.abs(edge)*.25,0,255)
        if USE_TEMPORAL_SMOOTHING and self.previous is not None and self.previous.shape==lum.shape:
            motion=np.abs(lum-self.previous);lum=np.where(motion<48,.65*lum+.35*self.previous,lum)
        self.previous=lum.copy(); chars=charset(); ids=np.rint(lum/255*(len(chars)-1)).astype(np.int32)
        return [[(chars[ids[y,x]],tuple(int(v) for v in rgb[y,x])) for x in range(columns)] for y in range(rows)]

def terminal_columns(frame)->int:
    available=max(8,shutil.get_terminal_size((COLUMNS,40)).columns-1);return min(len(frame[0]),available)

def ansi_frame(cells)->str:
    out=[HOME]
    for row in cells:
        for ch,(r,g,b) in row:
            if USE_MONOCHROME:r,g,b=(255,255,255)
            elif USE_TERMINAL_GREEN:r,g,b=(34,197,94)
            elif USE_AMBER:r,g,b=(245,158,11)
            out.append(f"\033[38;2;{r};{g};{b}m{ch}")
        out.append(RESET+"\n")
    return ''.join(out)

def choose_input_file() -> str:
    """Choose one random supported file from the local, ignored input folder."""
    folder = Path(__file__).parent / INPUT_FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    supported = {".mp4", ".webm", ".mov", ".gif"}
    files = [path for path in folder.iterdir() if path.is_file() and path.suffix.lower() in supported]
    if not files:
        raise FileNotFoundError(
            f"Place an MP4, WebM, MOV, or GIF inside: {folder.resolve()}"
        )
    return str(random.choice(files))

def open_capture(path:str):
    cap=cv2.VideoCapture(path)
    if not cap.isOpened(): raise RuntimeError("OpenCV could not decode this file or codec.")
    source_fps=cap.get(cv2.CAP_PROP_FPS) or FPS
    return cap,source_fps

class AsciiWindow:
    """Control-free Tkinter player backed by fully prepared ASCII frames."""
    BG = "#000000"
    SPINNER = ("[ | ]", "[ / ]", "[ - ]", "[ \\ ]")

    def __init__(self, path: str, auto_export: bool = True):
        import tkinter as tk

        self.path = path
        self.cap, self.source_fps = open_capture(path)
        self.closed = False
        self.photo = None
        self.frames: list[bytes] = []
        self.preview_frames: list[bytes] = []
        self.frame_index = 0
        self.prepare_done = False
        self.prepare_error: Exception | None = None
        self.prepared_count = 0
        self.loading_step = 0
        self.total_frames = max(1, int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT) or 1))
        self.auto_export = auto_export

        self.root = tk.Tk()
        self.root.title("Video to ASCII")
        self.root.configure(bg=self.BG)
        self.root.geometry(f"{PREVIEW_WIDTH}x{PREVIEW_HEIGHT}")
        self.root.minsize(480, 320)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        self.preview = tk.Label(self.root, bg=CUSTOM_BACKGROUND, bd=0,
                                highlightthickness=0)
        self.preview.pack(fill="both", expand=True)
        self.loading = tk.Label(self.preview, text="[ | ]\n\nPreparing ASCII frames… 0%",
                                bg=self.BG, fg="#FFFFFF", font=(FONT_NAME, 13),
                                justify="center", bd=0)
        self.loading.place(relx=.5, rely=.5, anchor="center")
        self.prepare_thread = threading.Thread(target=self._prepare_worker, daemon=True)
        self.prepare_thread.start()
        self.root.after(50, self._watch_preparation)

    def _prepare_worker(self):
        engine = Engine()
        try:
            while not self.closed:
                ok, frame = self.cap.read()
                if not ok:
                    break
                image = render_image(engine.convert(frame, COLUMNS), OUTPUT_WIDTH)
                encoded = io.BytesIO()
                image.save(encoded, format="PNG", optimize=False, compress_level=1)
                self.frames.append(encoded.getvalue())
                preview = image.copy()
                preview.thumbnail((PREVIEW_WIDTH, PREVIEW_HEIGHT), Image.Resampling.LANCZOS)
                preview_encoded = io.BytesIO()
                preview.save(preview_encoded, format="PNG", optimize=False, compress_level=1)
                self.preview_frames.append(preview_encoded.getvalue())
                self.prepared_count += 1
            if not self.frames and not self.closed:
                raise RuntimeError("No decodable frames found.")
        except Exception as exc:
            self.prepare_error = exc
        finally:
            self.cap.release()
            self.prepare_done = True

    def _watch_preparation(self):
        if self.closed:
            return
        if self.prepare_error:
            self.loading.configure(text=f"Could not prepare video:\n{self.prepare_error}")
            return
        percent = min(100, round(self.prepared_count / self.total_frames * 100))
        spinner = self.SPINNER[self.loading_step % len(self.SPINNER)]
        self.loading_step += 1
        self.loading.configure(text=f"{spinner}\n\nPreparing ASCII frames… {percent}%")
        if not self.prepare_done:
            self.root.after(50, self._watch_preparation)
            return
        self.loading.destroy()
        self.frame_index = 0
        self.root.after(0, self.tick)
        if self.auto_export and (EXPORT_VIDEO or EXPORT_GIF):
            self.export_thread = threading.Thread(
                target=self._export_worker, daemon=False
            )
            self.export_thread.start()

    def tick(self):
        if self.closed or not self.frames:
            return
        image = Image.open(io.BytesIO(self.preview_frames[self.frame_index]))
        self.photo = ImageTk.PhotoImage(image)
        self.preview.configure(image=self.photo)
        self.frame_index = (self.frame_index + 1) % len(self.frames)
        self.root.after(max(1, round(1000 / self.source_fps)), self.tick)

    def _export_worker(self):
        try:
            output = export(self.path, self.frames, self.source_fps)
            print(f"Saved: {output.resolve()}")
        except Exception as exc:
            print(f"Export error: {exc}", file=sys.stderr)

    def run(self):
        self.root.mainloop()

    def close(self):
        self.closed = True
        self.cap.release()
        self.root.destroy()

def play(path:str)->None:
    cap,source_fps=open_capture(path);engine=Engine();index=0;start=time.perf_counter();sys.stdout.write("\033[2J"+HIDE);sys.stdout.flush()
    try:
        while True:
            ok,frame=cap.read()
            if not ok:
                if LOOP_PLAYBACK:cap.set(cv2.CAP_PROP_POS_FRAMES,0);engine.reset();index=0;start=time.perf_counter();continue
                break
            target=index/source_fps;now=time.perf_counter()-start
            if now-target>1/source_fps: index+=1;continue
            cells=engine.convert(frame,min(COLUMNS,max(8,shutil.get_terminal_size().columns-1)))
            sys.stdout.write(ansi_frame(cells));sys.stdout.flush();remaining=start+target-time.perf_counter()
            if remaining>0:time.sleep(remaining)
            index+=1
    finally:cap.release();restore_terminal()

def find_font(size:int):
    candidates=[Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts'/'cour.ttf','DejaVuSansMono.ttf']
    for p in candidates:
        try:return ImageFont.truetype(str(p),size)
        except OSError:pass
    return ImageFont.load_default()

def render_color(color):
    if USE_MONOCHROME:
        return (255, 255, 255)
    if USE_TERMINAL_GREEN:
        return (34, 197, 94)
    if USE_AMBER:
        return (245, 158, 11)
    if USE_CUSTOM_PALETTE:
        palette = [tuple(int(value[i:i+2], 16) for i in (1, 3, 5)) for value in CUSTOM_PALETTE]
        return min(palette, key=lambda item: sum((item[index] - color[index]) ** 2 for index in range(3)))
    return color

def render_image(cells,width:int)->Image.Image:
    rows,cols=len(cells),len(cells[0]);cell_w=max(1,width//cols);cell_h=max(2,round(cell_w*2));font=find_font(min(FONT_SIZE,max(5,cell_h)));img=Image.new('RGB',(cell_w*cols,cell_h*rows),CUSTOM_BACKGROUND);d=ImageDraw.Draw(img)
    for y,row in enumerate(cells):
        for x,(ch,color) in enumerate(row):d.text((x*cell_w,y*cell_h),ch,font=font,fill=render_color(color),anchor='lt')
    return img

def export(path:str, prepared_frames:list[bytes]|None=None, prepared_fps:float|None=None)->Path:
    if shutil.which('ffmpeg') is None: raise RuntimeError("FFmpeg is required for video export. Install with: winget install Gyan.FFmpeg")
    cap=None;engine=None;first=None
    if prepared_frames:
        source_fps=prepared_fps or FPS;sample=Image.open(io.BytesIO(prepared_frames[0])).convert('RGB')
    else:
        cap,source_fps=open_capture(path);ok,first=cap.read()
        if not ok:raise RuntimeError("No decodable frames found.")
        engine=Engine();cells=engine.convert(first);sample=render_image(cells,OUTPUT_WIDTH)
    outdir=Path(__file__).parent/'public'/'output';outdir.mkdir(parents=True,exist_ok=True);suffix='.gif' if EXPORT_GIF else f'.{OUTPUT_FORMAT}';out=outdir/f'{Path(path).stem}-ascii{suffix}'
    cmd=['ffmpeg','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{sample.width}x{sample.height}','-r',str(source_fps),'-i','-']
    if PRESERVE_AUDIO and not EXPORT_GIF:cmd+=['-i',path,'-map','0:v','-map','1:a?','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(out)]
    elif EXPORT_GIF:cmd+=['-vf','split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',str(out)]
    else:cmd+=['-c:v','libx264','-pix_fmt','yuv420p',str(out)]
    proc=subprocess.Popen(cmd,stdin=subprocess.PIPE);count=0
    try:
        if prepared_frames:
            for count,data in enumerate(prepared_frames,1):
                proc.stdin.write(Image.open(io.BytesIO(data)).convert('RGB').tobytes())
                if count%30==0:print(f"\rExported {count} frames",end='',flush=True)
        else:
            proc.stdin.write(sample.tobytes())
            while True:
                ok,frame=cap.read()
                if not ok:break
                proc.stdin.write(render_image(engine.convert(frame),OUTPUT_WIDTH).tobytes());count+=1
                if count%30==0:print(f"\rExported {count} frames",end='',flush=True)
    finally:
        if cap is not None:cap.release()
        if proc.stdin:proc.stdin.close()
        code=proc.wait()
    if code:raise RuntimeError(f"FFmpeg exited with code {code}.")
    print(f"\nSaved: {out.resolve()}");return out

def restore_terminal():
    sys.stdout.write(RESET+SHOW+"\n");sys.stdout.flush()
atexit.register(restore_terminal)

def main():
    parser=argparse.ArgumentParser(description="Convert video/GIF to animated ASCII")
    parser.add_argument('file',nargs='?');parser.add_argument('--no-play',action='store_true');parser.add_argument('--no-export',action='store_true');parser.add_argument('--columns',type=int);args=parser.parse_args()
    validate_config();global COLUMNS
    if args.columns:COLUMNS=args.columns
    path=args.file or choose_input_file()
    if not Path(path).is_file():raise FileNotFoundError(path)
    print(f"Selected input: {Path(path).resolve()}")
    window_will_export=SHOW_WINDOW and not args.no_play and not args.no_export and (EXPORT_VIDEO or EXPORT_GIF)
    if SHOW_WINDOW and not args.no_play:AsciiWindow(path,auto_export=window_will_export).run()
    if PLAY_IN_TERMINAL and not args.no_play:play(path)
    if (EXPORT_VIDEO or EXPORT_GIF) and not args.no_export and not window_will_export:export(path)

if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:print("\nCancelled.")
    except Exception as exc:print(f"\nError: {exc}",file=sys.stderr);sys.exit(1)
