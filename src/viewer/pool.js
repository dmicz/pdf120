// A pool of render workers, each with its own pdf.js document instance, so
// several pages rasterize in parallel. Scheduling lives here on the main
// thread and is "pull" based: whenever something changes, pump() asks the
// viewer for the current priority-ordered list of wanted renders, cancels
// in-flight work that fell off that list, and hands the head of the list to
// idle workers. A worker runs one render at a time, so a cancel always frees
// a worker for the most important job.

let nextId = 1;
const sig = (j) => `${j.key}|${j.width}x${j.height}|${j.invert ? 1 : 0}|${j.crop || ""}`;

export class RenderPool {
  constructor({ size, urls, provider, onRendered, onSizes }) {
    this.size = size;
    this.urls = urls;
    this.provider = provider; // () => Job[] | null (null = paused)
    this.onRendered = onRendered;
    this.onSizes = onSizes;
    this.workers = [];
    this.textRequests = new Map();
    this.failed = new Set();
    this.stats = { renders: 0, cancels: 0, lastMs: 0, avgMs: 0, queued: 0 };
  }

  #spawn() {
    const w = { worker: new Worker(this.urls.renderWorker, { type: "module" }), job: null, ready: false, texts: 0 };
    w.worker.onmessage = ({ data }) => this.#onMessage(w, data);
    w.worker.onerror = (e) => console.error("[pdf120] render worker error", e.message || e);
    this.workers.push(w);
    return w;
  }

  // Loads the document in the primary worker (resolving password prompts),
  // then brings up the remaining workers in the background.
  async open(data, askPassword) {
    const primary = this.#spawn();
    const info = await new Promise((resolve, reject) => {
      primary.boot = { resolve, reject, askPassword };
      const copy = data.slice(0);
      primary.worker.postMessage({ type: "init", data: copy, primary: true, urls: this.urls }, [copy]);
    });
    this.password = info.password;
    for (let i = 1; i < this.size; i++) {
      const w = this.#spawn();
      w.boot = { resolve: () => this.pump(), reject: () => {}, askPassword: null };
      const copy = data.slice(0);
      w.worker.postMessage({ type: "init", data: copy, password: this.password, primary: false, urls: this.urls }, [copy]);
    }
    return info;
  }

  #onMessage(w, msg) {
    switch (msg.type) {
      case "needPassword": {
        const ask = w.boot?.askPassword;
        if (!ask) return w.boot?.reject(new Error("password"));
        ask(msg.incorrect).then((value) => {
          if (value == null) return w.boot.reject(Object.assign(new Error("A password is required to open this PDF."), { name: "PasswordException" }));
          w.pendingPassword = value;
          w.worker.postMessage({ type: "password", value });
        });
        break;
      }
      case "ready":
        w.ready = true;
        w.boot?.resolve({ ...msg, password: w.pendingPassword });
        w.boot = null;
        this.pump();
        break;
      case "fatal":
        if (w.boot) w.boot.reject(Object.assign(new Error(msg.message), { name: msg.name }));
        else console.error("[pdf120] worker failed:", msg.message);
        break;
      case "sizes":
        this.onSizes?.(msg.sizes);
        break;
      case "rendered": {
        const job = w.job;
        w.job = null;
        this.stats.renders++;
        this.stats.lastMs = msg.ms;
        this.stats.avgMs = this.stats.avgMs ? this.stats.avgMs * 0.9 + msg.ms * 0.1 : msg.ms;
        if (job && job.id === msg.id) this.onRendered(job, msg.bitmap, msg.ms);
        else msg.bitmap.close();
        this.pump();
        break;
      }
      case "cancelled":
        if (w.job?.id === msg.id) w.job = null;
        this.stats.cancels++;
        this.pump();
        break;
      case "error":
        if (w.job?.id === msg.id) {
          console.warn("[pdf120] render failed", w.job, msg.message);
          this.failed.add(sig(w.job));
          w.job = null;
          this.pump();
        } else {
          this.#settleText(w, msg, true);
        }
        break;
      case "text":
        this.#settleText(w, msg, false);
        break;
    }
  }

  #settleText(w, msg, isError) {
    const req = this.textRequests.get(msg.id);
    if (!req) return;
    this.textRequests.delete(msg.id);
    w.texts--;
    if (isError) req.reject(new Error(msg.message));
    else req.resolve(msg);
  }

  pump() {
    const ready = this.workers.filter((w) => w.ready);
    if (!ready.length) return;
    const wanted = this.provider();
    if (!wanted) return; // paused (e.g. mid-pinch)
    const list = wanted.filter((j) => !this.failed.has(sig(j)));
    this.stats.queued = list.length;
    const wantedSigs = new Set(list.map(sig));

    // Cancel renders nobody wants anymore. The worker stays busy until it
    // acknowledges, so cancellation never double-books a worker.
    for (const w of ready) {
      if (w.job && !w.job.cancelling && !wantedSigs.has(sig(w.job))) {
        w.job.cancelling = true;
        w.worker.postMessage({ type: "cancel", id: w.job.id });
      }
    }

    const inflight = new Set(ready.filter((w) => w.job).map((w) => sig(w.job)));
    let i = 0;
    for (const w of ready) {
      if (w.job) continue;
      while (i < list.length && inflight.has(sig(list[i]))) i++;
      if (i >= list.length) break;
      const job = { ...list[i++], id: nextId++ };
      w.job = job;
      inflight.add(sig(job));
      w.worker.postMessage({ type: "render", id: job.id, page: job.page, width: job.width, height: job.height, crop: job.crop, invert: job.invert });
    }
  }

  get inflight() {
    return this.workers.filter((w) => w.job && !w.job.cancelling).length;
  }

  isInflight(key) {
    return this.workers.some((w) => w.job && !w.job.cancelling && w.job.key === key);
  }

  // Text + links for one page, from the least busy ready worker.
  text(page) {
    const ready = this.workers.filter((w) => w.ready);
    const w = ready.reduce((a, b) => (b.texts + (b.job ? 1 : 0) < a.texts + (a.job ? 1 : 0) ? b : a));
    const id = nextId++;
    w.texts++;
    return new Promise((resolve, reject) => {
      this.textRequests.set(id, { resolve, reject });
      w.worker.postMessage({ type: "text", id, page });
    });
  }

  destroy() {
    for (const w of this.workers) w.worker.terminate();
    this.workers = [];
  }
}
