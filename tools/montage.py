"""Lay a tall full-page screenshot out as side-by-side columns so the whole page can be seen at once.

    python tools/montage.py verify/index-390-dark.png [more.png ...] [--col 2200] [--max-width 2400]

Writes <name>-montage.png next to each input. Columns are cut every --col pixels (default: about
2.6 phone screens) and the result is scaled down to --max-width if it would be wider.
"""
import argparse
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser()
ap.add_argument("files", nargs="+")
ap.add_argument("--col", type=int, default=2200)
ap.add_argument("--max-width", type=int, default=2400)
a = ap.parse_args()
COL, MAXW = a.col, a.max_width
GAP = 24

for f in a.files:
    im = Image.open(f).convert("RGB")
    W, H = im.size
    n = (H + COL - 1) // COL
    out = Image.new("RGB", (n * W + (n - 1) * GAP, min(H, COL)), (255, 0, 160))
    d = ImageDraw.Draw(out)
    for k in range(n):
        part = im.crop((0, k * COL, W, min(H, (k + 1) * COL)))
        x = k * (W + GAP)
        out.paste(part, (x, 0))
        d.text((x + 4, 4), f"{k * COL}px", fill=(255, 0, 160))
    if out.width > MAXW:
        out = out.resize((MAXW, round(out.height * MAXW / out.width)), Image.LANCZOS)
    dst = f.replace(".png", "-montage.png")
    out.save(dst)
    print(dst, f"{W}x{H}", f"{n} column(s)")
