// server.js — sgapi kiosk backend
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const PORT = 8080;
const ROOT = __dirname;
const CONTENT_DIR = path.join(ROOT, 'content');
const DB_PATH = path.join(ROOT, 'kiosk.db');

if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });

// ---------- Database ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS slides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,           -- 'image' | 'video' | 'web' | 'html'
    src TEXT NOT NULL,            -- filename (for image/video/html) or URL (for web)
    duration INTEGER DEFAULT 10,  -- seconds; videos ignore this
    position INTEGER NOT NULL,
    label TEXT,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

const q = {
  all:    db.prepare('SELECT * FROM slides ORDER BY position ASC'),
  active: db.prepare('SELECT * FROM slides WHERE enabled = 1 ORDER BY position ASC'),
  get:    db.prepare('SELECT * FROM slides WHERE id = ?'),
  maxPos: db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM slides'),
  insert: db.prepare('INSERT INTO slides (type, src, duration, position, label) VALUES (?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE slides SET duration = ?, label = ?, enabled = ? WHERE id = ?'),
  reorder:db.prepare('UPDATE slides SET position = ? WHERE id = ?'),
  delete: db.prepare('DELETE FROM slides WHERE id = ?'),
};

// ---------- Express ----------
const app = express();
app.use(express.json());
// Uploaded filenames embed a timestamp + random suffix, so a given URL is
// immutable — let the TV cache it forever instead of refetching every cycle.
app.use('/content', express.static(CONTENT_DIR, { maxAge: '365d', immutable: true }));
app.use('/static', express.static(path.join(ROOT, 'public')));

// ---------- Live updates (SSE) ----------
// The kiosk keeps one of these open, so uploads/edits hit the TV immediately
// instead of waiting out a polling interval.
const clients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

function broadcast() {
  const payload = `event: slides\ndata: ${JSON.stringify(q.active.all())}\n\n`;
  for (const res of clients) res.write(payload);
}

// Comment keeps proxies and dozing Wi-Fi links from dropping the stream.
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- Uploads ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CONTENT_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safe = crypto.randomBytes(6).toString('hex');
    cb(null, `${Date.now()}-${safe}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    // Allow images, videos, and HTML files (HTML gets rendered in an iframe)
    const isMedia = /^(image|video)\//.test(file.mimetype);
    const isHtml = file.mimetype === 'text/html' || /\.html?$/i.test(file.originalname);
    const ok = isMedia || isHtml;
    cb(ok ? null : new Error('Only image, video, or HTML uploads allowed'), ok);
  },
});

function typeOf(file) {
  if (file.mimetype.startsWith('video/')) return 'video';
  if (file.mimetype === 'text/html' || /\.html?$/i.test(file.originalname)) return 'html';
  return 'image';
}

// ---------- Web slide helpers ----------
// A URL typed without a scheme ("sga.elon.edu") resolves *relative to the kiosk
// page* inside the iframe, which is why such slides came up as a broken-page
// icon. Normalise before it ever reaches the database.
function normalizeUrl(raw) {
  const url = String(raw).trim();
  // Leave any real scheme alone so probe() can reject the non-web ones by name
  // rather than mangling them into a nonsense https:// address. A colon
  // followed by digits is a port ("dashboard:3000"), not a scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
    || (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[a-z][a-z0-9+.-]*:\d/i.test(url));
  return hasScheme ? url : `https://${url}`;
}

// The probe below fetches a URL supplied by whoever can reach the admin panel,
// so it must never be pointed at the Pi itself or the rest of the LAN — that
// would turn this endpoint into a port scanner for internal services.
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)   // link-local, incl. cloud metadata
      || a >= 224;                  // multicast / reserved
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (/^f[cd]/.test(v6)) return true;     // unique local  fc00::/7
  if (/^fe[89ab]/.test(v6)) return true;  // link-local    fe80::/10
  const mapped = /^::ffff:(.+)$/.exec(v6);
  if (!mapped) return false;
  const tail = mapped[1];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isPrivateAddress(tail);
  // ...and the URL parser writes that form as two hextets: ::ffff:7f00:1
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return false;
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
  return isPrivateAddress([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
}

async function isPublicHost(hostname) {
  if (net.isIP(hostname)) return !isPrivateAddress(hostname);
  // ponytail: resolved once here and again by fetch, so a hostile DNS server
  // could rebind in between. Closing that needs a pinned-IP agent; the payoff
  // here is a yes/no oracle about LAN hosts for someone already on the LAN.
  const addrs = await dns.lookup(hostname, { all: true });
  return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
}

// Most big sites refuse to be framed (X-Frame-Options / CSP frame-ancestors).
// An iframe gives no usable error for that, so ask the site ourselves and let
// the admin panel warn at add-time and the kiosk skip the slide at play-time.
const embedCache = new Map(); // url -> { at, result }

function verdictFrom(res) {
  const xfo = (res.headers.get('x-frame-options') || '').toLowerCase();
  const csp = (res.headers.get('content-security-policy') || '').toLowerCase();
  const ancestors = /frame-ancestors\s+([^;]*)/.exec(csp)?.[1]?.trim();

  if (!res.ok) return { ok: false, reason: `Site returned HTTP ${res.status}` };
  if (xfo.includes('deny') || xfo.includes('sameorigin'))
    return { ok: false, reason: 'Site blocks embedding (X-Frame-Options)' };
  if (ancestors && (ancestors === "'none'" || ancestors === "'self'"))
    return { ok: false, reason: 'Site blocks embedding (CSP frame-ancestors)' };
  return { ok: true };
}

async function probe(startUrl) {
  let target = startUrl;

  // Redirects are followed by hand so every hop gets checked — 'follow' would
  // let a public URL bounce the request onto an internal address.
  for (let hop = 0; hop < 4; hop++) {
    let parsed;
    try { parsed = new URL(target); }
    catch (e) { return { ok: false, reason: 'Not a valid web address' }; }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return { ok: false, reason: 'Only http and https pages can be shown' };

    // A dashboard on your own network is a normal thing to put on the kiosk —
    // the TV's browser loads it directly. This server just won't fetch it.
    // .hostname keeps the brackets around an IPv6 literal; net.isIP won't.
    if (!(await isPublicHost(parsed.hostname.replace(/^\[|\]$/g, ''))))
      return { ok: true, unverified: true, reason: 'Local network address — not checked from the server' };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try { res = await fetch(target, { redirect: 'manual', signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    res.body?.cancel?.();

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      target = new URL(location, target).href;
      continue;
    }
    return verdictFrom(res);
  }
  return { ok: false, reason: 'Too many redirects' };
}

async function checkEmbeddable(url) {
  const hit = embedCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.result;

  let result;
  try {
    result = await probe(url);
  } catch (e) {
    result = { ok: false, reason: e.name === 'AbortError' ? 'Site timed out' : 'Site unreachable' };
  }

  embedCache.set(url, { at: Date.now(), result });
  return result;
}

// ---------- API ----------
app.get('/api/slides', (req, res) => {
  res.json(q.all.all());
});

app.get('/api/slides/active', (req, res) => {
  res.json(q.active.all());
});

// Accepts one file or many — the admin panel drops a whole folder at once.
app.post('/api/slides/upload', upload.array('file', 50), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No file uploaded' });
  const created = req.files.map((file) => {
    const type = typeOf(file);
    const duration = parseInt(req.body.duration) || (type === 'html' ? 20 : 10);
    // A shared label across a multi-file drop would be meaningless, so only
    // honour it when a single file came in.
    const label = (req.files.length === 1 && req.body.label) || file.originalname;
    const pos = q.maxPos.get().m + 1;
    return q.get.get(q.insert.run(type, file.filename, duration, pos, label).lastInsertRowid);
  });
  broadcast();
  res.json(created.length === 1 ? created[0] : created);
});

app.post('/api/slides/web', (req, res) => {
  const { url, duration, label } = req.body;
  if (!url || !String(url).trim()) return res.status(400).json({ error: 'URL required' });
  const href = normalizeUrl(url);
  const pos = q.maxPos.get().m + 1;
  const info = q.insert.run('web', href, parseInt(duration) || 20, pos, label || href);
  broadcast();
  res.json(q.get.get(info.lastInsertRowid));
});

app.get('/api/check-embed', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ error: 'url required' });
  res.json(await checkEmbeddable(normalizeUrl(req.query.url)));
});

app.patch('/api/slides/:id', (req, res) => {
  const slide = q.get.get(req.params.id);
  if (!slide) return res.status(404).json({ error: 'Not found' });
  const duration = req.body.duration ?? slide.duration;
  const label = req.body.label ?? slide.label;
  const enabled = req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : slide.enabled;
  q.update.run(duration, label, enabled, slide.id);
  broadcast();
  res.json(q.get.get(slide.id));
});

app.post('/api/slides/reorder', (req, res) => {
  const { order } = req.body; // array of slide IDs in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' });
  const tx = db.transaction((ids) => {
    ids.forEach((id, idx) => q.reorder.run(idx, id));
  });
  tx(order);
  broadcast();
  res.json(q.all.all());
});

app.delete('/api/slides/:id', (req, res) => {
  const slide = q.get.get(req.params.id);
  if (!slide) return res.status(404).json({ error: 'Not found' });
  // Remove the file from disk for any locally-hosted slide (image/video/html)
  if (slide.type !== 'web') {
    const filePath = path.join(CONTENT_DIR, slide.src);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  q.delete.run(slide.id);
  broadcast();
  res.json({ ok: true });
});

// Multer rejections (wrong type, over 500MB) arrive here as plain errors —
// without this they'd come back as an HTML stack trace the admin can't read.
app.use((err, req, res, next) => {
  if (!err) return next();
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  res.status(400).json({ error: tooBig ? 'File is larger than 500MB' : err.message });
});

// ---------- Pages ----------
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/kiosk', (req, res) => res.sendFile(path.join(ROOT, 'public', 'kiosk.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`sgapi kiosk running on http://0.0.0.0:${PORT}`);
});
