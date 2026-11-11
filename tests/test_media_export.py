import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

import app


@pytest.mark.parametrize("output_fps,expected_frames", [(15,150),(30,300),(60,600)])
def test_encoded_ten_second_duration_and_rate(tmp_path,monkeypatch,output_fps,expected_frames):
    ffmpeg=app.find_ffmpeg();ffprobe=shutil.which("ffprobe")
    if ffmpeg and not ffprobe:
        candidate=Path(ffmpeg).with_name("ffprobe.exe")
        ffprobe=str(candidate) if candidate.exists() else None
    if not ffmpeg or not ffprobe:pytest.skip("FFmpeg/FFprobe unavailable")
    source=tmp_path/"synthetic.mp4";source.write_bytes(b"source is unused when audio is disabled")
    encoded=io.BytesIO();Image.new("RGB",(32,16),(40,80,120)).save(encoded,"JPEG")
    frames=[encoded.getvalue()]*240
    monkeypatch.setattr(app,"__file__",str(tmp_path/"app.py"))
    monkeypatch.setattr(app,"EXPORT_FPS",output_fps)
    monkeypatch.setattr(app,"EXPORT_AUDIO",False)
    monkeypatch.setattr(app,"EXPORT_GIF",False)
    monkeypatch.setattr(app,"OUTPUT_FORMAT","mp4")
    output=app.export(str(source),frames,24.0)
    metadata=json.loads(subprocess.check_output([ffprobe,"-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=avg_frame_rate,nb_read_frames,duration","-of","json",str(output)]))["streams"][0]
    assert int(metadata["nb_read_frames"])==expected_frames
    assert metadata["avg_frame_rate"]==f"{output_fps}/1"
    assert abs(float(metadata["duration"])-10)<=1/output_fps

def test_export_can_include_or_omit_source_audio(tmp_path,monkeypatch):
    ffmpeg=app.find_ffmpeg();ffprobe=shutil.which("ffprobe")
    if ffmpeg and not ffprobe:
        candidate=Path(ffmpeg).with_name("ffprobe.exe");ffprobe=str(candidate) if candidate.exists() else None
    if not ffmpeg or not ffprobe:pytest.skip("FFmpeg/FFprobe unavailable")
    source=tmp_path/"with-audio.mp4"
    subprocess.run([ffmpeg,"-y","-f","lavfi","-i","color=c=black:s=32x16:r=24:d=2","-f","lavfi","-i","sine=frequency=440:duration=2","-c:v","libx264","-c:a","aac","-shortest",str(source)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    encoded=io.BytesIO();Image.new("RGB",(32,16),(20,40,60)).save(encoded,"JPEG");frames=[encoded.getvalue()]*48
    monkeypatch.setattr(app,"__file__",str(tmp_path/"app.py"));monkeypatch.setattr(app,"EXPORT_FPS",30);monkeypatch.setattr(app,"EXPORT_GIF",False);monkeypatch.setattr(app,"OUTPUT_FORMAT","mp4")
    monkeypatch.setattr(app,"EXPORT_AUDIO",True);with_audio=app.export(str(source),frames,24.0)
    streams=json.loads(subprocess.check_output([ffprobe,"-v","error","-show_entries","stream=codec_type,duration","-of","json",str(with_audio)]))["streams"]
    assert {stream["codec_type"] for stream in streams}=={"video","audio"}
    durations=[float(stream["duration"]) for stream in streams]
    assert max(durations)-min(durations)<=1/app.EXPORT_FPS
    monkeypatch.setattr(app,"EXPORT_AUDIO",False);without_audio=tmp_path/"without-audio.mp4"
    app.export(str(source),frames,24.0).replace(without_audio)
    streams=json.loads(subprocess.check_output([ffprobe,"-v","error","-show_entries","stream=codec_type","-of","json",str(without_audio)]))["streams"]
    assert [stream["codec_type"] for stream in streams]==["video"]
