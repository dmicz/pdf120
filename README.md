# pdf120

A Chrome MV3 extension that replaces Chrome's PDF viewer. It is built for smooth 120Hz scrolling on Retina MacBooks: the main thread never rasterizes PDF content, and scrolling is fully native.

## Install

```sh
npm install
npm run build        # outputs dist/
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `dist/`.
2. For local files, open the extension's **Details** and turn on **Allow access to file URLs**.
3. Open any PDF link. Clicking the toolbar icon opens an empty viewer where you can drop a file.

`npm run watch` rebuilds when files change. After a rebuild, reload the extension.

## Architecture

```
 main thread (viewer.html)              render workers (×2–3)            pdf.js parser workers
 ─────────────────────────              ───────────────────────          ─────────────────────
 native-scrolling #viewport             pdf.js display API               pdf.worker.min.mjs
  └ sizer (full doc size)      jobs →   OffscreenCanvas 2D        ↔      (one nested per render worker)
     └ .pages                           page.render()
        └ .page × N placeholders  ← ImageBitmap (transferred, zero-copy)
           └ <canvas bitmaprenderer>  (only pages near viewport)
           └ .textLayer (lazy)
```

- **Rendering off the main thread.** Each render worker runs pdf.js with an `OffscreenCanvas`. Fonts load into the worker's own `FontFaceSet` (`ownerDocument: self`), and pdf.js gets OffscreenCanvas/no-op filter factories. A finished page is sent back with `transferToImageBitmap()`. The main thread adopts it with `bitmaprenderer.transferFromImageBitmap()`, which takes the bitmap without copying it or drawing it again.
- **Virtualized native scrolling.** Every page has an absolutely positioned placeholder div of the right size (`contain: strict`), snapped to whole device pixels so bitmaps map 1:1. Only pages within about 1 viewport behind and 3 viewports ahead get their canvas mounted. A scroll event costs one binary search and, occasionally, a DOM append. Canvases sit on their own compositor layers, so scrolling moves textures and never re-rasters.
- **Render queue** (`src/viewer/pool.js`). Scheduling is pull-based. On any change, the pool asks the viewer for a priority-ordered wish list: visible pages (nearest the reading position first), then pages ahead in the scroll direction, then pages behind, then sidebar thumbnails. In-flight renders that drop off the list are cancelled (`RenderTask.cancel()`), and idle workers take the head of the list. Each worker runs one job at a time, so a cancel always frees capacity for the most important page.
- **Pinch / ctrl+wheel zoom.** During the gesture only `transform: scale()` changes on the pages layer, with the transform origin at the pointer. There's no layout and no rendering, and scheduling is paused. About 180ms after the last event, the zoom is committed: relayout, re-anchor the scroll position under the pointer, and request crisp renders. The old bitmaps stay up, stretched, until the new ones replace them.
- **LRU cache** (`src/viewer/cache.js`), capped at 1.5GB (width × height × 4 bytes per entry). Mounted pages are never evicted. Thumbnails share the same budget.
- **Lazy text layer.** Text is extracted only once scrolling pauses, and only for visible pages. It's built in `requestIdleCallback` chunks as transparent spans, laid out in PDF points and placed on the page with one CSS transform, so zooming rewrites one style per page. Link annotations become clickable areas: internal destinations scroll, external URLs open.
- **Search** (Cmd+F) extracts text page by page in batches across the workers, yielding between batches. Matches are highlighted with the CSS Custom Highlight API, so they add no DOM.
- **Dark mode.** The UI follows the system or a manual theme (D). Inverted page colors (I) are baked into the bitmap in the worker (`invert(0.92) hue-rotate(180deg)`), so the compositor never runs a filter while scrolling. Right after you toggle it, pages already on screen get a temporary CSS filter until their re-rendered bitmaps arrive.
- **Interception** (`src/background.js`, `src/content.js`):
  1. A `declarativeNetRequest` rule redirects top-level `http(s)` navigations whose path ends in `.pdf` to `viewer.html#<original URL>`, before any bytes download.
  2. A `document_start` content script reports any top-level document whose `document.contentType` is `application/pdf`. This covers PDFs on URLs without a `.pdf` extension and `file://` URLs.
  3. The "Open in Chrome's viewer" button and ⌘P set a per-tab bypass (a session DNR allow rule plus a flag) and go back to the original URL.
- **Remembered position.** The page, offset within the page and zoom are stored per URL in `chrome.storage.local` (last 1000 files). A `#page=N` fragment takes precedence.

## Verifying 120fps

Press **Shift+D** (or click the graph icon) to open the FPS overlay. It shows:

- a frame-time graph with a line at the refresh budget (green = on time, yellow = slow, red = missed vsync)
- the detected display Hz, p99 and worst frame times, dropped frames and Long Animation Frame count
- cache size, mounted pages, and running/queued/cancelled renders with the average render time

**Bench** (Shift+B) scrolls the document at 2400 px/s for 6 seconds, driven from `requestAnimationFrame`. It reports fps and the percentage of frames that were on time.

The overlay measures main-thread frames. Native trackpad scrolling runs on the compositor and can stay smooth even when the main thread hiccups, so the overlay is the stricter measure. For the compositor's own numbers, use DevTools → Rendering → **Frame Rendering Stats**. On macOS, Chrome only runs at 120Hz on ProMotion displays, and only when Low Power Mode is off.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| J/K, N/P, ←/→ | Next / previous page |
| Space, arrows, PgUp/PgDn | Native scroll |
| Home / End | First / last page |
| G | Go to page |
| ⌘F, ⌘G / ⇧⌘G, Enter / ⇧Enter | Find, next / previous |
| ⌘= / ⌘− / ⌘0 | Zoom in / out / automatic |
| W / F | Fit width / fit page |
| T | Thumbnails |
| I | Invert page colors |
| D | Theme: system → light → dark |
| ⇧D / ⇧B | FPS overlay / scroll benchmark |
| ⌘S | Download |
| ⌘P | Print (via Chrome's viewer) |
| ? | Help |

## Testing

```sh
npm run build && npm test
```

`test/smoke.mjs` uses headless Chrome (`CHROME_PATH` overrides the default macOS path). It generates a 60-page fixture, serves `dist/` as a plain page (storage falls back to `localStorage` outside the extension) and checks:

- rendering at devicePixelRatio and virtualization
- text-layer alignment, search and highlights
- crisp re-render after zoom, and pinch transform followed by commit
- baked inversion, thumbnails and internal links
- cache accounting, the remembered page, and no console errors

`npm run serve` serves the same setup at `http://localhost:8120/viewer.html?file=/sample.pdf` for manual poking. `window.pdf120` exposes the viewer and pool.

The interception paths (DNR, content script, file://) need the real extension loaded and aren't covered by the automated test.

## Limitations / next steps

- **Very high zoom.** A page bitmap is capped at 32 MP (about 3× zoom on a Letter page at 2× DPR). Beyond that, bitmaps are upscaled. Tiled rendering of just the visible region would fix this.
- **Not supported:** forms, printing, rotation and the outline sidebar. Use "Open in Chrome's viewer" (which also handles ⌘P) for the first two.
- **Transfer functions and HCM filters.** pdf.js implements these with SVG filters, which are unavailable in workers, so they're skipped.
- **Re-fetching.** PDFs reached via POST, or links that force a download, are fetched again with GET. This can fail on sites that require the original request.
- **Bypass scope.** After "Open in Chrome's viewer", the bypass lasts for the rest of that tab's life.
- **Memory.** Each render worker parses the document separately, so memory scales with the pool size (2 workers, or 3 on machines with 8+ cores).
