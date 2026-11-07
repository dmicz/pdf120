// Panning benchmark for big single-page PDFs (maps, posters, schematics).
// Zooms in, pans continuously, and samples every frame what fraction of the
// visible page area is covered by full-resolution tiles.
//
//   npm run build && node test/pan.mjs path/to/map.pdf [zoom=2] [px/s=1200] [startX=0.5] [startY=0.4]
// startX/startY: where to begin, as fractions of the page.
import puppeteer from "puppeteer-core";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { serve } from "../scripts/serve.mjs";

const [file, zoomArg = "2", speedArg = "1200", sxArg = "0.5", syArg = "0.4"] = process.argv.slice(2);
if (!file) {
  console.error("usage: node test/pan.mjs <file.pdf> [zoom] [px/s]");
  process.exit(1);
}
const root = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(join(root, "test/fixtures"), { recursive: true });
copyFileSync(resolve(file), join(root, "test/fixtures/_pan.pdf"));

const mac = process.platform === "darwin";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || (mac ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"),
  headless: true,
  args: mac ? ["--enable-gpu", "--use-angle=metal"] : ["--no-sandbox"],
});
const server = await serve(8129);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900, deviceScaleFactor: 2 });
  await page.goto("http://localhost:8129/viewer.html?file=/_pan.pdf");
  await page.waitForFunction(() => window.pdf120?.viewer?.n > 0, { timeout: 30000 });
  // Let the whole-page base bitmap render first (that's the blurry backdrop).
  await page.waitForFunction(() => document.querySelector(".page canvas:not(.tile)"), { timeout: 60000 });
  console.log(`workers: ${await page.evaluate(() => pdf120.pool.workers.length)}`);

  const result = await page.evaluate(
    async (zoom, speed, sx, sy) => {
      const v = pdf120.viewer;
      const sc = v.scroller;
      v.setZoom(zoom);
      // Start near the middle of the page.
      sc.scrollTop = v.tops[0] + v.h[0] * sy;
      sc.scrollLeft = v.lefts[0] + v.w[0] * sx;
      const coverage = () => {
        const vp = sc.getBoundingClientRect();
        const pg = document.querySelector(".page").getBoundingClientRect();
        const ix = (r) => Math.max(0, Math.min(r.right, vp.right) - Math.max(r.left, vp.left)) * Math.max(0, Math.min(r.bottom, vp.bottom) - Math.max(r.top, vp.top));
        const total = ix(pg);
        let got = 0;
        for (const c of document.querySelectorAll(".page canvas.tile:not(.stale)")) got += ix(c.getBoundingClientRect());
        return total ? Math.min(1, got / total) : 1;
      };
      const waitFull = async (limit) => {
        const t0 = performance.now();
        while (coverage() < 0.999 && performance.now() - t0 < limit) await new Promise((r) => requestAnimationFrame(r));
        return performance.now() - t0;
      };
      const firstFill = await waitFull(30000);

      // Record per-tile render times (the slowest tile bounds how long any
      // patch can stay blurry). Pan right 2s, down 2s, diagonally back 2s.
      const tileMs = [];
      const orig = pdf120.pool.onRendered;
      pdf120.pool.onRendered = (job, bitmap, ms) => {
        if (job.kind === "tile") tileMs.push(ms);
        orig(job, bitmap, ms);
      };
      const legs = [[1, 0], [0, 1], [-0.7, -0.7]];
      const samples = [];
      for (const [dx, dy] of legs) {
        const t0 = performance.now();
        let last = t0;
        while (performance.now() - t0 < 2000) {
          await new Promise((r) => requestAnimationFrame(r));
          const now = performance.now();
          const dt = (now - last) / 1000;
          last = now;
          sc.scrollLeft += dx * speed * dt;
          sc.scrollTop += dy * speed * dt;
          samples.push(coverage());
        }
      }
      const settle = await waitFull(30000);
      samples.sort((a, b) => a - b);
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      return {
        firstFill,
        settle,
        mean,
        p10: samples[Math.floor(samples.length * 0.1)],
        min: samples[0],
        tiles: tileMs.length,
        tileP50: tileMs.sort((a, b) => a - b)[Math.floor(tileMs.length * 0.5)] || 0,
        tileP95: tileMs[Math.floor(tileMs.length * 0.95)] || 0,
        tileMax: tileMs[tileMs.length - 1] || 0,
      };
    },
    Number(zoomArg),
    Number(speedArg),
    Number(sxArg),
    Number(syArg),
  );
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  console.log(`zoom ${zoomArg}×, panning ${speedArg} CSS px/s from (${sxArg}, ${syArg})`);
  console.log(`  initial fill of viewport: ${result.firstFill.toFixed(0)}ms`);
  console.log(`  sharp coverage while panning: mean ${pct(result.mean)}, p10 ${pct(result.p10)}, min ${pct(result.min)}`);
  console.log(`  ${result.tiles} tiles rendered: p50 ${result.tileP50.toFixed(0)}ms, p95 ${result.tileP95.toFixed(0)}ms, max ${result.tileMax.toFixed(0)}ms; fully sharp ${result.settle.toFixed(0)}ms after stopping`);
  await page.screenshot({ path: join(root, "test/out/pan.png") });
} finally {
  await browser.close();
  server.close();
}
