"""Render every project from tools/projects.json into the site. Idempotent; run before deploy.

    python tools/build_projects.py     # then: python tools/stamp_assets.py

What it writes:
  * site/projects/index.html  the cards (between <!-- build:cards --> markers), the "Live on the web"
                              list (<!-- build:live -->) and the counts in the heading and filter line
  * every page in site/       any <a data-project="slug"> gets that project's current URL, and any
                              element with data-project-name="slug" gets its current name, so the
                              home cards, studio page and posts follow the JSON too. Links to a known
                              project URL that aren't tagged yet are tagged automatically.
  * site/assets/js/projects-data.js   what the terminal reads (play/open/ls)
  * functions/_lib/projects-live.json the nodes /api/status checks (every project with a live URL)

To change a project's URL: edit "url" in tools/projects.json and run the two commands above.
To pull a link (rename, outage): set "url": null and "unavailable": "short note".
"""
import hashlib
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DATA = json.loads((Path(__file__).with_name("projects.json")).read_text(encoding="utf-8"))
P = DATA["projects"]
BY = {p["slug"]: p for p in P}
NE = '<svg aria-hidden="true"><use href="#i-arrow-ne"/></svg>'
R = '<svg aria-hidden="true"><use href="#i-arrow-r"/></svg>'
STATUS_CLASS = {"live": "live", "review": "review", "proto": "soon", "build": "review", "internal": "internal", "exp": "exp"}
e = lambda s: html.escape(str(s), quote=True)


def norm(u):
    return (u or "").rstrip("/")


def thumb(p):
    t = p.get("thumb") or {}
    if t.get("kind") == "par-readout":
        return ('<div class="du-mini" role="img" aria-label="PAR summary: about 72 thousand lines, 231 routes, 340 plus automated checks, '
                'rolled out to a 40-person department."><span class="du-mini-head" aria-hidden="true">PAR // SYS.STATUS <i>● IN SERVICE</i></span>'
                '<span class="du-mini-grid" aria-hidden="true"><span><b>~72k</b><small>lines</small></span><span><b>231</b><small>routes</small></span>'
                '<span><b class="g">340+</b><small>checks</small></span><span><b>40</b><small>dept size</small></span></span></div>')
    # art direction (thumb.fit): cover = crop to the box at thumb.focus; contain = the whole image on the
    # tinted panel; phone = a portrait phone screen standing on the panel, running off the bottom edge
    fit = t.get("fit", "cover")
    cls = {"cover": f'cover focus-{p["slug"]}', "contain": "contain", "phone": "shot-phone"}[fit]
    lazy = "" if t.get("eager") else ' loading="lazy"'
    v = hashlib.sha256((SITE / "assets" / "img" / t["src"]).read_bytes()).hexdigest()[:10]  # same stamp as stamp_assets.py
    return f'<img class="{cls}" src="/assets/img/{t["src"]}?v={v}"{srcset(t)} width="{t["w"]}" height="{t["h"]}"{lazy} decoding="async" alt="{e(t["alt"])}">'


# smaller copies made by tools/img_variants.py (<name>-480.webp, <name>-960.webp), so phones fetch ~480 px
# images. sizes follows the .pgrid columns: 1 up to 479px, 2 up to 1023px, then ~380px cards.
CARD_SIZES = "(max-width: 479px) calc(100vw - 34px), (max-width: 1023px) calc(50vw - 40px), 380px"


def srcset(t):
    src = SITE / "assets" / "img" / t["src"]
    url = lambda f: f'/assets/img/{f.relative_to(SITE / "assets" / "img").as_posix()}?v={hashlib.sha256(f.read_bytes()).hexdigest()[:10]}'
    cands = [(src.with_name(f"{src.stem}-{w}.webp"), w) for w in (480, 960)]
    cands = [(url(f), w) for f, w in cands if f.is_file()]
    if not cands or t.get("fit") == "phone":
        return ""
    cands.append((url(src), t["w"]))
    return f' srcset="{", ".join(f"{u} {w}w" for u, w in cands)}" sizes="{CARD_SIZES}"'


def focus_css():
    rules = "".join(f'.thumb img.focus-{p["slug"]} {{ object-position: {p["thumb"].get("focus", "50% 50%")}; }}' + chr(10)
                    for p in P if (p.get("thumb") or {}).get("src") and p["thumb"].get("fit", "cover") == "cover")
    return rules


# Gameplay clip (optional): "clip": "<name>" -> site/assets/clips/<name>.webm + .mp4, recorded by
# tools/capture_clips.js. assets/js/clips.js plays it over the still while the card is on screen.
def clip_files(p):
    c = p.get("clip")
    if not c:
        return None
    files = {ext: SITE / "assets" / "clips" / f"{c}.{ext}" for ext in ("webm", "mp4")}
    return files if all(f.is_file() for f in files.values()) else None  # missing files: just the still


def thumb_class(p):
    panel = " is-panel" if (p.get("thumb") or {}).get("fit") in ("contain", "phone") else ""
    return "thumb" + panel + (" clip-box" if clip_files(p) else "")


def clip_attrs(p):
    files = clip_files(p)
    if not files:
        return ""
    stamp = lambda f: hashlib.sha256(f.read_bytes()).hexdigest()[:10]
    return "".join(f' data-clip-{ext}="/assets/clips/{f.name}?v={stamp(f)}"' for ext, f in files.items())


# Live projects get a status chip in the image corner; assets/js/status.js lights it (data-state).
def thumb_extras(p):
    out = '<span class="clip-hud" aria-hidden="true">▶ Live capture</span>' if clip_files(p) else ""
    if p.get("url"):
        out += f'<span class="sdot" data-status-slug="{p["slug"]}"></span>'
    return out


# The card picture is a link to the card's primary action (the first action that has a target), so the
# image opens the game or app too. tabindex="-1" keeps one keyboard stop per card (the button); the
# aria-label names the destination for anyone who meets the link by pointer or screen-reader cursor.
# A project with no action target keeps a plain picture.
def primary(p):
    for a in p.get("actions", []):
        href = p.get("url") if a["href"] == "@url" else a["href"]
        if href:
            return a, href
    return None, None


def media_label(p, a):
    t, n = a["text"], p["name"]
    return {"Try it": f"Try {n}", "Case study": f"{n} case study"}.get(t, f"{t} {n}")


def media_open(p):
    a, href = primary(p)
    if not a:
        return f'<div class="{thumb_class(p)}"{clip_attrs(p)}>'
    ext = href.startswith("http")
    attrs = (f' href="{e(href)}"' + (' rel="noopener"' if ext else "") + (f' data-project="{p["slug"]}"' if a["href"] == "@url" else "")
             + (" data-recurse" if a.get("recurse") else "") + f' tabindex="-1" aria-label="{e(media_label(p, a))}"')
    return f'<a class="{thumb_class(p)} pcard-media"{clip_attrs(p)}{attrs}>'


def media_close(p):
    a, href = primary(p)
    if not a:
        return "</div>"
    chip = "▶ Play" if p.get("play") and a["href"] == "@url" else ("↗ Open" if href.startswith("http") else "→ " + a["text"])
    return f'<span class="media-go" aria-hidden="true">{e(chip)}</span></a>'


def actions(p):
    out = []
    for a in p.get("actions", []):
        href = p.get("url") if a["href"] == "@url" else a["href"]
        if not href:
            continue  # pulled link (url null): no dead action
        ext = href.startswith("http")
        tag = f' data-project="{p["slug"]}"' if a["href"] == "@url" else ""
        rec = " data-recurse" if a.get("recurse") else ""
        rel = ' rel="noopener"' if ext else ""
        icon = NE if ext else R
        style = a.get("style", "link")
        if style in ("btn", "btn-int"):
            out.append(f'<a class="btn btn-primary btn-sm" href="{e(href)}"{rel}{tag}{rec}>{e(a["text"])} {icon}</a>')
        elif style == "int":
            out.append(f'<a class="link-arrow internal" href="{e(href)}"{rec}>{e(a["text"])} {R}</a>')
        else:
            out.append(f'<a class="link-arrow" href="{e(href)}"{rel}{tag}{rec}>{e(a["text"])} {icon}</a>')
    if p.get("more"):
        out.append(f'<details class="pcard-more"><summary>Read more</summary><p>{e(p["more"])}</p></details>')
    return "".join(out)


def card(p):
    aside = f' <span class="pcard-aside">{e(p["aside"])}</span>' if p.get("aside") else ""
    tags = "".join(f"<li>{e(t)}</li>" for t in p.get("tags", []))
    return f'''        <li class="pcard" id="{p["slug"]}" data-cats="{" ".join(p["cats"])}">
          {media_open(p)}{thumb(p)}{thumb_extras(p)}{media_close(p)}
          <div class="pcard-body">
            <span class="status {STATUS_CLASS[p["status"]]}">{e(p["status_label"])}</span>
            <h2 class="pcard-name"><span data-project-name="{p["slug"]}">{e(p["name"])}</span>{aside}</h2>
            <p class="pcard-pitch">{e(p["pitch"])}</p>
            <ul class="chips" aria-label="Technologies">{tags}</ul>
            <div class="pcard-act">{actions(p)}</div>
          </div>
        </li>
'''


live = [p for p in P if p.get("url")]


def live_list():
    items = "".join(
        f'<li><a href="{e(p["url"])}" rel="noopener" data-project="{p["slug"]}"><span class="lw-name" data-project-name="{p["slug"]}">{e(p["name"])}</span>'
        f'<span class="lw-host">{e(p.get("live_label") or p["url"].replace("https://", ""))}</span>{NE}</a></li>' for p in live)
    return f'''      <nav class="live-web" aria-labelledby="live-web-title">
        <h2 id="live-web-title"><span class="lamp" aria-hidden="true"></span>Live on the web <span class="lw-count">{len(live)} links</span></h2>
        <ul>{items}</ul>
      </nav>
'''


def between(s, name, body):
    a, b = f"<!-- build:{name} -->", f"<!-- /build:{name} -->"
    i, j = s.index(a) + len(a), s.index(b)
    return s[:i] + "\n" + body + "      " + s[j:]


changed = []


def write(path, old, new):
    if new != old:
        path.write_bytes(new.encode("utf-8"))
        changed.append(path.relative_to(SITE).as_posix())


# 1. /projects/
pp = SITE / "projects" / "index.html"
old = pp.read_bytes().decode("utf-8")
s = old
if "<!-- build:cards -->" not in s:  # first run: put markers around the hand-made regions
    s = re.sub(r'(<ul class="pgrid" data-filter-list>\n)(.*?)(      </ul>\n    </div>\n  </section>)',
               lambda m: m.group(1) + "<!-- build:cards -->\n<!-- /build:cards -->\n" + m.group(3), s, count=1, flags=re.S)
    s = re.sub(r'      <nav class="live-web".*?</nav>\n', "      <!-- build:live -->\n<!-- /build:live -->\n", s, count=1, flags=re.S)
    s = s.replace("<!-- build:cards -->\n<!-- /build:cards -->\n      </ul>", "      <!-- build:cards -->\n<!-- /build:cards -->\n      </ul>")
s = between(s, "cards", "".join(card(p) for p in P))
s = between(s, "live", live_list())
s = re.sub(r"Index · \d+ entries", f"Index · {len(P)} entries", s)
s = re.sub(r"data-filter-count>\d+ projects<", f"data-filter-count>{len(P)} projects<", s)
write(pp, old, s)

# 1b. the per-card focal points (thumb.focus) as CSS: the CSP allows no inline styles
cp = SITE / "assets" / "css" / "site.css"
old = cp.read_bytes().decode("utf-8")
a, b = "/* build:focus */", "/* /build:focus */"
NL = chr(10)
s = old if a in old else old.rstrip(NL) + NL * 2 + "/* card focal points, generated by tools/build_projects.py from thumb.focus */" + NL + a + NL + b + NL
s = s[:s.index(a) + len(a)] + NL + focus_css() + s[s.index(b):]
write(cp, old, s)

# 2. every page: tag + update project links and names
URLS = {norm(p["url"]): p["slug"] for p in P if p.get("url")}
A_TAG = re.compile(r"<a\b[^>]*>")
for f in sorted(SITE.rglob("*.html")):
    old = f.read_bytes().decode("utf-8")

    def fix_a(m):
        t = m.group(0)
        slug = re.search(r'data-project="([^"]+)"', t)
        href = re.search(r'href="([^"]*)"', t)
        if not slug and href and norm(href.group(1)) in URLS:  # first sighting of a known URL: tag it
            t = t[:-1] + f' data-project="{URLS[norm(href.group(1))]}">'
            slug = re.search(r'data-project="([^"]+)"', t)
        if slug and slug.group(1) in BY and BY[slug.group(1)].get("url") and href:
            t = t.replace(f'href="{href.group(1)}"', f'href="{e(BY[slug.group(1)]["url"])}"', 1)
        return t

    s = A_TAG.sub(fix_a, old)
    s = re.sub(r'(<(\w+)[^>]*data-project-name="([^"]+)"[^>]*>)[^<]*(</\2>)',
               lambda m: m.group(1) + (e(BY[m.group(3)]["name"]) if m.group(3) in BY else "") + m.group(4), s)
    s = re.sub(r"See all \d+ projects", f"See all {len(P)} projects", s)
    write(f, old, s)

# 3. terminal data
term = [{k: v for k, v in {
    "slug": p["slug"], "name": p["name"], "aliases": p.get("aliases", [p["slug"]]), "url": p.get("url"),
    "play": bool(p.get("play")), "line": p.get("launch_line"), "unavailable": p.get("unavailable"),
    "anchor": p.get("home_anchor"), "desc": p.get("desc", p["pitch"]), "cats": p["cats"], "recurse": bool(p.get("recurse")),
}.items() if v not in (None, False, [])} for p in P]
js = ("// Generated by tools/build_projects.py from tools/projects.json. Don't edit by hand.\n"
      "(function () { var DG = (window.DG = window.DG || {}); DG.projects = " + json.dumps(term, ensure_ascii=False, indent=1) + "; })();\n")
jp = SITE / "assets" / "js" / "projects-data.js"
old = jp.read_text(encoding="utf-8") if jp.exists() else ""
if js != old:
    jp.write_text(js, encoding="utf-8", newline="\n")
    changed.append("assets/js/projects-data.js")

# 4. live-status node list for the Pages Function (functions/api/status.js). Not served as a static file.
#    kind "workers": hosted on <service>.<account>.workers.dev, checked through a service binding
#    (SVC_<SERVICE>, see wrangler.toml); kind "pages": hosted on Cloudflare Pages, checked with fetch().
def node(p):
    host = p["url"].split("://", 1)[-1].split("/", 1)[0].lower()
    n = {"slug": p["slug"], "name": p["name"], "url": p["url"], "kind": "workers" if host.endswith(".workers.dev") else "pages"}
    if n["kind"] == "workers":
        n["service"] = host.split(".", 1)[0]
    return n


lj = ROOT / "functions" / "_lib" / "projects-live.json"
live_json = json.dumps([node(p) for p in live], ensure_ascii=False, indent=1) + "\n"
old = lj.read_text(encoding="utf-8") if lj.exists() else ""
if live_json != old:
    lj.write_text(live_json, encoding="utf-8", newline="\n")
    changed.append("../functions/_lib/projects-live.json")

print(f"{len(P)} projects, {len(live)} live links; " + (f"updated {len(changed)} file(s): " + ", ".join(changed) if changed else "already current"))
