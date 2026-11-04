const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- Admin (exclusive to the user named "Zerks") ----------
// Anyone who logs in with this username automatically gets the admin badge
// (admin: true on every user object -> the frontend shows the admin logo
// next to the username) and full access to /api/admin/*.
const ADMIN_NAME = 'zerks';
const DUP_NAME_ERROR = 'Please choose another name';
const isAdmin = u => !!u && String(u.name || '').toLowerCase() === ADMIN_NAME;

// ---------- Badge System ----------
const BADGES = new Map(); // badgeId -> badge definition
const USER_BADGES = new Map(); // uid -> Set of badgeIds

// Badge definition structure:
// { id, name, description, icon (emoji or color), color, category, createdBy, createdAt, isHidden }

// User badge structure:
// { badgeId, earnedAt, expiresAt (optional) }

function createBadge(definition, creator) {
  const id = 'b' + crypto.randomBytes(4).toString('hex');
  const badge = {
    id,
    name: String(definition.name || '').slice(0, 40),
    description: String(definition.description || '').slice(0, 200),
    icon: String(definition.icon || '⭐').slice(0, 10),
    color: /^#[0-9a-f]{6}$/i.test(definition.color) ? definition.color : '#ffd700',
    category: String(definition.category || 'general').slice(0, 30),
    createdBy: creator.uid,
    createdByName: creator.name,
    createdAt: Date.now(),
    isHidden: !!definition.isHidden
  };
  BADGES.set(id, badge);
  return badge;
}

function awardBadge(uid, badgeId) {
  if (!BADGES.has(badgeId)) return false;
  if (!USER_BADGES.has(uid)) {
    USER_BADGES.set(uid, new Map());
  }
  const userBadges = USER_BADGES.get(uid);
  if (userBadges.has(badgeId)) return false; // Already has this badge

  userBadges.set(badgeId, { badgeId, earnedAt: Date.now() });
  return true;
}

function getUserBadges(uid) {
  const userBadges = USER_BADGES.get(uid) || new Map();
  return [...userBadges.values()].map(ub => {
    const badge = BADGES.get(ub.badgeId);
    return badge ? { ...badge, earnedAt: ub.earnedAt } : null;
  }).filter(Boolean);
}

function getBadgeDefinition(badgeId) {
  return BADGES.get(badgeId);
}

function listAllBadges() {
  return [...BADGES.values()];
}

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
  }
};
// ---------- Servers (instances): every game can run several rooms ----------
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 12;
const instances = new Map(); // id -> { id, game, max, ts, players: Map(socketId -> player) }
const instOf = gid => [...instances.values()].filter(i => i.game === gid);
const online = gid => instOf(gid).reduce((n, i) => n + i.players.size, 0);
function pickInstance(gid, want) {
  if (want && want !== 'new') { const i = instances.get(want); if (i && i.game === gid && i.players.size < i.max) return i; }
  if (want !== 'new') { // best open server = the fullest one that still has room
    const open = instOf(gid).filter(i => i.players.size < i.max).sort((a, b) => b.players.size - a.players.size)[0];
    if (open) return open;
  }
  const inst = { id: crypto.randomBytes(4).toString('hex'), game: gid, max: MAX_PLAYERS, ts: Date.now(), players: new Map() };
  instances.set(inst.id, inst);
  return inst;
}

// ---------- Guest login ----------
const sessions = new Map();

// ---------- Ban System ----------
// The admin (Zerks) bans an account with a REASON + DURATION from the Admin Panel.
// A banned user who opens the website and tries to log in gets:
//   ❌ Account Banned
//   We Are So Sorry Ban You Account
//   Reason : <reason>
//   Time   : <remaining time | Permanent>
// Bans are keyed by lowercased username (so re-login with the same name is blocked)
// and persisted to voxely-bans.json so they survive server restarts.
const BAN_DURATIONS = { '1h': 36e5, '6h': 6 * 36e5, '12h': 12 * 36e5, '1d': 864e5, '3d': 3 * 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };
const BANS_FILE = path.join(__dirname, 'voxely-bans.json');
const BANS = new Map(); // key (lowercased username) -> { key, uid, name, reason, bannedAt, until, permanent, by }
const banKey = n => String(n || '').trim().toLowerCase();
function loadBans() { try { for (const b of JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'))) BANS.set(b.key, b); } catch (e) { /* no bans yet */ } }
function saveBans() { try { fs.writeFileSync(BANS_FILE, JSON.stringify([...BANS.values()], null, 1)); } catch (e) { console.error('saveBans failed:', e.message); } }
const fmtRemaining = ms => {
  if (ms <= 0) return 'Expired';
  // unit thresholds so a fresh "1 day" ban reads "1 day" (not "24 hours")
  const mins = ms / 6e4;
  if (mins < 45) { const m = Math.ceil(mins); return m + (m === 1 ? ' minute' : ' minutes'); }
  const hours = ms / 36e5;
  if (hours < 23) { const h = Math.ceil(hours); return h + (h === 1 ? ' hour' : ' hours'); }
  const d = Math.ceil(ms / 864e5); return d + (d === 1 ? ' day' : ' days');
};
function activeBan(name) { // returns the active ban, auto-expires it when the duration passed
  const k = banKey(name), b = BANS.get(k);
  if (!b) return null;
  if (!b.permanent && Date.now() >= b.until) { BANS.delete(k); saveBans(); return null; }
  return b;
}
const banPayload = b => ({ reason: b.reason, permanent: !!b.permanent, until: b.until || null, time: b.permanent ? 'Permanent' : fmtRemaining(b.until - Date.now()) });
const banResponse = (res, b) => res.status(403).json({ banned: true, error: 'Account Banned', ...banPayload(b) });
const killSessionsOf = name => { const k = banKey(name); [...sessions.entries()].forEach(([tok, u]) => { if (banKey(u.name) === k) sessions.delete(tok); }); };
loadBans();

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use((req, res, next) => { const u = sessions.get((req.headers.authorization || '').replace('Bearer ', '')); if (u) { u.joined = u.joined || Date.now(); u.lastSeen = Date.now(); } next(); });
app.use(express.json({ limit: '1mb' }));
const cleanName = s => String(s || '').replace(/[^\p{L}\p{N}_ .-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const nameTaken = (n, exceptTok) => { const me = sessions.get(exceptTok); return [...sessions.values()].some(u => u !== me && u.name.toLowerCase() === n.toLowerCase()); };
const pubUser = u => ({ name: u.name, color: u.color, uid: u.uid, av: u.avatar ? u.av : 0, google: !!u.gid, about: u.about || '', level: levelOf(u), followers: u.followers?.size || 0, following: u.following?.size || 0, admin: isAdmin(u) });
const IMG = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const parseImg = (s, max) => { const m = IMG.exec(String(s || '')); if (!m) return null; const buf = Buffer.from(m[2], 'base64'); return buf.length && buf.length <= max ? { type: m[1], buf } : null; };
const sendImg = (img, res) => img ? res.set({ 'Content-Type': img.type, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }).send(img.buf) : res.sendStatus(404);

app.get('/api/me', (req, res) => {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  const u = sessions.get(tok);
  if (!u) return res.sendStatus(401);
  // if the account got banned while still logged in, end the session + return the ban info
  const ban = activeBan(u.name);
  if (ban) { sessions.delete(tok); return banResponse(res, ban); }
  res.json(pubUser(u));
});
app.post('/api/guest', (req, res) => {
  const raw = String(req.body?.name || '').trim();
  let name = cleanName(raw);
  if (raw) {
    if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters (letters/numbers)' });
    // BAN SYSTEM: a banned user trying to log in with their name gets the ban message
    const ban = activeBan(name);
    if (ban) return banResponse(res, ban);
    if (nameTaken(name)) return res.status(400).json({ error: DUP_NAME_ERROR });
  } else {
    do { name = 'Guest' + Math.floor(1000 + Math.random() * 9000); } while (nameTaken(name));
  }
  const token = crypto.randomBytes(16).toString('hex');
  const user = { name, color: COLORS[Math.floor(Math.random() * COLORS.length)], uid: crypto.randomBytes(4).toString('hex'), game: null, friends: new Set(), reqIn: new Map(), reqOut: new Set(), followers: new Set(), following: new Set(), notes: [] };
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
  if (!at) return res.status(400).json({ error: 'Missing token' });
  let info;
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + at } });
    if (!r.ok) return res.status(401).json({ error: 'Google login invalid or expired' });
    info = await r.json();
  } catch (e) { return res.status(502).json({ error: 'Could not reach Supabase' }); }
  if (!info?.id) return res.status(401).json({ error: 'Invalid Google login' });
  let user = byGoogle.get(info.id);
  if (!user) {
    const m = info.user_metadata || {};
    let base = cleanName(m.full_name || m.name || String(info.email || '').split('@')[0]);
    if (base.length < 2) base = 'Player';
    let name = base;
    while (nameTaken(name) || BANS.has(banKey(name))) name = base.slice(0, 12) + Math.floor(100 + Math.random() * 900);
    user = { name, color: COLORS[Math.floor(Math.random() * COLORS.length)], uid: crypto.createHash('sha256').update(info.id).digest('hex').slice(0, 8),
      game: null, gid: info.id, friends: new Set(), reqIn: new Map(), reqOut: new Set(), followers: new Set(), following: new Set(), notes: [] };
    byGoogle.set(info.id, user);
  }
  // BAN SYSTEM: banned Google accounts cannot log in either
  const ban = activeBan(user.name);
  if (ban) return banResponse(res, ban);
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
    if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters (letters/numbers)' });
    if (nameTaken(name, tok)) return res.status(400).json({ error: DUP_NAME_ERROR });
    user.name = name;
    Object.entries(GAMES).forEach(([gid, g]) => { if (g.ownerUid === user.uid) { g.owner = name; saveGame(gid); } });
  }
  if (b.about !== undefined) user.about = String(b.about).replace(/[<>]/g, '').trim().slice(0, 200);
  if (b.avatar === null) { user.avatar = null; user.av = 0; }
  else if (b.avatar !== undefined) {
    const img = parseImg(b.avatar, 60 * 1024);
    if (!img) return res.status(400).json({ error: 'Invalid image or file too large' });
    if (!user.avatar && [...sessions.values()].filter(x => x.avatar).length >= 300) return res.status(400).json({ error: 'Photo storage is full' });
    user.avatar = img; user.av = Date.now();
  }
  res.json(pubUser(user));
});

const bearer = req => (req.headers.authorization || '').replace('Bearer ', '');
const pub = (id, g, tok) => ({ id, title: g.title, tagline: g.tagline, desc: g.desc, tags: g.tags, sky: g.sky, art: g.art, owner: g.owner, visits: g.stats?.visits || 0, thumb: g.thumb ? g.thumbV : 0, status: g.status || '', changelog: (g.changelog || []).slice(0, 12), mine: !!sessions.get(tok) && g.ownerUid === sessions.get(tok).uid, online: online(id) });
app.get('/api/games', (req, res) => res.json(Object.entries(GAMES).map(([id, g]) => pub(id, g, bearer(req)))));

app.get('/api/people', (_req, res) => {
  const list = [...new Set(sessions.values())].map(u => ({ name: u.name, color: u.color, uid: u.uid, av: u.avatar ? u.av : 0, game: u.game && GAMES[u.game] ? GAMES[u.game].title : null, admin: isAdmin(u) }));
  list.sort((a, b) => !!b.game - !!a.game);
  res.json(list.slice(0, 200));
});

// ---------- Developer Portal: users publish their own games ----------
const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, lo, hi, d) => { v = parseFloat(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const txt = (v, n) => String(v || '').replace(/[<>]/g, '').trim().slice(0, n);
const MAX_PARTS = 300, MAX_SCRIPTS = 8, MAX_CODE = 30000;
const cleanPart = x => ({
  x: num(x?.x, -2000, 2000, 0), y: num(x?.y, -100, 1000, 0), z: num(x?.z, -2000, 2000, 0),
  w: num(x?.w, 0.2, 2000, 4), h: num(x?.h, 0.2, 500, 1), d: num(x?.d, 0.2, 2000, 4),
  c: HEX.test(x?.c) ? x.c : '#888888', l: x?.l ? 1 : 0,
  n: txt(x?.n, 30), r: num(x?.r, -360, 360, 0), t: num(x?.t, 0, 0.95, 0),
  cc: x?.cc === 0 || x?.cc === false ? 0 : 1, k: x?.k ? 1 : 0, sp: x?.sp ? 1 : 0
});
// Release label shown on game cards: '', 'beta', 'alpha' or 'wip'
const LABELS = ['', 'beta', 'alpha', 'wip'];
// ex = existing game: fields that are missing from the request keep their old value (partial update)
const buildGame = (b, ex) => {
  const has = k => b[k] !== undefined;
  const title = has('title') || !ex ? txt(b.title, 30) : ex.title;
  if (title.length < 3) return { error: 'Title must be at least 3 letters' };
  const boxes = Array.isArray(b.boxes) ? b.boxes.slice(0, MAX_PARTS).map(cleanPart) : ex ? ex.boxes : [];
  if (!boxes.length) return { error: 'Add at least 1 platform' };
  const f = boxes.find(x => x.sp) || boxes[0];
  const tags = Array.isArray(b.tags) ? b.tags.map(t => txt(t, 14)).filter(Boolean).slice(0, 3) : ex ? ex.tags : [];
  return { game: {
    title, tagline: has('tagline') ? txt(b.tagline, 60) || 'A community-made game.' : ex?.tagline || 'A community-made game.',
    desc: has('desc') ? txt(b.desc, 400) || 'No description yet.' : ex?.desc || 'No description yet.',
    tags: tags && tags.length ? tags : ['Community'],
    sky: HEX.test(b.sky) ? b.sky : ex?.sky || '#7ec8ff',
    art: [HEX.test(b.art?.[0]) ? b.art[0] : ex?.art?.[0] || '#1463ff', HEX.test(b.art?.[1]) ? b.art[1] : ex?.art?.[1] || '#0a0f1a'],
    spawn: [f.x, f.y + f.h / 2 + 1.5, f.z], boxes,
    status: has('status') ? (LABELS.includes(String(b.status || '')) ? String(b.status) : '') : ex ? ex.status || '' : '',
    scripts: Array.isArray(b.scripts) ? b.scripts.slice(0, MAX_SCRIPTS).map(s => ({ name: txt(s?.name, 30) || 'Script', code: String(s?.code || '').slice(0, MAX_CODE) })) : ex?.scripts || []
  } };
};
app.post('/api/games', (req, res) => {
  const tok = bearer(req), user = sessions.get(tok);
  if (!user) return res.sendStatus(401);
  const b = req.body || {};
  const all = Object.values(GAMES).filter(g => g.ownerUid);
  if (all.filter(g => g.ownerUid === user.uid).length >= 5) return res.status(400).json({ error: 'You can create up to 5 games per account' });
  if (all.length >= 50) return res.status(400).json({ error: 'Server is full, try again later' });
  const built = buildGame(b);
  if (built.error) return res.status(400).json({ error: built.error });
  const thumb = b.thumb ? parseImg(b.thumb, 400 * 1024) : null;
  if (b.thumb && !thumb) return res.status(400).json({ error: 'Invalid thumbnail or file too large' });
  const id = 'u' + crypto.randomBytes(4).toString('hex');
  GAMES[id] = { ...built.game, owner: user.name, ownerUid: user.uid, ownerGoogle: !!user.gid, thumb, thumbV: thumb ? Date.now() : 0, changelog: [] };
  saveGame(id);
  res.json({ id });
});
const mineGame = req => { const g = GAMES[req.params.id]; return g && g.ownerUid && g.ownerUid === sessions.get(bearer(req))?.uid ? g : null; };
app.get('/api/games/:id/source', (req, res) => {
  const g = mineGame(req); if (!g) return res.sendStatus(403);
  res.json({ title: g.title, tagline: g.tagline, desc: g.desc, tags: g.tags, sky: g.sky, art: g.art, boxes: g.boxes, status: g.status || '', changelog: g.changelog || [], scripts: g.scripts || [], hasThumb: !!g.thumb });
});
app.put('/api/games/:id', (req, res) => {
  const g = mineGame(req); if (!g) return res.sendStatus(403);
  const b = req.body || {}, built = buildGame(b, g);
  if (built.error) return res.status(400).json({ error: built.error });
  const thumb = b.thumb ? parseImg(b.thumb, 400 * 1024) : null;
  if (b.thumb && !thumb) return res.status(400).json({ error: 'Invalid thumbnail or file too large' });
  Object.assign(g, built.game);
  if (thumb) { g.thumb = thumb; g.thumbV = Date.now(); }
  saveGame(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/games/:id', (req, res) => {
  const g = GAMES[req.params.id];
  if (!g || !g.ownerUid || g.ownerUid !== sessions.get(bearer(req))?.uid) return res.sendStatus(403);
  delete GAMES[req.params.id]; dropGame(req.params.id);
  res.sendStatus(204);
});
app.get('/api/thumb/:id', (req, res) => sendImg(GAMES[req.params.id]?.thumb, res));
app.post('/api/games/:id/thumb', (req, res) => {
  const g = GAMES[req.params.id];
  if (!g || !g.ownerUid || g.ownerUid !== sessions.get(bearer(req))?.uid) return res.sendStatus(403);
  const thumb = parseImg(req.body?.image, 400 * 1024);
  if (!thumb) return res.status(400).json({ error: 'Invalid thumbnail or file too large' });
  g.thumb = thumb; g.thumbV = Date.now();
  saveGame(req.params.id);
  res.json({ ok: true });
});
// ---------- Changelog (update notes written by the game's developer) ----------
const clText = s => String(s || '').replace(/\r/g, '').replace(/[<>]/g, '').trim().slice(0, 400);
app.get('/api/games/:id/changelog', (req, res) => {
  const g = GAMES[req.params.id];
  if (!g) return res.sendStatus(404);
  res.json({ changelog: g.changelog || [] });
});
app.post('/api/games/:id/changelog', (req, res) => {
  const g = mineGame(req); if (!g) return res.sendStatus(403);
  const ver = txt(req.body?.ver, 10) || 'v1', text = clText(req.body?.text);
  if (!text) return res.status(400).json({ error: 'Write the update notes first' });
  g.changelog = g.changelog || [];
  g.changelog.unshift({ id: crypto.randomBytes(4).toString('hex'), ver, text, ts: Date.now() });
  g.changelog = g.changelog.slice(0, 20);
  saveGame(req.params.id);
  res.json({ ok: true, changelog: g.changelog });
});
app.delete('/api/games/:id/changelog/:cid', (req, res) => {
  const g = mineGame(req); if (!g) return res.sendStatus(403);
  g.changelog = (g.changelog || []).filter(e => e.id !== req.params.cid);
  saveGame(req.params.id);
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
      admin: isAdmin(u),
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
  if (g.ownerUid === me.uid) return res.status(400).json({ error: 'You cannot review your own game' });
  const text = plain(req.body?.text, 500);
  if (!text) return res.status(400).json({ error: 'Write your review first' });
  const list = reviewsOf(g), up = !!req.body?.up, ex = list.find(r => r.uid === me.uid);
  if (ex) Object.assign(ex, { up, text, ts: Date.now() });
  else if (list.length >= 500) return res.status(400).json({ error: 'Review limit reached for this game' });
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
  if (r.uid === me.uid) return res.status(400).json({ error: 'You cannot vote on your own review' });
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
const author = (users, uid, name) => { const u = users.get(uid); return { name: u?.name || name, uid, av: u?.avatar ? u.av : 0, color: u?.color || '#1463ff', admin: isAdmin(u) }; };
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
  if (title.length < 3) return res.status(400).json({ error: 'Title must be at least 3 characters' });
  if (!body) return res.status(400).json({ error: 'Thread body cannot be empty' });
  const now = Date.now();
  if (now - (me.lastThread || 0) < 30000) return res.status(400).json({ error: 'Wait 30 seconds before creating another thread' });
  me.lastThread = now;
  if (threads.length >= 500) threads.splice(threads.reduce((m, t, i, a) => (t.last < a[m].last ? i : m), 0), 1);
  const t = { id: String(++tid), cat: cat.id, title, body, uid: me.uid, name: me.name, ts: now, last: now, views: 0, posts: [] };
  threads.push(t);
  res.json({ id: t.id });
});
app.get('/api/forum/thread/:id', (req, res) => {
  const t = threads.find(x => x.id === req.params.id); if (!t) return res.sendStatus(404);
  if (!req.query.nv) t.views++;
  const users = uidMap(), me = meOf(req);
  res.json({ ...item(users, t), category: CATS.find(c => c.id === t.cat), body: t.body, own: me?.uid === t.uid,
    posts: t.posts.map(p => ({ id: p.id, body: p.body, ts: p.ts, own: me?.uid === p.uid, author: author(users, p.uid, p.name) })) });
});
app.post('/api/forum/thread/:id/reply', (req, res) => {
  const me = meOf(req); if (!me) return res.sendStatus(401);
  const t = threads.find(x => x.id === req.params.id); if (!t) return res.sendStatus(404);
  const body = plain(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'Reply cannot be empty' });
  if (t.posts.length >= 300) return res.status(400).json({ error: 'This thread is full' });
  const now = Date.now();
  if (now - (me.lastReply || 0) < 5000) return res.status(400).json({ error: 'Wait a few seconds before replying again' });
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

// ---------- Groups (tab "Groups" di samping People) ----------
// - Di tab grup ada macam-macam grup (grup resmi bawaan + grup buatan user)
// - Batasan: setiap akun hanya boleh membuat MAX_GROUPS_PER_ACCOUNT (2) grup
// - Nama grup harus unik -> kalau sudah dipakai muncul error "silahkan pilih nama yang lain"
// - Setiap grup punya forum sendiri (thread + reply)
const MAX_GROUPS_PER_ACCOUNT = 2;
const MAX_GROUPS_TOTAL = 200;
const MAX_MEMBERS_PER_GROUP = 100;
const GROUPS = new Map(); // id -> group
const cleanGroupName = s => String(s || '').replace(/[^\p{L}\p{N}_ .-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
const isGroupNameTaken = (n, except) => [...GROUPS.values()].some(g => g !== except && g.name.toLowerCase() === String(n || '').toLowerCase());
const myGroupCount = uid => [...GROUPS.values()].filter(g => g.ownerUid === uid).length;
const liteUser = (users, uid, fallbackName) => { const u = users.get(uid); return { uid: uid || null, name: u?.name || fallbackName || 'Former user', av: u?.avatar ? u.av : 0, color: u?.color || '#1463ff', admin: isAdmin(u) }; };
const gThreadItem = (users, g, t) => ({ id: t.id, gid: g.id, title: t.title, ts: t.ts, replies: t.posts.length, views: t.views, author: liteUser(users, t.uid, t.name) });
const groupCard = (users, g) => ({ id: g.id, name: g.name, desc: g.desc, color: g.color, icon: g.icon, members: g.members.size, threads: g.threads.length, owner: liteUser(users, g.ownerUid, g.ownerName), created: g.created });

app.get('/api/groups', (req, res) => {
  const me = meOf(req), users = uidMap();
  const q = String(req.query.q || '').toLowerCase().trim();
  let list = [...GROUPS.values()];
  if (q.length >= 2) list = list.filter(g => (g.name + ' ' + g.desc).toLowerCase().includes(q));
  list.sort((a, b) => b.members.size - a.members.size || b.created - a.created);
  res.json({ mine: me ? myGroupCount(me.uid) : 0, limit: MAX_GROUPS_PER_ACCOUNT, total: list.length, groups: list.slice(0, 120).map(g => groupCard(users, g)) });
});
app.post('/api/groups', (req, res) => {
  const me = meOf(req); if (!me) return res.sendStatus(401);
  const b = req.body || {};
  const name = cleanGroupName(b.name);
  if (name.length < 3) return res.status(400).json({ error: 'Group name must be at least 3 characters' });
  if (isGroupNameTaken(name)) return res.status(400).json({ error: DUP_NAME_ERROR });
  if (myGroupCount(me.uid) >= MAX_GROUPS_PER_ACCOUNT) return res.status(400).json({ error: 'You can only create ' + MAX_GROUPS_PER_ACCOUNT + ' groups per account' });
  if (GROUPS.size >= MAX_GROUPS_TOTAL) return res.status(400).json({ error: 'Server is full, try again later' });
  const users = uidMap();
  const g = {
    id: 'g' + crypto.randomBytes(4).toString('hex'), name,
    desc: txt(b.desc, 160) || 'No description yet.',
    color: HEX.test(b.color) ? b.color : '#1463ff',
    icon: String(b.icon || '').trim().slice(0, 2) || name[0].toUpperCase(),
    ownerUid: me.uid, ownerName: me.name, created: Date.now(),
    members: new Map([[me.uid, { name: me.name, role: 'owner', at: Date.now() }]]),
    threads: []
  };
  GROUPS.set(g.id, g);
  res.json({ id: g.id, group: groupCard(users, g) });
});
app.get('/api/groups/:id', (req, res) => {
  const g = GROUPS.get(req.params.id); if (!g) return res.sendStatus(404);
  const me = meOf(req), users = uidMap();
  res.json({
    group: { ...groupCard(users, g), own: !!me && g.ownerUid === me.uid },
    joined: !!me && g.members.has(me.uid),
    own: !!me && g.ownerUid === me.uid,
    members: [...g.members.entries()]
      .map(([uid, m]) => ({ ...liteUser(users, uid, m.name), role: m.role, joinedAt: m.at }))
      .sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || a.joinedAt - b.joinedAt)
      .slice(0, MAX_MEMBERS_PER_GROUP),
    threads: g.threads.slice().sort(byLast).slice(0, 100).map(t => gThreadItem(users, g, t))
  });
});
app.post('/api/groups/:id/join', (req, res) => {
  const me = meOf(req); if (!me) return res.sendStatus(401);
  const g = GROUPS.get(req.params.id); if (!g) return res.sendStatus(404);
  if (!g.members.has(me.uid)) {
    if (g.members.size >= MAX_MEMBERS_PER_GROUP) return res.status(400).json({ error: 'This group is full' });
    g.members.set(me.uid, { name: me.name, role: 'member', at: Date.now() });
  }
  res.json({ ok: true });
});
app.post('/api/groups/:id/leave', (req, res) => {
  const me = meOf(req); if (!me) return res.sendStatus(401);
  const g = GROUPS.get(req.params.id); if (!g) return res.sendStatus(404);
  if (g.ownerUid === me.uid) return res.status(400).json({ error: 'Owner cannot leave — delete the group instead' });
  g.members.delete(me.uid);
  res.json({ ok: true });
});
app.delete('/api/groups/:id', (req, res) => {
  const me = meOf(req); if (!me) return res.sendStatus(401);
  const g = GROUPS.get(req.params.id); if (!g) return res.sendStatus(404);
  if (g.ownerUid !== me.uid && !isAdmin(me)) return res.sendStatus(403); // owner atau admin (Zerks)
  GROUPS.delete(g.id);
  res.sendStatus(204);
});
// ----- Forum di dalam grup -----
app.post('/api/groups/:id/forum', (req, res) => {
  const me = meOf(req); if (!me) return res.sendStatus(401);
  const g = GROUPS.get(req.params.id); if (!g) return res.sendStatus(404);
  if (!g.members.has(me.uid) && !isAdmin(me)) return res.status(403).json({ error: 'Join this group before posting in its forum' });
  const title = plain(req.body?.title, 100).replace(/\s+/g, ' '), body = plain(req.body?.body, 2000);
  if (title.length < 3) return res.status(400).json({ error: 'Title must be at least 3 characters' });
  if (!body) return res.status(400).json({ error: 'Thread body cannot be empty' });
  const now = Date.now();
  if (now - (me.lastThread || 0) < 30000) return res.status(400).json({ error: 'Wait 30 seconds before creating another thread' });
  me.lastThread = now;
  if (g.threads.length >= 200) g.threads.splice(g.threads.reduce((m, t, i, a) => (t.last < a[m].last ? i : m), 0), 1);
  const t = { id: crypto.randomBytes(4).toString('hex'), title, body, uid: me.uid, name: me.name, ts: now, last: now, views: 0, posts: [] };
  g.threads.push(t);
  res.json({ id: t.id });
});
app.get('/api/groups/:id/forum/:tid', (req, res) => {
  const g = GROUPS.get(req.params.id); if (!g) return res.sendStatus(404);
  const t = g.threads.find(x => x.id === req.params.tid); if (!t) return res.sendStatus(404);
  if (!req.query.nv) t.views++;
  const users = uidMap(), me = meOf(req);
  res.json({ ...gThreadItem(users, g, t), groupName: g.name, body: t.body,
    own: me?.uid === t.uid,
    isOwner: !!me && g.ownerUid === me.uid,
    canDelete: !!me && (me.uid === t.uid || g.ownerUid === me.uid || isAdmin(me)),
    posts: t.posts.map(p => ({ id: p.id, body: p.body, ts: p.ts, own: me?.uid === p.uid, author: liteUser(users, p.uid, p.name) })) });
});
app.post('/api/groups/:id/forum/:tid/reply', (req, res) => {
  const me = meOf(req); if (!me) return res.sendStatus(401);
  const g = GROUPS.get(req.params.id); if (!g) return res.sendStatus(404);
  const t = g.threads.find(x => x.id === req.params.tid); if (!t) return res.sendStatus(404);
  if (!g.members.has(me.uid) && !isAdmin(me)) return res.status(403).json({ error: 'Join this group before replying here' });
  const body = plain(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'Reply cannot be empty' });
  if (t.posts.length >= 300) return res.status(400).json({ error: 'This thread is full' });
  const now = Date.now();
  if (now - (me.lastReply || 0) < 5000) return res.status(400).json({ error: 'Wait a few seconds before replying again' });
  me.lastReply = now;
  t.posts.push({ id: crypto.randomBytes(3).toString('hex'), uid: me.uid, name: me.name, body, ts: now });
  t.last = now;
  res.json({ ok: true });
});
app.delete('/api/groups/:id/forum/:tid', (req, res) => {
  const me = meOf(req);
  const g = GROUPS.get(req.params.id); if (!g) return res.sendStatus(404);
  const i = g.threads.findIndex(x => x.id === req.params.tid); if (i < 0) return res.sendStatus(404);
  const t = g.threads[i];
  // boleh hapus: penulis thread, owner grup, atau admin (Zerks)
  if (!me || (t.uid !== me.uid && g.ownerUid !== me.uid && !isAdmin(me))) return res.sendStatus(403);
  g.threads.splice(i, 1);
  res.sendStatus(204);
});
app.delete('/api/groups/:id/forum/:tid/post/:pid', (req, res) => {
  const me = meOf(req);
  const g = GROUPS.get(req.params.id); if (!g) return res.sendStatus(404);
  const t = g.threads.find(x => x.id === req.params.tid); if (!t) return res.sendStatus(404);
  const i = t.posts.findIndex(p => p.id === req.params.pid); if (i < 0) return res.sendStatus(404);
  // boleh hapus: penulis reply, owner grup, atau admin (Zerks)
  if (!me || (t.posts[i].uid !== me.uid && g.ownerUid !== me.uid && !isAdmin(me))) return res.sendStatus(403);
  t.posts.splice(i, 1);
  res.sendStatus(204);
});

// ---------- Friends & notifications ----------
const userCard = u => ({ uid: u.uid, name: u.name, color: u.color, av: u.avatar ? u.av : 0, game: u.game && GAMES[u.game] ? GAMES[u.game].title : null, followers: u.followers?.size || 0, following: u.following?.size || 0, admin: isAdmin(u) });
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
  const userBadges = getUserBadges(u.uid);
  res.json({ ...userCard(u), outfit: u.outfit || null, friend: me && me.uid !== u.uid ? friendState(me, u) : 'none', followed: !!me?.following?.has(u.uid), friends: u.friends.size, joined: u.joined || null, lastSeen: u.lastSeen || null, about: u.about || '', level: levelOf(u),
    friendList: (() => { const m = uidMap(); return [...u.friends].map(id => m.get(id)).filter(Boolean).slice(0, 12).map(userCard); })(),
    games: Object.entries(GAMES).filter(([, g]) => g.ownerUid === u.uid).map(([id, g]) => pub(id, g, bearer(req))),
    badges: userBadges.slice(0, 10) }); // Show up to 10 badges in profile
});
app.post('/api/users/:uid/follow', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const o = other(req, me); if (!o) return res.sendStatus(404);
  me.following ||= new Set(); o.followers ||= new Set();
  me.following.add(o.uid); o.followers.add(me.uid);
  res.json({ ok: true, followers: o.followers.size, following: me.following.size });
});
app.delete('/api/users/:uid/follow', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const o = other(req, me); if (!o) return res.sendStatus(404);
  me.following?.delete(o.uid); o.followers?.delete(me.uid);
  res.json({ ok: true, followers: o.followers?.size || 0, following: me.following?.size || 0 });
});
app.get('/api/friends', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const users = uidMap();
  res.json({ friends: [...me.friends].map(id => users.get(id)).filter(Boolean).map(userCard).sort((a, b) => !!b.game - !!a.game) });
});
app.post('/api/friends/:uid/request', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const o = other(req, me); if (!o) return res.sendStatus(404);
  if (me.friends.has(o.uid)) return res.json({ ok: true, state: 'friends' });
  if (me.reqOut.has(o.uid)) return res.json({ ok: true, state: 'sent' });
  if (me.reqIn.has(o.uid)) { makeFriends(me, o); return res.json({ ok: true, state: 'accepted' }); } // they already asked me
  if (me.friends.size >= 100 || me.reqOut.size >= 50) return res.status(400).json({ error: 'Friend / request limit reached' });
  me.reqOut.add(o.uid); o.reqIn.set(me.uid, Date.now());
  res.json({ ok: true, state: 'sent' });
});
app.post('/api/friends/:uid/accept', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const o = other(req, me); if (!o || !me.reqIn.has(o.uid)) return res.sendStatus(404);
  if (me.friends.size >= 100) return res.status(400).json({ error: 'Friend list full' });
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

// ---------- Level, games friends played, My T-Shirts / My Accessories ----------
const levelOf = u => 1 + Math.floor(Math.sqrt((u.xp || 0) / 5));
app.get('/api/friends/played', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const users = uidMap(), map = new Map();
  for (const id of me.friends) {
    const f = users.get(id); if (!f || !f.played) continue;
    for (const [gid, ts] of f.played) if (GAMES[gid]) { const e = map.get(gid) || { ts: 0, friends: [] }; e.ts = Math.max(e.ts, ts); e.friends.push(userCard(f)); map.set(gid, e); }
  }
  res.json({ games: [...map].sort((a, b) => b[1].ts - a[1].ts).map(([gid, e]) => ({ ...pub(gid, GAMES[gid], bearer(req)), friends: e.friends.slice(0, 8), friendCount: e.friends.length })) });
});
const ITEM_KINDS = new Map([['shirts', 8], ['accessories', 10]]);
app.get('/api/me/items', (req, res) => { const me = needMe(req, res); if (!me) return; res.json({ shirts: me.shirts || [], accessories: me.accessories || [] }); });
app.post('/api/me/items/:kind', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  const kind = req.params.kind, max = ITEM_KINDS.get(kind); if (!max) return res.sendStatus(404);
  const list = (me[kind] = me[kind] || []), b = req.body || {}, name = txt(b.name, 30);
  if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  if (list.length >= max) return res.status(400).json({ error: 'You can have up to ' + max + ' items here' });
  const it = { id: crypto.randomBytes(4).toString('hex'), name, ts: Date.now() };
  if (kind === 'shirts') {
    const s = String(b.image || '');
    if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) || s.length > 180000) return res.status(400).json({ error: 'Choose a valid image (120 KB max)' });
    it.image = s;
  } else {
    if (!OUT_HATS.includes(b.hat) || b.hat === 'none') return res.status(400).json({ error: 'Choose an accessory type' });
    it.hat = b.hat; it.color = HEX.test(b.color) ? b.color : '#e63946';
  }
  list.unshift(it); res.json({ item: it });
});
app.delete('/api/me/items/:kind/:id', (req, res) => {
  const me = needMe(req, res); if (!me) return;
  if (!ITEM_KINDS.has(req.params.kind)) return res.sendStatus(404);
  me[req.params.kind] = (me[req.params.kind] || []).filter(i => i.id !== req.params.id); res.sendStatus(204);
});

// ---------- Avatar outfit (colors, face, hat) ----------
const OUT_PARTS = ['head', 'torso', 'armL', 'armR', 'legL', 'legR'];
const OUT_FACES = ['smile', 'cool', 'wink', 'surprised', 'sad', 'angry'];
const OUT_HATS = ['none', 'cap', 'tophat', 'crown', 'headphones', 'horns'];
const cleanOutfit = o => {
  const shirt = String(o?.tshirt || '');
  const out = { skin: {}, face: OUT_FACES.includes(o?.face) ? o.face : 'smile', hat: OUT_HATS.includes(o?.hat) ? o.hat : 'none', hatColor: HEX.test(o?.hatColor) ? o.hatColor : '#e63946', tshirt: /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(shirt) && shirt.length <= 180000 ? shirt : null };
  for (const k of OUT_PARTS) out.skin[k] = HEX.test(o?.skin?.[k]) ? o.skin[k] : '#e6eaf2';
  return out;
};
app.get('/api/outfit', (req, res) => { const me = sessions.get(bearer(req)); if (!me) return res.sendStatus(401); res.json({ outfit: me.outfit || null }); });
app.post('/api/outfit', (req, res) => { const me = sessions.get(bearer(req)); if (!me) return res.sendStatus(401); me.outfit = cleanOutfit(req.body); res.json({ outfit: me.outfit }); });

// ---------- Admin Panel — khusus user bernama "Zerks" ----------
const needAdmin = (req, res) => {
  const me = sessions.get(bearer(req));
  if (!me) { res.sendStatus(401); return null; }
  if (!isAdmin(me)) { res.status(403).json({ error: 'Admin panel is only for the user "' + ADMIN_NAME + '"' }); return null; }
  return me;
};
app.get('/api/admin/overview', (req, res) => {
  const me = needAdmin(req, res); if (!me) return;
  const users = uidMap();
  const allGroups = [...GROUPS.values()];
  const groupThreadList = allGroups.flatMap(g => g.threads);
  res.json({
    me: pubUser(me),
    stats: {
      users: users.size,
      online: [...instances.values()].reduce((n, i) => n + i.players.size, 0),
      servers: instances.size,
      games: Object.keys(GAMES).length,
      groups: allGroups.length,
      groupThreads: groupThreadList.length,
      groupPosts: groupThreadList.reduce((n, t) => n + t.posts.length, 0),
      forumThreads: threads.length,
      forumPosts: threads.reduce((n, t) => n + t.posts.length, 0),
      badges: BADGES.size
    },
    users: (() => {
      const seen = new Set();
      const list = [];
      [...users.values()].forEach(u => {
        seen.add(u.uid);
        const ban = activeBan(u.name);
        list.push({ ...userCard(u), google: !!u.gid, level: levelOf(u), joined: u.joined || null, lastSeen: u.lastSeen || null, groups: myGroupCount(u.uid), banned: !!ban, ban: ban ? banPayload(ban) : null });
      });
      // banned users whose session was killed stay visible in the panel (from the ban records)
      [...BANS.values()].forEach(b => {
        if (seen.has(b.uid)) return;
        list.push({ uid: b.uid, name: b.name, color: '#4a5568', av: 0, game: null, admin: false, followers: 0, following: 0, google: false, level: 1, joined: b.bannedAt, lastSeen: null, groups: myGroupCount(b.uid), banned: true, ban: banPayload(b) });
      });
      return list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    })(),
    groups: allGroups.map(g => ({ id: g.id, name: g.name, desc: g.desc, color: g.color, icon: g.icon, ownerName: users.get(g.ownerUid)?.name || g.ownerName || 'Voxely', members: g.members.size, threads: g.threads.length, created: g.created }))
      .sort((a, b) => b.created - a.created),
    threads: groupThreadList.map(t => {
      const g = allGroups.find(x => x.threads.includes(t));
      return { id: t.id, gid: g.id, groupName: g.name, title: t.title, authorName: users.get(t.uid)?.name || t.name, replies: t.posts.length, ts: t.ts };
    }).sort((a, b) => b.ts - a.ts)
  });
});
app.post('/api/admin/user/:uid/rename', (req, res) => {
  const me = needAdmin(req, res); if (!me) return;
  const target = uidMap().get(req.params.uid); if (!target) return res.sendStatus(404);
  const name = cleanName(req.body?.name);
  if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters (letters/numbers)' });
  if (target.name.toLowerCase() !== name.toLowerCase() && nameTaken(name)) return res.status(400).json({ error: DUP_NAME_ERROR });
  const old = target.name;
  target.name = name;
  // keep an existing ban attached to this user when the name changes
  const oldBan = BANS.get(banKey(old));
  if (oldBan) { BANS.delete(banKey(old)); oldBan.name = name; oldBan.key = banKey(name); BANS.set(oldBan.key, oldBan); saveBans(); }
  Object.entries(GAMES).forEach(([gid, g]) => { if (g.ownerUid === target.uid) { g.owner = name; saveGame(gid); } });
  GROUPS.forEach(g => {
    if (g.ownerUid === target.uid) g.ownerName = name;
    g.members.forEach((m, uid) => { if (uid === target.uid) m.name = name; });
    g.threads.forEach(t => { if (t.uid === target.uid) t.name = name; t.posts.forEach(p => { if (p.uid === target.uid) p.name = name; }); });
  });
  threads.forEach(t => { if (t.uid === target.uid) t.name = name; t.posts.forEach(p => { if (p.uid === target.uid) p.name = name; }); });
  res.json({ ok: true, old, name });
});
// BAN: replaces the old delete button — asks for a Reason + Duration
app.post('/api/admin/user/:uid/ban', (req, res) => {
  const me = needAdmin(req, res); if (!me) return;
  const target = uidMap().get(req.params.uid);
  if (!target) return res.sendStatus(404);
  if (target.uid === me.uid) return res.status(400).json({ error: 'You cannot ban your own admin account' });
  if (isAdmin(target)) return res.status(400).json({ error: 'Admin accounts cannot be banned' });
  const reason = txt(req.body?.reason, 200);
  if (!reason) return res.status(400).json({ error: 'Reason is required' });
  const duration = String(req.body?.duration || '');
  if (duration !== 'permanent' && !BAN_DURATIONS[duration]) return res.status(400).json({ error: 'Choose a valid duration' });
  const ban = { key: banKey(target.name), uid: target.uid, name: target.name, reason, bannedAt: Date.now(), until: BAN_DURATIONS[duration] ? Date.now() + BAN_DURATIONS[duration] : null, permanent: duration === 'permanent', by: me.name };
  BANS.set(ban.key, ban); saveBans();
  killSessionsOf(target.name); // sign the banned user out of every device
  res.json({ ok: true, ban: banPayload(ban) });
});
app.post('/api/admin/user/:uid/unban', (req, res) => {
  const me = needAdmin(req, res); if (!me) return;
  const target = uidMap().get(req.params.uid);
  // the target may be offline (session already killed by the ban) -> look in the ban records too
  const rec = [...BANS.values()].find(b => b.uid === req.params.uid);
  if (!target && !rec) return res.sendStatus(404);
  if (rec) BANS.delete(rec.key);
  if (target) BANS.delete(banKey(target.name));
  saveBans();
  res.json({ ok: true, unbanned: !!(rec || target) });
});
app.delete('/api/admin/user/:uid', (req, res) => {
  const me = needAdmin(req, res); if (!me) return;
  const target = uidMap().get(req.params.uid);
  if (!target) return res.sendStatus(404);
  if (target.uid === me.uid) return res.status(400).json({ error: 'You cannot delete your own admin account' });
  BANS.delete(banKey(target.name)); saveBans(); // a deleted account no longer needs its ban record
  // hapus grup buatan user ini
  [...GROUPS.entries()].forEach(([id, g]) => { if (g.ownerUid === target.uid) GROUPS.delete(id); });
  // hapus jejaknya di grup lain & forum
  GROUPS.forEach(g => {
    g.threads = g.threads.filter(t => t.uid !== target.uid);
    g.threads.forEach(t => { t.posts = t.posts.filter(p => p.uid !== target.uid); });
    g.members.delete(target.uid);
  });
  for (let i = threads.length - 1; i >= 0; i--) if (threads[i].uid === target.uid) threads.splice(i, 1);
  threads.forEach(t => { t.posts = t.posts.filter(p => p.uid !== target.uid); });
  // hapus game buatan user ini
  Object.entries(GAMES).forEach(([gid, g]) => { if (g.ownerUid === target.uid) { delete GAMES[gid]; dropGame(gid); } });
  // cabut semua sesi login user ini
  [...sessions.entries()].forEach(([tok, u]) => { if (u.uid === target.uid) sessions.delete(tok); });
  if (target.gid) byGoogle.delete(target.gid);
  res.json({ ok: true });
});
app.delete('/api/admin/group/:gid', (req, res) => {
  const me = needAdmin(req, res); if (!me) return;
  if (!GROUPS.has(req.params.gid)) return res.sendStatus(404);
  GROUPS.delete(req.params.gid);
  res.json({ ok: true });
});

// ---------- Badge System API ----------
// Get all badges (public list)
app.get('/api/badges', (req, res) => {
  const me = sessions.get(bearer(req));
  const badges = listAllBadges().filter(b => !b.isHidden || (me && me.uid === b.createdBy));
  res.json({ badges, total: badges.length });
});

// Get badge details
app.get('/api/badges/:id', (req, res) => {
  const badge = getBadgeDefinition(req.params.id);
  if (!badge) return res.sendStatus(404);
  res.json(badge);
});

// Create a new badge (developer only - Google authenticated users)
app.post('/api/badges', (req, res) => {
  const me = sessions.get(bearer(req));
  if (!me) return res.sendStatus(401);
  if (!me.gid) return res.status(403).json({ error: 'Only verified accounts can create badges' });

  const b = req.body || {};
  if (!b.name || String(b.name).trim().length < 2) {
    return res.status(400).json({ error: 'Badge name must be at least 2 characters' });
  }

  const badge = createBadge(b, me);
  res.json({ badge, ok: true });
});

// Award badge to a user (developer or self)
app.post('/api/badges/:id/award', (req, res) => {
  const me = sessions.get(bearer(req));
  if (!me) return res.sendStatus(401);

  const badge = getBadgeDefinition(req.params.id);
  if (!badge) return res.sendStatus(404);

  const key = String(req.body?.uid || '').trim(), allU = uidMap();
  const targetUser = allU.get(key) || [...allU.values()].find(u => u.name.toLowerCase() === key.toLowerCase());
  const targetUid = targetUser?.uid;

  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  if (badge.createdBy !== me.uid) return res.status(403).json({ error: 'Only the badge creator can give this badge' });

  const success = awardBadge(targetUid, req.params.id);
  if (!success) return res.status(400).json({ error: 'User already has this badge' });

  res.json({ ok: true });
});

// Get user's badges
app.get('/api/users/:uid/badges', (req, res) => {
  const targetUser = uidMap().get(req.params.uid);
  if (!targetUser) return res.sendStatus(404);

  const badges = getUserBadges(req.params.uid);
  res.json({ badges, total: badges.length });
});

// Get my badges
app.get('/api/me/badges', (req, res) => {
  const me = sessions.get(bearer(req));
  if (!me) return res.sendStatus(401);

  const badges = getUserBadges(me.uid);
  res.json({ badges, total: badges.length });
});

// Delete a badge (creator only)
app.delete('/api/badges/:id', (req, res) => {
  const me = sessions.get(bearer(req));
  if (!me) return res.sendStatus(401);

  const badge = getBadgeDefinition(req.params.id);
  if (!badge) return res.sendStatus(404);
  if (badge.createdBy !== me.uid) return res.sendStatus(403);

  BADGES.delete(req.params.id);
  res.sendStatus(204);
});

// ---------- Game stats (owner dashboard) ----------
const dayKey = t => new Date(t || Date.now()).toISOString().slice(0, 10);
const statsOf = g => (g.stats = g.stats || { visits: 0, uniq: [], peak: 0, secs: 0, sessions: 0, daily: {} });
const dirtyGames = new Set();
function touchGame(id) { if (!dirtyGames.size) setTimeout(() => { dirtyGames.forEach(saveGame); dirtyGames.clear(); }, 30000); dirtyGames.add(id); }
function trackJoin(gid, user) {
  const g = GAMES[gid]; if (!g || !g.ownerUid) return;
  const s = statsOf(g); s.visits++; s.sessions++;
  if (s.uniq.length < 5000 && !s.uniq.includes(user.uid)) s.uniq.push(user.uid);
  const d = dayKey(); s.daily[d] = (s.daily[d] || 0) + 1;
  Object.keys(s.daily).sort().slice(0, -30).forEach(k => delete s.daily[k]);
  s.peak = Math.max(s.peak, online(gid)); touchGame(gid);
}
function trackLeave(gid, secs) { const g = GAMES[gid]; if (!g || !g.ownerUid) return; statsOf(g).secs += Math.max(0, secs); touchGame(gid); }
app.get('/api/games/:id/stats', (req, res) => {
  const g = mineGame(req); if (!g) return res.sendStatus(403);
  const s = statsOf(g), id = req.params.id, rv = (g.reviews || []).filter(r => r.reports.size < 3), daily = [];
  for (let i = 13; i >= 0; i--) { const d = dayKey(Date.now() - i * 864e5); daily.push({ d, n: s.daily[d] || 0 }); }
  res.json({ visits: s.visits, unique: s.uniq.length, online: online(id), peak: s.peak, secs: Math.round(s.secs), avg: s.sessions ? Math.round(s.secs / s.sessions) : 0,
    servers: instOf(id).length, reviews: rv.length, up: rv.filter(r => r.up).length, daily });
});

// ---------- Server list ----------
app.get('/api/games/:id/servers', (req, res) => {
  if (!GAMES[req.params.id]) return res.sendStatus(404);
  res.json(instOf(req.params.id).map(i => ({
    id: i.id, players: i.players.size, max: i.max, full: i.players.size >= i.max,
    names: [...i.players.values()].slice(0, 5).map(p => p.name), age: Math.floor((Date.now() - i.ts) / 1000)
  })).sort((a, b) => b.players - a.players));
});

// ---------- Persistence: games made by Google users are stored in Supabase ----------
// Needs the SECRET key as an environment variable (never put it in the code).
const SUPA_SECRET = process.env.SUPABASE_SECRET_KEY || '';
async function db(path, opts = {}) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, { ...opts, headers: { apikey: SUPA_SECRET, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200));
  return r.status === 204 ? null : r.json().catch(() => null);
}
const rowOf = (id, g) => ({
  id, owner_uid: g.ownerUid, owner_name: g.owner || null,
  data: { title: g.title, tagline: g.tagline, desc: g.desc, tags: g.tags, sky: g.sky, art: g.art, spawn: g.spawn, boxes: g.boxes, status: g.status || null, changelog: g.changelog || [], scripts: g.scripts || [], stats: g.stats || null },
  thumb_type: g.thumb ? g.thumb.type : null, thumb_b64: g.thumb ? g.thumb.buf.toString('base64') : null, thumb_v: g.thumbV || 0, updated_at: new Date().toISOString()
});
function saveGame(id) {
  const g = GAMES[id];
  if (!SUPA_SECRET || !g || !g.ownerGoogle) return; // guests' games stay in memory only
  db('games?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rowOf(id, g)) })
    .catch(e => console.error('save game failed:', e.message));
}
function dropGame(id) {
  if (!SUPA_SECRET) return;
  db('games?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }).catch(e => console.error('delete game failed:', e.message));
}
async function loadGames() {
  if (!SUPA_SECRET) { console.log('SUPABASE_SECRET_KEY not set -> user games are kept in memory only'); return; }
  try {
    const rows = (await db('games?select=*')) || [];
    for (const r of rows) {
      if (GAMES[r.id]) continue;
      GAMES[r.id] = { ...r.data, owner: r.owner_name, ownerUid: r.owner_uid, ownerGoogle: true,
        thumb: r.thumb_b64 ? { type: r.thumb_type, buf: Buffer.from(r.thumb_b64, 'base64') } : null, thumbV: Number(r.thumb_v) || 0 };
    }
    console.log('Loaded ' + rows.length + ' game(s) from Supabase');
  } catch (e) { console.error('load games failed:', e.message); }
}

const WEB = [path.join(__dirname, 'web'), path.join(__dirname, '..', 'web')].find(p => fs.existsSync(path.join(p, 'index.html'))) || __dirname;
app.get('/config.js', (req, res, next) => {
  if (WEB !== __dirname && fs.existsSync(path.join(WEB, 'config.js'))) return next();
  const origin = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
  res.type('js').send('window.VOXELY=' + JSON.stringify({ server: origin, supabaseUrl: SUPA_URL, supabaseKey: SUPA_KEY, download: process.env.CLIENT_DOWNLOAD_URL || '' }) + ';');
});
app.get(['/', '/index.html'], (_req, res) => fs.existsSync(path.join(WEB, 'index.html')) ? res.sendFile(path.join(WEB, 'index.html')) : res.send('Voxely game server is running'));
if (WEB !== __dirname) app.use(express.static(WEB, { index: false, dotfiles: 'ignore' }));

// ---------- Multiplayer ----------
io.use((socket, next) => {
  const user = sessions.get(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user; next();
});
io.on('connection', socket => {
  let inst = null, lastChat = 0, lastEv = 0, lastEmote = 0, joinedAt = 0;
  socket.on('join', arg => {
    const gid = typeof arg === 'string' ? arg : arg?.game;
    if (!GAMES[gid] || inst) return;
    const g = GAMES[gid];
    inst = pickInstance(gid, arg?.room);
    socket.join(inst.id); socket.user.game = gid;
    (socket.user.played = socket.user.played || new Map()).set(gid, Date.now()); socket.user.xp = (socket.user.xp || 0) + 5;
    const me = { id: socket.id, uid: socket.user.uid, name: socket.user.name, color: socket.user.color, admin: isAdmin(socket.user), x: g.spawn[0], y: g.spawn[1], z: g.spawn[2], ry: 0, st: 0, outfit: socket.user.outfit || null };
    inst.players.set(socket.id, me);
    trackJoin(gid, socket.user); joinedAt = Date.now();
    socket.emit('init', { me, room: inst.id, now: Date.now(), start: inst.ts, game: { title: g.title, sky: g.sky, spawn: g.spawn, boxes: g.boxes, scripts: g.scripts || [] }, players: [...inst.players.values()] });
    socket.to(inst.id).emit('join', me);
    io.to(inst.id).emit('count', inst.players.size);
  });
  socket.on('move', m => {
    const p = inst?.players.get(socket.id); if (!p) return;
    Object.assign(p, { x: +m.x || 0, y: +m.y || 0, z: +m.z || 0, ry: +m.ry || 0, st: [0, 1, 2, 3, 4].includes(+m.st) ? +m.st : 0 });
    socket.to(inst.id).volatile.emit('move', p);
  });
  socket.on('chat', text => {
    if (!inst || Date.now() - lastChat < 400) return;
    lastChat = Date.now();
    io.to(inst.id).emit('chat', { id: socket.id, uid: socket.user.uid, name: socket.user.name, color: socket.user.color, admin: isAdmin(socket.user), text: String(text).slice(0, 140) });
  });
  socket.on('emote', e => { // /e wave, /e dance (and 'stop' when the player moves)
    if (!inst || !['wave', 'dance', 'stop'].includes(e) || Date.now() - lastEmote < 200) return;
    lastEmote = Date.now(); socket.to(inst.id).emit('emote', { id: socket.id, e });
  });
  socket.on('ev', (n, d) => { // custom events from game scripts, relayed to everyone else on the same server
    if (!inst || typeof n !== 'string' || n.length > 32 || Date.now() - lastEv < 40) return;
    lastEv = Date.now();
    let j; try { j = JSON.stringify(d); } catch (e) { return; }
    if (j && j.length > 1024) return;
    socket.to(inst.id).emit('ev', { from: socket.user.name, n, d });
  });
  socket.on('disconnect', () => {
    if (!inst) return;
    trackLeave(inst.game, (Date.now() - joinedAt) / 1000);
    socket.user.game = null; socket.user.lastSeen = Date.now(); socket.user.xp = (socket.user.xp || 0) + Math.floor((Date.now() - joinedAt) / 60000);
    inst.players.delete(socket.id);
    io.to(inst.id).emit('leave', socket.id);
    io.to(inst.id).emit('count', inst.players.size);
    if (!inst.players.size) instances.delete(inst.id); // empty servers disappear from the list
  });
});

// ---------- Seed: macam-macam grup resmi biar tab Groups tidak kosong ----------
function seedGroups() {
  if (GROUPS.size) return;
  const seeds = [
    ['Voxely Official', 'Official news, updates and events from the Voxely team.', '📢', '#5b8def'],
    ['Builders Club', 'Show off your builds, share tips and get feedback from other builders.', '🧱', '#f97316'],
    ['Obby Masters', 'For parkour fans — post your hardest obbies and speedrun times here.', '🏃', '#22c55e'],
    ['Scripters Hub', 'Help each other with scripts, game logic and the Developer Portal.', '💻', '#8b5cf6'],
    ['Music Lounge', 'Talk about music, share your favorite tracks and playlists.', '🎵', '#ec4899'],
    ['Food Corner', 'Food talk, recipes and snack reviews. Pizza lovers welcome.', '🍕', '#eab308']
  ];
  seeds.forEach(([name, desc, icon, color], i) => {
    const id = 'g' + crypto.randomBytes(4).toString('hex');
    GROUPS.set(id, {
      id, name, desc, icon, color, ownerUid: null, ownerName: 'Voxely Team',
      created: Date.now() - (seeds.length - i) * 864e5,
      members: new Map(), threads: []
    });
  });
  console.log('Seeded ' + seeds.length + ' official groups');
}

seedGroups();
loadGames().finally(() => server.listen(PORT, () => console.log(`Voxely game server: http://localhost:${PORT}`)));

