#!/usr/bin/env node
/**
 * Static file server for the GMW dashboard SPA (Vite build output).
 *
 * Replaces `node .next/standalone/server.js`. The `gmw-frontend` systemd
 * unit ExecStarts this file on :4017 behind the gmw-proxy nginx
 * (`GMW_FRONTEND_PORT` overrides the port).
 *
 * Node builtins only — no dependencies — so the shipped runtime is just
 * `dist/` plus the node binary, and there is nothing to install at
 * deploy time.
 *
 * Two behaviours nginx cannot provide on its own:
 *
 *  1. SPA fallback — any path that is not a real file (a deep link like
 *     /moderation, or a trailing-slash bookmark /moderation/ left over
 *     from the `trailingSlash: true` Next.js era) serves index.html with
 *     a 200 so the client router can take over. An unknown path therefore
 *     renders the app's own 404 page, not the proxy's.
 *  2. Split caching — Vite hashes asset filenames, so /assets/* is
 *     immutable for a year, while the shell (index.html, served for every
 *     fallback) must revalidate or a deploy strands browsers on stale
 *     asset URLs.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const INDEX = path.join(DIST, "index.html");
const PORT = Number(process.env.GMW_FRONTEND_PORT ?? 4017);
const HOST = "127.0.0.1";

const MIME = new Map(
  Object.entries({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
  }),
);

function cacheControl(pathname) {
  // Hashed build output — safe to cache forever.
  if (pathname.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

async function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const rel = path.normalize(decoded).replace(/^[/\\]+/, "");
  const abs = path.join(DIST, rel);
  // Jail: a resolved path outside dist/ (e.g. /%2e%2e/...) is treated as
  // missing, which falls through to the SPA shell below — never served.
  if (abs !== DIST && !abs.startsWith(DIST + path.sep)) return null;
  try {
    if ((await stat(abs)).isFile()) return abs;
  } catch {
    // Missing — fall through to the shell.
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = (await resolveFile(url.pathname)) ?? INDEX;
    const isShell = file === INDEX;
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type":
        MIME.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
      "content-length": body.length,
      // The shell carries the asset hashes for this deploy — it must
      // revalidate, or browsers pin to stale bundles after a release.
      "cache-control": isShell ? "no-cache" : cacheControl(url.pathname),
    });
    res.end(req.method === "GET" ? body : undefined);
  } catch (err) {
    console.error(`[gmw-frontend] ${req.method} ${req.url} → 500`, err);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("internal error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[gmw-frontend] serving ${DIST} on http://${HOST}:${PORT}`);
});
