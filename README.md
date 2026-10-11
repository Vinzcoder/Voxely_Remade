# Voxely

Voxely adalah game client Electron, game web Babylon.js, server multiplayer Socket.IO, Voxely Studio, avatar customization, dan marketplace item gratis.

## Membuat client desktop

Gunakan Node.js 20+:

```bash
npm install
npm run dist
```

Perintah tersebut menghasilkan installer sesuai platform:

- Windows: `dist/Voxely-Client-Setup.exe`
- Linux: `dist/Voxely-Client.deb`
- macOS: `dist/Voxely-Client.dmg`

Untuk menjalankan client tanpa build installer:

```bash
npm run client
```

Untuk menjalankan server game:

```bash
npm run server
```

## Isi penting

- `client/` — Electron client, launcher, game, dan Voxely Studio.
- `web/` — website/store dan browser game.
- `server/` — server API, Socket.IO multiplayer, followers, outfit, games, dan friends.
- `assets/` — avatar Blender serta asset UI.
- `supabase/` — schema database.

## Build otomatis

Workflow `.github/workflows/build-client.yml` dapat dijalankan dari GitHub Actions dengan `workflow_dispatch`, atau otomatis ketika tag `v*` di-push. Workflow membuat installer Windows dan Linux serta mengunggahnya sebagai artifact/release.

## Format `.vxly`

Voxely Studio menyediakan tombol **Save .vxly** dan **Open .vxly** untuk menyimpan dan memulihkan metadata game, layout world, script, dan model yang di-import dalam satu file JSON ber-ekstensi `.vxly`.
