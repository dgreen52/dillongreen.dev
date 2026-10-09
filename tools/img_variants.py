"""Smaller copies of the wide card screenshots, so phones don't download desktop-sized images.

    python tools/img_variants.py      # then python tools/build_projects.py && python tools/stamp_assets.py

For every image under site/assets/img/ that's at least 900 px wide, writes <name>-480.webp (and
<name>-960.webp when the original is wider than 1200 px) next to it. build_projects.py and the home
page list them in srcset; the original stays the largest candidate. Idempotent: a variant is only
rewritten when it's missing or older than its original.

Also makes the landscape "band" posters for the portrait games that have a gameplay clip
(butter, beepbeach): the first frame of the clip (site/assets/clips/<name>.mp4), so the still and the
loop line up exactly in the card.
"""
import subprocess
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "site" / "assets" / "img"
CLIPS = ROOT / "site" / "assets" / "clips"


def save(im, dst, w):
    im = im.convert("RGB")
    if im.width > w:
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    im.save(dst, "WEBP", quality=80, method=6)
    print(f"{dst.relative_to(IMG).as_posix():36s} {im.width}x{im.height} {dst.stat().st_size // 1024} KB")


for src in sorted(IMG.rglob("*.webp")):
    if src.stem.endswith(("-480", "-960")):
        continue
    with Image.open(src) as im:
        widths = [480] + ([960] if im.width > 1200 else []) if im.width >= 900 else []
        for w in widths:
            dst = src.with_name(f"{src.stem}-{w}.webp")
            if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
                save(im, dst, w)


def ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


for name in ("butter", "beepbeach"):
    clip, dst = CLIPS / f"{name}.mp4", IMG / "more" / f"{name}-band.webp"
    if not clip.exists():
        print(f"!! {clip.name} missing (node tools/capture_clips.js {name})"); continue
    if dst.exists() and dst.stat().st_mtime >= clip.stat().st_mtime:
        continue
    png = dst.with_suffix(".png")
    subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-i", str(clip), "-frames:v", "1", str(png)], check=True)
    with Image.open(png) as im:
        save(im, dst, 640)  # butter: 640x360 landscape since the pixel-art rework; beepbeach: 512x320 band
    png.unlink()
