// Render worker. Owns one pdf.js document (whose parser runs in a nested
// pdf.worker) and rasterizes pages into an OffscreenCanvas, shipping the
// result to the main thread as a transferable ImageBitmap. The main thread
// never rasterizes PDF content.
//
// Protocol (main -> worker):
//   {type:"init", data, password?, primary, urls}
//   {type:"password", value}
//   {type:"render", id, page, width, height, invert}
//   {type:"cancel", id}
//   {type:"text", id, page}
// Protocol (worker -> main):
//   {type:"ready", numPages, firstSize, title}
//   {type:"sizes", sizes: Float32Array [w0,h0,w1,h1,...] in PDF points}
//   {type:"needPassword", incorrect}
//   {type:"rendered", id, page, bitmap, ms}
//   {type:"cancelled"|"error", id, message?}
//   {type:"text", id, page, items, styles, links, vt}
//   {type:"fatal", message, name}
import { getDocument, GlobalWorkerOptions, RenderingCancelledException, AnnotationMode } from "pdfjs-dist";
import { INVERT_FILTER } from "../shared.js";

// pdf.js asks its CanvasFactory for scratch canvases (soft masks, patterns,
// transparency groups). In a worker these must be OffscreenCanvases.
class OffscreenCanvasFactory {
  constructor() {}
  create(width, height) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(cc, width, height) {
    cc.canvas.width = width;
    cc.canvas.height = height;
  }
  destroy(cc) {
    if (cc.canvas) cc.canvas.width = cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
  getNoAlphaContext(canvas) {
    return canvas.getContext("2d", { alpha: false });
  }
}

// The DOM filter factory builds SVG <filter>s, which don't exist in workers.
// These only matter for transfer functions / HCM, so render without them.
class NoopFilterFactory {
  constructor() {}
  addFilter() { return "none"; }
  addHCMFilter() { return "none"; }
  addAlphaFilter() { return "none"; }
  addLuminosityFilter() { return "none"; }
  addKnockoutFilter() { return "none"; }
  addHighlightHCMFilter() { return "none"; }
  addSelectionHCMFilter() { return "none"; }
  addSelectionFilter() { return "none"; }
  createSelectionStyle() { return null; }
  destroy() {}
}

let doc = null;
let loadingTask = null;
let passwordCallback = null;
const tasks = new Map(); // job id -> RenderTask
const canvas = new OffscreenCanvas(1, 1);
const ctx = canvas.getContext("2d", { alpha: false });
let scratch = null; // second canvas used when baking the invert filter

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function init({ data, password, primary, urls }) {
  GlobalWorkerOptions.workerPort = new Worker(urls.pdfWorker, { type: "module" });
  loadingTask = getDocument({
    data,
    password,
    // Fonts are loaded into the worker's own FontFaceSet (self.fonts), which
    // is what OffscreenCanvas text rendering resolves against.
    ownerDocument: self,
    CanvasFactory: OffscreenCanvasFactory,
    FilterFactory: NoopFilterFactory,
    useWorkerFetch: true,
    cMapUrl: urls.cMaps,
    standardFontDataUrl: urls.standardFonts,
    wasmUrl: urls.wasm,
    iccUrl: urls.iccs,
    isEvalSupported: false,
    enableHWA: true,
    disableWorkerRendering: true,
  });
  loadingTask.onPassword = (update, reason) => {
    passwordCallback = update;
    post({ type: "needPassword", incorrect: reason === 2 });
  };
  try {
    doc = await loadingTask.promise;
  } catch (e) {
    post({ type: "fatal", message: e?.message || String(e), name: e?.name });
    return;
  }
  const first = await doc.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  let title = null;
  if (primary) {
    try {
      const meta = await doc.getMetadata();
      title = meta?.metadata?.get?.("dc:title") || meta?.info?.Title || null;
    } catch {}
  }
  post({ type: "ready", numPages: doc.numPages, firstSize: [vp.width, vp.height], title });
  if (primary) sendSizes();
}

async function sendSizes() {
  const n = doc.numPages;
  const sizes = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    sizes[i * 2] = vp.width;
    sizes[i * 2 + 1] = vp.height;
  }
  post({ type: "sizes", sizes }, [sizes.buffer]);
}

// Per-operation bounding boxes (recorded by pdf.js, normalized to the page)
// let a tile render skip every drawing operation that doesn't touch it, so a
// tile of a 78k-operation map costs a fraction of a full render. pdf.js only
// records them on an uncropped render, so when a tile arrives first we record
// them with a cheap low-resolution pass, once per page per worker.
const bboxPasses = new Map();
let useTileFilter = true; // debug switch: {type:"config", tileFilter:false}
function ensureBBoxes(page, pageNum) {
  if (page.recordedBBoxes) return Promise.resolve();
  let pass = bboxPasses.get(pageNum);
  if (!pass) {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1024 / base.width, 1024 / base.height);
    const viewport = page.getViewport({ scale });
    const c = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    pass = page
      .render({ canvasContext: c.getContext("2d"), canvas: c, viewport, intent: "display", annotationMode: AnnotationMode.ENABLE, recordOperations: true })
      .promise.catch(() => {})
      .finally(() => (c.width = c.height = 0));
    bboxPasses.set(pageNum, pass);
  }
  return pass;
}

function tileFilter(page, [cx, cy, cw, ch], width, height) {
  const bb = page.recordedBBoxes;
  if (!bb) return null;
  const minX = cx / width;
  const minY = cy / height;
  const maxX = (cx + cw) / width;
  const maxY = (cy + ch) / height;
  // Same test pdf.js's own viewer uses for partial (detail) renders.
  return (i) => !bb.isEmpty(i) && bb.minX(i) <= maxX && bb.maxX(i) >= minX && bb.minY(i) <= maxY && bb.maxY(i) >= minY;
}

// width/height: full page size in device px. crop: optional [x, y, w, h]
// sub-rectangle to render (a high-zoom tile); the canvas is just that region.
async function render({ id, page: pageNum, width, height, crop, invert }) {
  const t0 = performance.now();
  let task;
  try {
    const page = await doc.getPage(pageNum);
    if (crop) await ensureBBoxes(page, pageNum);
    if (!tasks.has(id)) return post({ type: "cancelled", id }); // cancelled while waiting
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const [cx, cy, cw, ch] = crop || [0, 0, width, height];
    canvas.width = cw;
    canvas.height = ch;
    // Map the viewport's (possibly fractional) height onto our integer page
    // height, then shift so the crop's origin lands at (0, 0).
    const ky = height / viewport.height;
    task = page.render({
      canvasContext: ctx,
      canvas,
      viewport,
      transform: ky !== 1 || cx || cy ? [1, 0, 0, ky, -cx, -cy] : null,
      intent: "display",
      annotationMode: AnnotationMode.ENABLE,
      // Full-page renders record bboxes (first time only); tiles use them.
      recordOperations: !crop,
      operationsFilter: crop && useTileFilter ? tileFilter(page, crop, width, height) : null,
    });
    tasks.set(id, task);
    await task.promise;
    let bitmap;
    if (invert) {
      // Bake dark mode into the bitmap so the compositor never runs a filter.
      if (!scratch) scratch = new OffscreenCanvas(cw, ch);
      scratch.width = cw;
      scratch.height = ch;
      const sctx = scratch.getContext("2d", { alpha: false });
      sctx.filter = INVERT_FILTER;
      sctx.drawImage(canvas, 0, 0);
      bitmap = scratch.transferToImageBitmap();
    } else {
      bitmap = canvas.transferToImageBitmap();
    }
    tasks.delete(id);
    post({ type: "rendered", id, page: pageNum, bitmap, ms: performance.now() - t0 }, [bitmap]);
  } catch (e) {
    tasks.delete(id);
    if (e instanceof RenderingCancelledException || e?.name === "RenderingCancelledException") {
      post({ type: "cancelled", id });
    } else {
      post({ type: "error", id, message: e?.message || String(e) });
    }
  }
}

async function resolveDest(dest) {
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return null;
    const ref = explicit[0];
    const pageIndex = typeof ref === "object" && ref ? await doc.getPageIndex(ref) : Number.isInteger(ref) ? ref : null;
    if (pageIndex == null) return null;
    const mode = explicit[1]?.name;
    let top = null;
    if (mode === "XYZ" || mode === "FitH" || mode === "FitBH") {
      const y = mode === "XYZ" ? explicit[3] : explicit[2];
      if (typeof y === "number") {
        const page = await doc.getPage(pageIndex + 1);
        top = page.getViewport({ scale: 1 }).convertToViewportPoint(0, y)[1];
      }
    }
    return { page: pageIndex, top };
  } catch {
    return null;
  }
}

async function text({ id, page: pageNum }) {
  try {
    const page = await doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    const [content, annots] = await Promise.all([
      page.getTextContent(),
      page.getAnnotations({ intent: "display" }).catch(() => []),
    ]);
    const items = [];
    for (const it of content.items) {
      if (typeof it.str !== "string") continue; // marked-content markers
      items.push({ str: it.str, t: it.transform, w: it.width, h: it.height, f: it.fontName, eol: it.hasEOL, dir: it.dir });
    }
    const links = [];
    for (const a of annots) {
      if (a.subtype !== "Link" || !a.rect) continue;
      const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
      const rect = [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
      if (a.url || a.unsafeUrl) links.push({ rect, url: a.url || a.unsafeUrl });
      else if (a.dest) {
        const d = await resolveDest(a.dest);
        if (d) links.push({ rect, dest: d });
      }
    }
    post({ type: "text", id, page: pageNum, items, styles: content.styles, links, vt: vp.transform });
  } catch (e) {
    post({ type: "error", id, message: e?.message || String(e) });
  }
}

self.onmessage = ({ data: msg }) => {
  switch (msg.type) {
    case "init":
      init(msg);
      break;
    case "password":
      passwordCallback?.(msg.value);
      break;
    case "render":
      tasks.set(msg.id, null); // placeholder so a cancel before render() starts sticks
      render(msg);
      break;
    case "cancel": {
      const task = tasks.get(msg.id);
      tasks.delete(msg.id);
      task?.cancel();
      break;
    }
    case "text":
      text(msg);
      break;
    case "config":
      if ("tileFilter" in msg) useTileFilter = !!msg.tileFilter;
      break;
  }
};
