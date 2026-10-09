"""Builds the site's screenshot assets (WebP) from the sibling project folders.

Read-only with respect to the source projects. Re-run after source screenshots
change:  python tools/build_images.py
Spectro has no stored screenshot; render it first with tools/render-spectro.js.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent          # portfolio/
EXTE = ROOT.parent                                     # sibling projects
OUT = ROOT / "site" / "assets" / "img"

def save(im, rel, width, quality=82):
    im = im.convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    dst = OUT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "WEBP", quality=quality, method=6)
    print(f"{rel:32s} {im.width}x{im.height}  {dst.stat().st_size // 1024} KB")

def crumb_screen(name):
    # The store shots are marketing frames; crop to the phone's inner screen.
    im = Image.open(EXTE / "Crumb/app/store/screenshots" / f"{name}.png")
    return im.crop((150, 590, 1170, 2772))

# Featured: phone shots shown ~230 CSS px wide -> 480 px for 2x screens.
P429 = EXTE / "pocket429/store/screenshots/raw"
for src, dst in [("01-decode", "decode"), ("05-scan", "scan"), ("03-text", "text")]:
    save(Image.open(P429 / f"{src}.png"), f"work/pocket429-{dst}.webp", 480)
for src, dst in [("1-recipes", "recipes"), ("2-recipe", "recipe"), ("5-plan", "plan")]:
    save(crumb_screen(src), f"work/crumb-{dst}.webp", 480)
save(Image.open(EXTE / "jaderealm/tools/shots/PC-classic.png"), "work/jaderealm.webp", 1440, 78)

# More things: thumbnails ~ 380 CSS px boxes.
save(Image.open(EXTE / "surprisepass/tools/shots/paid-download.png"), "more/surprisepass.webp", 900)
save(Image.open(EXTE / "butter/tools/shots/day-5-flare.png"), "more/butter.webp", 360)
save(Image.open(EXTE / "beepbeach/tools/shots/01-beach.png"), "more/beepbeach.webp", 360)
save(Image.open(EXTE / "halfsies/tools/shots/01-home.png"), "more/halfsies.webp", 360)
# Browser experiments (low-key section). Rendered locally by tools/render-*.js
# into verify/ first; RetrOS reuses the owner's own capture in its folder.
save(Image.open(EXTE / "RetrOS/New folder/Screenshot 2026-06-18 134824.png"), "lab/retros.webp", 800)
RENDERS = {"spectro-raw.png": ("lab/spectro.webp", None),
           "cyberhome-raw.png": ("lab/cyberhome.webp", (160, 0, 1120, 600)),
           "ribbon-popup.png": ("lab/ribbon.webp", None)}
for raw, (dst, box) in RENDERS.items():
    p = ROOT / "verify" / raw
    if not p.exists():
        print(f"!! {raw} missing - see tools/README notes"); continue
    im = Image.open(p)
    save(im.crop(box) if box else im, dst, 800)

# Smart Mirror: demo renders from tools/render-mirror.js (invented config, faked APIs;
# the real config.json / notes.json are never read).
for name in ("rain", "boot", "hack"):
    p = ROOT / "verify" / f"mirror-{name}.png"
    if p.exists():
        save(Image.open(p), f"work/mirror-{name}.webp", 480)
    else:
        print(f"!! mirror-{name}.png missing - run: node tools/render-mirror.js")
