import express from 'express';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { isSea, getRawAsset } from 'node:sea';

// When packaged as a single executable (Node SEA), import.meta.url is not a
// real file path — __dirname is then only used for dev-mode disk reads anyway.
const __dirname = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

const IS_PACKAGED = isSea();
const APP_ID = 'bookstack-companion';
const APP_VERSION = '2.0.0';
const DEFAULT_PORT = Number(process.env.PORT) || 3000;

// Editions: the packaged (shared) app is image localization only; running from
// source keeps the full toolset. Override with BSC_EDITION=full|localizer.
const EDITION = process.env.BSC_EDITION || (IS_PACKAGED ? 'localizer' : 'full');

// Keys of all files embedded into the packaged executable (public/ + extensions).
const ASSET_KEYS = (() => {
  if (!IS_PACKAGED) return null;
  try {
    return new Set(JSON.parse(Buffer.from(getRawAsset('asset-manifest.json')).toString('utf8')));
  } catch {
    return new Set();
  }
})();

// Keep the server alive if a background fetch/timer rejects unexpectedly — log
// it rather than letting the default handler terminate the process.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ---------------------------------------------------------------------------
// Config — stored per-user so the packaged app never needs a hand-edited file.
// A config.json beside the source is still honored in dev when no user-level
// config exists. Saving from the in-app settings writes the user-level file
// and applies immediately (no restart needed).
// ---------------------------------------------------------------------------
function userConfigDir() {
  if (process.env.BSC_CONFIG_DIR) return process.env.BSC_CONFIG_DIR;
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'BookStack Companion');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'BookStack Companion');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bookstack-companion');
}

const USER_CONFIG_PATH = join(userConfigDir(), 'config.json');
const LEGACY_CONFIG_PATH = IS_PACKAGED ? null : join(__dirname, 'config.json');

const DEFAULT_TEMPLATES = [
  {
    id: 'script',
    name: 'PowerShell Script',
    description: 'Standard script documentation with summary, parameters, risk notes, and change log',
  },
  {
    id: 'kb',
    name: 'KB Article',
    description: 'Process or how-to article with overview, prerequisites, steps, gotchas, and rollback',
  },
  {
    id: 'raw',
    name: 'Raw / No Template',
    description: 'Publish content as-is with no formatting applied',
  },
];

const state = {
  url: '',
  tokenId: '',
  tokenSecret: '',
  host: '',
  templates: DEFAULT_TEMPLATES,
  configured: false,
  source: null, // which config file is active
};

function applyConfig(cfg) {
  const bs = cfg?.bookstack ?? {};
  state.url = (bs.url || '').trim().replace(/\/+$/, '');
  state.tokenId = (bs.token_id || '').trim();
  state.tokenSecret = (bs.token_secret || '').trim();
  try {
    state.host = state.url ? new URL(state.url).host : '';
  } catch {
    state.host = '';
  }
  if (Array.isArray(cfg?.templates) && cfg.templates.length) state.templates = cfg.templates;
  state.configured = Boolean(state.url && state.tokenId && state.tokenSecret);
}

async function loadConfig() {
  for (const path of [USER_CONFIG_PATH, LEGACY_CONFIG_PATH].filter(Boolean)) {
    try {
      applyConfig(JSON.parse(await readFile(path, 'utf8')));
      state.source = path;
      return;
    } catch {
      /* not present or unreadable — try the next location */
    }
  }
}

async function saveConfig(bookstack) {
  const cfg = { bookstack };
  if (state.templates !== DEFAULT_TEMPLATES) cfg.templates = state.templates;
  await mkdir(dirname(USER_CONFIG_PATH), { recursive: true });
  await writeFile(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  applyConfig(cfg);
  state.source = USER_CONFIG_PATH;
}

const authHeader = () => `Token ${state.tokenId}:${state.tokenSecret}`;

// Try a real authenticated call against a candidate config and return a
// human-actionable verdict — used by the setup screen's "Test connection".
async function testBookstack({ url, token_id, token_secret }) {
  const base = (url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, reason: 'The address must start with http:// or https://.' };
  }
  let res;
  try {
    res = await fetch(`${base}/api/books?count=1`, {
      headers: { Authorization: `Token ${token_id}:${token_secret}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return {
      ok: false,
      reason:
        err.name === 'TimeoutError'
          ? 'No answer after 8 seconds. Check the address and that BookStack is running.'
          : `Could not reach that address (${err.cause?.code || err.message}).`,
    };
  }
  let data = null;
  try {
    data = JSON.parse(await res.text());
  } catch {
    /* non-JSON response — handled below */
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason:
        'BookStack answered but rejected the token. Check the Token ID and Secret, and that ' +
        'your BookStack role has the "Access System API" permission.',
    };
  }
  if (!res.ok) return { ok: false, reason: `The server responded with status ${res.status}.` };
  if (!data || typeof data.total !== 'number') {
    return {
      ok: false,
      reason: 'That address responded, but not like a BookStack API. Check the address is the wiki itself.',
    };
  }
  return { ok: true, books: data.total };
}

// ---------------------------------------------------------------------------
// BookStack proxy helper
// ---------------------------------------------------------------------------
async function bookstackFetch(path, options = {}) {
  if (!state.configured) {
    return {
      ok: false,
      status: 503,
      data: { error: { message: 'BookStack connection is not set up yet — open Settings.' } },
    };
  }
  const target = `${state.url}${path}`;
  const res = await fetch(target, {
    ...options,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

// Pull a human-readable message out of a BookStack error payload.
function extractError(data, status) {
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  if (data?.raw) return String(data.raw).slice(0, 300);
  return `BookStack responded with status ${status}`;
}

// Build a direct URL to a BookStack page from a create/read/update response.
function pageLink(data) {
  return data?.slug && data?.book_slug
    ? `${state.url}/books/${data.book_slug}/page/${data.slug}`
    : `${state.url}/link/${data?.id}`;
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (stored / no compression) — dependency-free, used to
// package the browser-bridge extension as a .zip (Chrome) or .xpi (Firefox).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Buffer }] → Buffer of a valid stored ZIP archive.
function makeZip(files) {
  const DOS_DATE = 0x0021; // 1980-01-01
  const DOS_TIME = 0x0000;
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, end]);
}

// Read every (flat) file in an extension folder into [{name, data}] — from
// disk in dev, from the embedded assets when running as a packaged executable.
async function readExtensionFiles(browser) {
  if (IS_PACKAGED) {
    const prefix = browser === 'firefox' ? 'extension-firefox/' : 'extension/';
    return [...ASSET_KEYS]
      .filter((k) => k.startsWith(prefix) && !k.endsWith('README.md'))
      .map((k) => ({ name: k.slice(prefix.length), data: Buffer.from(getRawAsset(k)) }));
  }
  const dir = EXTENSION_DIRS[browser];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name === 'README.md') continue; // not needed inside the package
    files.push({ name: e.name, data: await readFile(join(dir, e.name)) });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Image localizer helpers
// ---------------------------------------------------------------------------

// Pull image URLs out of a page's HTML or markdown content.
function extractImageUrls(content) {
  if (!content) return [];
  const urls = new Set();
  // HTML <img src="...">
  const imgRe = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = imgRe.exec(content)) !== null) urls.add(m[1]);
  // Markdown ![alt](url ...)
  const mdRe = /!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g;
  while ((m = mdRe.exec(content)) !== null) {
    urls.add(m[1].replace(/^<|>$/g, ''));
  }
  return [...urls];
}

// An image is "external" if it lives on a different host than this BookStack.
function isExternalImage(rawUrl) {
  let u;
  try {
    const norm = rawUrl.startsWith('//') ? `http:${rawUrl}` : rawUrl;
    u = new URL(norm);
  } catch {
    return false; // relative URL → already local
  }
  if (!/^https?:$/.test(u.protocol)) return false; // data:, mailto:, etc.
  return u.host !== state.host;
}

// Browser-like headers. Many image hosts (WordPress hotlink protection, CDNs)
// reject bot User-Agents or non-browser requests, which produces false
// "unreachable" results and failed downloads. Presenting as a browser — and
// sending a Referer from the image's own origin — defeats most of that.
function browserHeaders(url, auth) {
  const h = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  try {
    const u = new URL(url.startsWith('//') ? `http:${url}` : url);
    h.Referer = `${u.protocol}//${u.host}/`;
    // Optional auth passthrough: borrow the user's browser User-Agent + cookie
    // (e.g. a Cloudflare cf_clearance cookie) for hosts that challenge bots.
    if (auth) {
      if (auth.userAgent) h['User-Agent'] = auth.userAgent;
      const host = u.host.toLowerCase();
      const match = (auth.cookies || []).find((c) => {
        const d = (c.domain || '').toLowerCase().replace(/^\./, '');
        return d && (host === d || host.endsWith(`.${d}`));
      });
      if (match?.cookie) h.Cookie = match.cookie;
    }
  } catch {
    /* no referer if URL won't parse */
  }
  return h;
}

// Lightweight reachability + size probe for the dry-run report. Never downloads
// the full image — uses HEAD, then a single-byte ranged GET as a fallback.
async function probeImage(url, auth) {
  const headers = browserHeaders(url, auth);
  // Try HEAD first.
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers,
    });
    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        contentType: (res.headers.get('content-type') || '').split(';')[0],
        size: Number(res.headers.get('content-length')) || null,
      };
    }
    // Some servers reject HEAD (405) but serve GET — fall through to ranged GET.
    if (res.status !== 405 && res.status !== 501) {
      return { ok: false, status: res.status };
    }
  } catch {
    /* fall through to ranged GET */
  }
  // Fallback: ranged GET for just the first byte.
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, Range: 'bytes=0-0' },
    });
    const contentType = (res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok && res.status !== 206) {
      await res.body?.cancel?.();
      return { ok: false, status: res.status, contentType };
    }
    // Prefer content-range total; else content-length.
    const range = res.headers.get('content-range'); // e.g. "bytes 0-0/12345"
    const total = range && range.includes('/') ? Number(range.split('/')[1]) : null;
    await res.body?.cancel?.();
    return {
      ok: true,
      status: res.status,
      contentType,
      size: total || Number(res.headers.get('content-length')) || null,
    };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
}

// Resolve a scope ({ bookId?, chapterId?, pageId? }) to a flat list of page summaries.
async function listPagesInScope({ bookId, chapterId, pageId } = {}) {
  if (pageId) {
    const { ok, data } = await bookstackFetch(`/api/pages/${pageId}`);
    return ok ? [{ id: data.id, name: data.name, book_id: data.book_id }] : [];
  }
  const pages = [];
  let offset = 0;
  const count = 500;
  for (;;) {
    let q = `?count=${count}&offset=${offset}`;
    if (chapterId) q += `&filter%5Bchapter_id%5D=${chapterId}`;
    else if (bookId) q += `&filter%5Bbook_id%5D=${bookId}`;
    const { ok, data } = await bookstackFetch(`/api/pages${q}`);
    if (!ok) break;
    const batch = data.data || [];
    pages.push(...batch);
    if (batch.length < count) break;
    offset += count;
  }
  return pages;
}

// Choose the editable content field for a page based on its editor type.
function pageSource(detail) {
  const isMd =
    (detail.editor || '').includes('markdown') ||
    (!detail.raw_html && !!detail.markdown);
  return {
    isMarkdown: isMd,
    content: isMd ? detail.markdown || '' : detail.raw_html || '',
  };
}

// Derive a safe upload filename from a URL + content type.
function filenameFromUrl(url, contentType) {
  let base = 'image';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'image';
  } catch {
    /* keep default */
  }
  base = base.split('?')[0].replace(/[^\w.\-]+/g, '_').slice(0, 100) || 'image';
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
    const extMap = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'image/bmp': 'bmp',
    };
    base += `.${extMap[(contentType || '').split(';')[0]] || 'png'}`;
  }
  return base;
}

async function downloadImage(url, auth) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
    headers: browserHeaders(url, auth),
  });
  if (!res.ok) throw new Error(`source returned ${res.status}`);
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error('source returned 0 bytes');

  // Guard against login/redirect pages masquerading as images: reject HTML and
  // anything that doesn't look like an image by content-type or magic bytes.
  if (/^text\/html\b/i.test(contentType)) {
    throw new Error('source returned an HTML page (likely auth/redirect), not an image');
  }
  if (contentType && !/^image\//i.test(contentType) && !looksLikeImage(buf)) {
    throw new Error(`source returned non-image content (${contentType})`);
  }
  return { buf, contentType: /^image\//i.test(contentType) ? contentType : sniffImageType(buf) };
}

// Magic-byte sniff for the common web image formats.
function sniffImageType(buf) {
  if (buf.length < 4) return 'application/octet-stream';
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp';
  const head = b.slice(0, 256).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function looksLikeImage(buf) {
  return sniffImageType(buf) !== 'application/octet-stream';
}

// Upload bytes into BookStack's image gallery, attached to a page.
async function uploadToGallery(pageId, buf, filename, contentType) {
  const form = new FormData();
  form.append('type', 'gallery');
  form.append('uploaded_to', String(pageId));
  form.append(
    'image',
    new Blob([buf], { type: contentType || 'application/octet-stream' }),
    filename
  );
  const res = await fetch(`${state.url}/api/image-gallery`, {
    method: 'POST',
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    body: form,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(extractError(data, res.status));
  if (!data.url) throw new Error('upload succeeded but no URL returned');
  return data.url;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '5mb' }));

// Static frontend: from disk in dev, from embedded assets when packaged.
if (IS_PACKAGED) {
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    let p;
    try {
      p = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (p === '/') p = '/index.html';
    const key = `public${p}`;
    if (!ASSET_KEYS.has(key)) return next();
    res.type(extname(p) || '.html');
    res.send(Buffer.from(getRawAsset(key)));
  });
} else {
  app.use(express.static(join(__dirname, 'public')));
}

// Identity ping — lets a second launch detect an already-running instance.
app.get('/api/app/identity', (_req, res) => {
  res.json({ app: APP_ID, version: APP_VERSION, edition: EDITION });
});

// Publish-tab routes are not part of the localizer-only edition.
const fullOnly = (_req, res, next) => {
  if (EDITION === 'full') return next();
  res.status(404).json({ error: 'Not available in this edition of the app.' });
};

// Expose templates to the frontend.
app.get('/api/config/templates', fullOnly, (_req, res) => {
  res.json(state.templates);
});

// Current connection settings (sanitized — the secret never leaves the server).
app.get('/api/config', (_req, res) => {
  res.json({
    configured: state.configured,
    url: state.url,
    tokenIdHint: state.tokenId ? `${state.tokenId.slice(0, 4)}…${state.tokenId.slice(-4)}` : '',
    edition: EDITION,
  });
});

// Test candidate settings without saving. Blank token fields fall back to the
// saved ones, so an existing setup can be re-tested after only changing the URL.
app.post('/api/config/test', async (req, res) => {
  const { url, token_id, token_secret } = req.body ?? {};
  res.json(
    await testBookstack({
      url,
      token_id: (token_id || '').trim() || state.tokenId,
      token_secret: (token_secret || '').trim() || state.tokenSecret,
    })
  );
});

// Save settings to the per-user config file and apply them immediately.
app.put('/api/config', async (req, res) => {
  const { url, token_id, token_secret } = req.body ?? {};
  const bookstack = {
    url: (url || '').trim().replace(/\/+$/, ''),
    token_id: (token_id || '').trim() || state.tokenId,
    token_secret: (token_secret || '').trim() || state.tokenSecret,
  };
  if (!bookstack.url || !bookstack.token_id || !bookstack.token_secret) {
    return res.status(400).json({ error: 'Address, Token ID, and Token Secret are all required.' });
  }
  try {
    await saveConfig(bookstack);
    res.json({ configured: true });
  } catch (err) {
    res.status(500).json({ error: `Could not save settings: ${err.message}` });
  }
});

// Browser-bridge extension: folder paths (for copy-paste install instructions).
const EXTENSION_DIRS = {
  chrome: join(__dirname, 'extension'),
  firefox: join(__dirname, 'extension-firefox'),
};

app.get('/api/extension/info', (_req, res) => {
  if (IS_PACKAGED) return res.json({});
  res.json({
    chromePath: EXTENSION_DIRS.chrome,
    firefoxPath: EXTENSION_DIRS.firefox,
  });
});

// Download the extension packaged: .zip for Chromium, .xpi for Firefox.
app.get('/api/extension/download', async (req, res) => {
  const browser = req.query.browser === 'firefox' ? 'firefox' : 'chrome';
  try {
    const files = await readExtensionFiles(browser);
    const zip = makeZip(files);
    const filename =
      browser === 'firefox' ? 'bookstack-bridge-firefox.xpi' : 'bookstack-bridge-chrome.zip';
    const type = browser === 'firefox' ? 'application/x-xpinstall' : 'application/zip';
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zip);
  } catch (err) {
    res.status(500).json({ error: `Could not package extension: ${err.message}` });
  }
});

// Connection ping — BookStack GET /api/docs.
app.get('/api/bookstack/status', async (_req, res) => {
  try {
    const { ok, status } = await bookstackFetch('/api/docs');
    if (ok) return res.json({ connected: true });
    return res.status(200).json({ connected: false, status });
  } catch (err) {
    return res.status(200).json({ connected: false, error: err.message });
  }
});

// List books.
app.get('/api/bookstack/books', async (_req, res) => {
  try {
    // count=500 to fetch all books in one pass for typical local instances.
    const { ok, status, data } = await bookstackFetch('/api/books?count=500&sort=name');
    if (!ok) return res.status(status).json({ error: extractError(data, status) });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Could not reach BookStack: ${err.message}` });
  }
});

// Book contents (used for chapters).
app.get('/api/bookstack/books/:id/contents', async (req, res) => {
  try {
    const { ok, status, data } = await bookstackFetch(
      `/api/books/${encodeURIComponent(req.params.id)}`
    );
    if (!ok) return res.status(status).json({ error: extractError(data, status) });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Could not reach BookStack: ${err.message}` });
  }
});

// Create a page.
app.post('/api/bookstack/pages', fullOnly, async (req, res) => {
  try {
    const { book_id, chapter_id, name, markdown } = req.body ?? {};

    if (!name || !markdown) {
      return res.status(400).json({ error: 'Title and content are required.' });
    }
    if (!book_id && !chapter_id) {
      return res.status(400).json({ error: 'A book or chapter must be selected.' });
    }

    const payload = { name, markdown };
    if (chapter_id) payload.chapter_id = Number(chapter_id);
    else payload.book_id = Number(book_id);

    const { ok, status, data } = await bookstackFetch('/api/pages', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!ok) return res.status(status).json({ error: extractError(data, status) });

    res.json({ ...data, link: pageLink(data) });
  } catch (err) {
    res.status(502).json({ error: `Could not reach BookStack: ${err.message}` });
  }
});

// Fetch a single page for editing.
app.get('/api/bookstack/pages/:id', fullOnly, async (req, res) => {
  try {
    const { ok, status, data } = await bookstackFetch(
      `/api/pages/${encodeURIComponent(req.params.id)}`
    );
    if (!ok) return res.status(status).json({ error: extractError(data, status) });
    res.json({
      id: data.id,
      name: data.name,
      book_id: data.book_id,
      chapter_id: data.chapter_id,
      editor: data.editor,
      markdown: data.markdown || '',
      html: data.html || '',
      raw_html: data.raw_html || '',
      updated_at: data.updated_at,
      link: pageLink(data),
    });
  } catch (err) {
    res.status(502).json({ error: `Could not reach BookStack: ${err.message}` });
  }
});

// Full-text search across the wiki (books/chapters/pages).
app.get('/api/bookstack/search', fullOnly, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ data: [] });
    const { ok, status, data } = await bookstackFetch(
      `/api/search?query=${encodeURIComponent(q)}&count=25`
    );
    if (!ok) return res.status(status).json({ error: extractError(data, status) });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Search failed: ${err.message}` });
  }
});

// Update an existing page (title + markdown content).
app.put('/api/bookstack/pages/:id', fullOnly, async (req, res) => {
  try {
    const { name, markdown } = req.body ?? {};
    if (!name || !markdown) {
      return res.status(400).json({ error: 'Title and content are required.' });
    }
    const { ok, status, data } = await bookstackFetch(
      `/api/pages/${encodeURIComponent(req.params.id)}`,
      { method: 'PUT', body: JSON.stringify({ name, markdown }) }
    );
    if (!ok) return res.status(status).json({ error: extractError(data, status) });
    res.json({ ...data, link: pageLink(data) });
  } catch (err) {
    res.status(502).json({ error: `Could not reach BookStack: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Image localizer routes
// ---------------------------------------------------------------------------

// Dry-run: scan a scope and report external images found per page. Changes nothing.
app.post('/api/localize/scan', async (req, res) => {
  try {
    const { bookId, chapterId, pageId, auth } = req.body ?? {};
    const summaries = await listPagesInScope({ bookId, chapterId, pageId });

    const pages = [];
    const totals = { pagesScanned: summaries.length, pagesWithExternal: 0, externalImages: 0, reachable: 0, unreachable: 0 };

    for (const summary of summaries) {
      const { ok, data } = await bookstackFetch(`/api/pages/${summary.id}`);
      if (!ok) continue;

      const { content } = pageSource(data);
      const externalUrls = [...new Set(extractImageUrls(content).filter(isExternalImage))];
      if (!externalUrls.length) continue;

      // Probe each external image concurrently.
      const images = await Promise.all(
        externalUrls.map(async (url) => ({ url, ...(await probeImage(url, auth)) }))
      );

      images.forEach((img) => {
        totals.externalImages += 1;
        if (img.ok) totals.reachable += 1;
        else totals.unreachable += 1;
      });
      totals.pagesWithExternal += 1;

      pages.push({
        id: data.id,
        name: data.name,
        book_id: data.book_id,
        editor: data.editor,
        link: `${state.url}/link/${data.id}`,
        images,
      });
    }

    res.json({ totals, pages });
  } catch (err) {
    res.status(502).json({ error: `Scan failed: ${err.message}` });
  }
});

// Apply: download the selected external images, re-host them in BookStack, and
// rewrite each page's content to point at the local copies.
app.post('/api/localize/apply', async (req, res) => {
  try {
    const { selections, auth } = req.body ?? {};
    if (!Array.isArray(selections) || !selections.length) {
      return res.status(400).json({ error: 'No pages/images selected.' });
    }

    const results = [];

    for (const sel of selections) {
      const pageId = sel.pageId;
      const urls = [...new Set((sel.urls || []).filter(isExternalImage))];
      const pageResult = { pageId, name: sel.name, localized: [], failed: [], updated: false };

      if (!urls.length) {
        results.push(pageResult);
        continue;
      }

      // Fetch current content.
      const { ok, data } = await bookstackFetch(`/api/pages/${pageId}`);
      if (!ok) {
        pageResult.failed.push({ url: '(page)', error: 'could not fetch page' });
        results.push(pageResult);
        continue;
      }

      const { isMarkdown, content: original } = pageSource(data);
      let content = original;
      const provided = sel.blobs || {}; // url -> { dataBase64, contentType } from the browser bridge

      for (const url of urls) {
        try {
          let buf;
          let contentType;
          const fromBrowser = provided[url];
          if (fromBrowser?.dataBase64) {
            // Bytes fetched by the browser extension (e.g. Cloudflare-protected).
            buf = Buffer.from(fromBrowser.dataBase64, 'base64');
            contentType = (fromBrowser.contentType || '').split(';')[0].trim() || sniffImageType(buf);
            if (!buf.byteLength) throw new Error('browser returned 0 bytes');
            if (/^text\/html\b/i.test(contentType) || (!/^image\//i.test(contentType) && !looksLikeImage(buf))) {
              throw new Error('browser-provided content is not an image');
            }
          } else {
            ({ buf, contentType } = await downloadImage(url, auth));
          }
          const filename = filenameFromUrl(url, contentType);
          const newUrl = await uploadToGallery(pageId, buf, filename, contentType);
          // Replace every occurrence of the old URL with the new local one.
          content = content.split(url).join(newUrl);
          pageResult.localized.push({ from: url, to: newUrl });
        } catch (err) {
          pageResult.failed.push({ url, error: err.message });
        }
      }

      // Only write the page back if something actually changed.
      if (content !== original && pageResult.localized.length) {
        const payload = isMarkdown ? { markdown: content } : { html: content };
        const upd = await bookstackFetch(`/api/pages/${pageId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        if (upd.ok) {
          pageResult.updated = true;
        } else {
          pageResult.failed.push({ url: '(page update)', error: extractError(upd.data, upd.status) });
        }
      }

      results.push(pageResult);
    }

    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: `Apply failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the printed URL still works */
  }
}

// Auto-open the browser when running as the packaged app (or via BSC_OPEN=1).
// BSC_NO_OPEN=1 suppresses it, e.g. when running as a background service.
const WANT_OPEN =
  process.env.BSC_NO_OPEN !== '1' && (IS_PACKAGED || process.env.BSC_OPEN === '1');

async function isOurInstance(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/app/identity`, {
      signal: AbortSignal.timeout(1500),
    });
    return (await res.json())?.app === APP_ID;
  } catch {
    return false;
  }
}

function startServer(port, remaining = 10) {
  const server = app.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  BookStack Companion v${APP_VERSION}${EDITION === 'localizer' ? ' — Image Localizer edition' : ''}`);
    console.log(`  ─────────────────────────────────────────`);
    console.log(`  Running at   ${url}`);
    console.log(`  BookStack    ${state.configured ? state.url : '(not set up yet — finish setup in the browser)'}`);
    console.log(`  Settings     ${state.source || `${USER_CONFIG_PATH} (created on first save)`}\n`);
    if (WANT_OPEN) openBrowser(url);
  });
  server.on('error', async (err) => {
    if (err.code !== 'EADDRINUSE' || remaining <= 0) {
      console.error(`Could not start server: ${err.message}`);
      process.exit(1);
    }
    // If the port is held by another copy of this app, just open that one.
    if (await isOurInstance(port)) {
      console.log(`BookStack Companion is already running at http://localhost:${port} — opening it.`);
      openBrowser(`http://localhost:${port}`);
      process.exit(0);
    }
    startServer(port + 1, remaining - 1);
  });
}

async function main() {
  await loadConfig();
  startServer(DEFAULT_PORT);
}

main();
