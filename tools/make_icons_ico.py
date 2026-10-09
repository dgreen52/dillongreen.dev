"""Packs site/icon-16/32/48.png into site/favicon.ico (run after tools/render_icons.js)."""
from pathlib import Path
from PIL import Image

SITE = Path(__file__).resolve().parent.parent / "site"
imgs = [Image.open(SITE / f"icon-{s}.png").convert("RGBA") for s in (16, 32, 48)]
imgs[-1].save(SITE / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)], append_images=imgs[:-1])
print("wrote favicon.ico")
