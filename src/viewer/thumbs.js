// Thumbnail sidebar: its own virtualized scroller. Thumbnails are rendered by
// the same worker pool at the lowest priority (after every main-view page)
// and live in the same LRU cache, so they share the 1.5GB budget.

const THUMB_W = 116; // CSS px
const GAP = 22; // includes room for the page-number label
const PAD = 14;

const thumbKey = (p) => `t${p}`;

export class Thumbnails {
  constructor(viewer, scroller) {
    this.viewer = viewer;
    this.scroller = scroller;
    this.sizer = document.createElement("div");
    this.sizer.className = "thumb-sizer";
    scroller.append(this.sizer);
    this.enabled = false;
    this.items = [];
    this.mounted = new Map(); // p -> entry|null
    this.current = -1;
    this.range = [0, -1];

    scroller.addEventListener("scroll", () => this.update(), { passive: true });
    scroller.addEventListener("click", (e) => {
      const item = e.target.closest(".thumb");
      if (item) viewer.goToPage(+item.dataset.index);
    });
    viewer.addEventListener("layout", () => this.layout());
    viewer.addEventListener("pagechange", () => this.setCurrent(viewer.current));
    new ResizeObserver(() => this.update()).observe(scroller);
  }

  init() {
    const v = this.viewer;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < v.n; i++) {
      const item = document.createElement("div");
      item.className = "thumb";
      item.dataset.index = i;
      const box = document.createElement("div");
      box.className = "thumb-page";
      const label = document.createElement("span");
      label.className = "thumb-label";
      label.textContent = i + 1;
      item.append(box, label);
      this.items.push({ item, box });
      frag.append(item);
    }
    this.sizer.append(frag);
    this.layout();
  }

  layout() {
    const v = this.viewer;
    if (!v.n || !this.items.length) return;
    const d = v.dpr;
    this.tops = new Float64Array(v.n);
    this.hs = new Float64Array(v.n);
    let y = PAD;
    for (let i = 0; i < v.n; i++) {
      const h = Math.round(((THUMB_W * v.ptH[i]) / v.ptW[i]) * d) / d;
      this.tops[i] = y;
      this.hs[i] = h;
      const { item, box } = this.items[i];
      item.style.cssText = `top:${y}px;height:${h + GAP - 6}px`;
      box.style.cssText = `width:${THUMB_W}px;height:${h}px`;
      y += h + GAP;
    }
    this.sizer.style.height = `${y + PAD - GAP}px`;
    // Sizes may have changed: drop mismatched thumbnails from view.
    for (const p of [...this.mounted.keys()]) this.#unmount(p);
    this.range = [0, -1];
    this.update();
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) {
      this.update();
      this.setCurrent(this.viewer.current, true);
      this.viewer.pool?.pump();
    }
  }

  #pageAtY(y) {
    let lo = 0;
    let hi = this.viewer.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  update() {
    if (!this.enabled || !this.tops) return;
    const top = this.scroller.scrollTop;
    const h = this.scroller.clientHeight;
    const a = this.#pageAtY(top - h);
    const b = this.#pageAtY(top + 2 * h);
    if (a === this.range[0] && b === this.range[1]) return;
    this.range = [a, b];
    this.visible = [this.#pageAtY(top), this.#pageAtY(top + h)];
    for (const p of [...this.mounted.keys()]) if (p < a || p > b) this.#unmount(p);
    for (let p = a; p <= b; p++) {
      if (this.mounted.has(p)) continue;
      this.mounted.set(p, null);
      const e = this.viewer.cache.touch(thumbKey(p));
      if (e) this.#attach(p, e);
    }
    this.viewer.pool?.pump();
  }

  #attach(p, e) {
    const old = this.mounted.get(p);
    if (old && old !== e) old.canvas.remove();
    this.mounted.set(p, e);
    const { box } = this.items[p];
    if (e.canvas.parentNode !== box) box.prepend(e.canvas);
    box.classList.toggle("inv-pending", e.invert !== this.viewer.invert);
  }

  #unmount(p) {
    this.mounted.get(p)?.canvas.remove();
    this.mounted.delete(p);
  }

  #target(p) {
    const d = this.viewer.dpr;
    return { w: Math.round(THUMB_W * d), h: Math.max(1, Math.round(this.hs[p] * d)) };
  }

  wanted() {
    if (!this.enabled || !this.tops) return [];
    const jobs = [];
    const [a, b] = this.range;
    const [va, vb] = this.visible || [a, b];
    const order = [];
    for (let p = va; p <= vb; p++) order.push(p);
    for (let p = vb + 1; p <= b; p++) order.push(p);
    for (let p = va - 1; p >= a; p--) order.push(p);
    for (const p of order) {
      const t = this.#target(p);
      const e = this.viewer.cache.get(thumbKey(p));
      if (e && e.width === t.w && e.height === t.h && e.invert === this.viewer.invert) continue;
      jobs.push({ key: thumbKey(p), page: p + 1, width: t.w, height: t.h, invert: this.viewer.invert, kind: "thumb" });
    }
    return jobs;
  }

  onRendered(job, bitmap) {
    const p = job.page - 1;
    const e = this.viewer.cache.put(job.key, bitmap, { page: p, invert: job.invert });
    if (this.mounted.has(p)) this.#attach(p, e);
    this.viewer.cache.evict(this.viewer.protectedKeys());
  }

  mountedKeys() {
    return [...this.mounted.keys()].map(thumbKey);
  }

  setInvert(on) {
    for (const [p, e] of this.mounted) if (e) this.items[p].box.classList.toggle("inv-pending", e.invert !== on);
  }

  setCurrent(p, force = false) {
    if (!this.items.length || (p === this.current && !force)) return;
    this.items[this.current]?.item.classList.remove("current");
    this.current = p;
    this.items[p].item.classList.add("current");
    if (!this.enabled || this.scroller.matches(":hover")) return;
    const top = this.tops[p];
    const bottom = top + this.hs[p] + GAP;
    const st = this.scroller.scrollTop;
    const h = this.scroller.clientHeight;
    if (top < st || bottom > st + h) this.scroller.scrollTop = top - h / 3;
  }
}
