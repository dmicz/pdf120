// Debug overlay: frame-time graph + stats, to verify 120Hz holds.
//
// Frame times come from requestAnimationFrame deltas, i.e. main-thread
// frames. Native scrolling runs on the compositor and can stay smooth even
// when these drop, so this is the stricter of the two signals; for the
// compositor's view use DevTools > Rendering > "Frame Rendering Stats".
// Long Animation Frames (>50ms) are counted via PerformanceObserver.
//
// "Bench" scrolls the document at a constant speed from rAF for 6s and
// reports what fraction of frames were on time.

const HISTORY = 240; // frames shown in the graph
const GRAPH_W = 240;
const GRAPH_H = 64;

export class FpsOverlay {
  constructor(viewer) {
    this.viewer = viewer;
    this.el = document.createElement("div");
    this.el.className = "fps";
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="fps-head"><b class="fps-big">--</b><span class="fps-unit">fps</span><span class="fps-hz"></span>
        <button class="fps-btn" data-act="bench" title="Scroll the document at constant speed for 6s (Shift+B)">Bench</button>
        <button class="fps-btn" data-act="reset" title="Reset counters">Reset</button></div>
      <canvas width="${GRAPH_W * 2}" height="${GRAPH_H * 2}" style="width:${GRAPH_W}px;height:${GRAPH_H}px"></canvas>
      <pre class="fps-stats"></pre>`;
    document.body.append(this.el);
    this.canvas = this.el.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.big = this.el.querySelector(".fps-big");
    this.hz = this.el.querySelector(".fps-hz");
    this.statsEl = this.el.querySelector(".fps-stats");
    this.el.addEventListener("click", (e) => {
      const act = e.target.dataset?.act;
      if (act === "bench") this.bench();
      if (act === "reset") this.reset();
    });
    this.benchState = { running: false, tick: null };
    this.frames = new Float32Array(HISTORY);
    this.head = 0;
    this.reset();
    this.loafs = 0;
    try {
      new PerformanceObserver((list) => (this.loafs += list.getEntries().length)).observe({ type: "long-animation-frame", buffered: false });
    } catch {}
  }

  reset() {
    this.frames.fill(0);
    this.total = 0;
    this.dropped = 0;
    this.worst = 0;
    this.loafs = 0;
    this.benchResult = "";
  }

  get visible() {
    return !this.el.hidden;
  }

  toggle(on = this.el.hidden) {
    this.el.hidden = !on;
    if (on) {
      this.last = 0;
      this.textAt = 0;
      requestAnimationFrame((t) => this.#frame(t));
    }
  }

  // Refresh interval estimate: median of recent deltas.
  #interval() {
    const xs = [...this.frames].filter((x) => x > 0).sort((a, b) => a - b);
    return xs.length ? xs[xs.length >> 1] : 1000 / 60;
  }

  #frame(t) {
    if (this.el.hidden) return;
    requestAnimationFrame((t2) => this.#frame(t2));
    if (this.last) {
      const dt = t - this.last;
      this.frames[this.head] = dt;
      this.head = (this.head + 1) % HISTORY;
      this.total++;
      const iv = this.#interval();
      // A delta of ~2 intervals means one missed vsync.
      if (dt > iv * 1.5) this.dropped += Math.round(dt / iv) - 1;
      if (this.total > 10 && dt > this.worst) this.worst = dt;
      this.benchState.tick?.(t, dt, iv);
    }
    this.last = t;
    this.#draw();
    if (t - this.textAt > 250) {
      this.textAt = t;
      this.#text();
    }
  }

  #draw() {
    const { ctx } = this;
    const W = GRAPH_W * 2;
    const H = GRAPH_H * 2;
    const iv = this.#interval();
    const scaleMs = Math.max(34, iv * 4); // graph height in ms
    ctx.clearRect(0, 0, W, H);
    // Budget line at one refresh interval.
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(0, H - (iv / scaleMs) * H, W, 1);
    const bw = W / HISTORY;
    for (let k = 0; k < HISTORY; k++) {
      const dt = this.frames[(this.head + k) % HISTORY];
      if (!dt) continue;
      const h = Math.min(H, (dt / scaleMs) * H);
      ctx.fillStyle = dt > iv * 1.5 ? "#ff5a4f" : dt > iv * 1.15 ? "#f5b941" : "#46d68c";
      ctx.fillRect(k * bw, H - h, Math.max(1, bw - 0.5), h);
    }
  }

  #text() {
    const sum = this.frames.reduce((a, b) => a + b, 0);
    const n = this.frames.filter((x) => x > 0).length;
    const fps = n ? (1000 * n) / sum : 0;
    const iv = this.#interval();
    this.big.textContent = fps.toFixed(0);
    this.hz.textContent = `display ≈ ${(1000 / iv).toFixed(0)} Hz`;
    const s = this.viewer.stats;
    const sorted = [...this.frames].filter((x) => x > 0).sort((a, b) => a - b);
    const p99 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0;
    this.statsEl.textContent = [
      `frame p99 ${p99.toFixed(1)}ms  worst ${this.worst.toFixed(1)}ms`,
      `dropped ${this.dropped} / ${this.total} frames  LoAF ${this.loafs}`,
      `cache ${s.cacheMB.toFixed(0)} MB (${s.cacheEntries})  mounted ${s.mounted}`,
      `render ${s.inflight} running, ${s.queued} queued  avg ${s.avgRenderMs.toFixed(0)}ms`,
      `renders ${s.renders}  cancelled ${s.cancels}`,
      `zoom ${(s.zoom * 100).toFixed(0)}%  dpr ${s.dpr}  pinch ×${this.viewer.gestureScale.toFixed(2)}`,
      this.benchResult,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Constant-speed scroll driven from rAF (a main-thread scroll, so stricter
  // than a trackpad fling). Reports on-time frames.
  bench(seconds = 6, pxPerSec = 2400) {
    if (this.benchState.running) return;
    this.toggle(true);
    const sc = this.viewer.scroller;
    const startTop = sc.scrollTop;
    const range = Math.max(0, sc.scrollHeight - sc.clientHeight);
    let elapsed = 0;
    let frames = 0;
    let late = 0;
    let worst = 0;
    this.benchResult = "bench: running…";
    this.benchState.running = true;
    this.benchState.tick = (t, dt, iv) => {
      elapsed += dt;
      frames++;
      if (dt > iv * 1.5) late++;
      if (frames > 2 && dt > worst) worst = dt;
      // Ping-pong through the document.
      const dist = (elapsed / 1000) * pxPerSec;
      const period = range * 2 || 1;
      const pos = (startTop + dist) % period;
      sc.scrollTop = pos <= range ? pos : period - pos;
      if (elapsed >= seconds * 1000) {
        this.benchState.tick = null;
        this.benchState.running = false;
        const fps = (frames * 1000) / elapsed;
        this.benchResult = `bench: ${fps.toFixed(1)} fps, ${(((frames - late) / frames) * 100).toFixed(1)}% on time, worst ${worst.toFixed(1)}ms`;
        console.log(`[pdf120] ${this.benchResult}`);
      }
    };
  }
}
