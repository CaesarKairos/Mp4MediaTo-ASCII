import numpy as np
import app
def test_rows_landscape_and_portrait():
    assert app.rows_for(1920,1080,160)==45
    assert app.rows_for(1080,1920,100)==89
    assert app.fitted_preview_size(1920,1080,1100,680)==(1100,620)
    assert app.fitted_preview_size(1080,1920,1100,680)==(383,680)
    assert app.fitted_preview_size(1920,1080,800,600)==(800,451)
def test_luminance_known_values():
    old=(app.BRIGHTNESS,app.CONTRAST,app.GAMMA,app.INVERT)
    app.BRIGHTNESS,app.CONTRAST,app.GAMMA,app.INVERT=0,1,1,False
    x=app.adjust_luminance(np.array([[[255.,0.,0.],[255.,255.,255.]]]))
    assert abs(x[0,0]-54.213)<.01 and abs(x[0,1]-255)<.01
    app.BRIGHTNESS,app.CONTRAST,app.GAMMA,app.INVERT=old
def test_conflicting_styles(monkeypatch):
    monkeypatch.setattr(app,'USE_CLASSIC_ASCII',True)
    monkeypatch.setattr(app,'USE_DETAILED_ASCII',True)
    try:app.validate_config();assert False
    except ValueError as e:assert 'exactly one character' in str(e)
def test_engine_is_temporally_deterministic():
    frame=np.full((40,80,3),127,np.uint8);a=app.Engine().convert(frame,20);b=app.Engine().convert(frame,20);assert a==b
def test_prepared_cache_round_trip(tmp_path,monkeypatch):
    source=tmp_path/'sample.mp4';source.write_bytes(b'video')
    monkeypatch.setattr(app,'CACHE_FOLDER',str(tmp_path/'cache'))
    saved=app.save_prepared_cache(str(source),[b'full'],[b'preview'],25.0)
    loaded=app.load_prepared_cache(str(source))
    assert saved.exists() and loaded['frames']==[b'full'] and loaded['preview_frames']==[b'preview'] and loaded['source_fps']==25.0

def test_export_timing_is_independent_from_playback_fps(monkeypatch):
    monkeypatch.setattr(app,'PLAYBACK_FPS',15)
    assert app.output_frame_count(10,60)==600
    monkeypatch.setattr(app,'PLAYBACK_FPS',120)
    assert app.output_frame_count(10,60)==600

def test_temporal_resampling_with_and_without_blending():
    assert app.temporal_sample(1,60,24,240)==(0,1,.4)
    assert app.temporal_sample(599,60,24,240)[1] == 239

def test_audio_playback_command_uses_position_and_volume(monkeypatch):
    monkeypatch.setattr(app,'PLAYBACK_AUDIO_VOLUME',.65)
    command=app.audio_playback_command('ffplay','movie.mp4',1.25)
    assert command[command.index('-ss')+1]=='1.250000'
    assert command[command.index('-volume')+1]=='65'
    assert command[-1]=='movie.mp4'
