# pdf120

[![CI](https://github.com/dmicz/pdf120/actions/workflows/ci.yml/badge.svg)](https://github.com/dmicz/pdf120/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/dmicz/pdf120?sort=semver)](https://github.com/dmicz/pdf120/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**A Chrome PDF viewer built for buttery 120Hz scrolling.**

pdf120 replaces Chrome's built-in PDF viewer. All page rendering happens in Web Workers on `OffscreenCanvas`, and pages are displayed as pre-rendered bitmaps inside a natively scrolling, virtualized view. The main thread never rasterizes a PDF.

## Features

- **Smooth scrolling.** Scrolling is Chrome's native compositor scrolling. The main thread only does a binary search and the occasional DOM append.
- **Parallel, prioritized rendering.** Several workers render pages: visible first, then pages ahead in your scroll direction, then pages behind. Renders that are no longer needed are cancelled.
- **Sharp at any zoom, even while panning.** Pages render at `devicePixelRatio`. Above about 2× zoom, the page is covered with full-resolution 512px tiles that render while you pan; each tile draws only the operations that touch it.
- **Instant pinch zoom.** Trackpad pinch and ⌃scroll scale the existing bitmaps with CSS while you zoom, then re-render sharply once the gesture settles.
- **Text selection, links and ⌘F search.** Text layers are built lazily, and search matches are highlighted with the CSS Custom Highlight API.
- **Dark mode.** The UI theme follows your system or can be set manually. Page colors can also be inverted, and the inversion is baked into the bitmaps so scrolling costs nothing extra.
- **Thumbnails, remembered position, shortcuts.** There's a thumbnail sidebar, the last page and zoom are remembered for every file, and there are keyboard shortcuts for everything.
- **FPS overlay and benchmark.** A frame-time overlay and a built-in scroll benchmark let you check that it holds 120fps.
- **Works everywhere PDFs open.** It handles `http(s)` links, PDFs served from URLs without a `.pdf` extension, and local `file://` PDFs.

## Install

**From a release:** download `pdf120-vX.Y.Z.zip` from [Releases](https://github.com/dmicz/pdf120/releases/latest) and unzip it.

**From source:**

```sh
git clone https://github.com/dmicz/pdf120 && cd pdf120
npm ci && npm run build      # outputs dist/
```

Then load it into Chrome (version 120 or later):

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the unzipped folder (or `dist/` if you built from source).
3. To open local files, click **Details** and turn on **Allow access to file URLs**.

Open any PDF. To read a file from disk, click the toolbar icon and drop the file onto the page.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| <kbd>J</kbd> / <kbd>K</kbd>, <kbd>N</kbd> / <kbd>P</kbd>, <kbd>←</kbd> / <kbd>→</kbd> | Next / previous page |
| <kbd>Space</kbd>, arrows, <kbd>PgUp</kbd> / <kbd>PgDn</kbd> | Scroll |
| <kbd>Home</kbd> / <kbd>End</kbd> | First / last page |
| <kbd>G</kbd> | Go to page |
| <kbd>⌘F</kbd>, <kbd>⌘G</kbd> / <kbd>⇧⌘G</kbd> | Find, next / previous match |
| <kbd>⌘=</kbd> / <kbd>⌘−</kbd> / <kbd>⌘0</kbd> | Zoom in / out / automatic |
| <kbd>W</kbd> / <kbd>F</kbd> | Fit width / fit page |
| <kbd>T</kbd> | Thumbnail sidebar |
| <kbd>I</kbd> | Invert page colors |
| <kbd>D</kbd> | Theme: system → light → dark |
| <kbd>⇧D</kbd> / <kbd>⇧B</kbd> | FPS overlay / scroll benchmark |
| <kbd>⌘S</kbd> | Download |
| <kbd>⌘P</kbd> | Print (hands off to Chrome's viewer) |
| <kbd>?</kbd> | Show all shortcuts |

On Windows and Linux, use <kbd>Ctrl</kbd> wherever this table says <kbd>⌘</kbd>.

## Checking 120fps

Press <kbd>⇧D</kbd> to open the overlay. It shows:

- a live frame-time graph against the refresh budget
- the detected refresh rate, p99 and worst frame times, and dropped frames
- the Long Animation Frame count
- cache size and render queue stats

Press <kbd>⇧B</kbd> to scroll through the document at constant speed for 6 seconds and report the percentage of frames that were on time.

The overlay measures main-thread frames, which is the stricter test: native scrolling runs on the compositor and can stay smooth even if the main thread stutters. For the compositor's own numbers, use DevTools → Rendering → **Frame Rendering Stats**. On a MacBook, 120Hz requires a ProMotion display, and Low Power Mode must be off.

## How it works

```
main thread                               render workers (2–3)        pdf.js parsers
───────────                               ────────────────────        ──────────────
#viewport  (native overflow scroll)       pdf.js + OffscreenCanvas    one nested worker
 └ sizer   (full document height)  jobs → page.render()          ↔    per render worker
    └ .page × N   placeholder divs     ←  ImageBitmap (transferred)
       ├ <canvas> bitmaprenderer   only for pages near the viewport
       ├ <canvas> × tiles  full-res 512px tiles at high zoom
       └ .textLayer               built lazily when scrolling pauses
```

| Piece | Where | Notes |
| --- | --- | --- |
| Interception | [`background.js`](src/background.js), [`content.js`](src/content.js) | A `declarativeNetRequest` rule redirects `*.pdf` navigations before they download. A `document_start` content script catches any document whose `contentType` is `application/pdf`, including `file://`. "Open in Chrome's viewer" sets a per-tab bypass. |
| Rendering | [`render-worker.js`](src/worker/render-worker.js) | pdf.js runs in a worker with OffscreenCanvas factories, and fonts load into the worker's `FontFaceSet`. Finished pages go to the main thread through `transferToImageBitmap()`. |
| Scheduling | [`pool.js`](src/viewer/pool.js) | Pull-based. The pool asks the viewer for a priority-ordered wish list, cancels stale in-flight renders, and gives the top of the list to idle workers. |
| Layout & zoom | [`viewer.js`](src/viewer/viewer.js) | Page boxes snap to device pixels so bitmaps map 1:1. Pinch only changes `transform: scale()` until the gesture settles; then the layout is updated around the pointer. |
| High-zoom tiles | [`viewer.js`](src/viewer/viewer.js), [`render-worker.js`](src/worker/render-worker.js) | A whole-page bitmap is capped at 16 MP and shown stretched as a fallback. Above the cap, 512px tiles cover the viewport plus a prefetch ring half a viewport deep. Visible tiles render first, nearest the center. Tiles leaving the ring are cancelled, and cached tiles make panning back instant. Each worker records a bounding box for every PDF drawing operation once, with a cheap low-res pass. Each tile then draws only the operations that touch it, which on a 78k-operation map takes a tile from about 16ms to about 1ms. |
| Cache | [`cache.js`](src/viewer/cache.js) | LRU, capped at 1.5 GB. Each entry is a `bitmaprenderer` canvas that took ownership of its ImageBitmap without a copy, so remounting a page is just a DOM append. |
| Text & search | [`textlayer.js`](src/viewer/textlayer.js), [`find.js`](src/viewer/find.js) | Transparent spans are built in idle-time chunks and placed with a single transform per page. Search runs across pages in batches. |

## Development

```sh
npm run watch    # rebuild on change (then reload the extension)
npm test         # headless-Chrome smoke test (needs a prior build)
npm run serve    # http://localhost:8120/viewer.html?file=/sample.pdf
npm run zip      # package dist/ as pdf120-v<version>.zip
node test/pan.mjs map.pdf [zoom] [px/s] [x] [y]   # panning benchmark for big pages
```

The smoke test generates a 60-page PDF and runs the viewer as a plain page. It checks:

- rendering at devicePixelRatio and virtualization
- text-layer alignment, search and highlights
- zoom and pinch, plus high-zoom tiles staying sharp while panning
- color inversion, thumbnails and internal links
- the cache cap, the remembered position, and console errors

Set `CHROME_PATH` to use a different browser binary. The interception paths only run inside the installed extension, so they aren't covered by this test.

In the viewer, `window.pdf120` exposes the viewer and the render pool for poking at from DevTools.

**Releasing:** bump `version` in `package.json` and commit. Then tag and push:

```sh
git tag v0.2.0 && git push --tags
```

CI builds and tests the tag, then publishes a GitHub release with the zip attached.

## Limitations

- **Not supported:** forms, printing, page rotation and the document outline. "Open in Chrome's viewer" (also <kbd>⌘P</kbd>) covers forms and printing.
- **Missing PDF effects.** Transfer functions and high-contrast-mode filters need SVG filters, which workers don't have, so they're skipped.
- **POST-only PDFs.** PDFs that came from a POST request are fetched again with GET, which may fail.
- **Memory.** Each render worker parses the document on its own, so memory use grows with the pool size.

## License

[Apache-2.0](LICENSE). PDF rendering is powered by [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0).
