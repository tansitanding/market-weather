import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
// Local-only development/preview bridge. No raw data is copied into dist or Git.
const snapshot = fileURLToPath(
  new URL("../.local/data/latest.json", import.meta.url),
);
function bridge(server: { middlewares: { use: (fn: any) => void } }) {
  server.middlewares.use(async (req: any, res: any, next: () => void) => {
    if ((req.url ?? "").split("?")[0] !== "/data/latest.json") return next();
    if (!["GET", "HEAD"].includes(req.method ?? "")) {
      res.statusCode = 405;
      res.end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const data = await readFile(snapshot);
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "No local validated snapshot" }));
    }
  });
}
export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  plugins: [
    {
      name: "local-snapshot-bridge",
      configureServer: bridge,
      configurePreviewServer: bridge,
    },
  ],
  build: { outDir: "../dist", emptyOutDir: true },
});
