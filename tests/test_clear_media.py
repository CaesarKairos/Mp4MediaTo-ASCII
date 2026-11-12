from pathlib import Path

from scripts import clear_media


def test_clear_folder_accepts_cache_and_preserves_gitkeep(tmp_path, monkeypatch):
    root = tmp_path / "project"
    cache = root / "public" / "cache"
    cache.mkdir(parents=True)
    (cache / ".gitkeep").write_text("", encoding="utf-8")
    (cache / "prepared.frames").write_bytes(b"cache")
    nested = cache / "old"
    nested.mkdir()
    (nested / "frame.jpg").write_bytes(b"frame")
    monkeypatch.setattr(clear_media, "PROJECT_ROOT", root)

    assert clear_media.clear_folder(cache) == 2
    assert [path.name for path in cache.iterdir()] == [".gitkeep"]


def test_clear_folder_rejects_paths_outside_known_media_folders(tmp_path, monkeypatch):
    root = tmp_path / "project"
    monkeypatch.setattr(clear_media, "PROJECT_ROOT", root)
    invalid = root / "public" / "assets"
    invalid.mkdir(parents=True)

    try:
        clear_media.clear_folder(invalid)
        assert False, "an unknown public folder must be rejected"
    except RuntimeError as error:
        assert "inválida" in str(error)
