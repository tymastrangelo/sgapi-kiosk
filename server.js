// server.js — sgapi kiosk backend
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = 8080;
const ROOT = __dirname;
const CONTENT_DIR = path.join(ROOT, 'content');
const DB_PATH = path.join(ROOT, 'kiosk.db');

if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });

// ---------- Database ----------
const db = new Database(DB_PATH);
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
app.use('/content', express.static(CONTENT_DIR));
app.use('/static', express.static(path.join(ROOT, 'public')));

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

// ---------- API ----------
app.get('/api/slides', (req, res) => {
  res.json(q.all.all());
});

app.get('/api/slides/active', (req, res) => {
  res.json(q.active.all());
});

app.post('/api/slides/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let type;
  if (req.file.mimetype.startsWith('video/')) type = 'video';
  else if (req.file.mimetype === 'text/html' || /\.html?$/i.test(req.file.originalname)) type = 'html';
  else type = 'image';
  const duration = parseInt(req.body.duration) || (type === 'html' ? 20 : 10);
  const label = req.body.label || req.file.originalname;
  const pos = q.maxPos.get().m + 1;
  const info = q.insert.run(type, req.file.filename, duration, pos, label);
  res.json(q.get.get(info.lastInsertRowid));
});

app.post('/api/slides/web', (req, res) => {
  const { url, duration, label } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const pos = q.maxPos.get().m + 1;
  const info = q.insert.run('web', url, parseInt(duration) || 20, pos, label || url);
  res.json(q.get.get(info.lastInsertRowid));
});

app.patch('/api/slides/:id', (req, res) => {
  const slide = q.get.get(req.params.id);
  if (!slide) return res.status(404).json({ error: 'Not found' });
  const duration = req.body.duration ?? slide.duration;
  const label = req.body.label ?? slide.label;
  const enabled = req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : slide.enabled;
  q.update.run(duration, label, enabled, slide.id);
  res.json(q.get.get(slide.id));
});

app.post('/api/slides/reorder', (req, res) => {
  const { order } = req.body; // array of slide IDs in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' });
  const tx = db.transaction((ids) => {
    ids.forEach((id, idx) => q.reorder.run(idx, id));
  });
  tx(order);
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
  res.json({ ok: true });
});

// ---------- Pages ----------
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/kiosk', (req, res) => res.sendFile(path.join(ROOT, 'public', 'kiosk.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`sgapi kiosk running on http://0.0.0.0:${PORT}`);
});