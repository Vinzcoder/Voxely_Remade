// Copies Babylon.js + socket.io client into the desktop client so it works offline.
const fs = require('fs'), path = require('path');
const dir = n => path.dirname(require.resolve(n + '/package.json'));
const out = path.join(__dirname, '..', 'client', 'game', 'vendor');
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(dir('babylonjs'), 'babylon.js'), path.join(out, 'babylon.js'));
fs.copyFileSync(path.join(dir('socket.io-client'), 'dist', 'socket.io.min.js'), path.join(out, 'socket.io.min.js'));
console.log('vendor files copied');
