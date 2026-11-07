// The page view: a natively scrolling container with one absolutely
// positioned placeholder div per page. Only pages near the viewport are
// "mounted" (given their cached canvas and text layer); everything else is an
// empty, size-contained box, so scroll work on the main thread is a binary
// search and a few DOM appends.
//
// Scroll performance notes:
// - Scrolling is fully native (compositor-driven). The only non-passive
//   listener is the wheel handler, which returns immediately unless ctrlKey
//   is set (pinch / ctrl+wheel), and the main thread is kept idle so that
//   handler is never delayed.
// - Page canvases are bitmaprenderer canvases promoted to their own layers,
//   so the compositor just moves textures; nothing is re-rastered on scroll.
// - Dark mode is baked into bitmaps in the worker, not applied as a filter.
import { BitmapCache } from "./cache.js";
import { PT_TO_CSS } from "../shared.js";
import { buildTextLayer, placeTextLayer } from "./textlayer.js";

const GAP = 10;
const PAD = 12;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;
const AUTO_MAX = 1.5;
// Above this, bitmaps are rendered smaller and upscaled (keeps a single page
// under ~128MB). Tiled rendering would lift this; see README.
const MAX_BITMAP_PIXELS = 32e6;
const MAX_BITMAP_SIDE = 16384;
const SETTLE_MS = 180; // pinch idle time before the crisp re-render
const TEXT_IDLE_MS = 120; // scroll idle time before building text layers
const AHEAD_VIEWPORTS = 3;
const BEHIND_VIEWPORTS = 1;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pageKey = (p) => `p${p}`;

export class Viewer extends EventTarget {
  constructor(scroller) {
    super();
    this.scroller = scroller;
    this.sizer = document.createElement("div");
    this.sizer.className = "sizer";
    this.layer = document.createElement("div");
    this.layer.className = "pages";
    this.sizer.append(this.layer);
    scroller.append(this.sizer);

    this.cache = new BitmapCache();
    this.pool = null; // set by main.js
    this.thumbs = null; // set by the sidebar
    this.n = 0;
    this.zoom = 1;
    this.fitMode = "auto";
    this.dpr = devicePixelRatio;
    this.invert = false;
    this.mounted = new Map(); // page index -> {div, entry, text, cancelText}
    this.divs = [];
    this.texts = new Map(); // page index -> Promise<text payload>
    this.textData = new Map(); // page index -> resolved text payload
    this.vis = [0, -1];
    this.range = [0, -1];
    this.dir = 1;
    this.lastScrollTop = 0;
    this.current = 0;
    this.gesture = null;
    this.viewW = scroller.clientWidth;
    this.viewH = scroller.clientHeight;

    scroller.addEventListener("scroll", () => this.#onScroll(), { passive: true });
    scroller.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
    new ResizeObserver(() => this.#onResize()).observe(scroller);
    this.#watchDpr();
  }

  // ---- document setup ------------------------------------------------------

  init(numPages, [w, h]) {
    this.n = numPages;
    this.ptW = new Float64Array(numPages).fill(w);
    this.ptH = new Float64Array(numPages).fill(h);
    this.w = new Float64Array(numPages);
    this.h = new Float64Array(numPages);
    this.tops = new Float64Array(numPages);
    this.lefts = new Float64Array(numPages);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < numPages; i++) {
      const div = document.createElement("div");
      div.className = "page";
      div.dataset.page = i + 1;
      this.divs.push(div);
      frag.append(div);
    }
    this.layer.append(frag);
    this.zoom = this.#fitZoom(this.fitMode, 0);
    this.#relayout();
  }

  // Real page sizes arrive from the worker after first paint (page 1's size
  // is used as an estimate until then). Re-layout without moving the reader.
  setSizes(sizes) {
    let changed = false;
    for (let i = 0; i < this.n; i++) {
      if (this.ptW[i] !== sizes[i * 2] || this.ptH[i] !== sizes[i * 2 + 1]) changed = true;
      this.ptW[i] = sizes[i * 2];
      this.ptH[i] = sizes[i * 2 + 1];
    }
    if (!changed) return;
    const anchor = this.#anchorAt(0, 0);
    if (this.fitMode) this.zoom = this.#fitZoom(this.fitMode, anchor.p);
    this.#relayout();
    this.#restoreAnchor(anchor, 0, 0);
    this.update();
    this.dispatchEvent(new Event("layout"));
  }

  // ---- layout --------------------------------------------------------------

  #relayout() {
    const k = this.zoom * PT_TO_CSS;
    const d = this.dpr;
    let y = PAD;
    let maxW = 0;
    for (let i = 0; i < this.n; i++) {
      // Snap page boxes to whole device pixels so bitmaps map 1:1.
      const w = Math.max(1, Math.round(this.ptW[i] * k * d)) / d;
      const h = Math.max(1, Math.round(this.ptH[i] * k * d)) / d;
      this.w[i] = w;
      this.h[i] = h;
      this.tops[i] = y;
      y += h + GAP;
      if (w > maxW) maxW = w;
    }
    this.contentH = y - GAP + PAD;
    this.contentW = Math.max(this.viewW, maxW + 2 * PAD);
    for (let i = 0; i < this.n; i++) {
      this.lefts[i] = Math.round(((this.contentW - this.w[i]) / 2) * d) / d;
      this.divs[i].style.cssText = `top:${this.tops[i]}px;left:${this.lefts[i]}px;width:${this.w[i]}px;height:${this.h[i]}px`;
    }
    this.sizer.style.width = `${this.contentW}px`;
    this.sizer.style.height = `${this.contentH}px`;
    for (const [p, m] of this.mounted) {
      if (m.text) placeTextLayer(m.text.el, this.ptW[p], this.ptH[p], this.w[p], this.h[p]);
    }
  }

  // Device-pixel size for a page's bitmap at the current zoom.
  targetSize(p) {
    let w = Math.round(this.w[p] * this.dpr);
    let h = Math.round(this.h[p] * this.dpr);
    const s = Math.min(1, Math.sqrt(MAX_BITMAP_PIXELS / (w * h)), MAX_BITMAP_SIDE / w, MAX_BITMAP_SIDE / h);
    if (s < 1) {
      w = Math.max(1, Math.floor(w * s));
      h = Math.max(1, Math.floor(h * s));
    }
    return { w, h };
  }

  pageAtY(y) {
    let lo = 0;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // Viewport in layout coordinates, undoing an in-progress pinch transform.
  #viewRect() {
    let top = this.scroller.scrollTop;
    let h = this.viewH;
    const g = this.gesture;
    if (g) {
      top = g.oy + (top - g.oy) / g.g;
      h /= g.g;
    }
    return { top, bottom: top + h, h };
  }

  // A reading position expressed relative to a page, so it survives relayout.
  #anchorAt(fx, fy) {
    let x = this.scroller.scrollLeft + fx;
    let y = this.scroller.scrollTop + fy;
    const g = this.gesture;
    if (g) {
      x = g.ox + (x - g.ox) / g.g;
      y = g.oy + (y - g.oy) / g.g;
    }
    const p = this.pageAtY(y);
    return { p, rx: (x - this.lefts[p]) / this.w[p], ry: (y - this.tops[p]) / this.h[p] };
  }

  #restoreAnchor(a, fx, fy) {
    this.scroller.scrollTop = this.tops[a.p] + a.ry * this.h[a.p] - fy;
    this.scroller.scrollLeft = this.lefts[a.p] + a.rx * this.w[a.p] - fx;
    this.lastScrollTop = this.scroller.scrollTop;
  }

  // ---- scrolling & virtualization -------------------------------------------

  #onScroll() {
    this.update();
  }

  update() {
    if (!this.n) return;
    const st = this.scroller.scrollTop;
    if (st !== this.lastScrollTop) {
      this.dir = st > this.lastScrollTop ? 1 : -1;
      this.lastScrollTop = st;
    }
    const { top, bottom, h } = this.#viewRect();
    const a = this.pageAtY(top);
    const b = this.pageAtY(bottom);
    const ahead = AHEAD_VIEWPORTS * h;
    const behind = BEHIND_VIEWPORTS * h;
    const ma = this.pageAtY(top - (this.dir > 0 ? behind : ahead));
    const mb = this.pageAtY(bottom + (this.dir > 0 ? ahead : behind));

    const changed = a !== this.vis[0] || b !== this.vis[1] || ma !== this.range[0] || mb !== this.range[1] || this.dir !== this.lastDir;
    this.vis = [a, b];
    this.range = [ma, mb];
    this.lastDir = this.dir;

    if (changed) {
      for (const p of [...this.mounted.keys()]) if (p < ma || p > mb) this.#unmount(p);
      for (let p = ma; p <= mb; p++) if (!this.mounted.has(p)) this.#mount(p);
      this.pool?.pump();
    }

    // Text layers wait until scrolling pauses.
    clearTimeout(this.textTimer);
    this.textTimer = setTimeout(() => this.#buildVisibleText(), TEXT_IDLE_MS);

    const cur = this.pageAtY(top + h * 0.4);
    if (cur !== this.current) {
      this.current = cur;
      this.dispatchEvent(new Event("pagechange"));
    }
  }

  #mount(p) {
    const m = { div: this.divs[p], entry: null, text: null, cancelText: null };
    this.mounted.set(p, m);
    const e = this.cache.touch(pageKey(p));
    if (e) this.#attach(p, m, e);
  }

  #unmount(p) {
    const m = this.mounted.get(p);
    m.entry?.canvas.remove();
    m.cancelText?.();
    m.text?.el.remove();
    this.mounted.delete(p);
  }

  #attach(p, m, e) {
    if (m.entry && m.entry !== e) m.entry.canvas.remove();
    m.entry = e;
    if (e.canvas.parentNode !== m.div) m.div.prepend(e.canvas);
    m.div.classList.toggle("inv-pending", e.invert !== this.invert);
  }

  // ---- render scheduling ----------------------------------------------------

  // Priority-ordered render wish list, pulled by the pool: visible pages
  // (closest to the reading position first), then pages ahead in the scroll
  // direction, then behind, then sidebar thumbnails. null pauses scheduling.
  wanted() {
    if (!this.n || this.gesture) return null;
    const jobs = [];
    const add = (p) => {
      const t = this.targetSize(p);
      const e = this.cache.get(pageKey(p));
      if (e && e.width === t.w && e.height === t.h && e.invert === this.invert) return;
      jobs.push({ key: pageKey(p), page: p + 1, width: t.w, height: t.h, invert: this.invert, kind: "page" });
    };
    const [a, b] = this.vis;
    const [ma, mb] = this.range;
    const visible = [];
    for (let p = a; p <= b; p++) visible.push(p);
    visible.sort((x, y) => Math.abs(x - this.current) - Math.abs(y - this.current));
    visible.forEach(add);
    if (this.dir > 0) {
      for (let p = b + 1; p <= mb; p++) add(p);
      for (let p = a - 1; p >= ma; p--) add(p);
    } else {
      for (let p = a - 1; p >= ma; p--) add(p);
      for (let p = b + 1; p <= mb; p++) add(p);
    }
    if (this.thumbs) jobs.push(...this.thumbs.wanted());
    return jobs;
  }

  onRendered(job, bitmap) {
    if (job.kind === "thumb") return this.thumbs?.onRendered(job, bitmap);
    const p = job.page - 1;
    const t = this.targetSize(p);
    const fits = (w, h, inv) => w === t.w && h === t.h && inv === this.invert;
    const existing = this.cache.get(job.key);
    if (existing && fits(existing.width, existing.height, existing.invert) && !fits(job.width, job.height, job.invert)) {
      bitmap.close(); // a better bitmap is already cached
      return;
    }
    const e = this.cache.put(job.key, bitmap, { page: p, invert: job.invert });
    const m = this.mounted.get(p);
    if (m) this.#attach(p, m, e);
    this.cache.evict(this.protectedKeys());
  }

  protectedKeys() {
    const keep = new Set();
    for (const p of this.mounted.keys()) keep.add(pageKey(p));
    if (this.thumbs) for (const k of this.thumbs.mountedKeys()) keep.add(k);
    return keep;
  }

  // ---- zoom ----------------------------------------------------------------

  #fitZoom(mode, p) {
    const availW = Math.max(50, this.viewW - 2 * PAD);
    const availH = Math.max(50, this.viewH - 2 * PAD);
    const widthZoom = availW / (this.ptW[p] * PT_TO_CSS);
    const pageZoom = Math.min(widthZoom, availH / (this.ptH[p] * PT_TO_CSS));
    const z = mode === "width" ? widthZoom : mode === "page" ? pageZoom : Math.min(widthZoom, AUTO_MAX);
    return clamp(z, MIN_ZOOM, MAX_ZOOM);
  }

  // Sets zoom keeping the content under (fx, fy) — viewport-relative CSS px —
  // fixed on screen. Existing bitmaps stretch until crisp ones arrive.
  setZoom(z, fx = this.viewW / 2, fy = this.viewH / 2, mode = null) {
    if (!this.n) return;
    const anchor = this.#anchorAt(fx, fy);
    this.#endGestureTransform();
    this.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
    this.fitMode = mode;
    this.#relayout();
    this.#restoreAnchor(anchor, fx, fy);
    this.vis = [0, -1]; // force a remount/pump
    this.update();
    this.dispatchEvent(new Event("zoomchange"));
  }

  fit(mode) {
    if (!this.n) return;
    this.setZoom(this.#fitZoom(mode, this.current), this.viewW / 2, 0, mode);
  }

  zoomBy(factor) {
    this.setZoom(this.zoom * factor);
  }

  // Pinch (trackpad) and ctrl+wheel arrive as wheel events with ctrlKey.
  // During the gesture only a CSS transform changes — no layout, no
  // rasterization. A crisp relayout + re-render happens once it settles.
  #onWheel(e) {
    if (!e.ctrlKey) return; // plain scrolling: stay out of the way
    e.preventDefault();
    if (!this.n) return;
    const rect = this.scrollerRect || (this.scrollerRect = this.scroller.getBoundingClientRect());
    const fx = e.clientX - rect.left;
    const fy = e.clientY - rect.top;
    if (!this.gesture) {
      const ox = this.scroller.scrollLeft + fx;
      const oy = this.scroller.scrollTop + fy;
      this.gesture = { g: 1, ox, oy, fx, fy };
      this.layer.style.transformOrigin = `${ox}px ${oy}px`;
      this.layer.style.willChange = "transform";
    }
    const g = this.gesture;
    g.fx = fx;
    g.fy = fy;
    let dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    dy = clamp(dy, -25, 25);
    g.g = clamp(this.zoom * g.g * Math.exp(-dy * 0.01), MIN_ZOOM, MAX_ZOOM) / this.zoom;
    if (!this.gestureFrame) {
      this.gestureFrame = requestAnimationFrame(() => {
        this.gestureFrame = 0;
        if (!this.gesture) return;
        this.layer.style.transform = `scale(${this.gesture.g})`;
        this.update(); // mount pages uncovered by zooming out
      });
    }
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.#commitGesture(), SETTLE_MS);
  }

  #commitGesture() {
    const g = this.gesture;
    if (!g) return;
    this.setZoom(this.zoom * g.g, g.fx, g.fy, null); // anchorAt() sees the gesture mapping
  }

  #endGestureTransform() {
    if (!this.gesture) return;
    this.gesture = null;
    clearTimeout(this.settleTimer);
    this.layer.style.transform = "";
    this.layer.style.transformOrigin = "";
    this.layer.style.willChange = "";
  }

  get gestureScale() {
    return this.gesture ? this.gesture.g : 1;
  }

  // ---- resize / DPR ---------------------------------------------------------

  #onResize() {
    if (this.resizeFrame) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = 0;
      this.scrollerRect = null;
      const w = this.scroller.clientWidth;
      const h = this.scroller.clientHeight;
      if (w === this.viewW && h === this.viewH) return;
      this.viewW = w;
      this.viewH = h;
      if (!this.n) return;
      const anchor = this.#anchorAt(0, 0);
      if (this.fitMode) this.zoom = this.#fitZoom(this.fitMode, anchor.p);
      this.#relayout();
      this.#restoreAnchor(anchor, 0, 0);
      this.vis = [0, -1];
      this.update();
      this.dispatchEvent(new Event("zoomchange"));
    });
  }

  // Moving to a different display (or browser zoom) changes devicePixelRatio;
  // re-snap the layout and re-render at the new density.
  #watchDpr() {
    const mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    mq.addEventListener(
      "change",
      () => {
        this.dpr = devicePixelRatio;
        if (this.n) {
          const anchor = this.#anchorAt(0, 0);
          this.#relayout();
          this.#restoreAnchor(anchor, 0, 0);
          this.vis = [0, -1];
          this.update();
          this.dispatchEvent(new Event("layout"));
        }
        this.#watchDpr();
      },
      { once: true },
    );
  }

  // ---- navigation ------------------------------------------------------------

  goToPage(p, topPt = null) {
    if (!this.n) return;
    p = clamp(p, 0, this.n - 1);
    const y = topPt == null ? this.tops[p] - PAD / 2 : this.tops[p] + (topPt * this.h[p]) / this.ptH[p] - 8;
    this.scroller.scrollTop = y;
  }

  goToDest(dest) {
    this.goToPage(dest.page, dest.top);
  }

  nextPage() {
    const p = this.pageAtY(this.scroller.scrollTop + PAD);
    this.goToPage(p + 1);
  }

  prevPage() {
    const top = this.scroller.scrollTop;
    const p = this.pageAtY(top + PAD);
    this.goToPage(this.tops[p] < top - 1 ? p : p - 1);
  }

  // Scroll so a rect given in page points is comfortably visible.
  revealRect(p, xPt, yPt, wPt, hPt) {
    const sx = this.w[p] / this.ptW[p];
    const sy = this.h[p] / this.ptH[p];
    const top = this.tops[p] + yPt * sy;
    const bottom = top + hPt * sy;
    const st = this.scroller.scrollTop;
    if (top < st + 40 || bottom > st + this.viewH - 40) this.scroller.scrollTop = top - this.viewH / 3;
    const left = this.lefts[p] + xPt * sx;
    const right = left + wPt * sx;
    const sl = this.scroller.scrollLeft;
    if (left < sl || right > sl + this.viewW) this.scroller.scrollLeft = left - this.viewW / 3;
  }

  // Reading position for persistence.
  get position() {
    const a = this.#anchorAt(0, 0);
    return { page: a.p, ry: a.ry, zoom: this.zoom, fitMode: this.fitMode };
  }

  restorePosition(pos) {
    if (!this.n || !pos) return;
    if (pos.fitMode) this.zoom = this.#fitZoom(pos.fitMode, 0);
    else if (pos.zoom) this.zoom = clamp(pos.zoom, MIN_ZOOM, MAX_ZOOM);
    this.fitMode = pos.fitMode ?? null;
    this.#relayout();
    const p = clamp(pos.page | 0, 0, this.n - 1);
    this.#restoreAnchor({ p, rx: 0, ry: pos.ry || 0 }, 0, 0);
    this.scroller.scrollLeft = (this.contentW - this.viewW) / 2;
    this.vis = [0, -1];
    this.update();
    this.dispatchEvent(new Event("zoomchange"));
  }

  // ---- dark mode -------------------------------------------------------------

  setInvert(on) {
    this.invert = on;
    this.layer.classList.toggle("inverted", on);
    // Until re-rendered bitmaps arrive, cached ones get a temporary CSS filter
    // so the toggle is instant.
    for (const m of this.mounted.values()) if (m.entry) m.div.classList.toggle("inv-pending", m.entry.invert !== on);
    this.thumbs?.setInvert(on);
    this.pool?.pump();
  }

  // ---- text ------------------------------------------------------------------

  getText(p) {
    let t = this.texts.get(p);
    if (!t) {
      t = this.pool.text(p + 1);
      t.then(
        (d) => this.textData.set(p, d),
        () => this.texts.delete(p),
      );
      this.texts.set(p, t);
    }
    return t;
  }

  #buildVisibleText() {
    if (this.gesture) return;
    const [a, b] = this.vis;
    for (let p = a; p <= b; p++) {
      const m = this.mounted.get(p);
      if (!m || m.text || m.cancelText) continue;
      m.cancelText = () => {}; // claim the slot while text is fetched
      this.getText(p).then(
        (data) => {
          if (this.mounted.get(p) !== m) return;
          m.cancelText = buildTextLayer(data, (dest) => this.goToDest(dest), (text) => {
            m.cancelText = null;
            m.text = text;
            placeTextLayer(text.el, this.ptW[p], this.ptH[p], this.w[p], this.h[p]);
            m.div.append(text.el);
            this.dispatchEvent(new CustomEvent("textlayer", { detail: { page: p, spans: text.spans } }));
          });
        },
        () => {
          if (this.mounted.get(p) === m) m.cancelText = null;
        },
      );
    }
  }

  textLayerFor(p) {
    return this.mounted.get(p)?.text || null;
  }

  get stats() {
    return {
      cacheMB: this.cache.bytes / 1048576,
      cacheEntries: this.cache.map.size,
      mounted: this.mounted.size,
      inflight: this.pool?.inflight ?? 0,
      queued: this.pool?.stats.queued ?? 0,
      renders: this.pool?.stats.renders ?? 0,
      cancels: this.pool?.stats.cancels ?? 0,
      avgRenderMs: this.pool?.stats.avgMs ?? 0,
      zoom: this.zoom,
      dpr: this.dpr,
    };
  }
}
