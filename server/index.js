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
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
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
  sessions.set(token, user);
  res.json({ token, user });
});
app.get('/api/games', (_req, res) => {
  res.json(Object.entries(GAMES).map(([id, g]) => ({ id, ...g, boxes: undefined, online: rooms[id].size })));
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
    gameId = id; socket.join(id);
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
    rooms[gameId].delete(socket.id);
    io.to(gameId).emit('leave', socket.id);
    io.to(gameId).emit('count', rooms[gameId].size);
  });
});

server.listen(PORT, () => console.log(`Voxely game server: http://localhost:${PORT}`));
