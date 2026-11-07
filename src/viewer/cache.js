// LRU cache of rendered page bitmaps.
//
// A rendered ImageBitmap is handed to a canvas with a "bitmaprenderer"
// context, which adopts it without a copy. The canvas element *is* the cache
// entry: mounting a page just appends that canvas, so displaying a cached
// page never copies or re-rasterizes pixels.
export const CACHE_LIMIT_BYTES = 1.5 * 1024 ** 3;

export class BitmapCache {
  constructor(limit = CACHE_LIMIT_BYTES) {
    this.limit = limit;
    this.bytes = 0;
    this.map = new Map(); // key -> entry; iteration order = LRU order
  }

  get(key) {
    return this.map.get(key);
  }

  touch(key) {
    const e = this.map.get(key);
    if (e) {
      this.map.delete(key);
      this.map.set(key, e);
    }
    return e;
  }

  // Wraps the bitmap in a canvas and stores it. Returns the new entry; the
  // caller is responsible for swapping it into the DOM if the page is mounted.
  put(key, bitmap, meta) {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("bitmaprenderer").transferFromImageBitmap(bitmap);
    const entry = { ...meta, key, canvas, width: canvas.width, height: canvas.height, bytes: canvas.width * canvas.height * 4 };
    const old = this.map.get(key);
    if (old) this.#drop(old);
    this.map.set(key, entry);
    this.bytes += entry.bytes;
    return entry;
  }

  delete(key) {
    const e = this.map.get(key);
    if (e) this.#drop(e);
  }

  // Evicts least-recently-used entries until under the limit. Entries whose
  // keys are in `keep` (currently mounted / visible) are never evicted.
  evict(keep) {
    if (this.bytes <= this.limit) return;
    for (const [key, e] of this.map) {
      if (this.bytes <= this.limit) break;
      if (keep.has(key)) continue;
      this.#drop(e);
    }
  }

  clear() {
    for (const e of [...this.map.values()]) this.#drop(e);
  }

  #drop(e) {
    this.map.delete(e.key);
    this.bytes -= e.bytes;
    e.canvas.remove();
    // Release the GPU-backed bitmap now rather than waiting for GC.
    e.canvas.getContext("bitmaprenderer").transferFromImageBitmap(null);
    e.canvas.width = e.canvas.height = 0;
  }
}
