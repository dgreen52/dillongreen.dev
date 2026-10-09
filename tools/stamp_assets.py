"""Cache-busting: stamp every /assets/ reference with ?v=<content hash>. Run before every deploy.

    python tools/stamp_assets.py            # rewrite the ?v= values in place (idempotent)
    python tools/stamp_assets.py --check    # exit 1 if any reference is missing or stale

_headers lets browsers keep CSS/JS for a day (and serve them stale for a week) and fonts for a
year, but the file names never change. So every reference carries ?v=<first 10 hex of sha256>:
when a file changes, its URL changes and returning visitors fetch the new one with the new HTML.

Order matters and is handled here: fonts (and any other url() in the CSS) are stamped inside
site.css first, so the CSS hash covers them; then every href/src="...assets/..." in the HTML is
stamped from the files on disk, including the font preloads, which must match the CSS URLs
exactly or the browser downloads each font twice. JS doesn't load any assets by URL itself
(forms.js only calls /api/*), so there is nothing to stamp inside the scripts.
"""
import hashlib
import re
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
CHECK = "--check" in sys.argv


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


def resolve(base_dir: Path, ref: str) -> Path:
    return (SITE / ref.lstrip("/")) if ref.startswith("/") else (base_dir / ref)


def stamp(text: str, base_dir: Path, pattern: re.Pattern, where: str, problems: list) -> str:
    def sub(m):
        ref = m.group("ref")
        f = resolve(base_dir, ref).resolve()
        if not f.is_file():
            if ref.lstrip("./") in OPTIONAL:
                print(f"note: {where}: optional {ref} is not here yet; left unstamped")
                return m.group(0)
            problems.append(f"{where}: {ref} does not exist")
            return m.group(0)
        want = f"{ref}?v={digest(f)}"
        if m.group("q") != f"?v={digest(f)}":
            problems.append(f"{where}: {ref}{m.group('q') or ''} -> ?v={digest(f)}")
        return m.group("pre") + want + m.group("post")
    return pattern.sub(sub, text)


# url("../fonts/x.woff2") or url(../img/x.png?v=...) inside stylesheets (data: URIs untouched)
CSS_URL = re.compile(r'(?P<pre>url\(\s*"?)(?P<ref>(?!data:)[^")?#]+)(?P<q>\?v=[0-9a-f]*)?(?P<post>"?\s*\))')
# href="assets/..." / src="/assets/..." in HTML, relative or absolute, with or without an old ?v=
# (and data-clip-webm/mp4="/assets/clips/..." on game cards, read by assets/js/clips.js)
HTML_REF = re.compile(r'(?P<pre>\b(?:href|src|data-clip-webm|data-clip-mp4)=")(?P<ref>(?:\.\./|\./|/)*assets/[^"?#]+)(?P<q>\?v=[0-9a-f]*)?(?P<post>")')
# absolute share-card URLs in <meta content="https://dillongreen.dev/assets/og/....png">, so a regenerated
# card gets a new URL and link previews that cache by URL pick it up
META_REF = re.compile(r'(?P<pre>\bcontent="https://dillongreen\.dev)(?P<ref>/assets/[^"?#]+)(?P<q>\?v=[0-9a-f]*)?(?P<post>")')
# Files another part of the build owns (the live-status widget). If a local checkout doesn't have them yet,
# the reference is left unstamped and reported instead of failing the run.
OPTIONAL = {"assets/js/status.js", "assets/css/status.css"}

SRCSET = re.compile(r'(\bsrcset=")([^"]+)(")')
SRCSET_URL = re.compile(r'^(?P<pre>)(?P<ref>(?:\.\./|\./|/)*assets/[^\s?#]+)(?P<q>\?v=[0-9a-f]*)?(?P<post>(?:\s.*)?)$')

problems: list = []
changed = []
for css in sorted(SITE.rglob("*.css")):
    old = css.read_text(encoding="utf-8")
    new = stamp(old, css.parent, CSS_URL, css.relative_to(SITE).as_posix(), problems)
    if new != old:
        changed.append(css)
        if not CHECK:
            css.write_bytes(new.encode("utf-8"))  # bytes: keep the file's own line endings

for html in sorted(SITE.rglob("*.html")):
    raw = html.read_bytes().decode("utf-8")
    new = stamp(raw, html.parent, HTML_REF, html.relative_to(SITE).as_posix(), problems)
    new = stamp(new, html.parent, META_REF, html.relative_to(SITE).as_posix(), problems)
    # srcset="a-480.webp 480w, a.webp 960w": stamp each candidate URL the same way
    new = SRCSET.sub(lambda m: m.group(1) + ", ".join(
        stamp(c.strip(), html.parent, SRCSET_URL, html.relative_to(SITE).as_posix(), problems) for c in m.group(2).split(",")) + m.group(3), new)
    if new != raw:
        changed.append(html)
        if not CHECK:
            html.write_bytes(new.encode("utf-8"))

missing = [p for p in problems if "does not exist" in p]
if CHECK:
    print("\n".join(problems) if problems else "asset stamps: all current")
    sys.exit(1 if problems else 0)
for p in missing:
    print("!!", p)
print(f"stamped {len(changed)} file(s)" + (": " + ", ".join(c.relative_to(SITE).as_posix() for c in changed) if changed else " (already current)"))
sys.exit(1 if missing else 0)
