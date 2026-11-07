// Bundles the extension into dist/. Load dist/ as an unpacked extension.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeIcons } from "./icons.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const pdfjs = join(root, "node_modules/pdfjs-dist");
const watch = process.argv.includes("--watch");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "pdfjs"), { recursive: true });

// Static files.
cpSync(join(root, "static"), dist, { recursive: true });
// pdf.js parser worker + resources (fonts, CMaps, wasm decoders, ICC profiles).
cpSync(join(pdfjs, "build/pdf.worker.min.mjs"), join(dist, "pdfjs/pdf.worker.min.mjs"));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(pdfjs, dir), join(dist, "pdfjs", dir), { recursive: true });
}
for (const [size, png] of Object.entries(makeIcons())) {
  writeFileSync(join(dist, `icon-${size}.png`), png);
}

const common = {
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: "linked",
  minify: !watch,
  legalComments: "none",
  logLevel: "info",
};

const builds = [
  { entryPoints: { viewer: "src/viewer/main.js" }, outdir: dist },
  { entryPoints: { "render-worker": "src/worker/render-worker.js" }, outdir: dist },
  { entryPoints: { background: "src/background.js" }, outdir: dist },
  // Content scripts can't be ES modules.
  { entryPoints: { content: "src/content.js" }, outdir: dist, format: "iife" },
];

if (watch) {
  for (const b of builds) (await esbuild.context({ ...common, ...b })).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
}
