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
    monkeypatch.setattr(app,"PRESERVE_AUDIO",False)
    monkeypatch.setattr(app,"EXPORT_GIF",False)
    monkeypatch.setattr(app,"OUTPUT_FORMAT","mp4")
    output=app.export(str(source),frames,24.0)
    metadata=json.loads(subprocess.check_output([ffprobe,"-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=avg_frame_rate,nb_read_frames,duration","-of","json",str(output)]))["streams"][0]
    assert int(metadata["nb_read_frames"])==expected_frames
    assert metadata["avg_frame_rate"]==f"{output_fps}/1"
    assert abs(float(metadata["duration"])-10)<=1/output_fps
