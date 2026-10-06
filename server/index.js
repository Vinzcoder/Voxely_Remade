const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- Games (each one is just a list of boxes) ----------
const B = (x, y, z, w, h, d, c) => ({ x, y, z, w, h, d, c });
const L = (x, y, z, w, h, d, c) => ({ x, y, z, w, h, d, c, l: 1 }); // climbable ladder
const GAMES = {
  plaza: {
    title: 'Block Plaza', tagline: 'Hang out, chat and jump around.',
    desc: 'A big open plaza with a few blocks to climb. The best place to meet other players and test chat.',
    tags: ['Social', 'Chill', 'Multiplayer'], sky: '#7ec8ff', art: ['#2b6cb0', '#63b3ed'],
    spawn: [0, 2, 0],
    boxes: [B(0, -0.5, 0, 80, 1, 80, '#5cb85c'), B(6, 1, 4, 4, 2, 4, '#e0a040'), B(10, 2, 8, 4, 4, 4, '#d9534f'), L(10, 2, 5.85, 1.4, 4, 0.3, '#c8903c'), B(-8, 0.75, -6, 6, 1.5, 3, '#8e6bd0')]
  },
  obby: {
    title: 'Sky Obby', tagline: 'Jump your way up to the top.',
    desc: 'An obstacle course floating in the sky. Fall off and you respawn at the start.',
    tags: ['Obby', 'Parkour', 'Multiplayer'], sky: '#1b2a49', art: ['#6b21a8', '#f97316'],
    spawn: [0, 2, 0],
    boxes: [B(0, -0.5, 0, 10, 1, 10, '#3b82f6'), B(0, 1, 11, 4, 1, 4, '#f97316'), B(5, 2.5, 17, 4, 1, 4, '#eab308'), B(11, 4, 20, 4, 1, 4, '#22c55e'), B(17, 5.5, 14, 3, 1, 3, '#ec4899'), B(20, 7, 7, 3, 1, 3, '#8b5cf6'), B(20, 8.5, -1, 8, 1, 8, '#ffffff')]
  },
  hills: {
    title: 'Candy Hills', tagline: 'Climb the sweetest staircase.',
    desc: 'Colorful stairs and hills made of candy blocks. Race your friends to the summit.',
    tags: ['Casual', 'Climbing', 'Multiplayer'], sky: '#ffd6e8', art: ['#db2777', '#fcd34d'],
    spawn: [0, 2, -10],
    boxes: [B(0, -0.5, 0, 60, 1, 60, '#f9a8d4'), ...Array.from({ length: 10 }, (_, i) => B(0, i * 0.8 + 0.4, i * 3, 8, 0.8, 3, i % 2 ? '#a7f3d0' : '#fde68a'))]
  }
};
const rooms = Object.fromEntries(Object.keys(GAMES).map(k => [k, new Map()]));

// ---------- Guest login ----------
const sessions = new Map();
const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));
const cleanName = s => String(s || '').replace(/[^\p{L}\p{N}_ .-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const nameTaken = (n, exceptTok) => { const me = sessions.get(exceptTok); return [...sessions.values()].some(u => u !== me && u.name.toLowerCase() === n.toLowerCase()); };
const pubUser = u => ({ name: u.name, color: u.color, uid: u.uid, av: u.avatar ? u.av : 0 });
const IMG = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const parseImg = (s, max) => { const m = IMG.exec(String(s || '')); if (!m) return null; const buf = Buffer.from(m[2], 'base64'); return buf.length && buf.length <= max ? { type: m[1], buf } : null; };
const sendImg = (img, res) => img ? res.set({ 'Content-Type': img.type, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }).send(img.buf) : res.sendStatus(404);

app.get('/api/me', (req, res) => {
  const u = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
  u ? res.json(pubUser(u)) : res.sendStatus(401);
});
app.post('/api/guest', (req, res) => {
  const raw = String(req.body?.name || '').trim();
  let name = cleanName(raw);
  if (raw) {
    if (name.length < 2) return res.status(400).json({ error: 'Nama minimal 2 karakter (huruf/angka)' });
    if (nameTaken(name)) return res.status(400).json({ error: 'Nama sudah dipakai, coba yang lain' });
  } else {
    do { name = 'Guest' + Math.floor(1000 + Math.random() * 9000); } while (nameTaken(name));
  }
  const token = crypto.randomBytes(16).toString('hex');
  const user = { name, color: COLORS[Math.floor(Math.random() * COLORS.length)], uid: crypto.randomBytes(4).toString('hex'), game: null, friends: new Set(), reqIn: new Map(), reqOut: new Set(), notes: [] };
  if (sessions.size > 5000) sessions.delete(sessions.keys().next().value);
  sessions.set(token, user);
  res.json({ token, user: pubUser(user) });
});
// ---------- Google login (Supabase Auth) ----------
// Only the public (publishable) key is needed: Supabase itself verifies the access token.
const SUPA_URL = process.env.SUPABASE_URL || 'https://kleqnciieeouapaxpora.supabase.co';
const SUPA_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_Wmi1NDV2tMoDe7cZKwGsZg_V0fsK8OE';
const byGoogle = new Map(); // google user id -> user object (same account across devices)
app.post('/api/login/google', async (req, res) => {
  const at = String(req.body?.access_token || '');
  if (!at) return res.status(400).json({ error: 'Token tidak ada' });
  let info;
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + at } });
    if (!r.ok) return res.status(401).json({ error: 'Login Google tidak valid / kedaluwarsa' });
    info = await r.json();
  } catch (e) { return res.status(502).json({ error: 'Gagal menghubungi Supabase' }); }
  if (!info?.id) return res.status(401).json({ error: 'Login Google tidak valid' });
  let user = byGoogle.get(info.id);
  if (!user) {
    const m = info.user_metadata || {};
    let base = cleanName(m.full_name || m.name || String(info.email || '').split('@')[0]);
    if (base.length < 2) base = 'Player';
    let name = base;
    while (nameTaken(name)) name = base.slice(0, 12) + Math.floor(100 + Math.random() * 900);
    user = { name, color: COLORS[Math.floor(Math.random() * COLORS.length)], uid: crypto.createHash('sha256').update(info.id).digest('hex').slice(0, 8),
      game: null, friends: new Set(), reqIn: new Map(), reqOut: new Set(), notes: [] };
    byGoogle.set(info.id, user);
  }
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, user);
  res.json({ token, user: pubUser(user) });
});
app.get('/api/avatar/:uid', (req, res) => sendImg([...sessions.values()].find(x => x.uid === req.params.uid)?.avatar, res));
app.post('/api/profile', (req, res) => {
  const tok = (req.headers.authorization || '').replace('Bearer ', ''), user = sessions.get(tok);
  if (!user) return res.sendStatus(401);
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = cleanName(b.name);
    if (name.length < 2) return res.status(400).json({ error: 'Nama minimal 2 karakter (huruf/angka)' });
    if (nameTaken(name, tok)) return res.status(400).json({ error: 'Nama sudah dipakai' });
    user.name = name;
    Object.values(GAMES).forEach(g => { if (g.ownerUid === user.uid) g.owner = name; });
  }
  if (b.avatar === null) { user.avatar = null; user.av = 0; }
  else if (b.avatar !== undefined) {
    const img = parseImg(b.avatar, 60 * 1024);
    if (!img) return res.status(400).json({ error: 'Gambar tidak valid atau terlalu besar' });
    if (!user.avatar && [...sessions.values()].filter(x => x.avatar).length >= 300) return res.status(400).json({ error: 'Penyimpanan foto penuh' });
    user.avatar = img; user.av = Date.now();
  }
  res.json(pubUser(user));
});

const bearer = req => (req.headers.authorization || '').replace('Bearer ', '');
const pub = (id, g, tok) => ({ id, title: g.title, tagline: g.tagline, desc: g.desc, tags: g.tags, sky: g.sky, art: g.art, owner: g.owner, thumb: g.thumb ? g.thumbV : 0, mine: !!sessions.get(tok) && g.ownerUid === sessions.get(tok).uid, online: rooms[id].size });
app.get('/api/games', (req, res) => res.json(Object.entries(GAMES).map(([id, g]) => pub(id, g, bearer(req)))));

app.get('/api/people', (_req, res) => {
  const list = [...sessions.values()].map(u => ({ name: u.name, color: u.color, uid: u.uid, av: u.avatar ? u.av : 0, game: u.game && GAMES[u.game] ? GAMES[u.game].title : null }));
  list.sort((a, b) => !!b.game - !!a.game);
  res.json(list.slice(0, 200));
});

// ---------- Developer Portal: users publish their own games ----------
const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, lo, hi, d) => { v = parseFloat(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const txt = (v, n) => String(v || '').replace(/[<>]/g, '').trim().slice(0, n);
const buildGame = b => {
  const title = txt(b.title, 30);
  if (title.length < 3) return { error: 'Judul minimal 3 huruf' };
  const boxes = (Array.isArray(b.boxes) ? b.boxes : []).slice(0, 40).map(x => ({
    x: num(x?.x, -500, 500, 0), y: num(x?.y, -20, 200, 0), z: num(x?.z, -500, 500, 0),
    w: num(x?.w, 0.5, 200, 4), h: num(x?.h, 0.5, 100, 1), d: num(x?.d, 0.5, 200, 4),
    c: HEX.test(x?.c) ? x.c : '#888888', l: x?.l ? 1 : 0
  }));
  if (!boxes.length) return { error: 'Tambahkan minimal 1 platform' };
  const f = boxes[0];
  const tags = (Array.isArray(b.tags) ? b.tags : []).map(t => txt(t, 14)).filter(Boolean).slice(0, 3);
  return { game: {
    title, tagline: txt(b.tagline, 60) || 'Game buatan komunitas.', desc: txt(b.desc, 400) || 'Belum ada deskripsi.',
    tags: tags.length ? tags : ['Community'], sky: HEX.test(b.sky) ? b.sky : '#7ec8ff',
    art: [HEX.test(b.art?.[0]) ? b.art[0] : '#1463ff', HEX.test(b.art?.[1]) ? b.art[1] : '#0a0f1a'],
    spawn: [f.x, f.y + f.h / 2 + 1.5, f.z], boxes
  } };
};
app.post('/api/games', (req, res) => {
  const tok = bearer(req), user = sessions.get(tok);
  if (!user) return res.sendStatus(401);
  const b = req.body || {};
  const all = Object.values(GAMES).filter(g => g.ownerUid);
  if (all.filter(g => g.ownerUid === user.uid).length >= 5) return res.status(400).json({ error: 'Maksimal 5 game per akun' });
  if (all.length >= 50) return res.status(400).json({ error: 'Server penuh, coba lagi nanti' });
  const built = buildGame(b);
  if (built.error) return res.status(400).json({ error: built.error });
  const thumb = b.thumb ? parseImg(b.thumb, 400 * 1024) : null;
  if (b.thumb && !thumb) return res.status(400).json({ error: 'Thumbnail tidak valid atau terlalu besar' });
  const id = 'u' + crypto.randomBytes(4).toString('hex');
  GAMES[id] = { ...built.game, owner: user.name, ownerUid: user.uid, thumb, thumbV: thumb ? Date.now() : 0 };
  rooms[id] = new Map();
  res.json({ id });
});
const mineGame = req => { const g = GAMES[req.params.id]; return g && g.ownerUid && g.ownerUid === sessions.get(bearer(req))?.uid ? g : null; };
app.get('/api/games/:id/source', (req, res) => {
  const g = mineGame(req); if (!g) return res.sendStatus(403);
  res.json({ title: g.title, tagline: g.tagline, desc: g.desc, tags: g.tags, sky: g.sky, art: g.art, boxes: g.boxes, hasThumb: !!g.thumb });
});
app.put('/api/games/:id', (req, res) => {
  const g = mineGame(req); if (!g) return res.sendStatus(403);
  const b = req.body || {}, built = buildGame(b);
  if (built.error) return res.status(400).json({ error: built.error });
  const thumb = b.thumb ? parseImg(b.thumb, 400 * 1024) : null;
  if (b.thumb && !thumb) return res.status(400).json({ error: 'Thumbnail tidak valid atau terlalu besar' });
  Object.assign(g, built.game);
  if (thumb) { g.thumb = thumb; g.thumbV = Date.now(); }
  res.json({ ok: true });
});
app.delete('/api/games/:id', (req, res) => {
  const g = GAMES[req.params.id];
  if (!g || !g.ownerUid || g.ownerUid !== sessions.get(bearer(req))?.uid) return res.sendStatus(403);
  delete GAMES[req.params.id]; // rooms[id] stays so players still inside can leave cleanly
  res.sendStatus(204);
});
app.get('/api/thumb/:id', (req, res) => sendImg(GAMES[req.params.id]?.thumb, res));
app.post('/api/games/:id/thumb', (req, res) => {
  const g = GAMES[req.params.id];
  if (!g || !g.ownerUid || g.ownerUid !== sessions.get(bearer(req))?.uid) return res.sendStatus(403);
  const thumb = parseImg(req.body?.image, 400 * 1024);
  if (!thumb) return res.status(400).json({ error: 'Thumbnail tidak valid atau terlalu besar' });
  g.thumb = thumb; g.thumbV = Date.now();
  res.json({ ok: true });
});
// ---------- Reviews (any logged-in user, one per game) ----------
const plain = (v, n) => String(v || '').replace(/\r/g, '').trim().slice(0, n);
const uidMap = () => new Map([...sessions.values()].map(u => [u.uid, u]));
const reviewsOf = g => (g.reviews = g.reviews || []);

app.get('/api/games/:id/reviews', (req, res) => {
  const g = GAMES[req.params.id];
  if (!g) return res.sendStatus(404);
  const tok = bearer(req), me = sessions.get(tok), users = uidMap();
  const items = reviewsOf(g).filter(r => r.reports.size < 3).map(r => {
    const u = users.get(r.uid);
    return {
      id: r.id, uid: r.uid, name: u?.name || r.name, av: u?.avatar ? u.av : 0, color: u?.color || '#1463ff',
      up: r.up, text: r.text, ts: r.ts, yes: r.yes.size, no: r.no.size,
      mine: me ? (r.yes.has(me.uid) ? 'yes' : r.no.has(me.uid) ? 'no' : null) : null, own: me?.uid === r.uid
    };
  });
  items.sort(req.query.sort === 'helpful' ? (a, b) => b.yes - a.yes || b.ts - a.ts : (a, b) => b.ts - a.ts);
  const isOwner = !!me && g.ownerUid === me.uid;
  res.json({ isOwner, canReview: !!me && !isOwner, mine: items.find(x => x.own) || null, total: items.length, up: items.filter(x => x.up).length, reviews: items.slice(0, 100) });
});
app.post('/api/games/:id/reviews', (req, res) => {
  const g = GAMES[req.params.id], tok = bearer(req), me = sessions.get(tok);
  if (!me) return res.sendStatus(401);
  if (!g) return res.sendStatus(404);
  if (g.ownerUid === me.uid) return res.status(400).json({ error: 'Kamu tidak bisa mereview game buatanmu sendiri' });
  const text = plain(req.body?.text, 500);
  if (!text) return res.status(400).json({ error: 'Tulis reviewnya dulu' });
  const list = reviewsOf(g), up = !!req.body?.up, ex = list.find(r => r.uid === me.uid);
  if (ex) Object.assign(ex, { up, text, ts: Date.now() });
  else if (list.length >= 500) return res.status(400).json({ error: 'Review untuk game ini sudah penuh' });
  else list.push({ id: crypto.randomBytes(4).toString('hex'), uid: me.uid, name: me.name, up, text, ts: Date.now(), yes: new Set(), no: new Set(), reports: new Set() });
  res.json({ ok: true });
});
app.delete('/api/games/:id/reviews', (req, res) => {
  const g = GAMES[req.params.id], me = sessions.get(bearer(req));
  if (!me || !g) return res.sendStatus(403);
  g.reviews = reviewsOf(g).filter(r => r.uid !== me.uid);
  res.sendStatus(204);
});
const findReview = (req) => { const g = GAMES[req.params.id]; return g && reviewsOf(g).find(x => x.id === req.params.rid); };
app.post('/api/games/:id/reviews/:rid/vote', (req, res) => {
  const me = sessions.get(bearer(req)), r = findReview(req);
  if (!me) return res.sendStatus(401);
  if (!r) return res.sendStatus(404);
  if (r.uid === me.uid) return res.status(400).json({ error: 'Tidak bisa vote review sendiri' });
  r.yes.delete(me.uid); r.no.delete(me.uid);
  if (req.body?.v === 'yes') r.yes.add(me.uid); else if (req.body?.v === 'no') r.no.add(me.uid);
  res.json({ yes: r.yes.size, no: r.no.size });
});
app.post('/api/games/:id/reviews/:rid/report', (req, res) => {
  const me = sessions.get(bearer(req)), r = findReview(req);
  if (!me) return res.sendStatus(401);
  if (!r) return res.sendStatus(404);
  if (r.uid !== me.uid) r.reports.add(me.uid); // 3 different reports hide a review
  res.json({ ok: true });
});

// ---------- Forum ----------
const CATS = [
  { id: 'general', name: 'General Discussion', desc: 'Talk about anything and everything related to Voxely!', color: '#5b8def' },
  { id: 'games', name: 'Game Discussion', desc: 'Discuss your favorite games, share strategies, and find teammates.', color: '#6cc04a' },
  { id: 'dev', name: 'Game Development', desc: 'Share tips, tutorials, and get help building games in the Developer Portal.', color: '#d08b5b' },
  { id: 'suggest', name: 'Suggestions & Feedback', desc: 'Share your ideas to help improve Voxely!', color: '#d45d8a' },
  { id: 'bugs', name: 'Bug Reports', desc: 'Report bugs and technical issues you encounter.', color: '#6b8fb5' },
  { id: 'off', name: 'Off-Topic', desc: 'Discuss topics unrelated to Voxely and gaming.', color: '#a9b05b' }
];
const threads = []; let tid = 0;
const byLast = (a, b) => b.last - a.last;
const author = (users, uid, name) => { const u = users.get(uid); return { name: u?.name || name, uid, av: u?.avatar ? u.av : 0, color: u?.color || '#1463ff' }; };
const item = (users, t) => ({ id: t.id, title: t.title, ts: t.ts, replies: t.posts.length, views: t.views, author: author(users, t.uid, t.name) });
const meOf = req => sessions.get(bearer(req));

app.get('/api/forum', (_req, res) => {
  const cats = CATS.map(c => { const ts = threads.filter(t => t.cat === c.id); return { ...c, threads: ts.length, posts: ts.reduce((n, t) => n + 1 + t.posts.length, 0) }; });
  res.json({ cats, stats: { categories: cats.length, threads: threads.length, posts: cats.reduce((n, c) => n + c.posts, 0) } });
});
app.get('/api/forum/search', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim(), users = uidMap();
  res.json(q.length < 2 ? [] : threads.filter(t => (t.title + ' ' + t.body + ' ' + t.posts.map(p => p.body).join(' ')).toLowerCase().includes(q)).sort(byLast).slice(0, 50).map(t => item(users, t)));
});
app.get('/api/forum/mine', (req, res) => {
  const me = meOf(req); if (!me) return res.sendStatus(401);
  const users = uidMap();
  res.json(threads.filter(t => t.uid === me.uid || t.posts.some(p => p.uid === me.uid)).sort(byLast).slice(0, 100).map(t => item(users, t)));
});
app.get('/api/forum/cat/:cat', (req, res) => {
  const cat = CATS.find(c => c.id === req.params.cat); if (!cat) return res.sendStatus(404);
  const users = uidMap();
  res.json({ cat, threads: threads.filter(t => t.cat === cat.id).sort(byLast).slice(0, 100).map(t => item(users, t)) });
});
app.post('/api/forum/cat/:cat', (req, res) => {
  const me = meOf(req); if (!me) return res.sendStatus(401);
  const cat = CATS.find(c => c.id === req.params.cat); if (!cat) return res.sendStatus(404);
  const title = plain(req.body?.title, 100).replace(/\s+/g, ' '), body = plain(req.body?.body, 2000);
  if (title.length < 3) return res.status(400).json({ error: 'Judul minimal 3 karakter' });
  if (!body) return res.status(400).json({ error: 'Isi thread tidak boleh kosong' });
  const now = Date.now();
  if (now - (me.lastThread || 0) < 30000) return res.status(400).json({ error: 'Tunggu 30 detik sebelum membuat thread lagi' });
  me.lastThread = now;
  if (threads.length >= 500) threads.splice(threads.reduce((m, t, i, a) => (t.last < a[m].last ? i : m), 0), 1);
  const t = { id: String(++tid), cat: cat.id, title, body, uid: me.uid, name: me.name, ts: now, last: now, views: 0, posts: [] };
  threads.push(t);
  res.json({ id: t.id });
});
app.get('/api/forum/thread/:id', (req, res) => {
  const t = threads.find(x => x.id === req.params.id); if (!t) return res.sendStatus(404);
  t.views++;
  const users = uidMap(), me = meOf(req);
  res.json({ ...item(users, t), category: CATS.find(c => c.id === t.cat), body: t.body, own: me?.uid === t.uid,
    posts: t.posts.map(p => ({ id: p.id, body: p.body, ts: p.ts, own: me?.uid === p.uid, author: author(users, p.uid, p.name) })) });
});
app.post('/api/forum/thread/:id/reply', (req, res) => {
  const me = meOf(req); if (!me) return res.sendStatus(401);
  const t = threads.find(x => x.id === req.params.id); if (!t) return res.sendStatus(404);
  const body = plain(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'Balasan tidak boleh kosong' });
  if (t.posts.length >= 300) return res.status(400).json({ error: 'Thread ini sudah penuh' });
  const now = Date.now();
  if (now - (me.lastReply || 0) < 5000) return res.status(400).json({ error: 'Tunggu beberapa detik sebelum membalas lagi' });
  me.lastReply = now;
  t.posts.push({ id: crypto.randomBytes(3).toString('hex'), uid: me.uid, name: me.name, body, ts: now });
  t.last = now;
  res.json({ ok: true });
});
app.delete('/api/forum/thread/:id', (req, res) => {
  const me = meOf(req), i = threads.findIndex(x => x.id === req.params.id);
  if (!me || i < 0 || threads[i].uid !== me.uid) return res.sendStatus(403);
  threads.splice(i, 1);
  res.sendStatus(204);
});
app.delete('/api/forum/thread/:id/post/:pid', (req, res) => {
  const me = meOf(req), t = threads.find(x => x.id === req.params.id);
  if (!me || !t) return res.sendStatus(403);
  const i = t.posts.findIndex(p => p.id === req.params.pid && p.uid === me.uid);
  if (i < 0) return res.sendStatus(403);
  t.posts.splice(i, 1);
  res.sendStatus(204);
});

// ---------- Friends & notifications ----------
const userCard = u => ({ uid: u.uid, name: u.name, color: u.color, av: u.avatar ? u.av : 0, game: u.game && GAMES[u.game] ? GAMES[u.game].title : null });
const friendState = (me, o) => me.friends.has(o.uid) ? 'friends' : me.reqOut.has(o.uid) ? 'sent' : me.reqIn.has(o.uid) ? 'received' : 'none';
const needMe = (req, res) => { const me = sessions.get(bearer(req)); if (!me) res.sendStatus(401); return me; };
const other = (req, me) => { const o = uidMap().get(req.params.uid); return o && o.uid !== me.uid ? o : null; };
function makeFriends(me, o) {
  me.reqIn.delete(o.uid); me.reqOut.delete(o.uid); o.reqIn.delete(me.uid); o.reqOut.delete(me.uid);
  me.friends.add(o.uid); o.friends.add(me.uid);
  o.notes.unshift({ uid: me.uid, ts: Date.now(), read: false }); o.notes.length = Math.min(o.notes.length, 50);
}
app.get('/api/users/:uid', (req, res) => {
  const u = uidMap().get(req.params.uid); if (!u) return res.sendStatus(404);
  const me = sessions.get(bearer(req));
  res.json({ ...userCard(u), friend: me && me.uid !== u.uid ? friendState(me, u) : 'none', friends: u.friends.size,
    games: Object.entries(GAMES).filter(([, g]) => g.ownerUid === u.uid).map(([id, g]) => pub(id, g, bearer(req))) });
});
app.get('/api/friends', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const users = uidMap();
  res.json({ friends: [...me.friends].map(id => users.get(id)).filter(Boolean).map(userCard).sort((a, b) => !!b.game - !!a.game) });
});
app.post('/api/friends/:uid/request', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const o = other(req, me); if (!o) return res.sendStatus(404);
  if (me.friends.has(o.uid) || me.reqOut.has(o.uid)) return res.json({ ok: true });
  if (me.reqIn.has(o.uid)) { makeFriends(me, o); return res.json({ ok: true }); } // they already asked me
  if (me.friends.size >= 100 || me.reqOut.size >= 50) return res.status(400).json({ error: 'Batas teman / permintaan tercapai' });
  me.reqOut.add(o.uid); o.reqIn.set(me.uid, Date.now());
  res.json({ ok: true });
});
app.post('/api/friends/:uid/accept', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const o = other(req, me); if (!o || !me.reqIn.has(o.uid)) return res.sendStatus(404);
  if (me.friends.size >= 100) return res.status(400).json({ error: 'Daftar teman penuh' });
  makeFriends(me, o); res.json({ ok: true });
});
app.post('/api/friends/:uid/decline', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const o = other(req, me); if (!o) return res.sendStatus(404);
  me.reqIn.delete(o.uid); o.reqOut.delete(me.uid); res.json({ ok: true });
});
app.post('/api/friends/:uid/cancel', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const o = other(req, me); if (!o) return res.sendStatus(404);
  me.reqOut.delete(o.uid); o.reqIn.delete(me.uid); res.json({ ok: true });
});
app.delete('/api/friends/:uid', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const o = other(req, me); if (!o) return res.sendStatus(404);
  me.friends.delete(o.uid); o.friends.delete(me.uid); res.sendStatus(204);
});
app.get('/api/notifications', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const users = uidMap(), card = id => (users.get(id) ? userCard(users.get(id)) : null);
  const requests = [...me.reqIn].map(([id, ts]) => ({ ts, user: card(id) })).filter(x => x.user).sort((a, b) => b.ts - a.ts);
  const accepted = me.notes.map(n => ({ ts: n.ts, read: n.read, user: card(n.uid) })).filter(x => x.user);
  res.json({ requests, accepted, unread: requests.length + accepted.filter(x => !x.read).length });
});
app.post('/api/notifications/read', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  me.notes.forEach(n => (n.read = true)); res.json({ ok: true });
});

app.get('/', (_req, res) => res.send('Voxely game server is running'));

// ---------- Multiplayer ----------
io.use((socket, next) => {
  const user = sessions.get(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user; next();
});
io.on('connection', socket => {
  let gameId = null, lastChat = 0;
  socket.on('join', id => {
    if (!GAMES[id] || gameId) return;
    gameId = id; socket.join(id); socket.user.game = id;
    const g = GAMES[id];
    const me = { id: socket.id, name: socket.user.name, color: socket.user.color, x: g.spawn[0], y: g.spawn[1], z: g.spawn[2], ry: 0 };
    rooms[id].set(socket.id, me);
    socket.emit('init', { me, game: { title: g.title, sky: g.sky, spawn: g.spawn, boxes: g.boxes }, players: [...rooms[id].values()] });
    socket.to(id).emit('join', me);
    io.to(id).emit('count', rooms[id].size);
  });
  socket.on('move', m => {
    const p = rooms[gameId]?.get(socket.id); if (!p) return;
    Object.assign(p, { x: +m.x || 0, y: +m.y || 0, z: +m.z || 0, ry: +m.ry || 0, st: [0, 1, 2, 3, 4].includes(+m.st) ? +m.st : 0 });
    socket.to(gameId).volatile.emit('move', p);
  });
  socket.on('chat', text => {
    if (!gameId || Date.now() - lastChat < 400) return;
    lastChat = Date.now();
    io.to(gameId).emit('chat', { id: socket.id, name: socket.user.name, color: socket.user.color, text: String(text).slice(0, 140) });
  });
  socket.on('disconnect', () => {
    if (!gameId) return;
    socket.user.game = null;
    rooms[gameId].delete(socket.id);
    io.to(gameId).emit('leave', socket.id);
    io.to(gameId).emit('count', rooms[gameId].size);
  });
});

server.listen(PORT, () => console.log(`Voxely game server: http://localhost:${PORT}`));
