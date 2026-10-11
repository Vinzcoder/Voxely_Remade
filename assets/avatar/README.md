# Voxely Playermodel

`Voxelyplayermodel.blend` adalah source avatar yang dikirim pengguna.

Client Babylon memiliki hook untuk memuat `Voxelyplayermodel.glb` dari folder ini ketika export GLB tersedia; build saat ini mempertahankan rig prosedural sebagai fallback agar game tetap berjalan di browser dan Voxely Studio. File attachment yang diterima memakai container Zstandard dan tidak mengandung blok DNA Blender yang diperlukan untuk dibuka oleh Blender 5.0/5.2, sehingga export GLB otomatis tidak dapat dibuat dari attachment ini tanpa file `.blend` valid.
