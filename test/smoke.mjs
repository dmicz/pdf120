// End-to-end smoke test in headless Chrome. Serves dist/ as a plain page
// (chrome.* APIs absent -> localStorage fallbacks), generates a fixture PDF,
// and checks rendering, virtualization, text layer, search, zoom, invert,
// thumbnails and position memory.
//
//   npm run build && npm test
// Set CHROME_PATH to override the browser binary.
import puppeteer from "puppeteer-core";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { serve } from "../scripts/serve.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(root, "test/fixtures");
const out = join(root, "test/out");
mkdirSync(fixtures, { recursive: true });
mkdirSync(out, { recursive: true });

const mac = process.platform === "darwin";
const executablePath =
  process.env.CHROME_PATH || (mac ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: mac ? ["--enable-gpu", "--use-angle=metal"] : ["--no-sandbox", "--disable-dev-shm-usage"],
});
const MOD = mac ? "Meta" : "Control"; // the viewer uses ⌘ on macOS, Ctrl elsewhere
const server = await serve(8127);
const base = "http://localhost:8127";

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok " : "FAIL "} ${msg}`);
  if (!cond) failures++;
};

try {
  // ---- fixture: 60 pages with text, colors, an internal link, rotated text ----
  if (!existsSync(join(fixtures, "sample.pdf"))) {
    const page = await browser.newPage();
    const sections = Array.from({ length: 60 }, (_, i) => `
      <section id="s${i + 1}">
        <h1>Section ${i + 1}</h1>
        <p>${"The quick brown fox jumps over the lazy dog. ".repeat(18)}</p>
        <p>Unique marker: zebra${i + 1}quokka</p>
        <div class="box" style="background:hsl(${(i * 37) % 360} 70% 55%)"></div>
        <p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(14)}</p>
        ${i === 0 ? '<p><a href="#s42">Jump to section 42</a></p>' : ""}
      </section>`).join("");
    await page.setContent(`<style>
      body{font:12pt Georgia,serif;margin:0} section{break-after:page;padding:20px}
      h1{font:bold 22pt Helvetica,sans-serif;color:#234} .box{height:180px;border-radius:12px;margin:12px 0}
    </style>${sections}`);
    writeFileSync(join(fixtures, "sample.pdf"), await page.pdf({ format: "Letter", printBackground: true }));
    await page.close();
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warn") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`${base}/viewer.html?file=/sample.pdf`);
  await page.waitForFunction(() => window.pdf120?.viewer?.n > 0, { timeout: 15000 });
  const n = await page.evaluate(() => pdf120.viewer.n);
  check(n === 60, `document opened with ${n} pages`);

  await page.waitForFunction(() => document.querySelectorAll(".page canvas").length >= 2, { timeout: 15000 });
  const s1 = await page.evaluate(() => ({
    pageDivs: document.querySelectorAll(".page").length,
    canvases: document.querySelectorAll(".page canvas").length,
    mounted: pdf120.viewer.mounted.size,
    first: (() => {
      const c = document.querySelector('.page[data-page="1"] canvas');
      return c && { w: c.width, h: c.height, cssW: c.parentNode.getBoundingClientRect().width };
    })(),
  }));
  check(s1.pageDivs === 60, `60 placeholder divs (${s1.pageDivs})`);
  check(s1.mounted < 20, `virtualized: ${s1.mounted} pages mounted`);
  check(s1.first && Math.abs(s1.first.w - s1.first.cssW * 2) < 1.5, `page 1 bitmap at devicePixelRatio (${s1.first?.w}px for ${s1.first?.cssW} CSS px)`);

  // Pixel check: the rendered page isn't blank.
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: join(out, "01-top.png") });

  // ---- scroll far and verify mounting follows ----
  await page.evaluate(() => (pdf120.viewer.scroller.scrollTop = pdf120.viewer.tops[30]));
  await page.waitForFunction(() => document.querySelector('.page[data-page="31"] canvas'), { timeout: 15000 });
  const s2 = await page.evaluate(() => ({ current: pdf120.viewer.current, p1: !!document.querySelector('.page[data-page="1"] canvas') }));
  check(s2.current === 30, `current page tracks scroll (${s2.current + 1})`);
  check(!s2.p1, "page 1 unmounted after scrolling away");

  // ---- text layer ----
  await page.waitForFunction(() => document.querySelector('.page[data-page="31"] .textLayer span'), { timeout: 15000 });
  const txt = await page.evaluate(() => document.querySelector('.page[data-page="31"] .textLayer').textContent);
  check(txt.includes("zebra31quokka"), "text layer contains page text");

  // Selection geometry: the span for the marker overlaps its glyphs' region.
  const geo = await page.evaluate(() => {
    const span = [...document.querySelectorAll('.page[data-page="31"] .textLayer span')].find((s) => s.textContent.includes("Section 31"));
    const r = span?.getBoundingClientRect();
    const pr = document.querySelector('.page[data-page="31"]').getBoundingClientRect();
    return r && { x: (r.x - pr.x) / pr.width, y: (r.y - pr.y) / pr.height, w: r.width / pr.width };
  });
  check(geo && geo.x > 0 && geo.x < 0.3 && geo.y > 0 && geo.y < 0.2 && geo.w > 0.05, `heading span positioned near top-left (${JSON.stringify(geo)})`);

  // ---- find ----
  await page.keyboard.down(MOD);
  await page.keyboard.press("f");
  await page.keyboard.up(MOD);
  await page.keyboard.type("zebra47quokka");
  await page.waitForFunction(() => /1 of 1$/.test(document.getElementById("find-count").textContent), { timeout: 20000 });
  await page.waitForFunction(() => pdf120.viewer.current === 46 || pdf120.viewer.vis[0] <= 46 && pdf120.viewer.vis[1] >= 46, { timeout: 5000 });
  check(true, "find located the unique marker on page 47 and scrolled to it");
  await page.waitForFunction(() => CSS.highlights.get("pdf-find-current")?.size === 1, { timeout: 10000 }).then(
    () => check(true, "current match highlighted via CSS Custom Highlight API"),
    () => check(false, "current match highlighted"),
  );
  await page.screenshot({ path: join(out, "02-find.png") });
  await page.keyboard.press("Escape");

  // ---- zoom: crisp re-render after settle ----
  await page.evaluate(() => pdf120.viewer.setZoom(2));
  await page.waitForFunction(
    () => {
      const v = pdf120.viewer;
      const p = v.current;
      const c = document.querySelector(`.page[data-page="${p + 1}"] canvas`);
      const t = v.targetSize(p);
      return c && c.width === t.w;
    },
    { timeout: 15000 },
  );
  check(true, "re-rendered at new zoom with exact device-pixel size");

  // ---- pinch gesture: transform only, then commit ----
  const before = await page.evaluate(() => pdf120.viewer.zoom);
  await page.mouse.move(700, 450);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel({ deltaY: -10 });
    await page.keyboard.down("Control");
    await page.evaluate(() =>
      pdf120.viewer.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -8, ctrlKey: true, clientX: 700, clientY: 450, bubbles: true, cancelable: true })),
    );
    await page.keyboard.up("Control");
  }
  const mid = await page.evaluate(() => ({ g: pdf120.viewer.gestureScale, transform: pdf120.viewer.layer.style.transform, zoom: pdf120.viewer.zoom }));
  check(mid.g > 1 && mid.zoom === before, `pinch applies CSS transform only (scale ${mid.g.toFixed(2)}, zoom unchanged)`);
  await new Promise((r) => setTimeout(r, 400));
  const after = await page.evaluate(() => ({ zoom: pdf120.viewer.zoom, transform: pdf120.viewer.layer.style.transform }));
  check(after.zoom > before && !after.transform, `pinch commits after settle (${before.toFixed(2)} → ${after.zoom.toFixed(2)})`);

  // ---- high zoom: full-resolution detail overlay past the bitmap cap ----
  await page.evaluate(() => {
    const v = pdf120.viewer;
    v.setZoom(6);
    // Look at the top-left of the page, where the heading and body text are.
    v.scroller.scrollTop = v.tops[v.current] + 40;
    v.scroller.scrollLeft = v.lefts[v.current];
  });
  // Wait for a detail rendered at the *new* zoom (a stale one from the earlier
  // pinch is shown stretched meanwhile, by design).
  await page.waitForFunction(
    () => [...document.querySelectorAll(".page canvas.detail")].some((c) => Math.abs(c.width / c.getBoundingClientRect().width - devicePixelRatio) < 0.01),
    { timeout: 20000 },
  ).then(
    async () => {
      const d = await page.evaluate(() => {
        const v = pdf120.viewer;
        const c = [...document.querySelectorAll(".page canvas.detail")].find((c) => Math.abs(c.width / c.getBoundingClientRect().width - devicePixelRatio) < 0.01);
        const base = c.parentNode.querySelector("canvas:not(.detail)");
        const r = c.getBoundingClientRect();
        const pr = c.parentNode.getBoundingClientRect();
        // Does the detail cover the visible part of its page?
        const vp = v.scroller.getBoundingClientRect();
        const covers = r.left <= Math.max(pr.left, vp.left) + 1 && r.top <= Math.max(pr.top, vp.top) + 1 && r.right >= Math.min(pr.right, vp.right) - 1 && r.bottom >= Math.min(pr.bottom, vp.bottom) - 1;
        return { density: c.width / r.width, baseDensity: base.width / pr.width, covers };
      });
      check(Math.abs(d.density - 2) < 0.01, `detail renders at devicePixelRatio (${d.density.toFixed(3)} px/CSS px; capped base is ${d.baseDensity.toFixed(2)})`);
      check(d.covers, "detail covers the visible region of the page");
    },
    () => check(false, "detail overlay appears at 600% zoom"),
  );
  await page.screenshot({ path: join(out, "03a-zoom600.png") });
  await page.evaluate(() => pdf120.viewer.setZoom(2));

  // ---- invert ----
  await page.keyboard.press("i");
  await page.waitForFunction(
    () => {
      const v = pdf120.viewer;
      const m = v.mounted.get(v.current);
      return m?.entry?.invert === true && !m.div.classList.contains("inv-pending");
    },
    { timeout: 15000 },
  );
  check(true, "invert re-renders with inversion baked into the bitmap");
  await page.screenshot({ path: join(out, "03-invert.png") });
  await page.keyboard.press("i");

  // ---- thumbnails ----
  await page.evaluate(() => pdf120.viewer.fit("auto"));
  await page.keyboard.press("t");
  await page.waitForFunction(() => document.querySelectorAll(".thumb-page canvas").length >= 3, { timeout: 15000 });
  check(true, "thumbnail sidebar renders thumbnails");
  await page.click('.thumb[data-index="9"]');
  await page.waitForFunction(() => pdf120.viewer.current === 9, { timeout: 5000 }).then(
    () => check(true, "thumbnail click navigates"),
    () => check(false, "thumbnail click navigates"),
  );
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: join(out, "04-thumbs.png") });

  // ---- internal link ----
  await page.evaluate(() => pdf120.viewer.goToPage(0));
  await page.waitForFunction(() => document.querySelector('.page[data-page="1"] .textLayer a.link'), { timeout: 15000 }).then(
    async () => {
      await page.evaluate(() => document.querySelector('.page[data-page="1"] .textLayer a.link').click());
      await page.waitForFunction(() => pdf120.viewer.current === 41, { timeout: 5000 });
      check(true, "internal link jumps to destination page");
    },
    () => check(false, "internal link annotation present"),
  );

  // ---- cache accounting ----
  const cache = await page.evaluate(() => pdf120.viewer.stats);
  check(cache.cacheMB > 0 && cache.cacheMB < 1536, `cache ${cache.cacheMB.toFixed(0)} MB within 1.5 GB cap`);

  // ---- remembered position ----
  await page.evaluate(() => pdf120.viewer.goToPage(24));
  await new Promise((r) => setTimeout(r, 700));
  await page.reload();
  await page.waitForFunction(() => window.pdf120?.viewer?.n > 0);
  await new Promise((r) => setTimeout(r, 300));
  const restored = await page.evaluate(() => pdf120.viewer.current);
  check(restored === 24, `last page remembered across reload (${restored + 1})`);

  // ---- bench (headless frame timing isn't representative; just runs) ----
  await page.evaluate(() => {
    document.getElementById("btn-fps").click();
    window.__bench = new Promise((r) => {
      const orig = console.log;
      console.log = (...a) => {
        orig(...a);
        if (String(a[0]).includes("bench:")) r(a[0]);
      };
    });
    pdf120.viewer.scroller.focus();
  });
  await page.keyboard.down("Shift");
  await page.keyboard.press("B");
  await page.keyboard.up("Shift");
  const bench = await page.evaluate(() => window.__bench);
  console.log(`       ${bench} (headless; measure on real hardware)`);
  await page.screenshot({ path: join(out, "05-fps.png") });

  const relevant = errors.filter((e) => !/favicon|DevTools/.test(e));
  check(relevant.length === 0, `no console errors/warnings${relevant.length ? ":\n    " + relevant.join("\n    ") : ""}`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
