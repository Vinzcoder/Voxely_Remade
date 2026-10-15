# Voxely

Voxely adalah game client Electron, game web Babylon.js, server multiplayer Socket.IO, Voxely Studio, avatar customization, dan marketplace item gratis.

## License

Copyright (c) Voxely 2026. All rights reserved.

This project is closed-source. No license is granted to the public. You may view the source code for evaluation purposes, but modification, redistribution, or commercial use of this software, in whole or in part, is strictly prohibited without explicit written permission from the copyright holder.

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

Voxely Studio menyediakan tombol **Save .vxly** untuk menyimpan metadata game, layout world, script, dan model yang di-import dalam satu file JSON ber-ekstensi `.vxly`.

## Discord Rich Presence

Electron client menggunakan Discord IPC. Saat bermain, Discord menampilkan judul game Voxely dan jumlah pemain; saat membuka Studio, Discord menampilkan status pembuatan game. Discord Desktop harus sedang berjalan. Rich Presence tidak memakai bot token, public key, atau kredensial rahasia.

