# dillongreen.dev — portfolio

Static site: hand-written HTML, CSS and a little vanilla JS. No framework, no build step, no
cookies. The only third-party request is Cloudflare Web Analytics (cookieless), once it's switched
on for the Pages project (plus the owner's own games, framed on /arcade/ only after a click). Fonts
(Archivo, JetBrains Mono) are self-hosted under the SIL OFL; the licenses are in `site/assets/fonts/`.
Small Pages Functions store the guestbook and studio form posts in Cloudflare D1, report live status
and pass along the owner's public GitHub activity.

## Layout

```
portfolio/
├── site/                  ← the deployable site (and the only thing uploaded)
│   ├── index.html         home: hero + ARINC 429 bit-flipper, four featured projects, live status, how I work, experience
│   ├── projects/          every project, filterable (generated cards, see "Projects" below)
│   ├── arcade/            the web games, playable in a sandboxed frame on the page (see "Arcade")
│   ├── par.html           PAR case study (generalized, no proprietary data)
│   ├── studio/            "Dillon Green · Studio": pitch, pocket429, waitlist form (#waitlist)
│   ├── guestbook/         Web 1.0 guestbook; entries appear only after approval
│   ├── now/               "What I'm doing now" (a nownownow.com-style now page; update the date when you edit it) + "Latest from the workshop" GitHub feed
│   ├── privacy.html       plain-language privacy page (linked from the footer and both forms)
│   ├── 404.html
│   ├── Dillon_Green_Resume.pdf
│   ├── _headers           security + cache headers for Cloudflare Pages
│   ├── robots.txt, sitemap.xml, site.webmanifest
│   ├── og-image.png (1200×630), favicon.svg/.ico, apple-touch-icon.png, icon-192/512.png
│   └── assets/{css,js,fonts,img,clips,og}   js: theme, site (decoder + flipper), fun (terminal, ambient grid etc.), forms (guestbook/waitlist), clips (gameplay loops), status (live-status widget), arcade (game frames), activity (workshop feed)
│                          clips/: muted gameplay loops (.webm + .mp4) for the game cards · og/: per-page 1200x630 share cards
├── functions/             Cloudflare Pages Functions, deployed with the site
│   ├── api/guestbook.js   GET approved entries (max 100) + their countries · POST a new entry (stored 'pending')
│   ├── api/waitlist.js    POST only; there is deliberately no way to read the list over HTTP
│   ├── api/activity.js    GET the owner's recent public GitHub activity (logic: _lib/activity-core.js)
│   └── _lib/forms.js      shared validation, honeypot, ip_hash + rate limit, country code (not a route)
├── db/schema.sql          D1 tables + indexes (guestbook, waitlist): the whole schema, for a new database
├── db/migrations/         changes to an existing database, each safe to re-run (wrangler.toml migrations_dir)
├── resume/resume.html     working copy of the resume master, phone number removed
├── tools/                 asset + verification scripts (not deployed)
├── verify/                screenshots from the last verification run (not deployed)
└── wrangler.toml          Pages project config (pages_build_output_dir = ./site, D1 binding DB)
```

`site/` is kept separate so the README, tools and screenshots never get published. `functions/`
sits next to it and is picked up automatically when you deploy from this folder.

## Deploy (Cloudflare Pages)

From this folder:

```
python tools/build_projects.py     # project cards, live links and terminal data from tools/projects.json
python tools/stamp_assets.py       # cache-busting ?v=<hash> on every CSS/JS/font/image reference
npx wrangler pages deploy site --project-name dillongreen
```

Run both scripts before every deploy (they're idempotent; `check_links.py` fails if the stamps are
stale). `_headers` lets browsers cache CSS/JS for a day and fonts/images for longer, but file names
never change, so the `?v=` content hash is what makes returning visitors pick up new CSS/JS.

`wrangler.toml` sets the project name (`dillongreen`), `pages_build_output_dir = "./site"` and the
D1 binding (`DB` -> `dillongreen-db`), so only `site/` is uploaded as static files and
`functions/` is compiled into the Pages Worker. Don't run `deploy .`, which would upload the
README, tools and verification screenshots too.

### One-time setup for the guestbook + waitlist

The D1 database `dillongreen-db` already exists. Create its tables once (safe to re-run):

```
npx wrangler d1 execute dillongreen-db --remote --file db/schema.sql
```

Then bring an existing database up to date with the migrations in `db/migrations/` (wrangler records
what it has applied in a `d1_migrations` table; every file is also safe to run again by hand with
`d1 execute --remote --file`):

```
npx wrangler d1 migrations apply dillongreen-db --remote
```

`002_guestbook_country.sql` adds the nullable `guestbook.country` column. SQLite has no
`ADD COLUMN IF NOT EXISTS`, so it rebuilds the table (rows, ids and timestamps kept, indexes recreated)
and carries over countries already stored, which is what makes it re-runnable;
`node tools/test-migrations.js` proves that on throwaway local databases. Until it has run, the
guestbook keeps working without countries (the Function falls back to the old columns and logs it).

Until that runs, the forms answer with a friendly "try again in a minute" and the guestbook shows
"couldn't load".

### Cloudflare Web Analytics

Turn it on in the dashboard (Pages -> dillongreen -> Metrics -> Web Analytics). Cloudflare injects
`https://static.cloudflareinsights.com/beacon.min.js`, which reports to
`https://cloudflareinsights.com/cdn-cgi/rum`; `_headers` already allows exactly those two origins
(script-src and connect-src). Nothing else in the CSP was loosened.

The first run asks you to log in and creates the `dillongreen` Pages project. Attach the custom
domain `dillongreen.dev` under Pages → dillongreen → Custom domains.

**Domain:** canonical URLs, Open Graph URLs, `sitemap.xml` and `robots.txt` all use
`https://dillongreen.dev`. If you serve the site from a different domain, search and replace
that string in `site/`.

## Guestbook moderation and the waitlist

Nothing anyone types is public until you approve it. From this folder (PowerShell):

```
.\tools\guestbook.ps1 list-pending          # id, date, name, site, message
.\tools\guestbook.ps1 approve 12            # show entry 12 on /guestbook/
.\tools\guestbook.ps1 delete 13             # remove an entry (spam, or a removal request)
.\tools\guestbook.ps1 list-approved
.\tools\guestbook.ps1 list-waitlist         # studio form answers, newest first
.\tools\guestbook.ps1 delete-waitlist 4     # privacy deletion request
```

Each is a thin wrapper around `npx wrangler d1 execute dillongreen-db --remote --command "..."`;
ids must be integers, and nothing else from the command line reaches the SQL. Add `-Local` to run
against the local dev database instead.

How the API protects itself (both endpoints, `functions/_lib/forms.js`):

- JSON only, body capped at 8 KB (streamed and cut off at the cap, even without a
  `Content-Length`), a cross-site `Origin` is refused.
- Honeypot field `fax` (visually hidden): if it's filled in, the bot gets the normal "thanks"
  reply and nothing is stored.
- Lengths: name <= 40, site <= 80, guestbook message <= 280, waitlist workflow <= 1000. Control
  characters, bidi marks/overrides, the zero-width space, word joiner and BOM are stripped;
  ZWJ/ZWNJ and the emoji tag characters are kept on purpose (family / rainbow / England-flag
  emoji, Persian and Indic text), since every entry is moderated by hand. More than one URL in a
  message is refused. The guestbook site is stored and shown as plain text, never as a link.
- Rate limit, checked and written in **one** SQL statement (`INSERT ... SELECT ... WHERE`, atomic
  in D1, so parallel posts can't race past it): 3 posts per hour per `ip_hash`, and at most 20
  guestbook / 30 waitlist posts per hour in total. IPv6 addresses count per /64.
- `ip_hash` is HMAC-SHA-256 of the client IP (IPv6: its /64) keyed with the `IP_SALT` **secret**:
  set it once with `npx wrangler pages secret put IP_SALT --project-name dillongreen` (any long
  random string), then redeploy. It is never stored in the repo. **Without it both forms refuse
  posts** ("try again in a minute") rather than store a reversible hash. Hashes older than two
  days are blanked after each new post; changing the secret just restarts the hourly counts.
- Country: the guestbook POST keeps the `CF-IPCountry` header Cloudflare adds (validated as two capital
  letters; `XX` (unknown) and `T1` (Tor) are stored as NULL; a CHECK constraint backs it up), never
  the IP. GET returns `countries`, the distinct codes of **approved** entries (most signatures first),
  and never ties a country to an entry. The page shows "Signed from N countries" and a row of flags
  built from the codes (regional-indicator pairs, `textContent` only; where the system has no flag
  emoji, e.g. Windows, small code chips instead). The waitlist doesn't keep a country.
- Error replies are generic and friendly; raw errors only go to the Worker log.
- `GET /api/waitlist` is a 404 (POST is the only handler). Rendering uses `textContent` only
  (`site/assets/js/forms.js`).

## Updating things

| Task | Command (run from `portfolio/`) |
|---|---|
| Resume PDF | edit `resume/resume.html` (keep the phone number out), then run the Edge command below |
| Project screenshots | `python tools/build_images.py` (reads sibling project folders, read-only) |
| Spectro / extension renders | `node tools/render-spectro.js verify/spectro-raw.png 0 1` and `node tools/render-newtab.js <page.html> verify/<name>-raw.png` |
| Smart Mirror renders | `node tools/render-mirror.js` (serves ../Mirror/static read-only; every /api call is answered with an invented demo config and fake data, so the real config.json / notes.json are never read), then `python tools/build_images.py` |
| OG image and icons | `node tools/render-brand.js && python tools/make_ico.py` |
| Per-page share cards | `node tools/render_og.js && python tools/stamp_assets.py`: renders `tools/brand/og-page.html` once per page (list in the script) into `site/assets/og/*.png` (palette PNGs, < 200 KB), refreshes `site/og-image.png` (the generic card for privacy/404), and rewrites each page's `og:image*` / `twitter:image*` tags |
| Gameplay clips | `node tools/capture_clips.js [mixtape airfield butter beepbeach dragonrealm]`, then `python tools/img_variants.py && python tools/build_projects.py && python tools/stamp_assets.py`. Serves each game read-only from `../<game>/dist` on localhost (outside requests refused), drives it with the same inputs/test hooks as its own browser checks, records ~7.6 s with the CDP screencast, and ffmpeg makes a 7 s crossfaded loop (H.264 `.mp4` + VP9 `.webm`, limited-range BT.709, each ≤ 700 KB). ffmpeg comes from `$FFMPEG`, PATH or Python's `imageio-ffmpeg`. `KEEP=1` keeps raw frames in `verify/clips-raw/`; `--reencode` re-encodes from them without a browser |
| Card image variants | `python tools/img_variants.py`: `-480`/`-960` copies of wide screenshots for `srcset`, and the butter/beepbeach band posters (first frame of their clips) |

Resume PDF (PowerShell):

```
& "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --no-pdf-header-footer --user-data-dir="$env:TEMP\edge-pdf-profile" --print-to-pdf="$PWD\site\Dillon_Green_Resume.pdf" "file:///$($PWD -replace '\\','/')/resume/resume.html"
```

The Node scripts borrow Playwright from `../pocket429/node_modules` and drive the installed
Microsoft Edge, so nothing is downloaded. Set `PLAYWRIGHT_PATH` to use a different copy.

## Projects

Every project lives in one place: `tools/projects.json` (name, slug, pitch, status, tags, image,
live URL, actions, terminal line). `python tools/build_projects.py` renders the `/projects/` cards
and the "Live on the web" list, updates every link tagged `data-project="<slug>"` and every name
tagged `data-project-name="<slug>"` on any page (home featured cards, studio, now), and writes
`site/assets/js/projects-data.js`, which the terminal's `ls`, `open` and `play` read.

- **Change a URL or rename:** edit `url` / `name` in `tools/projects.json`, then run
  `python tools/build_projects.py && python tools/stamp_assets.py`.
- **Pull a link** (rename in progress, outage): set `"url": null` and `"unavailable": "short note"`.
  The card stays, its action disappears, and the terminal answers with the note.
- The four home cards keep their own longer copy and images in `site/index.html`; only their
  links and names follow the JSON.
- **Card pictures** (`thumb`): `fit` is `cover` (cropped to the card box at `focus`, a CSS
  object-position; the generated rules live between `/* build:focus */` markers at the end of
  `site.css`, since the CSP allows no inline styles), `contain` (the whole image on a tinted panel)
  or `phone` (a portrait phone screen standing on the panel). Wide shots get `srcset` from
  `tools/img_variants.py`. On phones every card puts its picture on top at full width in a 16:9
  box (two columns from 480px); there is no side-column thumbnail.
- **Gameplay clips** (`clip`: `"mixtape"` -> `site/assets/clips/mixtape.webm/.mp4`):
  `assets/js/clips.js` plays the loop over the still only while the card is on screen, never under
  reduced motion or Save-Data, with a "▶ LIVE CAPTURE" label; the still stays as the poster.
- **Live status**: every project with a `url` gets an `.sdot` chip (`data-status-slug`) in its
  picture corner, and `/` and `/projects/` have a `.status-slot` for the network-status panel;
  `assets/js/status.js` (+ `status.css`, `/api/status`) fills both. The slot reserves the panel's
  height (300px; 408px under 480px, for 11 nodes) so nothing moves when it loads. A 12th node fits
  the same box on wide screens; below 480px raise `--ns-rows` in `status.css` and the `.status-slot`
  min-height in `site.css` together.
- **Arcade** (`"arcade": {"order": n}`): the game gets a cabinet on `/arcade/` (see "Arcade" below).

## Arcade

`/arcade/` lists every project with `"arcade": {"order": n}` (cabinets written by
`build_projects.py` between `<!-- build:arcade -->` markers): butter, beepbeach, Mixtape Drift, Little
Airfield and Fernwood. Each cabinet is the card picture (+ gameplay clip and status chip) and its
controls. **Nothing from a game loads until "Play here" is pressed**; then `assets/js/arcade.js` swaps
in an `<iframe>` with `sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-popups"`,
`allow="fullscreen; autoplay; gamepad"`, `referrerpolicy="no-referrer"` and `loading="lazy"`, and
unloads any other running game first (one at a time). "Fullscreen" puts the frame full screen, "Stop"
removes it, "Open in new tab" is always there. Phones (under 720px wide, or a short landscape phone)
never embed: the link becomes "Play in a new tab" and a note says why; with JS off every game is a
new-tab link. The header shows the Arcade link from 800px (below that it's in the menu sheet).

- CSP: `frame-src https://*.dillon-eu-green.workers.dev` and nothing broader; the site itself keeps
  `frame-ancestors 'none'` + `X-Frame-Options: DENY`. `check_links.py` fails if either changes or a
  cabinet would embed something outside that host.
- Embedding needs the game to allow being framed. All five were checked (their `wrangler.toml`,
  `_headers` and worker code send no `X-Frame-Options` or `frame-ancestors`, and none frame-busts).
  For a game that refuses, set `"embed": false` in its `arcade` entry: it gets "Open in new tab" only.
- Inside the frame there's no `allow-modals` and no clipboard / web-share / motion-sensor permission,
  so a game's `confirm()` (Little Airfield's "start over"), `prompt()` fallback (Mixtape Drift's share
  link) and accelerometer reads quietly do nothing there; they work in the game's own tab.

## Workshop feed (/now/)

`GET /api/activity` (`functions/api/activity.js`, logic in `functions/_lib/activity-core.js`) reads
`https://api.github.com/users/dgreen52/events/public` and answers
`{ok, stale, fetched_at, items: [{repo, type, message, url, date}]}` (max 8, newest first):

- `push` (one per push; the head commit's first line, max 90 characters, with trailers such as
  `Co-Authored-By` / `Signed-off-by`, tool footers and email addresses removed; GitHub no longer sends
  commit messages in push events, so each is looked up once per SHA with the small git-data endpoint),
  `create` (a new repository only) and `release` (published). Only repos owned by `dgreen52`; links are
  always `https://github.com/...`; nothing else from GitHub is passed on.
- Caching: one stored copy in `caches.default` plus isolate memory, refreshed at most every 30 minutes
  with an ETag. If GitHub errors, times out or rate-limits (60/hour per egress IP when anonymous), the
  last good copy is served with `stale: true` and GitHub isn't asked again for 5 minutes (or until its
  rate-limit reset, at most 30). Never fetched and GitHub down: `503 {ok: false}`.
- **Optional `GITHUB_TOKEN`** raises the limit to 5,000/hour. It only reads public data, so a
  fine-grained token with no repository access and no permissions is enough:
  `npx wrangler pages secret put GITHUB_TOKEN --project-name dillongreen`. Without it, it works the same.
- The page (`assets/js/activity.js`) shows 6 rows in a box that reserves its height, `textContent`
  only, links re-checked as `https://github.com`; zero items shows a "quiet week" note, and when the
  feed can't be reached it shows the last copy this browser saw (localStorage), or an offline note.

## Verify before deploying

Run the site the way Pages will, with the Functions, `_headers` (so the CSP is enforced) and a
**local** D1 database:

```
npx wrangler d1 execute dillongreen-db --local --file db/schema.sql   # once; local only
npx wrangler d1 migrations apply dillongreen-db --local                 # local only
npx wrangler pages dev site --port 8788 --binding IP_SALT=local-test-salt   # in one terminal (the forms refuse posts without IP_SALT)
node tools/verify.js http://127.0.0.1:8788/              # full-page screenshots of every page (incl. 404) at 1440/430/390/360, night+daylight; broken images, 404s, JS/CSP errors; then zero sideways scroll at 320/360/375/390/414/430 in Chromium AND WebKit (iPhone), measured with the overflow-x guard off, listing any element that pokes out
node tools/test-webkit.js http://127.0.0.1:8788/        # iPhone 13 in WebKit: overflow, no boot overlay, no tilt/hover effects or header blur on touch, menu, More, rails, filters; scroll frames in verify/wk-home-*.png
node tools/test-cls.js http://127.0.0.1:8788/           # layout shift on a throttled phone (4x CPU, slow 4G, scroll to bottom), budget 0.05; SLOWFONT=1500 delays the fonts too
node tools/test-mobile.js http://127.0.0.1:8788/         # phones (touch emulation) at 320/360/390/430: no sideways scroll, text >= 12px, inputs >= 16px, tap targets >= 44px, AA contrast; menu sheet, "More" buttons, card rails, bit-flipper; verify/m-*.png
python tools/montage.py verify/index-390-dark.png         # lay a tall screenshot out as side-by-side columns to see the whole page at once
node tools/test-interactions.js http://127.0.0.1:8788/   # bit-flipper, keyboard, theme toggle
node tools/test-fun.js http://127.0.0.1:8788/            # boot, terminal, Konami intrusion, rain, reduced-motion fallbacks
node tools/test-forms.js http://127.0.0.1:8788/          # guestbook/waitlist API + UI, rate limit, honeypot, XSS as text, countries + flags, new terminal commands, pocket429 links
node tools/test-arcade.js http://127.0.0.1:8788/         # arcade: click-to-load, iframe sandbox/allow/referrer, one game at a time, fullscreen, phones open a tab, no-JS (games stubbed)
python tools/check_links.py                              # local links/anchors on every page; no phone numbers, dollar amounts or old email
```

`test-forms.js` wipes the **local** guestbook and waitlist tables before it runs (it never passes
`--remote`). If `npx wrangler` can't run offline, point `WRANGLER` at a local copy, e.g.
`$env:WRANGLER = "node ..\<some-project>\node_modules\wrangler\bin\wrangler.js"`.
`python -m http.server 8787 --directory site` still works for the static pages alone.

WebKit is a one-time, local-only browser download for the borrowed Playwright:
`node ../pocket429/node_modules/playwright/cli.js install webkit`.

## Look

Night (dark) is the default palette: near-black, neon cyan, hot magenta and a little amber, after
the Smart Mirror's cyberpunk theme. Daylight is the header toggle's other state, with the same
accents darkened to pass AA. The look is static on purpose (colour, mono HUD labels, thin borders,
corner brackets, a faint grid); glitch, tilt and the cursor grid only run with a mouse or trackpad
and never under reduced motion, and the boot screen never shows on touch devices.

## Phones

Below 720px the layout is tuned in one block at the end of `site.css`, so desktop rules stay as
they are. The header keeps the terminal and theme buttons and adds a menu button (below 1024px)
that opens a `<dialog>` sheet built by `site.js` (links, resume, email; Esc, close button,
backdrop or a link closes it). On the home page, long project copy, tags and older experience
bullets sit behind "More" buttons (`.more-btn` + `.m-extra`, phones only; with JS off everything
shows), and the "More things", "How I work" and "Side experiments" cards become sideways
scroll-snap rails (`.rail`). The ARINC 429 word runs edge to edge as 4 rows of 8 bits.
`viewport-fit=cover` is on every page and fixed/sticky parts pad for `env(safe-area-inset-*)`.

## The fun layer (`assets/js/fun.js`)

- **Boot/POST sequence**: once per browser session, about 1.5 s, skipped by any key, click,
  touch or scroll. Never shown under `prefers-reduced-motion`, to automation, or when the URL
  has a #fragment. Add `?boot` to the URL to see it again.
- **Terminal**: press `` ` `` or `/`, or click the `>_` button in the header. Try `help`,
  `whoami`, `decode 6445C0C1`, `projects`, `now`, `arcade`, `open mirror`, `pocket429` (opens the live web app in a
  new tab), `studio`, `waitlist`, `guestbook`, `play butter`, `play airfield`, `fly`, `theme`. It works on every page; section jumps fall back to the home page.
- **Easter eggs**: the Konami code (↑↑↓↓←→←→BA) or typing `netrunner` runs a MIRROR-OS-style
  intrusion with katakana rain (`?intrusion` in the URL triggers it too); typing `rain` starts
  katakana rain. Under reduced motion the intrusion is a static toast and nothing animates.
- **Motion**: an ambient grid lights up under the cursor on every page (one fixed layer behind the
  content, moved by transform in a rAF; off on touch, under reduced motion and in hidden tabs),
  cards tilt and glow, project names glitch on hover. All pointer effects are limited to fine
  pointers and turn off under reduced motion.

## Writing (unpublished)

The writing section is off the site. The posts live in `drafts/writing/` (next to `site/`, so
they are never deployed) until they're rewritten; `site/_redirects` sends `/writing` and
`/writing/*` to the home page with a 301 so old shared links don't 404. To bring a post back:
move its folder to `site/writing/<slug>/`, re-add the header/footer/menu links, the sitemap entry
and a `PAGES` entry in `tools/render_og.js`, drop the matching `_redirects` rule, and add the page
to the test page lists (`verify.js`, `test-mobile.js`, `test-webkit.js`, `test-cls.js`).
`check_links.py` fails if a public page is missing from the sitemap. The ARINC 429 draft reuses
the hero's bit-flipper markup; `site.js` drives any `[data-bits]` word on a page, and
`[data-load-word="HEX"]` buttons load preset words into it.

## Live status

`GET /api/status` (`functions/api/status.js`, logic in `functions/_lib/status-core.js`) checks every
project with a live URL and answers
`{checked_at, up, total, nodes: [{slug, name, status, ms, url}]}`.

- Node list: `functions/_lib/projects-live.json`, written by `python tools/build_projects.py` from
  `tools/projects.json` (slug, name, url, kind, and `service` for Workers-hosted ones). Not served
  as a static file.
- Each node gets one GET (redirects not followed) with a 4 s budget, all in parallel:
  **up** = 2xx/3xx under 1.5 s, **slow** = 2xx/3xx at 1.5 s or more, **down** = error, timeout,
  4xx or 5xx. `up` in the JSON counts nodes that answered (up + slow), which is the widget's
  "N/11 NODES ONLINE".
- Workers-hosted projects are fetched through **service bindings** (`SVC_<SERVICE>` in
  `wrangler.toml`), because a Pages Function fetching another Worker on the same account's
  workers.dev can be refused (error 1042). Without a binding (local dev) it falls back to `fetch()`.
  When you add a Workers project: add its `[[services]]` block (binding = `SVC_` + upper-cased
  service name with `-` -> `_`), run `build_projects.py`, redeploy.
- pocket429 and Linework are checked at their Pages origins (`https://pocket429.pages.dev/`,
  `https://linework-c4u.pages.dev/`) instead of their same-zone custom domains (`CHECK_URL` in
  `status-core.js`); the widget still links to the public URLs.
- Caching: one shared result for 60 s (`caches.default`, synthetic key `/__status-cache/v1`, plus
  per-isolate memory; concurrent cold requests share one round of checks). Browsers get
  `Cache-Control: public, max-age=30`. The endpoint reads nothing from the request.

Widget: `site/assets/css/status.css` + `site/assets/js/status.js`. Put
`<div data-status-panel></div>` anywhere (don't give it padding; it reserves its own height: 5 rows
of 2 below 480px, 3 rows of 3 above; override with `--ns-cols` / `--ns-rows` on the element), add
the stylesheet in `<head>` and `<script src="/assets/js/status.js" defer>`. Any element with
`data-status-slug="<slug>"` (the projects.json slug, or the workers.dev name, e.g. `airfield` or
`little-airfield`) gets `data-state="up|slow|down"`; an empty one also gets a dot and
screen-reader text. It fetches once the page is idle, refreshes every 60 s only while the tab is
visible, shows "status unavailable" on errors, and fires a `dg:status` event on `document`.

## Email alerts

New guestbook signatures and studio waitlist entries email the owner. Pages Functions can't use the
`send_email` binding, so a tiny Worker does it: `workers/notify/` (**dg-notify**, no npm deps,
`workers_dev = false`, no routes; only reachable through the Pages project's `NOTIFY` service
binding, and every call must carry `X-Notify-Key`). The guestbook/waitlist handlers call it with
`waitUntil` after a successful insert (`functions/_lib/notify.js`): fire-and-forget, never changes
the visitor's reply, skipped silently if `NOTIFY` or `NOTIFY_KEY` is missing. The ip_hash is never
sent. Waitlist alerts include email, role, org size, notify flag and workflow text, and set
`Reply-To` to the person's address so you can just hit reply.

Mail is plain text, built by hand (`workers/notify/lib.js`): From `"dillongreen.dev"
<notify@dillongreen.dev>`, To = the `NOTIFY_TO` secret, subjects `[guestbook] New signature from
<name>` / `[studio] New waitlist entry (<role>)`, a link to https://dillongreen.dev/admin/, and
Date, Message-ID, MIME-Version, `text/plain; charset=utf-8`, 8bit. CR/LF and control characters
are stripped from anything that lands in a header, lengths are capped, non-ASCII subjects are
RFC 2047 encoded. Everything the visitor typed sits below a `--- visitor-supplied text below (not
from dillongreen.dev) ---` line, and links in it are defanged (`hxxps://example[.]com`) so a
message dressed up as a system notice can't hand you a clickable phishing link.

One-time setup (from this folder, in this order):

1. Email Routing must be on for dillongreen.dev and the address you want alerts at must be a
   **verified destination**: dashboard -> dillongreen.dev -> Email -> Email Routing -> Destination
   addresses (status "Verified"). Add and verify it there if it isn't.
2. Deploy the Worker and set its two secrets (each command prompts for the value):
   ```
   cd workers/notify
   npx wrangler deploy
   npx wrangler secret put NOTIFY_TO      # the verified destination address from step 1
   npx wrangler secret put NOTIFY_KEY     # a long random string, e.g. node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
   cd ../..
   ```
3. Give the Pages project the same key:
   ```
   npx wrangler pages secret put NOTIFY_KEY --project-name dillongreen
   ```
4. Redeploy the Pages site (see "Deploy"). The `NOTIFY` binding in `wrangler.toml` points at
   `dg-notify`, so deploy the Worker **before** the site.

Test locally without sending anything: `cd workers/notify && npx wrangler dev --port 8792 --var
NOTIFY_KEY:local-test-key --var NOTIFY_TO:owner@example.com`, then in another terminal
`npx wrangler pages dev site --port 8791 --binding NOTIFY_KEY=local-test-key --binding IP_SALT=local-test-salt` and sign the
guestbook; wrangler writes the would-be email to a `.eml` file under `workers/notify/.wrangler/`
(gitignored; delete it afterwards).

## Admin (Cloudflare Access)

`/admin/` is a phone-first moderation console (pending guestbook entries: approve / delete;
approved: delete; waitlist: email + reply link, role, org size, notify flag, workflow text,
delete). Approve is instant; delete removes the card at once and is sent after a 4 s Undo window.
All user text is rendered with `textContent`. The page is `noindex, nofollow` (meta tag and
`X-Robots-Tag` from `_headers`); `robots.txt` disallows `/api/` but deliberately doesn't list
`/admin/`.

The API is `functions/api/admin/[[path]].js` (logic in `functions/_lib/admin-core.js`):
`GET /api/admin/pending|approved|waitlist`, `POST /api/admin/approve|delete-guestbook|delete-waitlist`
with `{"id": <positive integer>}`. It only answers on `dillongreen.dev` and `www.dillongreen.dev`
(`ADMIN_HOSTS`), where Access sits in front; on `dillongreen.pages.dev`, preview and
per-deployment URLs it's a 404. Every request must carry a valid Cloudflare Access JWT
(`Cf-Access-Jwt-Assertion`), verified in the Function itself (`functions/_lib/access.js`): RS256
against `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (keys cached ~1 h), `aud` must include
`ACCESS_AUD`, `iss` must be `https://<ACCESS_TEAM_DOMAIN>`, `exp`/`nbf` checked, the token must
carry an email, and that email must be in `ADMIN_EMAILS`. **Fail closed:** if `ACCESS_AUD`,
`ACCESS_TEAM_DOMAIN` or `ADMIN_EMAILS` is unset, or anything doesn't verify, the answer is 403.
POSTs also need a same-origin `Origin` header, a JSON content type and a body under 1 KB. SQL is
parameterized. `tools/guestbook.ps1` keeps working as a fallback.

One-time setup:

1. Cloudflare dashboard -> **Zero Trust**. First time: choose a team name (the Free plan is
   enough). Your team domain is `<team>.cloudflareaccess.com` (Settings -> Custom pages).
2. Access -> Applications -> **Add an application** -> **Self-hosted**. Name: `dillongreen admin`.
   Application domains (domain + path):
   - `dillongreen.dev` / `admin`
   - `dillongreen.dev` / `api/admin`
   - `www.dillongreen.dev` / `admin` and `www.dillongreen.dev` / `api/admin` (if www is attached)
3. Policy: Action **Allow**, Include -> **Emails** -> your own address. Save the application.
4. Open the application again and copy its **Application Audience (AUD) Tag** (Overview / Basic
   information).
5. Put the team domain in `wrangler.toml` `[vars]` as `ACCESS_TEAM_DOMAIN` (it's public: it's the
   login page host), then set the Pages secrets (each command prompts for the value):
   ```
   npx wrangler pages secret put ACCESS_AUD --project-name dillongreen          # the AUD tag from step 4
   npx wrangler pages secret put ADMIN_EMAILS --project-name dillongreen        # REQUIRED: your address (comma-separate several)
   ```
6. Redeploy the Pages site (see "Deploy"). Open https://dillongreen.dev/admin/: Access asks for
   your email and a one-time code, then the console loads. Without the secrets the page still
   loads but every list says "locked".

`DEV_ADMIN_BYPASS` is for local testing only and must never be set in `wrangler.toml` or as a
Pages variable/secret. It needs both `DEV_ADMIN_BYPASS=1` and a request to 127.0.0.1/localhost:

```
npx wrangler d1 execute dillongreen-db --local --file db/schema.sql
npx wrangler pages dev site --port 8791 --binding DEV_ADMIN_BYPASS=1 --binding IP_SALT=local-test-salt
node tools/test-admin.js http://127.0.0.1:8791/        # seeds the LOCAL db through the form APIs, drives the UI; verify/admin-*.png
node tools/test-status-ui.js http://127.0.0.1:8791/    # status widget with a mocked /api/status and the real CSP; verify/status-*.png
```

Unit tests (no server, no network): `node tools/test-status.js`, `node tools/test-notify.js`,
`node tools/test-access.js` (Access JWT with a locally generated RSA key and a mocked certs
endpoint, plus the admin API rules against a mock D1), `node tools/test-activity.js` (the GitHub
reducer and the feed's caching with a mocked fetch, clock and Cache API). `node tools/test-migrations.js`
runs `db/migrations` against throwaway local D1 databases (`--persist-to`, deleted afterwards).
