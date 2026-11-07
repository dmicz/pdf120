// Viewer entry point: figures out which PDF to show, boots the worker pool,
// and wires the toolbar, keyboard shortcuts, persistence and overlays.
import { Viewer } from "./viewer.js";
import { RenderPool } from "./pool.js";
import { Thumbnails } from "./thumbs.js";
import { Find } from "./find.js";
import { FpsOverlay } from "./fps.js";
import { loadBytes, filenameFromUrl } from "./loader.js";
import { loadPrefs, savePrefs, loadPosition, savePosition } from "./settings.js";

const $ = (id) => document.getElementById(id);
const isMac = navigator.platform.startsWith("Mac") || navigator.userAgentData?.platform === "macOS";
const inExtension = typeof chrome !== "undefined" && !!chrome.runtime?.id;
const asset = (p) => new URL(p, location.href).href;

const urls = {
  renderWorker: asset("render-worker.js"),
  pdfWorker: asset("pdfjs/pdf.worker.min.mjs"),
  cMaps: asset("pdfjs/cmaps/"),
  standardFonts: asset("pdfjs/standard_fonts/"),
  wasm: asset("pdfjs/wasm/"),
  iccs: asset("pdfjs/iccs/"),
};

// The PDF URL arrives in the fragment (viewer.html#https://host/a.pdf) from
// the redirect rule / content script; ?file= is accepted for development.
function getSource() {
  const raw = location.hash.slice(1) || new URLSearchParams(location.search).get("file") || "";
  if (!raw) return null;
  let url = raw;
  try {
    url = new URL(raw, location.href).href;
  } catch {}
  // A PDF's own fragment carries open parameters (#page=3).
  const hashAt = url.indexOf("#");
  const params = new URLSearchParams(hashAt >= 0 ? url.slice(hashAt + 1) : "");
  return { url, fetchUrl: hashAt >= 0 ? url.slice(0, hashAt) : url, page: parseInt(params.get("page"), 10) || null };
}

const status = $("status");
function showStatus(msg, isError = false) {
  status.hidden = false;
  status.className = isError ? "status error" : "status";
  status.innerHTML = "";
  const div = document.createElement("div");
  div.className = "msg";
  div.textContent = msg;
  status.append(div);
  return div;
}

let prefs;

function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = prefs.theme;
  $("btn-theme").title = `Theme: ${prefs.theme} (D)`;
}

function askPassword(incorrect) {
  const dlg = $("password-dialog");
  $("password-msg").textContent = incorrect ? "Incorrect password. Try again." : "This PDF is password protected.";
  $("password-input").value = "";
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? $("password-input").value : null), { once: true });
  });
}

async function main() {
  prefs = await loadPrefs();
  applyTheme();
  const src = getSource();
  if (!src) return showEmpty();
  document.title = filenameFromUrl(src.fetchUrl);
  $("title").textContent = document.title;
  showStatus("Loading…");
  let data;
  try {
    data = await loadBytes(src.fetchUrl);
  } catch (e) {
    return showFailure(e.message, src);
  }
  openDocument(data, { key: src.fetchUrl, name: filenameFromUrl(src.fetchUrl), src });
}

function showFailure(message, src) {
  const div = showStatus(message, true);
  if (src && inExtension) {
    const p = document.createElement("p");
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = "Open with Chrome's built-in viewer";
    a.onclick = (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "open-native", url: src.url });
    };
    p.append(a);
    div.append(p);
  }
}

function showEmpty() {
  const node = $("empty-template").content.firstElementChild.cloneNode(true);
  $("main").append(node);
  const drop = node.querySelector(".drop");
  const input = node.querySelector("input");
  const open = async (file) => {
    if (!file) return;
    node.remove();
    document.title = file.name;
    $("title").textContent = file.name;
    openDocument(await file.arrayBuffer(), { key: `file:${file.name}:${file.size}`, name: file.name, src: null });
  };
  input.addEventListener("change", () => open(input.files[0]));
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    open(e.dataTransfer.files[0]);
  });
}

async function openDocument(data, { key, name, src }) {
  const scroller = $("viewport");
  const viewer = new Viewer(scroller);
  const cores = navigator.hardwareConcurrency || 4;
  const pool = new RenderPool({
    // Leave headroom for the main thread, compositor and the pdf.js parser
    // workers: 2 workers on 4–6 cores, 4 on 10+.
    size: Math.min(4, Math.max(2, Math.floor(cores / 2) - 1)),
    urls,
    provider: () => viewer.wanted(),
    onRendered: (job, bitmap) => viewer.onRendered(job, bitmap),
    onSizes: (sizes) => viewer.setSizes(sizes),
  });
  viewer.pool = pool;
  window.pdf120 = { viewer, pool }; // handy from DevTools

  let info;
  try {
    info = await pool.open(data, askPassword);
  } catch (e) {
    pool.destroy();
    const msg = e.name === "InvalidPDFException" ? "This file isn't a valid PDF." : e.message;
    return showFailure(msg, src);
  }
  status.hidden = true;
  if (info.title?.trim()) document.title = info.title.trim();
  $("title").textContent = name;
  $("title").title = name;

  viewer.setInvert(prefs.invert);
  viewer.init(info.numPages, info.firstSize);
  $("page-count").textContent = `/ ${info.numPages}`;

  const thumbs = new Thumbnails(viewer, $("thumbs"));
  viewer.thumbs = thumbs;
  thumbs.init();
  const find = new Find(viewer, {
    bar: $("find"),
    input: $("find-input"),
    count: $("find-count"),
    prev: $("find-prev"),
    next: $("find-next"),
    close: $("find-close"),
  });
  const fps = new FpsOverlay(viewer);

  // Restore: explicit #page= wins, then the remembered position.
  const saved = await loadPosition(key);
  if (src?.page) viewer.goToPage(src.page - 1);
  else if (saved) viewer.restorePosition(saved);
  viewer.update();
  scroller.focus({ preventScroll: true });

  // ---- persistence ----
  let saveTimer = 0;
  const persist = () => savePosition(key, viewer.position);
  const schedulePersist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  };
  scroller.addEventListener("scroll", schedulePersist, { passive: true });
  viewer.addEventListener("zoomchange", schedulePersist);
  addEventListener("pagehide", persist);

  const setPref = (k, v) => {
    prefs[k] = v;
    savePrefs(prefs);
  };

  // ---- toolbar ----
  const pageInput = $("page-input");
  const syncPage = () => {
    if (document.activeElement !== pageInput) pageInput.value = viewer.current + 1;
  };
  viewer.addEventListener("pagechange", syncPage);
  syncPage();
  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const n = parseInt(pageInput.value, 10);
      if (n) viewer.goToPage(n - 1);
      scroller.focus({ preventScroll: true });
    } else if (e.key === "Escape") {
      scroller.focus({ preventScroll: true });
    }
  });
  pageInput.addEventListener("focus", () => pageInput.select());
  pageInput.addEventListener("blur", syncPage);

  const zoomSelect = $("zoom-select");
  const zoomCustom = $("zoom-custom");
  const syncZoom = () => {
    if (viewer.fitMode) {
      zoomSelect.value = viewer.fitMode;
      zoomCustom.hidden = true;
      return;
    }
    const match = [...zoomSelect.options].find((o) => Math.abs(parseFloat(o.value) - viewer.zoom) < 0.001);
    if (match) {
      zoomSelect.value = match.value;
      zoomCustom.hidden = true;
    } else {
      zoomCustom.textContent = `${Math.round(viewer.zoom * 100)}%`;
      zoomCustom.hidden = false;
      zoomSelect.value = "custom";
    }
  };
  viewer.addEventListener("zoomchange", syncZoom);
  syncZoom();
  zoomSelect.addEventListener("change", () => {
    const v = zoomSelect.value;
    if (v === "auto" || v === "page" || v === "width") viewer.fit(v);
    else if (v !== "custom") viewer.setZoom(parseFloat(v));
    scroller.focus({ preventScroll: true });
  });

  const STEPS = [0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
  const zoomStep = (dir) => {
    const z = viewer.zoom;
    const next = dir > 0 ? STEPS.find((s) => s > z + 0.001) : [...STEPS].reverse().find((s) => s < z - 0.001);
    if (next) viewer.setZoom(next);
  };
  $("zoom-in").onclick = () => zoomStep(1);
  $("zoom-out").onclick = () => zoomStep(-1);

  const sidebar = $("sidebar");
  const setSidebar = (on) => {
    sidebar.hidden = !on;
    $("btn-sidebar").setAttribute("aria-pressed", on);
    thumbs.setEnabled(on);
    setPref("sidebar", on);
  };
  $("btn-sidebar").onclick = () => setSidebar(sidebar.hidden);
  if (prefs.sidebar) setSidebar(true);

  const setInvert = (on) => {
    viewer.setInvert(on);
    $("thumbs").classList.toggle("inverted-thumbs", on);
    $("btn-invert").setAttribute("aria-pressed", on);
    setPref("invert", on);
  };
  $("btn-invert").onclick = () => setInvert(!viewer.invert);
  setInvert(prefs.invert);

  const cycleTheme = () => {
    const order = ["system", "light", "dark"];
    setPref("theme", order[(order.indexOf(prefs.theme) + 1) % order.length]);
    applyTheme();
  };
  $("btn-theme").onclick = cycleTheme;

  const setFps = (on) => {
    fps.toggle(on);
    $("btn-fps").setAttribute("aria-pressed", on);
    setPref("fps", on);
  };
  $("btn-fps").onclick = () => setFps(!fps.visible);
  if (prefs.fps) setFps(true);

  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
    a.download = name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  $("btn-download").onclick = download;

  const openNative = () => {
    if (inExtension && src) chrome.runtime.sendMessage({ type: "open-native", url: src.url });
  };
  const nativeBtn = $("btn-native");
  nativeBtn.onclick = openNative;
  if (!inExtension || !src) nativeBtn.hidden = true;

  $("btn-find").onclick = () => find.open();
  $("btn-help").onclick = () => $("help-dialog").showModal();

  // ---- keyboard ----
  addEventListener("keydown", (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const typing = e.target.closest?.("input, select, textarea");
    const key = e.key;

    if (mod && !e.altKey) {
      const k = key.toLowerCase();
      if (k === "f") return stop(e, () => find.open());
      if (k === "g") return stop(e, () => (find.isOpen ? find.step(e.shiftKey ? -1 : 1) : find.open()));
      if (k === "=" || k === "+") return stop(e, () => zoomStep(1));
      if (k === "-" || k === "_") return stop(e, () => zoomStep(-1));
      if (k === "0") return stop(e, () => viewer.fit("auto"));
      if (k === "s") return stop(e, download);
      if (k === "p" && inExtension && src) return stop(e, openNative);
      return;
    }
    if (key === "F3") return stop(e, () => find.step(e.shiftKey ? -1 : 1));
    if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
    if ($("help-dialog").open || $("password-dialog").open) return;

    const noHScroll = scroller.scrollWidth <= scroller.clientWidth + 1;
    switch (key) {
      case "j":
      case "n":
        return stop(e, () => viewer.nextPage());
      case "k":
      case "p":
        return stop(e, () => viewer.prevPage());
      case "ArrowRight":
        if (noHScroll) stop(e, () => viewer.nextPage());
        return;
      case "ArrowLeft":
        if (noHScroll) stop(e, () => viewer.prevPage());
        return;
      case "Home":
        return stop(e, () => viewer.goToPage(0));
      case "End":
        return stop(e, () => viewer.goToPage(viewer.n - 1));
      case "g":
        return stop(e, () => pageInput.focus());
      case "t":
        return stop(e, () => setSidebar(sidebar.hidden));
      case "i":
        return stop(e, () => setInvert(!viewer.invert));
      case "d":
        return stop(e, cycleTheme);
      case "D":
        return stop(e, () => setFps(!fps.visible));
      case "B":
        return stop(e, () => fps.bench());
      case "w":
        return stop(e, () => viewer.fit("width"));
      case "f":
        return stop(e, () => viewer.fit("page"));
      case "?":
        return stop(e, () => $("help-dialog").showModal());
      case "Escape":
        if (find.isOpen) stop(e, () => find.close());
        return;
    }
  });

  // Keep keyboard scrolling working after toolbar clicks.
  $("toolbar").addEventListener("pointerup", (e) => {
    if (!e.target.closest("input, select")) setTimeout(() => scroller.focus({ preventScroll: true }));
  });
}

function stop(e, fn) {
  e.preventDefault();
  e.stopPropagation();
  fn();
}

main();
