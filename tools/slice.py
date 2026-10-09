"""Slice tall full-page screenshots into viewable parts: python tools/slice.py verify/a.png ..."""
import sys
from PIL import Image
for f in sys.argv[1:]:
    im = Image.open(f); W, H = im.size
    step = 1100 if W > 1000 else 1400
    for k, y in enumerate(range(0, H, step)):
        im.crop((0, y, W, min(H, y + step))).save(f.replace(".png", f"_p{k}.png"))
    print(f, H, (H + step - 1) // step)
