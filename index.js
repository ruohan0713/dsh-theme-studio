/**
 * Theme Studio — Host half.
 *
 * Serves the plugin's own wallpaper directory over the Web GUI origin:
 *
 *   GET /theme-studio/manifest.json          available wallpaper files + their
 *                                            revisions + the directory to drop
 *                                            new images into
 *   GET /theme-studio/wallpapers/<file>      one wallpaper (jpg/png/webp/avif)
 *   POST /theme-studio/diag                  opt-in, write-only diagnostics sink
 *                                            used while tuning the theme; it
 *                                            answers 403 unless the package
 *                                            directory contains a file named
 *                                            `enable-diagnostics`, and it only
 *                                            ever writes
 *                                            `theme-studio-diagnostics.json`
 *                                            beside this module.
 *
 * The images are user-replaceable: dropping `<theme-id>.jpg` (or .png/.webp/
 * .avif) into `wallpapers/` is picked up on the next manifest read, with no
 * restart, because every read hits the filesystem. Responses are revalidated
 * (`no-cache` + a size/mtime ETag), never stored as immutable.
 *
 * @module dsh-theme-studio
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WALLPAPER_DIR = join(HERE, 'wallpapers');
const SENTINEL = join(HERE, 'enable-diagnostics');
const DIAG_FILE = join(HERE, 'theme-studio-diagnostics.json');
const ROUTE = '/theme-studio';
const MAX_DIAG_BYTES = 2 * 1024 * 1024;

/** Supported wallpaper media types. */
const MEDIA_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
]);

/** Services this plugin needs before it can serve assets. */
export const inject = ['webServer'];

/** JSON response helper. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Read the wallpaper directory into a manifest. A missing directory is a
 * valid empty manifest, not an error: the client falls back to CSS art.
 * @returns {Promise<object>} the manifest document.
 */
async function readManifest() {
  const wallpapers = [];
  let entries = [];
  try {
    entries = await readdir(WALLPAPER_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!MEDIA_TYPES.has(ext)) continue;
    const path = join(WALLPAPER_DIR, entry.name);
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size === 0) continue;
    const theme = entry.name.slice(0, entry.name.length - ext.length);
    wallpapers.push({
      name: entry.name,
      theme,
      extension: ext,
      bytes: info.size,
      mtimeMs: Math.round(info.mtimeMs),
      url: `${ROUTE}/wallpapers/${encodeURIComponent(entry.name)}`,
    });
  }
  wallpapers.sort((left, right) => left.name.localeCompare(right.name));
  return {
    version: 1,
    route: ROUTE,
    directory: WALLPAPER_DIR,
    diagnostics: existsSync(SENTINEL),
    wallpapers,
  };
}

/** MTag for one file: content revision cheap enough to compute per request. */
function etagOf(info) {
  return `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
}

/**
 * Serve one wallpaper file request.
 * @param {Request} request - fetched request; only method and path are read.
 * @returns {Promise<Response>} the file response, or a 404/400.
 */
async function serveWallpaper(request) {
  const pathname = new URL(request.url).pathname;
  const prefix = `${ROUTE}/wallpapers/`;
  if (!pathname.startsWith(prefix)) return new Response(null, { status: 404 });
  let name;
  try {
    name = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('\0') || name.split('.').includes('..')) {
    return new Response(null, { status: 404 });
  }
  const ext = extname(name).toLowerCase();
  const mediaType = MEDIA_TYPES.get(ext);
  if (mediaType === undefined) return new Response(null, { status: 404 });
  const target = resolve(normalize(join(WALLPAPER_DIR, name)));
  if (target !== WALLPAPER_DIR && !target.startsWith(WALLPAPER_DIR + sep)) return new Response(null, { status: 404 });
  let info;
  let bytes;
  try {
    info = await stat(target);
    if (!info.isFile() || info.size === 0) return new Response(null, { status: 404 });
    const etag = etagOf(info);
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: { etag, 'cache-control': 'no-cache' },
      });
    }
    bytes = await readFile(target);
    const headers = {
      'content-type': mediaType,
      'cache-control': 'no-cache',
      etag,
      'content-length': String(bytes.byteLength),
      'x-content-type-options': 'nosniff',
    };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(bytes, { status: 200, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/**
 * Resource route: manifest and wallpaper reads.
 * @param {Request} request - the browser request.
 * @returns {Promise<Response>} the response.
 */
async function resource(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === `${ROUTE}/manifest.json`) {
    return json(await readManifest());
  }
  if (pathname.startsWith(`${ROUTE}/wallpapers/`)) {
    return serveWallpaper(request);
  }
  return new Response(null, { status: 404 });
}

/**
 * Opt-in diagnostics sink. Enabled only while the sentinel file exists.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleDiag(req, res) {
  try {
    if (!existsSync(SENTINEL)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('diagnostics disabled');
      return;
    }
    if (req.method === 'GET') {
      // Fallback channel for bridges that do not carry POST: base64 JSON in
      // the query string, kept small by the client.
      const url = new URL(req.url || '/', 'http://local');
      const encoded = url.searchParams.get('data');
      if (encoded === null) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('missing data');
        return;
      }
      const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      await writeFile(DIAG_FILE, JSON.stringify({ receivedAt: new Date().toISOString(), payload }, null, 2) + '\n', 'utf8');
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'content-type': 'text/plain; charset=utf-8' });
      res.end('GET or POST only');
      return;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_DIAG_BYTES) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('too large');
        return;
      }
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    await writeFile(DIAG_FILE, JSON.stringify({ receivedAt: new Date().toISOString(), payload }, null, 2) + '\n', 'utf8');
    res.writeHead(204);
    res.end();
  } catch (error) {
    try {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(error && error.message ? error.message : error));
    } catch {
      /* the socket may already be gone */
    }
  }
}

/**
 * Register the asset and diagnostics routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, resource }),
    'theme-studio: wallpaper + manifest route',
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${ROUTE}/diag`, handler: handleDiag }),
    'theme-studio: diagnostics sink',
  );
}
