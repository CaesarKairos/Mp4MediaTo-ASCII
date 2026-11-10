"""Video to ASCII — local terminal player and FFmpeg/Pillow exporter."""
from __future__ import annotations
import argparse, atexit, math, os, shutil, subprocess, sys, time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ==========================================
# VIDEO TO ASCII — CONFIGURATION
# ==========================================
COLUMNS = 120
FPS = 24
FONT_NAME = "Courier New"
FONT_SIZE = 16
USE_CLASSIC_ASCII = True
USE_DETAILED_ASCII = False
USE_BLOCKS = False
USE_BRAILLE = False
USE_BINARY = False
USE_CUSTOM_CHARSET = False
CUSTOM_CHARSET = " .oO0@#"
USE_ORIGINAL_COLORS = True
USE_MONOCHROME = False
USE_TERMINAL_GREEN = False
USE_AMBER = False
USE_CUSTOM_PALETTE = False
CUSTOM_FOREGROUND = "#FFFFFF"
CUSTOM_BACKGROUND = "#000000"
CUSTOM_PALETTE = ["#000000", "#A855F7", "#22C55E", "#FFFFFF"]
USE_GLYPH_MATCHING = True
USE_EDGE_DETECTION = True
USE_TEMPORAL_SMOOTHING = True
USE_DITHERING = False
BRIGHTNESS = 0.0
CONTRAST = 1.0
GAMMA = 1.0
INVERT = False
PLAY_IN_TERMINAL = True
EXPORT_VIDEO = True
EXPORT_GIF = False
PRESERVE_AUDIO = True
OUTPUT_FORMAT = "mp4"
OUTPUT_WIDTH = 1280
LOOP_PLAYBACK = False

CLASSIC = " .:-=+*#%@"
DETAILED = " `.^\",:;Il!i~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"
BLOCKS = " ░▒▓█"
BINARY = " 01"
RESET = "\033[0m"; HOME = "\033[H"; HIDE = "\033[?25l"; SHOW = "\033[?25h"

def validate_config() -> None:
    styles = [USE_CLASSIC_ASCII, USE_DETAILED_ASCII, USE_BLOCKS, USE_BRAILLE, USE_BINARY, USE_CUSTOM_CHARSET]
    colors = [USE_ORIGINAL_COLORS, USE_MONOCHROME, USE_TERMINAL_GREEN, USE_AMBER, USE_CUSTOM_PALETTE]
    if sum(styles) != 1: raise ValueError("Enable exactly one character style in CONFIGURATION.")
    if sum(colors) != 1: raise ValueError("Enable exactly one color mode in CONFIGURATION.")
    if not 8 <= COLUMNS <= 500: raise ValueError("COLUMNS must be between 8 and 500.")
    if FPS <= 0: raise ValueError("FPS must be positive.")

def charset() -> str:
    return DETAILED if USE_DETAILED_ASCII else BLOCKS if USE_BLOCKS else BINARY if USE_BINARY else CUSTOM_CHARSET if USE_CUSTOM_CHARSET else CLASSIC

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

def select_file()->str:
    try:
        from tkinter import Tk,filedialog
        root=Tk();root.withdraw();root.attributes('-topmost',True)
        path=filedialog.askopenfilename(title="Select a video or GIF",filetypes=[("Video and GIF files","*.mp4 *.webm *.mov *.gif"),("All files","*.*")]);root.destroy();return path
    except Exception as exc: raise RuntimeError(f"File picker could not open: {exc}") from exc

def open_capture(path:str):
    cap=cv2.VideoCapture(path)
    if not cap.isOpened(): raise RuntimeError("OpenCV could not decode this file or codec.")
    source_fps=cap.get(cv2.CAP_PROP_FPS) or FPS
    return cap,source_fps

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

def render_image(cells,width:int)->Image.Image:
    rows,cols=len(cells),len(cells[0]);font=find_font(FONT_SIZE);cell_w=max(1,width//cols);cell_h=max(2,round(cell_w*2));img=Image.new('RGB',(cell_w*cols,cell_h*rows),CUSTOM_BACKGROUND);d=ImageDraw.Draw(img)
    for y,row in enumerate(cells):
        for x,(ch,color) in enumerate(row):d.text((x*cell_w,y*cell_h),ch,font=font,fill=color,anchor='lt')
    return img

def export(path:str)->Path:
    if shutil.which('ffmpeg') is None: raise RuntimeError("FFmpeg is required for video export. Install with: winget install Gyan.FFmpeg")
    cap,source_fps=open_capture(path);ok,first=cap.read()
    if not ok:raise RuntimeError("No decodable frames found.")
    engine=Engine();cells=engine.convert(first);sample=render_image(cells,OUTPUT_WIDTH);outdir=Path(__file__).parent/'output';outdir.mkdir(exist_ok=True);suffix='.gif' if EXPORT_GIF else f'.{OUTPUT_FORMAT}';out=outdir/f'{Path(path).stem}-ascii{suffix}'
    cmd=['ffmpeg','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{sample.width}x{sample.height}','-r',str(source_fps),'-i','-']
    if PRESERVE_AUDIO and not EXPORT_GIF:cmd+=['-i',path,'-map','0:v','-map','1:a?','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(out)]
    elif EXPORT_GIF:cmd+=['-vf','split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',str(out)]
    else:cmd+=['-c:v','libx264','-pix_fmt','yuv420p',str(out)]
    proc=subprocess.Popen(cmd,stdin=subprocess.PIPE);count=0
    try:
        for frame in [first]:proc.stdin.write(render_image(engine.convert(frame),OUTPUT_WIDTH).tobytes())
        while True:
            ok,frame=cap.read()
            if not ok:break
            proc.stdin.write(render_image(engine.convert(frame),OUTPUT_WIDTH).tobytes());count+=1
            if count%30==0:print(f"\rExported {count} frames",end='',flush=True)
    finally:
        cap.release()
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
    path=args.file or select_file()
    if not path:return
    if not Path(path).is_file():raise FileNotFoundError(path)
    if PLAY_IN_TERMINAL and not args.no_play:play(path)
    if (EXPORT_VIDEO or EXPORT_GIF) and not args.no_export:export(path)

if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:print("\nCancelled.")
    except Exception as exc:print(f"\nError: {exc}",file=sys.stderr);sys.exit(1)
