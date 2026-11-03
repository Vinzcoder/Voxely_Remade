#!/usr/bin/env node
/* ============================================================================
   VOXELY — SERVER ADDITIONS (referensi integrasi)
   ============================================================================
   File ini adalah IMPLEMENTASI LENGKAP + SIAP JALAN untuk semua endpoint BARU
   yang dibutuhkan frontend Voxely terbaru (voxely-updated.html):

     1. Nama duplikat  -> error "silahkan pilih nama yang lain"
        - POST /api/guest              (daftar/login guest)
        - POST /api/profile            (ganti display name)
        - POST /api/admin/user/:uid/rename
     2. Groups (tab baru di samping People)
        - GET    /api/groups           (daftar semua grup + kuota milikku)
        - POST   /api/groups           (buat grup, MAKS 2 PER AKUN)
        - GET    /api/groups/:id       (detail grup + member + thread forum)
        - DELETE /api/groups/:id       (hapus grup — owner atau admin)
        - POST   /api/groups/:id/join  / leave
     3. Forum di dalam grup
        - POST   /api/groups/:id/forum            (buat thread)
        - GET    /api/groups/:id/forum/:tid       (detail thread + reply)
        - POST   /api/groups/:id/forum/:tid/reply (balas)
        - DELETE /api/groups/:id/forum/:tid       (hapus thread)
        - DELETE /api/groups/:id/forum/:tid/post/:pid (hapus reply)
     4. Admin Panel khusus user bernama "Zerks"
        - GET    /api/admin/overview           (statistik + users + groups + threads)
        - DELETE /api/admin/user/:uid
        - DELETE /api/admin/group/:gid
     5. Badge admin di samping username
        - Setiap objek user yang dikirim server WAJIB berisi  admin: true|false
          (lihat fungsi pubUser() di bawah). Frontend menampilkan ikon perisai
          emas bila user.admin === true ATAU nama = "Zerks".

   CARA PAKAI:
     - Untuk mencoba mandiri : node voxely-server-additions.js  (port 8787,
       penyimpanan file JSON "voxely-data.json" di samping file ini)
     - Untuk integrasi: salin fungsi-fungsi di bagian "ENDPOINT" ke backend
       milikmu (Express/Vercel function). Yang perlu kamu sesuaikan hanya
       penyimpanan data (di sini: file JSON -> ganti ke DB milikmu).

   Konstanta penting (cari & sesuaikan):
     ADMIN_NAME           = "Zerks"  -> akun yang punya Admin Panel
     MAX_GROUPS_PER_USER  = 2        -> batas pembuatan grup per akun
     DUP_NAME_ERROR       = "silahkan pilih nama yang lain"
============================================================================ */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ----------------------------- KONFIGURASI ---------------------------------
const PORT = process.env.PORT || 8787;
const ADMIN_NAME = 'zerks';                       // case-insensitive
const MAX_GROUPS_PER_USER = 2;                    // batas grup per akun
const DUP_NAME_ERROR = 'silahkan pilih nama yang lain';
const DATA_FILE = path.join(__dirname, 'voxely-data.json');

// ------------------------------- UTILITAS ----------------------------------
const genId = (n = 12) => crypto.randomBytes(n).toString('hex').slice(0, n);
const is_admin = (name) => String(name || '').toLowerCase() === ADMIN_NAME;
const json = (res, code, data) => {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
};

// ------------------------- PENYIMPANAN (GANTI KE DB) ------------------------
let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { db = seed(); }
  save();
  return db;
}
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 1));
}

// PENTING: setiap user yang dikirim ke client HARUS lewat pubUser()
// supaya punya flag admin (dipakai untuk ikon di samping username).
function pubUser(u) {
  return {
    uid: u.uid, name: u.name, av: u.av, color: u.color,
    admin: is_admin(u.name),                       // <-- badge admin di frontend
    followers: u.followers, about: u.about, level: u.level,
    joined: u.joined, lastSeen: u.lastSeen, outfit: u.outfit, google: u.google,
  };
}
// Versi ringkas untuk author di forum/member grup (hemat payload).
const lite = (u) => u
  ? { uid: u.uid, name: u.name, av: u.av, color: u.color, admin: is_admin(u.name) }
  : { uid: '', name: '?', av: null, color: '#666', admin: false };

const findUserByName = (name) => {
  const n = String(name || '').trim().toLowerCase();
  return db.users.find((u) => u.name.toLowerCase() === n);
};
const ownedGroupCount = (uid) => db.groups.filter((g) => g.owner === uid).length;
const groupThreadCount = (gid) => db.gthreads.filter((t) => t.gid === gid).length;

// Token sederhana: token -> uid. Ganti dengan JWT/session milikmu bila perlu.
function userFromReq(req) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  const uid = db.tokens[m[1]];
  return db.users.find((u) => u.uid === uid) || null;
}

// ------------------------------ DATA CONTOH --------------------------------
function seed() {
  const now = Date.now(), day = 86400000;
  const mk = (name, color, followers) => ({
    uid: genId(), name, google: false, color, av: null, about: '',
    joined: now - 30 * day, lastSeen: now, followers, following: 0, level: 1,
    outfit: { skin: { head: '#e6eaf2', torso: '#e6eaf2', armL: '#e6eaf2', armR: '#e6eaf2', legL: '#e6eaf2', legR: '#e6eaf2' }, face: 'smile', hat: 'none', hatColor: '#e63946' },
  });
  const zerks = mk('Zerks', '#f5b301', 420);
  const aulia = mk('Aulia', '#e63946', 1200);
  const users = [zerks, aulia];
  const groups = [
    { id: genId(), name: 'Obby Masters', desc: 'Grup para jagoan obby!', color: '#e63946', icon: 'OM', owner: zerks.uid, created: now - 20 * day, members: [zerks.uid, aulia.uid] },
    { id: genId(), name: 'Builder Club', desc: 'Komunitas builder.', color: '#f77f00', icon: 'BC', owner: aulia.uid, created: now - 15 * day, members: [aulia.uid] },
  ];
  const gthreads = [
    { id: genId(), gid: groups[0].id, title: 'Tips naik tower?', body: 'Ada trik?', author: zerks.uid, ts: now - 3 * day, views: 12, posts: [{ id: genId(), author: aulia.uid, body: 'Skip 1 detik lalu lompat!', ts: now - 2 * day }] },
  ];
  return { users, tokens: {}, groups, gthreads };
}

/* ============================ ENDPOINT HANDLERS ============================
   Setiap fungsi menerima (req, res, me, params) — me = user yang login
   (atau null). Salin pola ini ke backend-mu; hanya bagian penyimpanan yang
   perlu diganti.
============================================================================ */

// POST /api/guest  { name }  — daftar/masuk guest + cek nama duplikat
function apiGuest(req, res, me, params, body) {
  let name = String(body.name || '').trim();
  if (!name) { do { name = 'Guest' + Math.floor(1000 + Math.random() * 9000); } while (findUserByName(name)); }
  if (name.length > 16) return json(res, 400, { error: 'Name is too long (max 16 characters)' });
  if (findUserByName(name)) return json(res, 400, { error: DUP_NAME_ERROR }); // <- nama sama
  const u = {
    uid: genId(), name, google: false, color: '#' + genId(3), av: null, about: '',
    joined: Date.now(), lastSeen: Date.now(), followers: 0, following: 0, level: 1,
    outfit: { skin: { head: '#e6eaf2', torso: '#e6eaf2', armL: '#e6eaf2', armR: '#e6eaf2', legL: '#e6eaf2', legR: '#e6eaf2' }, face: 'smile', hat: 'none', hatColor: '#e63946' },
  };
  db.users.push(u);
  const token = genId(32);
  db.tokens[token] = u.uid;
  save();
  json(res, 200, { token, user: pubUser(u) });
}

// POST /api/profile  { name?, about?, avatar? } — cek nama duplikat juga di sini
function apiProfile(req, res, me, params, body) {
  if (!me) return json(res, 401, { error: 'Please sign in first' });
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return json(res, 400, { error: 'Name cannot be empty' });
    if (name.length > 16) return json(res, 400, { error: 'Name is too long (max 16 characters)' });
    const other = findUserByName(name);
    if (other && other.uid !== me.uid) return json(res, 400, { error: DUP_NAME_ERROR });
    me.name = name;
  }
  if (typeof body.about === 'string') me.about = body.about.slice(0, 200);
  if (body.avatar === null) me.av = null;
  else if (typeof body.avatar === 'string' && body.avatar.startsWith('data:image')) me.av = body.avatar;
  save();
  json(res, 200, pubUser(me));
}

// GET /api/groups — daftar grup + kuota milik user
function apiGroupsList(req, res, me) {
  json(res, 200, {
    groups: db.groups.map((g) => ({
      id: g.id, name: g.name, desc: g.desc, color: g.color, icon: g.icon, created: g.created,
      owner: lite(db.users.find((u) => u.uid === g.owner)),
      members: g.members.length, threads: groupThreadCount(g.id),
    })).sort((a, b) => b.members - a.members),
    mine: me ? ownedGroupCount(me.uid) : 0,
  });
}

// POST /api/groups { name, desc, color, icon } — buat grup (MAKS 2 / AKUN)
function apiGroupCreate(req, res, me, params, body) {
  if (!me) return json(res, 401, { error: 'Please sign in first' });
  const name = String(body.name || '').trim();
  const desc = String(body.desc || '').trim().slice(0, 160);
  const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color)) ? String(body.color) : '#1463ff';
  const icon = String(body.icon || '').trim().slice(0, 2) || name.slice(0, 1);
  if (!name) return json(res, 400, { error: 'Group name is required' });
  if (name.length > 24) return json(res, 400, { error: 'Group name is too long (max 24 characters)' });
  if (db.groups.some((g) => g.name.toLowerCase() === name.toLowerCase()))
    return json(res, 400, { error: DUP_NAME_ERROR });                       // <- nama grup dipakai
  if (ownedGroupCount(me.uid) >= MAX_GROUPS_PER_USER)
    return json(res, 400, { error: 'Group limit reached — setiap akun hanya boleh membuat ' + MAX_GROUPS_PER_USER + ' grup.' });
  const g = { id: genId(), name, desc, color, icon, owner: me.uid, created: Date.now(), members: [me.uid] };
  db.groups.push(g);
  save();
  json(res, 200, { id: g.id, name: g.name });
}

// GET /api/groups/:id — detail grup untuk halaman grup (header + forum + member)
function apiGroupDetail(req, res, me, p) {
  const g = db.groups.find((x) => x.id === p.id);
  if (!g) return json(res, 404, { error: 'Group not found' });
  const owner = db.users.find((u) => u.uid === g.owner);
  json(res, 200, {
    group: {
      id: g.id, name: g.name, desc: g.desc, color: g.color, icon: g.icon, created: g.created,
      owner: lite(owner), own: !!me && g.owner === me.uid,
    },
    members: g.members.map((uid) => lite(db.users.find((u) => u.uid === uid))),
    threads: db.gthreads.filter((t) => t.gid === g.id).sort((a, b) => b.ts - a.ts)
      .map((t) => ({ id: t.id, gid: g.id, title: t.title, ts: t.ts, views: t.views, replies: t.posts.length, author: lite(db.users.find((u) => u.uid === t.author)) })),
    joined: !!me && g.members.includes(me.uid),
    own: !!me && g.owner === me.uid,
  });
}

// DELETE /api/groups/:id — owner ATAU admin
function apiGroupDelete(req, res, me, p) {
  if (!me) return json(res, 401, { error: 'Please sign in first' });
  const g = db.groups.find((x) => x.id === p.id);
  if (!g) return json(res, 404, { error: 'Group not found' });
  if (g.owner !== me.uid && !is_admin(me.name))
    return json(res, 400, { error: 'Only the group owner or an admin can delete this group' });
  db.groups = db.groups.filter((x) => x.id !== g.id);
  db.gthreads = db.gthreads.filter((t) => t.gid !== g.id);
  save();
  json(res, 200, { ok: true });
}

// POST /api/groups/:id/join | /leave
function apiGroupJoin(req, res, me, p) {
  if (!me) return json(res, 401, { error: 'Please sign in first' });
  const g = db.groups.find((x) => x.id === p.id);
  if (!g) return json(res, 404, { error: 'Group not found' });
  if (g.owner === me.uid) return json(res, 400, { error: 'Kamu adalah owner grup ini' });
  if (!g.members.includes(me.uid)) { g.members.push(me.uid); save(); }
  json(res, 200, { ok: true });
}
function apiGroupLeave(req, res, me, p) {
  if (!me) return json(res, 401, { error: 'Please sign in first' });
  const g = db.groups.find((x) => x.id === p.id);
  if (!g) return json(res, 404, { error: 'Group not found' });
  if (g.owner === me.uid) return json(res, 400, { error: 'Owner tidak bisa leave — hapus grupnya saja' });
  g.members = g.members.filter((uid) => uid !== me.uid);
  save();
  json(res, 200, { ok: true });
}

// POST /api/groups/:id/forum { title, body } — thread baru di forum grup
function apiGroupThreadCreate(req, res, me, p, body) {
  if (!me) return json(res, 401, { error: 'Please sign in first' });
  const g = db.groups.find((x) => x.id === p.id);
  if (!g) return json(res, 404, { error: 'Group not found' });
  const title = String(body.title || '').trim().slice(0, 100);
  const text = String(body.body || '').trim().slice(0, 2000);
  if (!title) return json(res, 400, { error: 'Thread title is required' });
  if (!text) return json(res, 400, { error: 'Thread body is required' });
  const t = { id: genId(), gid: g.id, title, body: text, author: me.uid, ts: Date.now(), views: 0, posts: [] };
  db.gthreads.push(t);
  save();
  json(res, 200, { id: t.id });
}

// GET /api/groups/:id/forum/:tid — detail thread (views bertambah kecuali ?nv=1)
function apiGroupThreadDetail(req, res, me, p, body, url) {
  const t = db.gthreads.find((x) => x.id === p.tid && x.gid === p.id);
  if (!t) return json(res, 404, { error: 'Thread not found' });
  if (!url.searchParams.has('nv')) { t.views++; save(); }
  const g = db.groups.find((x) => x.id === p.id);
  json(res, 200, {
    id: t.id, gid: p.id, groupName: g ? g.name : '', title: t.title, body: t.body, ts: t.ts,
    author: lite(db.users.find((u) => u.uid === t.author)),
    own: !!me && t.author === me.uid,
    isOwner: !!me && g && g.owner === me.uid,
    replies: t.posts.length, views: t.views,
    posts: t.posts.map((post) => ({ id: post.id, body: post.body, ts: post.ts, author: lite(db.users.find((u) => u.uid === post.author)), own: !!me && post.author === me.uid })),
  });
}

// DELETE /api/groups/:id/forum/:tid — penulis thread, owner grup, atau admin
function apiGroupThreadDelete(req, res, me, p) {
  if (!me) return json(res, 401, { error: 'Please sign in first' });
  const t = db.gthreads.find((x) => x.id === p.tid && x.gid === p.id);
  if (!t) return json(res, 404, { error: 'Thread not found' });
  const g = db.groups.find((x) => x.id === p.id);
  if (!(t.author === me.uid || (g && g.owner === me.uid) || is_admin(me.name)))
    return json(res, 400, { error: 'Only the author, group owner or an admin can delete this thread' });
  db.gthreads = db.gthreads.filter((x) => x.id !== t.id);
  save();
  json(res, 200, { ok: true });
}

// POST /api/groups/:id/forum/:tid/reply { body }
function apiGroupReply(req, res, me, p, body) {
  if (!me) return json(res, 401, { error: 'Please sign in first' });
  const t = db.gthreads.find((x) => x.id === p.tid && x.gid === p.id);
  if (!t) return json(res, 404, { error: 'Thread not found' });
  const text = String(body.body || '').trim().slice(0, 2000);
  if (!text) return json(res, 400, { error: 'Reply cannot be empty' });
  t.posts.push({ id: genId(), author: me.uid, body: text, ts: Date.now() });
  save();
  json(res, 200, { ok: true });
}

// DELETE /api/groups/:id/forum/:tid/post/:pid — penulis, owner grup, atau admin
function apiGroupPostDelete(req, res, me, p) {
  if (!me) return json(res, 401, { error: 'Please sign in first' });
  const t = db.gthreads.find((x) => x.id === p.tid && x.gid === p.id);
  if (!t) return json(res, 404, { error: 'Thread not found' });
  const g = db.groups.find((x) => x.id === p.id);
  const post = t.posts.find((x) => x.id === p.pid);
  if (!post) return json(res, 404, { error: 'Post not found' });
  if (!(post.author === me.uid || (g && g.owner === me.uid) || is_admin(me.name)))
    return json(res, 400, { error: 'Not allowed' });
  t.posts = t.posts.filter((x) => x.id !== p.pid);
  save();
  json(res, 200, { ok: true });
}

// ------------------------- ADMIN (khusus "Zerks") ---------------------------
// Semua endpoint /api/admin/* WAJIB melewati gate ini.
function requireAdmin(req, res, me) {
  if (!me) { json(res, 401, { error: 'Please sign in first' }); return false; }
  if (!is_admin(me.name)) {
    json(res, 403, { error: 'Admin access denied — panel ini khusus untuk user Zerks.' });
    return false;
  }
  return true;
}

// GET /api/admin/overview — data untuk Admin Panel
function apiAdminOverview(req, res, me) {
  if (!requireAdmin(req, res, me)) return;
  json(res, 200, {
    stats: {
      users: db.users.length, groups: db.groups.length, threads: db.gthreads.length,
      replies: db.gthreads.reduce((n, t) => n + t.posts.length, 0),
    },
    users: db.users.map((u) => ({ uid: u.uid, name: u.name, admin: is_admin(u.name), google: u.google, groups: ownedGroupCount(u.uid), joined: u.joined })),
    groups: db.groups.map((g) => ({ id: g.id, name: g.name, ownerName: (db.users.find((u) => u.uid === g.owner) || {}).name || '?', members: g.members.length, threads: groupThreadCount(g.id), created: g.created })),
    threads: db.gthreads.map((t) => ({ id: t.id, gid: t.gid, groupName: (db.groups.find((g) => g.id === t.gid) || {}).name || '?', title: t.title, authorName: (db.users.find((u) => u.uid === t.author) || {}).name || '?', replies: t.posts.length, ts: t.ts })),
  });
}

// DELETE /api/admin/user/:uid — hapus user + datanya (tidak bisa hapus diri sendiri)
function apiAdminDeleteUser(req, res, me, p) {
  if (!requireAdmin(req, res, me)) return;
  if (p.uid === me.uid) return json(res, 400, { error: 'Kamu tidak bisa menghapus akunmu sendiri' });
  const owned = db.groups.filter((g) => g.owner === p.uid).map((g) => g.id);
  db.groups = db.groups.filter((g) => g.owner !== p.uid);
  db.gthreads = db.gthreads.filter((t) => owned.indexOf(t.gid) === -1 && t.author !== p.uid);
  db.gthreads.forEach((t) => (t.posts = t.posts.filter((post) => post.author !== p.uid)));
  db.groups.forEach((g) => (g.members = g.members.filter((uid) => uid !== p.uid)));
  db.users = db.users.filter((u) => u.uid !== p.uid);
  Object.keys(db.tokens).forEach((k) => { if (db.tokens[k] === p.uid) delete db.tokens[k]; });
  save();
  json(res, 200, { ok: true });
}

// POST /api/admin/user/:uid/rename { name } — tetap cek nama duplikat
function apiAdminRename(req, res, me, p, body) {
  if (!requireAdmin(req, res, me)) return;
  const u = db.users.find((x) => x.uid === p.uid);
  if (!u) return json(res, 404, { error: 'User not found' });
  const name = String(body.name || '').trim();
  if (!name) return json(res, 400, { error: 'Name cannot be empty' });
  if (name.length > 16) return json(res, 400, { error: 'Name is too long (max 16 characters)' });
  const other = findUserByName(name);
  if (other && other.uid !== u.uid) return json(res, 400, { error: DUP_NAME_ERROR });
  u.name = name;
  save();
  json(res, 200, { ok: true });
}

// DELETE /api/admin/group/:gid
function apiAdminDeleteGroup(req, res, me, p) {
  if (!requireAdmin(req, res, me)) return;
  db.groups = db.groups.filter((g) => g.id !== p.gid);
  db.gthreads = db.gthreads.filter((t) => t.gid !== p.gid);
  save();
  json(res, 200, { ok: true });
}

/* ================================ ROUTER ================================== */
const routes = [
  ['POST',   /^\/api\/guest$/,                                 apiGuest],
  ['POST',   /^\/api\/profile$/,                               apiProfile],
  ['GET',    /^\/api\/groups$/,                                apiGroupsList],
  ['POST',   /^\/api\/groups$/,                                apiGroupCreate],
  ['GET',    /^\/api\/groups\/(?<id>[\w-]+)$/,                 apiGroupDetail],
  ['DELETE', /^\/api\/groups\/(?<id>[\w-]+)$/,                 apiGroupDelete],
  ['POST',   /^\/api\/groups\/(?<id>[\w-]+)\/join$/,           apiGroupJoin],
  ['POST',   /^\/api\/groups\/(?<id>[\w-]+)\/leave$/,          apiGroupLeave],
  ['POST',   /^\/api\/groups\/(?<id>[\w-]+)\/forum$/,          apiGroupThreadCreate],
  ['GET',    /^\/api\/groups\/(?<id>[\w-]+)\/forum\/(?<tid>[\w-]+)$/,       apiGroupThreadDetail],
  ['DELETE', /^\/api\/groups\/(?<id>[\w-]+)\/forum\/(?<tid>[\w-]+)$/,       apiGroupThreadDelete],
  ['POST',   /^\/api\/groups\/(?<id>[\w-]+)\/forum\/(?<tid>[\w-]+)\/reply$/, apiGroupReply],
  ['DELETE', /^\/api\/groups\/(?<id>[\w-]+)\/forum\/(?<tid>[\w-]+)\/post\/(?<pid>[\w-]+)$/, apiGroupPostDelete],
  ['GET',    /^\/api\/admin\/overview$/,                       apiAdminOverview],
  ['DELETE', /^\/api\/admin\/user\/(?<uid>[\w-]+)$/,           apiAdminDeleteUser],
  ['POST',   /^\/api\/admin\/user\/(?<uid>[\w-]+)\/rename$/,   apiAdminRename],
  ['DELETE', /^\/api\/admin\/group\/(?<gid>[\w-]+)$/,          apiAdminDeleteGroup],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  load();
  const me = userFromReq(req);
  const body = (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT')
    ? await new Promise((resolve) => {
        let s = '';
        req.on('data', (c) => (s += c));
        req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
      })
    : {};
  for (const [m, re, fn] of routes) {
    if (req.method !== m) continue;
    const match = url.pathname.match(re);
    if (!match) continue;
    try { return fn(req, res, me, match.groups || {}, body, url); }
    catch (e) { console.error(e); return json(res, 500, { error: 'Server error' }); }
  }
  json(res, 404, { error: 'Not found — endpoint ini hanya cover fitur BARU (grup/forum/admin). Endpoint lama tetap di server lamamu.' });
});

if (require.main === module) {
  server.listen(PORT, () => console.log('Voxely server additions (referensi) berjalan di http://localhost:' + PORT));
}
module.exports = { server, load, save, pubUser, is_admin };
