"""favicon.ico (16/32/48) from the rendered 512px icon."""
from pathlib import Path
from PIL import Image
site = Path(__file__).resolve().parent.parent / "site"
im = Image.open(site / "icon-512.png").convert("RGBA")
im.save(site / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
(site / "favicon-32.png").unlink(missing_ok=True)
print("favicon.ico written")
