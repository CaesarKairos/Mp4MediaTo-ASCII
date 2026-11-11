"""Remove arquivos locais de entrada e saída sem apagar suas pastas."""

from __future__ import annotations

import shutil
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
MEDIA_FOLDERS = (
    PROJECT_ROOT / "public" / "input",
    PROJECT_ROOT / "public" / "output",
)
PRESERVED_NAMES = {".gitkeep"}


def clear_folder(folder: Path) -> int:
    """Apaga o conteúdo permitido de uma pasta e retorna o total removido."""
    public_folder = (PROJECT_ROOT / "public").resolve()
    resolved = folder.resolve()
    if resolved.parent != public_folder or resolved.name not in {"input", "output"}:
        raise RuntimeError(f"Pasta de mídia inválida: {resolved}")

    resolved.mkdir(parents=True, exist_ok=True)
    removed = 0
    for item in resolved.iterdir():
        if item.name in PRESERVED_NAMES:
            continue
        if item.is_dir() and not item.is_symlink():
            shutil.rmtree(item)
        else:
            item.unlink()
        removed += 1
        print(f"Removido: {item.relative_to(PROJECT_ROOT)}")
    return removed


def main() -> None:
    removed = sum(clear_folder(folder) for folder in MEDIA_FOLDERS)
    print(f"Limpeza concluída: {removed} item(ns) removido(s).")


if __name__ == "__main__":
    main()
