// Serves the app for development the way the container does: /config.js is
// generated from the YNAB_CLIENT_ID environment variable, and responses carry
// the same Content-Security-Policy (see nginx/).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ID = process.env.YNAB_CLIENT_ID ?? "";

// The files the page loads; the same set the Dockerfile copies into the image.
const FILES = new Set(["/index.html", "/app.js", "/convert.js", "/ynab.js", "/style.css"]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src https://api.ynab.com; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/config.js") {
    res.writeHead(200, { ...HEADERS, "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    res.end(`export const YNAB_CLIENT_ID = ${JSON.stringify(CLIENT_ID)};\n`);
    return;
  }
  const file = path === "/" ? "/index.html" : path;
  if (!FILES.has(file)) {
    res.writeHead(404, HEADERS).end("Not found\n");
    return;
  }
  res.writeHead(200, { ...HEADERS, "Content-Type": TYPES[extname(file)], "Cache-Control": "no-cache" });
  res.end(await readFile(join(import.meta.dirname, file)));
}).listen(PORT, () => {
  console.log(`handynab on http://localhost:${PORT}/`);
  if (!CLIENT_ID) console.warn("YNAB_CLIENT_ID is not set; connecting to YNAB will not work.");
});
