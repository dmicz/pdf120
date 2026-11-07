// Cmd/Ctrl+F search. Text is extracted lazily per page by the workers (the
// same payload the text layer uses), searched on the main thread in small
// batches, and highlighted with the CSS Custom Highlight API so no extra DOM
// is created for matches.
import { searchableText, itemGeometry } from "./textlayer.js";

const BATCH = 8;

export class Find {
  constructor(viewer, ui) {
    this.viewer = viewer;
    this.ui = ui;
    this.query = "";
    this.gen = 0;
    this.byPage = new Map(); // page -> [[start, end], ...]
    this.total = 0;
    this.cur = null; // {page, i}
    this.done = false;
    this.hlFrame = 0;

    ui.input.addEventListener("input", () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.search(ui.input.value), 120);
    });
    ui.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (ui.input.value !== this.query) this.search(ui.input.value);
        else this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    ui.next.addEventListener("click", () => this.step(1));
    ui.prev.addEventListener("click", () => this.step(-1));
    ui.close.addEventListener("click", () => this.close());
    viewer.addEventListener("textlayer", () => this.#scheduleHighlights());
  }

  get isOpen() {
    return !this.ui.bar.hidden;
  }

  open() {
    this.ui.bar.hidden = false;
    this.ui.input.focus();
    this.ui.input.select();
  }

  close() {
    this.ui.bar.hidden = true;
    this.gen++;
    this.query = "";
    this.byPage.clear();
    this.total = 0;
    this.cur = null;
    CSS.highlights?.delete("pdf-find");
    CSS.highlights?.delete("pdf-find-current");
    this.viewer.scroller.focus({ preventScroll: true });
  }

  async search(raw) {
    const q = raw.toLowerCase();
    const gen = ++this.gen;
    this.query = raw;
    this.byPage.clear();
    this.total = 0;
    this.cur = null;
    this.done = false;
    this.#render();
    if (!q.trim()) {
      this.done = true;
      this.#render();
      this.#scheduleHighlights();
      return;
    }
    const v = this.viewer;
    const start = v.current;
    const order = [];
    for (let k = 0; k < v.n; k++) order.push((start + k) % v.n);
    for (let k = 0; k < order.length; k += BATCH) {
      const pages = order.slice(k, k + BATCH);
      const datas = await Promise.all(pages.map((p) => v.getText(p).catch(() => null)));
      if (gen !== this.gen) return;
      pages.forEach((p, idx) => {
        const data = datas[idx];
        if (!data) return;
        data.search ||= searchableText(data);
        const matches = [];
        const t = data.search.text;
        for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + q.length)) matches.push([at, at + q.length]);
        if (matches.length) {
          this.byPage.set(p, matches);
          this.total += matches.length;
          if (!this.cur) this.#select({ page: p, i: 0 });
        }
      });
      this.#render();
      this.#scheduleHighlights();
      // Yield so a long search never blocks a frame.
      await new Promise((r) => requestIdleCallback(r, { timeout: 50 }));
      if (gen !== this.gen) return;
    }
    this.done = true;
    this.#render();
  }

  #sortedPages() {
    return [...this.byPage.keys()].sort((a, b) => a - b);
  }

  step(delta) {
    if (!this.total) return;
    const pages = this.#sortedPages();
    let { page, i } = this.cur || { page: pages[0], i: -1 };
    i += delta;
    let pi = pages.indexOf(page);
    if (i < 0) {
      pi = (pi - 1 + pages.length) % pages.length;
      page = pages[pi];
      i = this.byPage.get(page).length - 1;
    } else if (i >= this.byPage.get(page).length) {
      pi = (pi + 1) % pages.length;
      page = pages[pi];
      i = 0;
    }
    this.#select({ page, i });
    this.#render();
  }

  async #select(cur) {
    this.cur = cur;
    this.#scheduleHighlights();
    const data = await this.viewer.getText(cur.page);
    if (this.cur !== cur) return;
    const [s] = this.byPage.get(cur.page)[cur.i];
    const idx = itemIndexAt(data.search.offsets, s);
    const item = data.items[idx];
    if (!item) return this.viewer.goToPage(cur.page);
    const g = itemGeometry(item, data.styles, data.vt);
    this.viewer.revealRect(cur.page, g.left, g.top, item.w, g.size);
  }

  #render() {
    const { count } = this.ui;
    if (!this.query.trim()) count.textContent = "";
    else if (!this.total) count.textContent = this.done ? "No matches" : "Searching…";
    else {
      const pages = this.#sortedPages();
      let n = 0;
      if (this.cur) {
        for (const p of pages) {
          if (p === this.cur.page) break;
          n += this.byPage.get(p).length;
        }
        n += this.cur.i + 1;
      }
      count.textContent = `${n} of ${this.total}${this.done ? "" : "+"}`;
    }
  }

  #scheduleHighlights() {
    if (this.hlFrame || !globalThis.CSS?.highlights) return;
    this.hlFrame = requestAnimationFrame(() => {
      this.hlFrame = 0;
      this.#applyHighlights();
    });
  }

  #applyHighlights() {
    const all = new Highlight();
    const current = new Highlight();
    for (const [p, matches] of this.byPage) {
      const layer = this.viewer.textLayerFor(p);
      const data = this.viewer.textData.get(p);
      if (!layer || !data?.search) continue;
      matches.forEach(([s, e], i) => {
        const range = makeRange(data, layer.spans, s, e);
        if (!range) return;
        if (this.cur && this.cur.page === p && this.cur.i === i) current.add(range);
        else all.add(range);
      });
    }
    CSS.highlights.set("pdf-find", all);
    CSS.highlights.set("pdf-find-current", current);
  }
}

function itemIndexAt(offsets, pos) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function makeRange(data, spans, s, e) {
  const { offsets } = data.search;
  let i = itemIndexAt(offsets, s);
  let so = s - offsets[i];
  if (so >= data.items[i].str.length) {
    i++; // match starts in a line-end separator
    so = 0;
  }
  let j = itemIndexAt(offsets, e - 1);
  const eo = Math.min(e - offsets[j], data.items[j].str.length);
  const a = spans[i]?.firstChild;
  const b = spans[j]?.firstChild;
  if (!a || !b) return null;
  const range = new Range();
  range.setStart(a, Math.min(so, a.length));
  range.setEnd(b, Math.min(eo, b.length));
  return range;
}
