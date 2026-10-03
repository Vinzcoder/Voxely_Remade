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
const GAMES = {
  plaza: {
    title: 'Block Plaza', tagline: 'Hang out, chat and jump around.',
    desc: 'A big open plaza with a few blocks to climb. The best place to meet other players and test chat.',
    tags: ['Social', 'Chill', 'Multiplayer'], sky: '#7ec8ff', art: ['#2b6cb0', '#63b3ed'],
    spawn: [0, 2, 0],
    boxes: [B(0, -0.5, 0, 80, 1, 80, '#5cb85c'), B(6, 1, 4, 4, 2, 4, '#e0a040'), B(10, 2, 8, 4, 4, 4, '#d9534f'), B(-8, 0.75, -6, 6, 1.5, 3, '#8e6bd0')]
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
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.get('/api/me', (req, res) => {
  const u = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
  u ? res.json(u) : res.sendStatus(401);
});
app.post('/api/guest', (req, res) => {
  let name = String(req.body?.name || '').replace(/[^\w]/g, '').slice(0, 16);
  if (name.length < 2) name = 'Guest' + Math.floor(1000 + Math.random() * 9000);
  const token = crypto.randomBytes(16).toString('hex');
  const user = { name, color: COLORS[Math.floor(Math.random() * COLORS.length)] };
  if (sessions.size > 5000) sessions.delete(sessions.keys().next().value);
  sessions.set(token, user);
  res.json({ token, user });
});
const bearer = req => (req.headers.authorization || '').replace('Bearer ', '');
const pub = (id, g, tok) => ({ id, title: g.title, tagline: g.tagline, desc: g.desc, tags: g.tags, sky: g.sky, art: g.art, owner: g.owner, mine: !!tok && g.ownerToken === tok, online: rooms[id].size });
app.get('/api/games', (req, res) => res.json(Object.entries(GAMES).map(([id, g]) => pub(id, g, bearer(req)))));

app.get('/api/people', (_req, res) => {
  const list = [...sessions.values()].map(u => ({ name: u.name, color: u.color, game: u.game && GAMES[u.game] ? GAMES[u.game].title : null }));
  list.sort((a, b) => !!b.game - !!a.game);
  res.json(list.slice(0, 200));
});

// ---------- Developer Portal: users publish their own games ----------
const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, lo, hi, d) => { v = parseFloat(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const txt = (v, n) => String(v || '').replace(/[<>]/g, '').trim().slice(0, n);
app.post('/api/games', (req, res) => {
  const tok = bearer(req), user = sessions.get(tok);
  if (!user) return res.sendStatus(401);
  const b = req.body || {};
  const title = txt(b.title, 30);
  if (title.length < 3) return res.status(400).json({ error: 'Judul minimal 3 huruf' });
  const all = Object.values(GAMES).filter(g => g.ownerToken);
  if (all.filter(g => g.ownerToken === tok).length >= 5) return res.status(400).json({ error: 'Maksimal 5 game per akun' });
  if (all.length >= 50) return res.status(400).json({ error: 'Server penuh, coba lagi nanti' });
  const boxes = (Array.isArray(b.boxes) ? b.boxes : []).slice(0, 40).map(x => ({
    x: num(x?.x, -500, 500, 0), y: num(x?.y, -20, 200, 0), z: num(x?.z, -500, 500, 0),
    w: num(x?.w, 0.5, 200, 4), h: num(x?.h, 0.5, 100, 1), d: num(x?.d, 0.5, 200, 4),
    c: HEX.test(x?.c) ? x.c : '#888888'
  }));
  if (!boxes.length) return res.status(400).json({ error: 'Tambahkan minimal 1 platform' });
  const f = boxes[0], id = 'u' + crypto.randomBytes(4).toString('hex');
  const tags = (Array.isArray(b.tags) ? b.tags : []).map(t => txt(t, 14)).filter(Boolean).slice(0, 3);
  GAMES[id] = {
    title, tagline: txt(b.tagline, 60) || 'Game buatan komunitas.', desc: txt(b.desc, 400) || 'Belum ada deskripsi.',
    tags: tags.length ? tags : ['Community'], sky: HEX.test(b.sky) ? b.sky : '#7ec8ff',
    art: [HEX.test(b.art?.[0]) ? b.art[0] : '#1463ff', HEX.test(b.art?.[1]) ? b.art[1] : '#0a0f1a'],
    spawn: [f.x, f.y + f.h / 2 + 1.5, f.z], boxes, owner: user.name, ownerToken: tok
  };
  rooms[id] = new Map();
  res.json({ id });
});
app.delete('/api/games/:id', (req, res) => {
  const g = GAMES[req.params.id];
  if (!g || !g.ownerToken || g.ownerToken !== bearer(req)) return res.sendStatus(403);
  delete GAMES[req.params.id]; // rooms[id] stays so players still inside can leave cleanly
  res.sendStatus(204);
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
    Object.assign(p, { x: +m.x || 0, y: +m.y || 0, z: +m.z || 0, ry: +m.ry || 0 });
    socket.to(gameId).volatile.emit('move', p);
  });
  socket.on('chat', text => {
    if (!gameId || Date.now() - lastChat < 400) return;
    lastChat = Date.now();
    io.to(gameId).emit('chat', { name: socket.user.name, color: socket.user.color, text: String(text).slice(0, 140) });
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
