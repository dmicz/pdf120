// Lazy text layer: transparent, absolutely positioned spans that line up
// with the rendered glyphs so the browser's native selection works. Built
// only for pages that are on screen, in idle time, in chunks so a page with
// thousands of runs never costs a frame.
//
// The layer is laid out in PDF points multiplied by K (to stay clear of any
// minimum-font-size clamping), then scaled to the page with a single CSS
// transform, so zooming only rewrites one style property per page.

const K = 4;
const measureCtx = new OffscreenCanvas(1, 1).getContext("2d");
let lastFont = "";

function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

// Geometry of one text run in page points: {left, top, size, angle}.
export function itemGeometry(item, styles, vt) {
  const tx = mul(vt, item.t);
  const style = styles[item.f] || {};
  let angle = Math.atan2(tx[1], tx[0]);
  if (style.vertical) angle += Math.PI / 2;
  const size = Math.hypot(tx[2], tx[3]);
  const ascentRatio = style.ascent ? style.ascent : style.descent ? 1 + style.descent : 0.8;
  const ascent = size * ascentRatio;
  const left = angle === 0 ? tx[4] : tx[4] + ascent * Math.sin(angle);
  const top = angle === 0 ? tx[5] - ascent : tx[5] - ascent * Math.cos(angle);
  return { left, top, size, angle, vertical: !!style.vertical, family: style.fontFamily || "sans-serif" };
}

// Builds the layer for one page. `data` is the worker's text payload.
// Calls back with {el, spans} when complete; returns a cancel function.
export function buildTextLayer(data, onLink, done) {
  const el = document.createElement("div");
  el.className = "textLayer";
  const spans = new Array(data.items.length).fill(null);
  let i = 0;
  let cancelled = false;
  let handle = 0;

  const step = (deadline) => {
    if (cancelled) return;
    const frag = document.createDocumentFragment();
    while (i < data.items.length && (deadline.didTimeout || deadline.timeRemaining() > 1)) {
      const item = data.items[i];
      if (item.str) {
        const g = itemGeometry(item, data.styles, data.vt);
        const span = document.createElement("span");
        span.textContent = item.str;
        const fontPx = g.size * K;
        const font = `${fontPx}px ${g.family}`;
        if (font !== lastFont) measureCtx.font = lastFont = font;
        const measured = measureCtx.measureText(item.str).width;
        const target = (g.vertical ? item.h : item.w) * K;
        let transform = "";
        if (g.angle) transform += `rotate(${g.angle}rad) `;
        if (measured > 0 && target > 0) transform += `scaleX(${target / measured})`;
        span.style.cssText = `left:${g.left * K}px;top:${g.top * K}px;font-size:${fontPx}px;font-family:${g.family};${transform ? `transform:${transform}` : ""}`;
        frag.append(span);
        spans[i] = span;
      }
      if (item.eol) frag.append(document.createElement("br"));
      i++;
    }
    el.append(frag);
    if (i < data.items.length) {
      handle = requestIdleCallback(step, { timeout: 200 });
      return;
    }
    for (const link of data.links) {
      const a = document.createElement("a");
      a.className = "link";
      const [x, y, w, h] = link.rect;
      a.style.cssText = `left:${x * K}px;top:${y * K}px;width:${w * K}px;height:${h * K}px`;
      if (link.url) {
        a.href = link.url;
        a.target = "_top";
        a.rel = "noopener noreferrer";
        a.title = link.url;
      } else {
        a.href = "#";
        a.addEventListener("click", (e) => {
          e.preventDefault();
          onLink(link.dest);
        });
      }
      el.append(a);
    }
    done({ el, spans });
  };
  handle = requestIdleCallback(step, { timeout: 200 });
  return () => {
    cancelled = true;
    cancelIdleCallback(handle);
  };
}

// Positions a built layer over a page box of cssW x cssH for a page that is
// ptW x ptH points.
export function placeTextLayer(el, ptW, ptH, cssW, cssH) {
  el.style.width = `${ptW * K}px`;
  el.style.height = `${ptH * K}px`;
  el.style.transform = `scale(${cssW / (ptW * K)}, ${cssH / (ptH * K)})`;
}

// Plain-text view of a page for searching: items concatenated, with a space
// at line ends. offsets[i] is where item i starts.
export function searchableText(data) {
  const offsets = new Int32Array(data.items.length);
  let text = "";
  data.items.forEach((it, i) => {
    offsets[i] = text.length;
    text += it.str;
    if (it.eol) text += " ";
  });
  return { text: text.toLowerCase(), offsets };
}
