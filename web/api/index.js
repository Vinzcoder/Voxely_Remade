// Voxely Store (Express) - deployed on Vercel. Static files live in /public.
const express = require('express');
const path = require('path');
const app = express();

app.get('/config.js', (_req, res) => {
  const cfg = {
    server: process.env.GAME_SERVER_URL || (process.env.VERCEL ? '' : 'http://localhost:3000'),
    download: process.env.CLIENT_DOWNLOAD_URL || ''
  };
  res.type('js').set('Cache-Control', 'no-store').send('window.VOXELY=' + JSON.stringify(cfg) + ';');
});

module.exports = app;

if (require.main === module) { // local: npm start -> http://localhost:3001
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.listen(3001, () => console.log('Voxely store: http://localhost:3001'));
}
