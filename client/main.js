const { app, BrowserWindow, shell, ipcMain, safeStorage, dialog } = require('electron');
const path = require('path'), fs = require('fs');

const PROTOCOL = 'voxely';
const REPO = 'Vinzcoder/Voxely_Remade'; // GitHub repo that holds the Releases
const STORE_URL = process.env.VOXELY_STORE || 'https://playvoxely.vercel.app';
const DEFAULT_SERVER = process.env.VOXELY_SERVER || 'https://dts5atk3kqga-production-908p4mxa.australia-southeast1.suga.run';
let gameWin = null, studioWin = null, launcherWin = null, pendingUrl = null, updater = null;
const WEB = { contextIsolation: true, nodeIntegration: false, sandbox: true };

// Register voxely:// so the website's Play / Studio buttons can open this app.
if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(PROTOCOL);

/* ---------- saved login (the token the website hands over when you press Play) ---------- */
const sessFile = () => path.join(app.getPath('userData'), 'session.json');
function saveSession(s) {
  try {
    const j = JSON.stringify(s);
    fs.writeFileSync(sessFile(), JSON.stringify(safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(j).toString('base64') } : { raw: j }));
  } catch (e) { /* not fatal */ }
}
function loadSession() {
  try { const d = JSON.parse(fs.readFileSync(sessFile(), 'utf8')); return JSON.parse(d.enc ? safeStorage.decryptString(Buffer.from(d.enc, 'base64')) : d.raw); } catch (e) { return null; }
}
const clearSession = () => { try { fs.unlinkSync(sessFile()); } catch (e) {} };

/* ---------- launching the game / studio ---------- */
function launch(raw) {
  try {
    const u = new URL(raw);
    const game = u.searchParams.get('game'), token = u.searchParams.get('token'), server = u.searchParams.get('server'), room = u.searchParams.get('room') || '';
    if (u.protocol !== PROTOCOL + ':' || !/^\w+$/.test(game || '') || !/^\w+$/.test(token || '') || !/^https?:\/\//.test(server || '') || !/^\w*$/.test(room)) return;
    saveSession({ token, server });
    if (u.hostname === 'studio') { // Voxely Studio (game editor)
      if (studioWin) studioWin.close();
      studioWin = new BrowserWindow({ width: 1500, height: 900, backgroundColor: '#1b1d21', autoHideMenuBar: true, title: 'Voxely Studio', webPreferences: WEB });
      studioWin.on('closed', () => (studioWin = null));
      studioWin.loadFile(path.join(__dirname, 'studio', 'index.html'), { query: { game, token, server } });
    } else {
      if (gameWin) gameWin.close();
      gameWin = new BrowserWindow({ width: 1280, height: 720, backgroundColor: '#000000', autoHideMenuBar: true, title: 'Voxely', webPreferences: WEB });
      gameWin.on('closed', () => (gameWin = null));
      gameWin.loadFile(path.join(__dirname, 'game', 'index.html'), { query: { game, token, server, room } });
    }
    if (launcherWin) launcherWin.close();
  } catch (e) { console.error('Bad launch url', e); }
}

function showLauncher() {
  if (launcherWin) { launcherWin.show(); launcherWin.focus(); return; }
  launcherWin = new BrowserWindow({ width: 480, height: 560, resizable: false, autoHideMenuBar: true, backgroundColor: '#04060b', title: 'Voxely Client',
    webPreferences: { ...WEB, preload: path.join(__dirname, 'preload.js') } });
  launcherWin.on('closed', () => (launcherWin = null));
  launcherWin.loadFile(path.join(__dirname, 'launcher.html'));
}

/* ---------- updates ---------- */
// Windows (installed build): electron-updater downloads the new installer from GitHub Releases in the background.
// Other platforms / dev runs: we only tell the user a newer release exists.
let updateState = { state: 'idle' };
const setUpdate = s => { updateState = s; if (launcherWin) launcherWin.webContents.send('v:update', s); };
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkForUpdates() {
  setUpdate({ state: 'checking' });
  if (process.platform === 'win32' && app.isPackaged) {
    try {
      if (!updater) {
        updater = require('electron-updater').autoUpdater; updater.autoDownload = true; updater.autoInstallOnAppQuit = true;
        updater.on('update-available', i => setUpdate({ state: 'progress', version: i.version, percent: 0 }));
        updater.on('update-not-available', () => setUpdate({ state: 'none' }));
        updater.on('download-progress', p => setUpdate({ state: 'progress', version: updateState.version, percent: Math.round(p.percent) }));
        updater.on('update-downloaded', i => {
          setUpdate({ state: 'ready', version: i.version });
          if (!launcherWin && !gameWin && !studioWin) dialog.showMessageBox({ type: 'info', buttons: ['Restart & Update', 'Nanti'], defaultId: 0, message: `Update Voxely Client v${i.version} siap dipasang.` }).then(r => { if (r.response === 0) updater.quitAndInstall(); });
        });
        updater.on('error', e => setUpdate({ state: 'error', msg: String(e && e.message || e).slice(0, 120) }));
      }
      await updater.checkForUpdates();
    } catch (e) { setUpdate({ state: 'error', msg: String(e.message).slice(0, 120) }); }
    return;
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'voxely-client', Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(), v = String(j.tag_name || '').replace(/^v/, '');
    setUpdate(v && newer(v, app.getVersion()) ? { state: 'manual', version: v, url: j.html_url } : { state: 'none' });
  } catch (e) { setUpdate({ state: 'none' }); }
}

/* ---------- IPC for the launcher window ---------- */
async function whoami(s) {
  const r = await fetch(s.server + '/api/me', { headers: { Authorization: 'Bearer ' + s.token } });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
ipcMain.handle('v:info', () => ({ version: app.getVersion() }));
ipcMain.handle('v:session', async () => {
  const s = loadSession(); if (!s) return { loggedIn: false };
  try {
    const u = await whoami(s);
    if (!u) { clearSession(); return { loggedIn: false, expired: true }; }
    saveSession({ ...s, user: u }); return { loggedIn: true, user: u, server: s.server };
  } catch (e) { return { loggedIn: true, offline: true, user: s.user || { name: 'Pemain', color: '#1463ff' }, server: s.server }; }
});
ipcMain.handle('v:guest', async () => {
  const server = (loadSession() || {}).server || DEFAULT_SERVER;
  try {
    const r = await fetch(server + '/api/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json(); saveSession({ token: d.token, server, user: d.user }); return { loggedIn: true, user: d.user, server };
  } catch (e) { return { loggedIn: false, error: 'Server tidak bisa dihubungi' }; }
});
ipcMain.handle('v:logout', () => { clearSession(); return true; });
ipcMain.handle('v:store', () => { shell.openExternal(STORE_URL); return true; });
ipcMain.handle('v:studio', () => {
  const s = loadSession(); if (!s) return false;
  launch(`${PROTOCOL}://studio?game=new&token=${s.token}&server=${encodeURIComponent(s.server)}`); return true;
});
ipcMain.handle('v:update-state', () => updateState);
ipcMain.handle('v:install', () => { if (updater) updater.quitAndInstall(); return true; });
ipcMain.handle('v:open', (_e, url) => { if (typeof url === 'string' && url.startsWith('https://github.com/')) shell.openExternal(url); return true; });

const findUrl = argv => argv.find(a => a.startsWith(PROTOCOL + '://'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => { const u = findUrl(argv); if (u) launch(u); else showLauncher(); });
  app.on('open-url', (e, url) => { e.preventDefault(); app.isReady() ? launch(url) : (pendingUrl = url); }); // macOS
  app.whenReady().then(() => {
    const url = pendingUrl || findUrl(process.argv);
    if (url) launch(url); else showLauncher(); // opened by hand: show the login / update screen
    checkForUpdates(); setInterval(checkForUpdates, 4 * 3600 * 1000);
  });
  app.on('window-all-closed', () => app.quit());
}
