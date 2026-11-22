"""从本仓库的透明母图生成扩展图标。"""
from pathlib import Path
from shutil import copyfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
ICONS = ROOT / "icons"


def main() -> None:
    source = ASSETS / "icon-source.png"
    with Image.open(source) as image:
        master = image.convert("RGBA")

    copyfile(source, ICONS / source.name)
    for size in (16, 32, 48, 128):
        output = ICONS / f"icon{size}.png"
        master.resize((size, size), Image.Resampling.LANCZOS).save(output, optimize=True)
        copyfile(output, ASSETS / output.name)


if __name__ == "__main__":
    main()
