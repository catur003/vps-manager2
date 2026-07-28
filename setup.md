# Setup Guide — VPS Manager

Panduan lengkap dari nol: instalasi CLI, setup sudo, konfigurasi, sampai menyalakan REST API supaya bisa diakses dari bot Telegram / mobile app / web GUI.

> Untuk referensi lengkap tiap endpoint API (request/response, error code), lihat **[docs/API.md](docs/API.md)**.

---

## Daftar Isi

1. [Prasyarat](#1-prasyarat)
2. [Instalasi CLI](#2-instalasi-cli)
3. [Setup Sudo (wajib)](#3-setup-sudo-wajib)
4. [Konfigurasi (`data/config.json`)](#4-konfigurasi-dataconfigjson)
5. [Pakai CLI](#5-pakai-cli)
6. [Setup REST API](#6-setup-rest-api)
7. [Jalankan API sebagai Service (PM2/systemd)](#7-jalankan-api-sebagai-service-pm2systemd)
8. [Expose API ke Internet (buat Mobile App/Bot)](#8-expose-api-ke-internet-buat-mobile-appbot)
9. [Dependency Tambahan (opsional)](#9-dependency-tambahan-opsional)
10. [Troubleshooting Cepat](#10-troubleshooting-cepat)

---

## 1. Prasyarat

- VPS Linux (Ubuntu, dites di lingkungan aaPanel) dengan akses SSH & `sudo`.
- Node.js **>= 16** (cek: `node -v`).
- Akses `sudo` ke user SSH kamu (dipakai buat setup sudoers di langkah 3).
- Kalau mau pakai fitur Database Manager/Backup: MySQL/MariaDB sudah terinstall & kredensial root diketahui.
- Kalau mau pakai fitur Nginx/SSL: Nginx sudah terinstall & jalan (path binary/config bisa beda-beda tergantung aaPanel vs paket Ubuntu biasa — lihat langkah 4).

## 2. Instalasi CLI

```bash
git clone https://github.com/catur003/vps-manager.git
cd vps-manager
npm install
```

**(Opsional) Link jadi command global** — biar `vps-manager` bisa dipanggil dari folder manapun:

- Kalau Node diinstall via **nvm**: `npm link` langsung, tanpa sudo.
- Kalau Node diinstall via **apt/system** (`which node` → `/usr/bin/node`): pakai prefix folder sendiri biar tidak bentrok dengan Node punya root/aaPanel:
  ```bash
  mkdir -p ~/.npm-global
  npm config set prefix ~/.npm-global
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
  source ~/.bashrc
  npm link
  ```

Setelah itu, dari terminal mana saja: `vps-manager`

**(Opsional) Set editor jadi nano** — biar gampang pas isi `.env`/config lewat prompt `editor`:
```bash
echo 'export EDITOR=nano' >> ~/.bashrc
source ~/.bashrc
```

## 3. Setup Sudo (wajib)

Banyak fitur butuh akses ke user lain (deploy user, mis. `www`) atau ke root (nginx reload, certbot, dump database, dll) **tanpa** prompt password, karena tool ini jalan non-interaktif saat eksekusi command.

**Cara termudah (direkomendasikan)** — pakai script yang sudah disediakan, idempoten (aman dijalankan berkali-kali):
```bash
sudo bash scripts/setup-sudoers.sh
```
Script ini akan menanyakan user yang menjalankan proses `vps-manager`/`vps-api` dan deploy user-nya, lalu menulis rule sudoers **scoped** ke command yang benar-benar dibutuhkan (bukan blanket akses penuh).

**Cara manual (kalau lebih suka kontrol penuh)** — `sudo visudo`, tambahkan di baris paling bawah:

Opsi A — spesifik per command (lebih aman, tapi perlu ditambah manual tiap ada fitur baru butuh command baru):
```
ubuntu ALL=(www) NOPASSWD: ALL
ubuntu ALL=(root) NOPASSWD: /bin/mkdir, /bin/chown, /bin/cat, /bin/ls, /bin/cp, /bin/rm, /bin/tar, /usr/bin/find, /bin/grep, /www/server/nginx/sbin/nginx, /usr/bin/certbot, /usr/bin/test, /usr/bin/openssl, /usr/bin/ss, /usr/sbin/ufw, /usr/bin/firewall-cmd, /usr/bin/fail2ban-client
```

Opsi B — full akses (simpel, tapi kalau akun `ubuntu` ke-compromise langsung dapat root):
```
ubuntu ALL=(ALL) NOPASSWD: ALL
```

Ganti `ubuntu` sesuai user SSH kamu kalau beda.

## 4. Konfigurasi (`data/config.json`)

File ini dibuat otomatis (default values) saat pertama kali CLI/API dijalankan, permission otomatis `chmod 600` (cuma owner file yang bisa baca — isinya termasuk password MySQL root). Edit lewat menu CLI **13. Configuration**, atau `PUT /config` di API, atau langsung `nano data/config.json`.

> File ini **tidak otomatis update** kalau ada field baru dari `git pull` (sudah ada duluan di VPS dan masuk `.gitignore`). Field baru harus ditambah manual.

```json
{
  "deploy_user": "www",
  "nginx_user": "www-data",
  "default_folder": "/www/wwwroot",
  "git_branch": "main",
  "starting_port": 3000,
  "nginx_conf_dir": "/www/server/panel/vhost/nginx",
  "nginx_binary": "/www/server/nginx/sbin/nginx",
  "certbot_webroot": "/var/www/certbot",
  "certbot_email": "email_kamu@example.com",
  "db_root_user": "root",
  "db_root_password": "isi_password_mysql_root",
  "backup_dir": "/www/backup_manager",
  "nginx_log_dir": "/www/wwwlogs",
  "backup_retention_days": 7,
  "runtime_default": { "node": "20.9.0", "php": "8.2" }
}
```

| Field | Fungsi | Dipakai di |
|---|---|---|
| `deploy_user` | User pemilik file project (bukan user SSH-mu) | Semua Deploy/Git/PM2 |
| `nginx_user` | User yang menjalankan worker nginx | Referensi permission |
| `default_folder` | Folder induk default buat project baru | Deploy Project Baru |
| `git_branch` | Branch default kalau tidak diisi manual | Deploy Project Baru |
| `starting_port` | Port awal buat auto-suggest port kosong | Deploy Project Baru |
| `nginx_conf_dir` | Lokasi file `.conf` per-site nginx (aaPanel) | Nginx Manager |
| `nginx_binary` | Binary nginx yang **beneran aktif** (cek `ps aux \| grep nginx`, aaPanel biasanya bukan `/usr/sbin/nginx`) | Nginx Manager, SSL Manager |
| `certbot_webroot` | Folder validasi ACME challenge Let's Encrypt | SSL Manager |
| `certbot_email` | Email pendaftaran Let's Encrypt (boleh kosong) | SSL Manager |
| `db_root_user` / `db_root_password` | Kredensial MySQL/MariaDB | Database Manager, Backup Manager |
| `backup_dir` | Lokasi simpan file hasil backup | Backup Manager |
| `nginx_log_dir` | Folder log nginx (dipakai buat baca error log per-domain) | Log Viewer, `GET /nginx/sites/:file/error-log` |
| `backup_retention_days` | Backup lebih tua dari ini otomatis kehapus | Backup Manager |

**Kalau nginx/mysql yang aktif ternyata punya aaPanel** (bukan paket Ubuntu biasa): cek dulu binary yang beneran jalan pakai `ps aux | grep nginx` / `ps aux | grep mysql`, samakan path-nya di `nginx_binary`/kredensial MySQL di sini. Ini juga penting buat nanti migrasi lepas dari aaPanel — tinggal ganti path di satu tempat ini, tidak perlu edit kode.

## 5. Pakai CLI

```bash
npm start
# atau, kalau sudah di-link:
vps-manager
```
Menu interaktif akan muncul — lihat daftar lengkap menu di [README.md](README.md).

## 6. Setup REST API

REST API dipakai kalau kamu mau kontrol VPS ini dari luar terminal — bot Telegram, mobile app, atau web GUI.

**Langkah 1 — generate API key** (cuma perlu sekali; kalau diulang, key lama langsung invalid):
```bash
node bin/vps-api-keygen.js
```
**Simpan key yang ditampilkan sekarang juga** — tidak akan ditampilkan lagi setelah ini (yang tersimpan di server cuma hash-nya, bukan key aslinya).

**Langkah 2 — jalankan API:**
```bash
node bin/vps-api.js
# atau: npm run api
```
Defaultnya jalan di `http://127.0.0.1:4001` (port bisa diubah lewat `data/config.json` → `api.port`, atau `PUT /config` — tapi field `api` sendiri **tidak** termasuk `EDITABLE_FIELDS` lewat API, harus edit `config.json` langsung untuk ganti port).

**Langkah 3 — tes:**
```bash
curl http://127.0.0.1:4001/health
# -> {"success":true,"message":"ok","data":{"time":"..."}}

curl http://127.0.0.1:4001/monitor -H "Authorization: Bearer <API_KEY>"
# -> {"success":true,"data":{"cpuPercent":...}}
```

API **sengaja cuma bind ke `127.0.0.1`** — tidak pernah expose port ke internet langsung. Ini poin penting kalau kamu mau sambungkan mobile app: lihat langkah 8.

## 7. Jalankan API sebagai Service (PM2/systemd)

Supaya API tetap jalan setelah kamu logout SSH / server reboot, jangan jalankan `node bin/vps-api.js` langsung di terminal. Dua pilihan umum:

**Opsi A — PM2** (tool ini sendiri sudah pakai PM2 buat project lain, jadi kemungkinan besar sudah terinstall di VPS-mu):
```bash
pm2 start bin/vps-api.js --name vps-manager-api
pm2 save
pm2 startup   # ikuti instruksi yang ditampilkan, sekali saja per VPS
```
Cek status: `pm2 logs vps-manager-api` / `pm2 restart vps-manager-api`.

**Opsi B — systemd** — buat file `/etc/systemd/system/vps-manager-api.service`:
```ini
[Unit]
Description=VPS Manager REST API
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/vps-manager
ExecStart=/usr/bin/node bin/vps-api.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```
Sesuaikan `User`/`WorkingDirectory`/path Node (`which node`) dengan setup-mu, lalu:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vps-manager-api
sudo systemctl status vps-manager-api
```

## 8. Expose API ke Internet (buat Mobile App/Bot)

Karena API cuma bind ke `127.0.0.1`, mobile app di luar VPS **tidak bisa** langsung `hit` port 4001. Cara mengekspos yang aman: pakai domain + reverse proxy + SSL, sama seperti project lain yang di-manage tool ini.

**Ringkasnya (lewat menu CLI atau API-nya sendiri):**
1. Arahkan sebuah domain/subdomain (mis. `api.domainkamu.com`) ke IP VPS ini (A record di DNS).
2. Buat site reverse-proxy: **Nginx Manager (menu 6)** → domain `api.domainkamu.com`, port `4001` (port API-nya). Lewat API sendiri: `POST /nginx/sites` dengan `{ "domain": "api.domainkamu.com", "port": 4001 }`.
3. Aktifkan HTTPS: **SSL Manager (menu 7)** untuk domain itu, atau `POST /ssl/issue` dengan `{ "domain": "api.domainkamu.com" }`.
4. Setelah itu, mobile app/bot memanggil `https://api.domainkamu.com/...` (bukan `127.0.0.1:4001`), tetap wajib header `Authorization: Bearer <API_KEY>` yang sama.

**Penting:** jangan pernah expose port 4001 langsung ke internet (mis. lewat `iptables`/security group cloud provider) — selalu lewat reverse proxy + SSL seperti di atas, supaya traffic API terenkripsi dan bisa dipasangi rate-limit/proteksi tambahan di level nginx kalau perlu nanti.

## 9. Dependency Tambahan (opsional)

```bash
which certbot || sudo apt install certbot -y
which fail2ban-client || sudo apt install fail2ban -y   # opsional, buat Security Manager
```

## 10. Troubleshooting Cepat

| Gejala | Kemungkinan Penyebab | Cek |
|---|---|---|
| `API key belum di-generate` saat start API | Belum jalanin `vps-api-keygen.js` | Ulangi langkah 6.1 |
| `401 UNAUTHORIZED` di semua request API | Header `Authorization` salah/hilang, atau key sudah pernah di-generate ulang | Pastikan format `Bearer <key>`, generate ulang kalau lupa key lama |
| Banyak fitur gagal dengan error permission | Sudoers belum di-setup | Jalankan `sudo bash scripts/setup-sudoers.sh`, atau cek `GET /doctor/permissions` / menu CLI **8. Permission Manager** |
| Nginx/SSL Manager gagal baca config | `nginx_conf_dir`/`nginx_binary` di `data/config.json` tidak sesuai binary yang beneran aktif | Cek `ps aux \| grep nginx`, samakan path di Configuration |
| `GET /nginx/sites/:file/error-log` balas `NGINX_LOG_FAILED` | File log domain belum ada, atau `nginx_log_dir` salah | Cek isi `nginx_log_dir` di Configuration, pastikan cocok lokasi log nginx yang aktif |
| Deploy/SSL/Build job stuck di `interrupted` | API sempat restart/crash di tengah job | Job lama tidak bisa dilanjut otomatis — untuk deploy, cek `stoppedAtKey` lalu `POST /deploy/:jobId/retry` kalau memungkinkan |

Untuk detail request/response tiap endpoint, lanjut ke **[docs/API.md](docs/API.md)**.
