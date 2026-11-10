import numpy as np
import app
def test_rows_landscape_and_portrait():
    assert app.rows_for(1920,1080,160)==45
    assert app.rows_for(1080,1920,100)==89
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
