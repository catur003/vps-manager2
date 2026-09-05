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

- **Setup lengkap** (akun admin, session web, direct IP:4001 atau domain, API key untuk automation): lihat **[setup.md](setup.md)**.
- **Referensi tiap endpoint** (request/response, kode error, mana yang butuh `confirm`): lihat **[docs/API.md](docs/API.md)**.

Ringkas:
```bash
git clone https://github.com/catur003/vps-manager2.git
cd vps-manager2
sudo bash setup-otomatis.sh
```
Installer menyiapkan dependency, folder kerja, sudoers, database, setup token admin, PM2, firewall, dan Nginx/SSL secara otomatis. MySQL/MariaDB existing dipakai tanpa mengganti engine atau mengubah root; MariaDB hanya dipasang pada server yang belum punya engine database. Web memakai username/password + session cookie; API key bernama untuk mobile/bot/script dibuat dari menu **API Keys** setelah login. Aksi yang mengubah data lama secara permanen (drop database, hapus project, dll) wajib `{ "confirm": true }`. Semua request tercatat di `data/audit.log` dengan field sensitif di-redact.

## Keamanan

- **`data/config.json` di-`chmod 600` otomatis** tiap kali dibaca/ditulis (isinya kredensial: `db_root_password`, dll), jadi cuma owner proses panel yang bisa baca file itu.
- **Command yang mengandung password (mysqldump/mysql restore) selalu jalan dengan `silent: true`**, jadi password nggak pernah muncul di log/scrollback terminal.
- **Input nama project & domain divalidasi** (cuma huruf/angka/titik/dash/underscore) sebelum dipakai di command shell, buat cegah command injection dari input yang aneh-aneh.
- Semua input tetap diasumsikan datang dari operator yang trusted (kamu sendiri lewat prompt interaktif) — bukan dari sumber luar/API publik. Kalau nanti tool ini dikembangin buat nerima input dari luar (misal webhook), validasi ini perlu diperkuat lagi.
- `db_root_password` tetap kesimpen **plaintext** di `config.json` (bukan di-hash/di-encrypt) — ini trade-off standar buat tool automation yang butuh baca password itu lagi tiap run. Selama akses SSH ke VPS ini aman, resikonya rendah.

## Instalasi & Setup

Panduan lengkap instalasi CLI, setup sudo (wajib), penjelasan tiap field `data/config.json`, sampai setup REST API + cara expose ke internet buat mobile app/bot, sekarang ada di **[setup.md](setup.md)**.

Ringkas banget buat yang sudah familiar:
```bash
git clone https://github.com/catur003/vps-manager2.git
cd vps-manager2
sudo bash setup-otomatis.sh
```

Tidak perlu menjalankan `npm install`, setup sudoers, setup database, atau PM2 satu per satu. Lihat [setup.md](setup.md) untuk pilihan domain/direct IP dan perubahan sistem yang dilakukan installer.

## Struktur Data

- `data/config.json` — konfigurasi global (penjelasan default ada di [setup.md](setup.md#6-default-konfigurasi))
- `data/registry.json` — daftar project terdaftar (nama, path, domain, port, deploy_user, dll)

Kedua file **jangan di-commit ke git** (sudah ada di `.gitignore`), karena isinya spesifik ke VPS ini.

## Catatan Penting: Migrasi dari aaPanel

Tool ini didesain untuk **berdampingan dulu** dengan aaPanel, bukan langsung menggantikan. Jangan uninstall aaPanel sampai:
1. Semua project existing berhasil di-import ke registry (menu 1)
2. Nginx Manager & SSL Manager udah teruji baca/tulis config yang sama persis
3. Backup penuh VPS udah dilakukan (termasuk `/etc/letsencrypt`, database, dan folder project)
4. Cek semua file `.conf` di `nginx_conf_dir` nggak ada yang `include` ke file/snippet punya aaPanel yang bakal ikut kehapus

Dependency sistem utama dipasang oleh `setup-otomatis.sh`; tidak perlu dipasang satu per satu.
