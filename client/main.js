const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const PROTOCOL = 'voxely';
const STORE_URL = process.env.VOXELY_STORE || 'https://YOUR-STORE.vercel.app' /* <- ganti dengan URL Vercel kamu */;
let gameWin = null, launcherWin = null, pendingUrl = null;

// Register voxely:// so the website's Play button can open this app.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function launch(raw) {
  try {
    const u = new URL(raw);
    const game = u.searchParams.get('game'), token = u.searchParams.get('token'), server = u.searchParams.get('server');
    if (u.protocol !== PROTOCOL + ':' || !/^\w+$/.test(game || '') || !/^\w+$/.test(token || '') || !/^https?:\/\//.test(server || '')) return;
    if (gameWin) gameWin.close();
    gameWin = new BrowserWindow({
      width: 1280, height: 720, backgroundColor: '#000000', autoHideMenuBar: true, title: 'Voxely',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    gameWin.on('closed', () => (gameWin = null));
    gameWin.loadFile(path.join(__dirname, 'game', 'index.html'), { query: { game, token, server } });
    if (launcherWin) launcherWin.close();
  } catch (e) { console.error('Bad launch url', e); }
}

function showLauncher() {
  const html = `<body style="margin:0;background:#171a21;color:#c6d4df;font:15px Arial;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:14px"><h2 style="color:#fff;letter-spacing:3px;margin:0">VOXELY CLIENT</h2><div>Client sudah terpasang. Buka store lalu klik Play.</div><a target="_blank" href="${STORE_URL}" style="background:#75b022;color:#fff;padding:10px 24px;text-decoration:none;border-radius:2px">Buka Voxely Store</a></body>`;
  launcherWin = new BrowserWindow({ width: 460, height: 260, resizable: false, autoHideMenuBar: true, title: 'Voxely Client' });
  launcherWin.on('closed', () => (launcherWin = null));
  launcherWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  launcherWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

const findUrl = argv => argv.find(a => a.startsWith(PROTOCOL + '://'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => { const u = findUrl(argv); if (u) launch(u); });
  app.on('open-url', (e, url) => { e.preventDefault(); app.isReady() ? launch(url) : (pendingUrl = url); }); // macOS
  app.whenReady().then(() => {
    const url = pendingUrl || findUrl(process.argv);
    if (url) launch(url);
    else showLauncher(); // opened by hand
  });
  app.on('window-all-closed', () => app.quit());
}
