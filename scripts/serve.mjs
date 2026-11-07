// Static server for dist/ so the viewer can be exercised as a plain page
// (outside the extension): http://localhost:8120/viewer.html?file=/test.pdf
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const roots = [join(root, "dist"), join(root, "test/fixtures")];
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".pdf": "application/pdf", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm", ".map": "application/json" };

export function serve(port = Number(process.env.PORT) || 8120) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    for (const r of roots) {
      try {
        const body = await readFile(join(r, path === "/" ? "viewer.html" : path));
        res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" });
        return res.end(body);
      } catch {}
    }
    res.writeHead(404).end("not found");
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve();
  console.log("Serving dist/ and test/fixtures/ at http://localhost:8120/viewer.html?file=/sample.pdf");
}
