"""Static checks over site/: every local href/src resolves, every #anchor exists,
no phone numbers, no dollar amounts in text.  python tools/check_links.py"""
import re, sys
from pathlib import Path
from html.parser import HTMLParser

SITE = Path(__file__).resolve().parent.parent / "site"
problems = []

class P(HTMLParser):
    def __init__(self):
        super().__init__(); self.refs = []; self.ids = set()
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a: self.ids.add(a["id"])
        for k in ("href", "src"):
            if a.get(k): self.refs.append((tag, a[k]))

pages = {}
for f in SITE.rglob("*.html"):
    p = P(); p.feed(f.read_text(encoding="utf-8")); pages[f.relative_to(SITE).as_posix()] = p

def resolve(page, path):
    """Map an href/src path to a site-relative file, like the static host does (dir/ -> dir/index.html)."""
    if path == "": return page
    base = SITE if path.startswith("/") else (SITE / page).parent
    fp = (base / path.lstrip("/")).resolve()
    if path.endswith("/") or fp.is_dir(): fp = fp / "index.html"
    try: return fp.relative_to(SITE.resolve()).as_posix()
    except ValueError: return None

external = set()
for name, p in pages.items():
    for tag, ref in p.refs:
        if ref.startswith(("http://", "https://")): external.add(ref); continue
        if ref.startswith("mailto:"): continue
        path, _, frag = ref.partition("#")
        path = path.split("?")[0]  # ?v= cache-busting stamps
        target = resolve(name, path)
        if target is None or not (SITE / target).exists(): problems.append(f"{name}: missing {ref}"); continue
        if frag and target in pages and frag not in pages[target].ids:
            problems.append(f"{name}: missing anchor #{frag} in {target}")

for f in list(SITE.rglob("*.html")) + list(SITE.rglob("*.css")) + list(SITE.rglob("*.js")) + list(SITE.rglob("*.xml")) + list(SITE.rglob("*.txt")) + [SITE / "_headers", SITE / "site.webmanifest"]:
    t = f.read_text(encoding="utf-8", errors="ignore")
    if re.search(r"\(?\b253\)?[\s.-]?\d{3}[\s.-]?\d{4}", t) or "253" in t and "350" in t:
        problems.append(f"{f.name}: possible phone number")
    if "gmail" in t.lower():
        problems.append(f"{f.name}: old Gmail address present")
    for m in re.finditer(r"\$\s?\d", t):
        problems.append(f"{f.name}: dollar amount near {t[max(0,m.start()-20):m.end()+10]!r}")

# every public page is in the sitemap (404 and the owner-only admin are not)
sm = (SITE / "sitemap.xml").read_text(encoding="utf-8")
for name in pages:
    if name in ("404.html",) or name.startswith("admin/"): continue
    url = "https://dillongreen.dev/" + (name[:-len("index.html")] if name.endswith("index.html") else name)
    if f"<loc>{url}</loc>" not in sm: problems.append(f"sitemap.xml: missing {url}")

# CSS url() references
for css in SITE.rglob("*.css"):
    for u in re.findall(r"url\(\"?([^\")]+)\"?\)", css.read_text(encoding="utf-8")):
        if u.startswith("data:"): continue
        if not (css.parent / u.split("?")[0]).resolve().exists(): problems.append(f"{css.name}: missing {u}")

# arcade: frames only from the owner's workers.dev subdomain (and nothing broader), the site itself still
# can't be framed, and every cabinet's embed URL is one the CSP allows; no frame is in the static HTML
hdr = (SITE / "_headers").read_text(encoding="utf-8")
csp = re.search(r"Content-Security-Policy: (.*)", hdr).group(1)
fsrc = re.search(r"(?:^|;)\s*frame-src ([^;]+)", csp)
if not fsrc or fsrc.group(1).split() != ["https://*.dillon-eu-green.workers.dev"]:
    problems.append("_headers: frame-src must be exactly https://*.dillon-eu-green.workers.dev")
if "frame-ancestors 'none'" not in csp or "X-Frame-Options: DENY" not in hdr:
    problems.append("_headers: the site itself must stay unframeable (frame-ancestors 'none', X-Frame-Options: DENY)")
arcade = SITE / "arcade" / "index.html"
if arcade.exists():
    at = arcade.read_text(encoding="utf-8")
    for u in re.findall(r'data-embed="([^"]*)"', at):
        if not re.match(r"^https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.dillon-eu-green\.workers\.dev/?$", u):
            problems.append(f"arcade/index.html: embed {u!r} is outside frame-src")
    if "<iframe" in at.lower():
        problems.append("arcade/index.html: no <iframe> in the static page (click-to-load only)")

# every /assets/ reference must carry a current ?v= stamp (tools/stamp_assets.py)
import subprocess
r = subprocess.run([sys.executable, str(Path(__file__).with_name("stamp_assets.py")), "--check"], capture_output=True, text=True)
if r.returncode: problems.append("stale or missing ?v= asset stamps, run python tools/stamp_assets.py: " + "; ".join(r.stdout.split(chr(10))[:5]))
print("external links (not fetched; outbound network is restricted here):")
for e in sorted(external): print("  ", e)
print("\n".join(problems) if problems else "local links, anchors, phone/dollar/gmail scan: clean")
sys.exit(1 if problems else 0)
