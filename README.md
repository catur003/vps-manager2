# VPS Universal Manager

Mini DevOps CLI pribadi buat gantiin aaPanel — kelola banyak project (Next.js, Laravel, Static) dalam satu VPS. Dijalankan langsung di VPS lewat SSH, bentuknya menu interaktif (bukan web dashboard).

## Status: Semua Phase Aktif ✅

| # | Menu | Keterangan |
|---|------|------------|
| 1 | 📥 Import Project ke Registry (Bukan Deploy) | Project yang SUDAH ada & jalan (mis. pindahan dari aaPanel) - daftarin ke registry tanpa nyentuh nginx/PM2/file yang jalan |
| 2 | 🚀 Deploy Project Baru | Clone Next.js dari git → install → Prisma (opsional) → build → PM2 → Nginx → SSL (opsional) |
| 3 | 🔧 Git Manager | Status, pull, branch, checkout, log, stash, update kredensial GitHub |
| 4 | 📁 Project Manager | List project, lihat/edit `.env`, preview & eksekusi delete project |
| 5 | ⚙️ PM2 Manager | List, start, stop, restart, logs, delete (support multi deploy_user) |
| 6 | 🌐 Nginx Manager | List site, view config, tambah/hapus site reverse proxy |
| 7 | 🔐 SSL Manager | Enable HTTPS (certbot webroot), cek expiry, renew |
| 8 | 🔑 Permission Manager | Cek owner folder project |
| 9 | 🗄️ Database Manager | List, buat, hapus database + user, reset password |
| 10 | 📊 Server Monitor | CPU, RAM, Disk, Uptime, Load Average |
| 11 | 💾 Backup Manager | Backup/restore project & database, retensi otomatis |
| 12 | 🔒 Security Manager | Audit read-only: firewall, port terbuka, fail2ban, setting SSH |
| 13 | ⚡ Configuration | Lihat & edit config tool ini + akun GitHub (PAT) tersimpan |
| 14 | 📜 Log Viewer | Log PM2 per app, atau error log Nginx per domain |
| 15 | 🧹 Bersihin Cache/Storage | Scan & hapus cache/file regenerable (build cache, npm/yarn cache, log PM2) |
| 16 | 🔍 VPS Scanner | Bandingkan kondisi nyata server (PM2/port/API health) vs registry |

## REST API (buat Bot Telegram / Mobile App / Web GUI)

Hampir semua menu di atas sudah punya endpoint REST yang setara — Deploy (async/job), Git, PM2, Nginx (termasuk error log per domain), SSL (issue), Database, Backup, Security, Scanner, Cleanup, Configuration (+ akun GitHub, cocok buat halaman Settings di mobile app), Doctor/Permission, dan `.env`/delete project.

- **Setup lengkap** (generate API key, jalanin sebagai service, expose ke internet lewat Nginx + SSL buat mobile app): lihat **[setup.md](setup.md#6-setup-rest-api)**.
- **Referensi tiap endpoint** (request/response, kode error, mana yang butuh `confirm`): lihat **[docs/API.md](docs/API.md)**.

Ringkas:
```bash
node bin/vps-api-keygen.js   # generate API key - CATET, cuma ditampilin sekali
node bin/vps-api.js          # start API di 127.0.0.1:4001 (localhost only, tidak pernah expose langsung)
```
Auth pakai header `Authorization: Bearer <api key>` di semua endpoint kecuali `GET /health`. Aksi yang mengubah data lama secara permanen (drop database, hapus project, dll) wajib `{ "confirm": true }` di body. Aksi yang bisa makan waktu lama (deploy, issue SSL, build manual) berjalan async — API langsung balas `jobId`, status dicek lewat `GET /jobs/:id`. Semua request tercatat di `data/audit.log` (field sensitif otomatis di-redact).

## Keamanan

- **`data/config.json` di-`chmod 600` otomatis** tiap kali dibaca/ditulis (isinya kredensial: `db_root_password`, dll), jadi cuma owner (`ubuntu`) yang bisa baca file itu.
- **Command yang mengandung password (mysqldump/mysql restore) selalu jalan dengan `silent: true`**, jadi password nggak pernah muncul di log/scrollback terminal.
- **Input nama project & domain divalidasi** (cuma huruf/angka/titik/dash/underscore) sebelum dipakai di command shell, buat cegah command injection dari input yang aneh-aneh.
- Semua input tetap diasumsikan datang dari operator yang trusted (kamu sendiri lewat prompt interaktif) — bukan dari sumber luar/API publik. Kalau nanti tool ini dikembangin buat nerima input dari luar (misal webhook), validasi ini perlu diperkuat lagi.
- `db_root_password` tetap kesimpen **plaintext** di `config.json` (bukan di-hash/di-encrypt) — ini trade-off standar buat tool automation yang butuh baca password itu lagi tiap run. Selama akses SSH ke VPS ini aman, resikonya rendah.

## Instalasi & Setup

Panduan lengkap instalasi CLI, setup sudo (wajib), penjelasan tiap field `data/config.json`, sampai setup REST API + cara expose ke internet buat mobile app/bot, sekarang ada di **[setup.md](setup.md)**.

Ringkas banget buat yang sudah familiar:
```bash
git clone https://github.com/catur003/vps-manager.git
cd vps-manager
npm install
sudo bash scripts/setup-sudoers.sh   # WAJIB, sebelum pakai fitur selain Configuration/Project List
npm start                            # atau: vps-manager (kalau sudah di-link, lihat setup.md)
```

## Struktur Data

- `data/config.json` — konfigurasi global (penjelasan tiap field ada di [setup.md](setup.md#4-konfigurasi-dataconfigjson))
- `data/registry.json` — daftar project terdaftar (nama, path, domain, port, deploy_user, dll)

Kedua file **jangan di-commit ke git** (sudah ada di `.gitignore`), karena isinya spesifik ke VPS ini.

## Catatan Penting: Migrasi dari aaPanel

Tool ini didesain untuk **berdampingan dulu** dengan aaPanel, bukan langsung menggantikan. Jangan uninstall aaPanel sampai:
1. Semua project existing berhasil di-import ke registry (menu 1)
2. Nginx Manager & SSL Manager udah teruji baca/tulis config yang sama persis
3. Backup penuh VPS udah dilakukan (termasuk `/etc/letsencrypt`, database, dan folder project)
4. Cek semua file `.conf` di `nginx_conf_dir` nggak ada yang `include` ke file/snippet punya aaPanel yang bakal ikut kehapus

## Dependency Tambahan yang Mungkin Dibutuhkan

```bash
which certbot || sudo apt install certbot -y
which fail2ban-client || sudo apt install fail2ban -y   # opsional, buat Security Manager
```

Detail lengkap ada di [setup.md](setup.md#9-dependency-tambahan-opsional).
