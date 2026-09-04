# VPS Manager — REST API Reference

Dokumentasi lengkap semua endpoint REST API `vps-manager`. API ini dibuat supaya semua fitur yang ada di menu CLI (interaktif via SSH) bisa juga dipakai dari luar — bot Telegram, mobile app, atau web GUI — tanpa harus SSH manual.

> Untuk cara instalasi & menyalakan API-nya (generate key, port, reverse proxy ke domain publik, dst), lihat **[setup.md](../setup.md)**. Dokumen ini cuma soal endpoint-nya — request/response, validasi, dan error yang mungkin muncul.

---

## Daftar Isi

- [Dasar-dasar](#dasar-dasar)
  - [Base URL](#base-url)
  - [Autentikasi](#autentikasi)
  - [Format Response](#format-response)
  - [Error Code](#error-code)
  - [Pola Aksi Destruktif (`confirm`)](#pola-aksi-destruktif-confirm)
  - [Pola Job Async (background task)](#pola-job-async-background-task)
  - [Audit Log](#audit-log)
- [Health](#health)
- [Monitor](#monitor)
- [Deploy](#deploy)
- [Jobs](#jobs)
- [Project](#project)
- [Git](#git)
- [PM2](#pm2)
- [Nginx](#nginx)
- [SSL](#ssl)
- [Database](#database)
- [Backup](#backup)
- [Build / Install Manual](#build--install-manual)
- [Security](#security-read-only)
- [Scanner](#scanner-read-only)
- [Cleanup](#cleanup)
- [Configuration](#configuration)
- [Doctor](#doctor)
- [System](#system)
- [Domains / SSL Aliases](#domains--ssl-aliases)
- [Node Manager](#node-manager)
- [Docker](#docker)
- [Docker Compose](#docker-compose)
- [Tools / Installer](#tools--installer)
- [SSH Keys](#ssh-keys)
- [File Manager](#file-manager)
- [AI Assistant](#ai-assistant)
- [Notifications (feed)](#notifications-feed)
- [Cron Jobs](#cron-jobs)
- [Cloudflare Integration](#cloudflare-integration)
- [Redis Monitoring](#redis-monitoring)
- [PostgreSQL](#postgresql)
- [Webhook GitHub (auto-deploy)](#webhook-github-auto-deploy)
- [Terminal (WebSocket)](#terminal-websocket)

---

## Dasar-dasar

### Base URL

API memiliki listener internal untuk Nginx. Fresh install tanpa domain juga dapat memakai direct HTTPS self-signed di port publik 4001. Semua path relatif terhadap base URL:

```
http://127.0.0.1:4001/pm2
https://api.domainkamu.com/pm2   (kalau sudah di-proxy)
https://IP_VPS:4001/pm2          (mode direct HTTPS)
```

### Autentikasi

Web dashboard memakai session cookie `HttpOnly; Secure; SameSite=Strict`. Login:

```http
POST /auth/login
Content-Type: application/json

{ "username": "admin", "password": "..." }
```

Request mutasi dari session web wajib membawa `X-CSRF-Token`; dashboard mengurusnya otomatis. Mobile, bot, dan script tetap memakai:

```
Authorization: Bearer <API_KEY>
```

`API_KEY` bernama dibuat dari menu **API Keys** setelah login. Setiap key dapat di-reveal atau dicabut sendiri tanpa memengaruhi key lain maupun session web. `node bin/vps-api-keygen.js` hanya untuk format legacy.

Endpoint publik yang tidak membutuhkan session/Bearer:

| Method | Path | Keterangan |
|---|---|---|
| GET | `/health` | Health check minimal |
| GET | `/auth/status` | Status initialized/setup token tanpa data rahasia |
| POST | `/auth/setup` | Buat admin pertama dengan setup token |
| POST | `/auth/login` | Buat session web |
| GET | `/auth/session` | Validasi session cookie |
| POST | `/auth/logout` | Hapus session aktif |

`POST /auth/setup`:

```json
{ "token": "...", "username": "admin", "password": "...", "passwordConfirm": "..." }
```

Setup token berlaku 24 jam, sekali pakai, dan diregenerasi dari folder repository lewat `node bin/vps-manager.js setup-token regenerate`. Membuat token baru membatalkan token lama. Setelah admin terbentuk, endpoint setup tidak dapat membuat admin kedua.

Kalau autentikasi hilang/salah:

```json
{ "success": false, "message": "Session atau API key tidak valid.", "code": "UNAUTHORIZED" }
```
HTTP status `401`.

### Format Response

Semua response JSON, selalu punya bentuk dasar yang sama:

**Sukses:**
```json
{ "success": true, "message": "OK", "data": { ... } }
```

**Gagal:**
```json
{ "success": false, "message": "Penjelasan singkat kenapa gagal.", "code": "SOME_ERROR_CODE" }
```

`data` bisa berupa object, array, atau tidak ada sama sekali (kalau endpoint memang tidak mengembalikan data). `message` selalu Bahasa Indonesia, aman ditampilkan langsung ke user.

### Error Code

Kode umum yang bisa muncul di **hampir semua** endpoint (di luar kode spesifik per-endpoint yang disebut di tabel masing-masing modul):

| Code | HTTP Status | Kapan Muncul |
|---|---|---|
| `UNAUTHORIZED` | 401 | Header `Authorization` hilang/salah |
| `ACTION_NOT_ALLOWED` | 403 | Action belum di-daftarkan di `commandPolicy.js` (default-deny) |
| `INVALID_INPUT` | 400 | Body/param/query tidak valid (format salah, field wajib kosong, dll) |
| `CONFIRM_REQUIRED` | 400 | Aksi destruktif dikirim tanpa `{ "confirm": true }` — lihat bagian confirm di bawah |
| `NOT_FOUND` | 404 | Path tidak dikenal sama sekali (bukan salah satu route di bawah) |
| `INTERNAL_ERROR` | 500 | Error tak terduga di server (sudah tercatat di log server) |

### Pola Aksi Destruktif (`confirm`)

Beberapa aksi (hapus project, drop database, hapus site nginx, dsb) **tidak bisa di-undo** atau **menimpa data lama**. Endpoint ini akan menolak request pertama dengan `CONFIRM_REQUIRED` kalau body belum menyertakan `confirm: true`:

```json
{
  "success": false,
  "message": "Aksi ini akan MENGHAPUS project \"myapp\" ... Kirim ulang dengan { \"confirm\": true } di body kalau yakin.",
  "code": "CONFIRM_REQUIRED"
}
```

Client (bot/mobile app) **wajib tetap menampilkan dialog konfirmasi ke user** sebelum mengirim ulang dengan `confirm: true` — validasi server ini cuma lapisan terakhir, bukan pengganti konfirmasi di UI. Endpoint mana saja yang butuh `confirm` ditandai eksplisit di tabel masing-masing modul di bawah.

### Pola Job Async (background task)

Aksi yang bisa makan waktu lama (deploy, issue SSL, build/install manual) **tidak** langsung dieksekusi sinkron — API langsung balas `202 Accepted` dengan `jobId`, lalu proses jalan di proses Node terpisah di background. Client polling status lewat `GET /jobs/:id`.

```
POST /deploy            -> { "data": { "jobId": "..." } }   (202)
GET  /jobs/<jobId>       -> { "data": { "status": "running", "steps": [...] } }
```

Field `status` pada job: `pending` → `running` → `success` **atau** `failed`. Ada juga `interrupted` — muncul kalau API sempat restart/crash di tengah job (status akhir job itu jadi tidak diketahui pasti, harus dicek manual).

Job disimpan di `data/jobs.json` (bukan cuma di memori), jadi tahan restart API — polling tetap bisa lanjut walau API sempat mati-nyala.

### Audit Log

Semua request (sukses maupun gagal) ke endpoint ber-auth tercatat di `data/audit.log` di server (format JSONL, 1 baris = 1 event). Field sensitif (password, token, isi `.env`) otomatis di-redact sebelum ditulis. Ini bukan endpoint API — cuma catatan kalau butuh telusuri histori aksi dari sisi server.

---

## Health

### `GET /health`
Cek API hidup. **Tanpa auth.**

**Response 200:**
```json
{ "success": true, "message": "ok", "data": { "time": "2026-07-28T10:00:00.000Z" } }
```

---

## Monitor

### `GET /monitor`
Status resource server saat ini (setara menu CLI "Server Monitor"). Read-only.

**Response 200 — `data`:**
```json
{
  "cpuPercent": 12.5,
  "ram": { "totalMB": 4096, "usedMB": 2048, "availableMB": 2048, "percent": 50.0 },
  "swap": { "totalMB": 0, "usedMB": 0, "freeMB": 0, "percent": 0 },
  "disk": { "total": "40G", "used": "20G", "available": "20G", "percent": 50 },
  "uptime": "3 days, 4 hours",
  "loadAverage": { "1min": "0.10", "5min": "0.20", "15min": "0.15" }
}
```

### `GET /monitor/bandwidth`
Bandwidth & Quota Monitoring — total trafik interface publik host (RX/TX kumulatif sejak boot + histori harian 30 hari, disample tiap 1 jam), network I/O per container Docker, dan storage R2 (Cloudflare) yang dipakai. Read-only.

**Response 200 — `data`:** `{ "current": { "rxBytesLabel": "...", "txBytesLabel": "..." }, "today": {...}, "monthTotalBytesLabel": "...", "dailyHistory": [{ "date": "2026-09-01", "rxBytes": 123, "txBytes": 456 }], "dockerContainers": [{ "name": "...", "rx": "6.87MB", "tx": "1.74MB" }], "r2": { "bytesLabel": "22.3 MB", "objectCount": 1 } }` (`r2` bisa `null` kalau rclone/config belum di-setup).

### `GET /monitor/server-info`
Info statis server (OS, arch, hostname, dst) — beda dari `GET /monitor` yang live/berubah-ubah. Read-only.

### `GET /monitor/recent-activity`
N baris terakhir dari `data/audit.log` (real, bukan data dummy) — dipakai widget "Recent Activity" di Overview. Read-only.

### `GET /monitor/check-port/:port`
Cek apakah 1 port TCP sedang dipakai proses lain — dipanggil dari form Deploy SEBELUM submit, biar ketauan bentrok port sebelum app di-deploy (bukan ketauan belakangan lewat error "address already in use"). Read-only.

---

## Deploy

Deploy project **Next.js baru** (clone git → `.env` → install → Prisma opsional → build → PM2 → Nginx → SSL opsional). Setara menu CLI "Deploy Project Baru". **Job-based (async).**

### `POST /deploy`

**Body:**
| Field | Wajib | Tipe | Keterangan |
|---|---|---|---|
| `name` | ✅ | string | Nama project, unik |
| `gitRepo` | ✅ | string | URL git (`https://...` atau `git@...`) |
| `domain` | ✅ | string | Domain tujuan |
| `port` | ✅ | integer | Port aplikasi (>0) |
| `folderPath` | ✅ | string | Absolute path folder tujuan (`/...`) |
| `branch` | – | string | Default: `git_branch` di Configuration (biasanya `main`) |
| `deployUser` | – | string | Default: `deploy_user` di Configuration |
| `envContent` | – | string | Isi file `.env`, default kosong |
| `prismaMode` | – | `none`\|`generate`\|`push`\|`migrate` | Default `none` |

**Response 202:**
```json
{ "success": true, "message": "Deploy dimulai di background. Cek progress lewat GET /jobs/:id.", "data": { "jobId": "..." } }
```

Poll `GET /jobs/:jobId` sampai `status` jadi `success`/`failed`. Kalau `failed` dan `stoppedAtKey` ada isinya, job bisa di-retry (lihat di bawah) tanpa mengulang dari awal.

**Error khusus:** `INVALID_INPUT` kalau salah satu field di atas tidak valid (pesan menjelaskan field mana).

### `POST /deploy/:jobId/retry`
Lanjutkan job deploy yang `failed`, mulai dari step terakhir yang belum berhasil (bukan dari awal) — kecuali ada override field yang memaksa step lebih awal diulang (lihat tabel).

**Syarat:** job dengan `jobId` itu harus job tipe deploy, `status: "failed"`, dan sempat melewati step clone (`stoppedAtKey` terisi). Kalau gagal sebelum clone, harus `POST /deploy` ulang dari awal (`NOT_RESUMABLE`).

**Body (semua opsional — override field tertentu sebelum resume):**
| Field | Efek |
|---|---|
| `envContent` | Isi `.env` baru, memaksa resume mulai dari step tulis `.env` |
| `port` | Port baru, memaksa resume mulai dari step start PM2 |
| `domain` | Domain baru, memaksa resume mulai dari step Nginx |
| `branch` | Branch baru (tidak memaksa step lebih awal) |
| `prismaMode` | Mode Prisma baru (tidak memaksa step lebih awal) |

`name`, `gitRepo`, `folderPath`, `deployUser` **tidak bisa** di-override saat retry (folder & identitas project sudah terpatri dari attempt pertama).

**Response 202:** sama seperti `POST /deploy`, dengan `jobId` baru.

**Error khusus:** `JOB_NOT_FOUND` (404), `INVALID_JOB_TYPE`, `JOB_NOT_FAILED`, `NOT_RESUMABLE` (semua 400).

---

## Jobs

Polling status job (dipakai bareng `/deploy`, `/ssl/issue`, `/project/:name/build`, `/project/:name/seed`). Read-only.

### `GET /jobs/:id`
**Response 200 — `data`:**
```json
{
  "id": "uuid",
  "type": "deploy_nextjs",
  "params": { "...": "field sensitif (password/token/.env) sudah di-[REDACTED]" },
  "status": "running",
  "message": "",
  "steps": [ { "key": "install", "message": "npm install selesai", "ok": true, "at": "2026-07-28T10:00:00.000Z" } ],
  "createdAt": "...",
  "updatedAt": "...",
  "stoppedAtKey": null
}
```
**Error khusus:** `JOB_NOT_FOUND` (404).

### `GET /jobs`
List semua job (terbaru maupun lama), bentuk array dari object job di atas.

---

## Project

Manajemen project yang **sudah terdaftar** di registry — `.env`, preview/eksekusi hapus. (List semua project registry & import project lama **belum** ada endpoint-nya di fase ini — lihat catatan di README.)

### `GET /project/:name/env`
Baca isi `.env` project. Read-only.

**Response 200:** `{ "data": { "content": "KEY=value\n..." } }`
**Error khusus:** `READ_ENV_FAILED` (400), `PROJECT_NOT_FOUND` (404).

### `PUT /project/:name/env` — 🔒 butuh `confirm`
Timpa **seluruh** isi `.env` project (bukan merge/patch).

**Body:** `{ "content": "KEY=value\n...", "confirm": true }`

**Response 200:** `{ "success": true, "message": "..." }`
**Error khusus:** `WRITE_ENV_FAILED` (400).

### `GET /project/:name/delete-preview`
Lihat dampak hapus project **sebelum** dieksekusi — app PM2 terkait, site Nginx, database terkait, ukuran folder. Read-only, tidak butuh `confirm`.

**Response 200 — `data`:** object preview (isi tergantung apa saja yang ketemu — PM2 app, nginx site, database, path folder).

### `POST /project/:name/delete` — 🔒 butuh `confirm`
Hapus project dari PM2 + Nginx + registry, dan **opsional** database & folder fisik.

**Body:**
| Field | Tipe | Default | Keterangan |
|---|---|---|---|
| `deletePm2` | boolean | — | Hapus app dari PM2 |
| `deleteNginx` | boolean | — | Hapus site Nginx |
| `dropDatabases` | boolean | `false` | **Sengaja default `false`** — harus eksplisit diminta |
| `deleteFolder` | boolean | `false` | **Sengaja default `false`** — harus eksplisit diminta |
| `confirm` | boolean | — | Wajib `true` |

**Response 200 — `data.results`:** array hasil per-step (bisa sukses sebagian, bukan all-or-nothing).

### `POST /project/:name/redeploy`
Tombol "Pull & Redeploy" manual — `git pull` + `npm install` + `npm build` + `pm2 restart`, alur PERSIS sama dengan yang jalan otomatis lewat webhook GitHub (lihat section `Webhook GitHub`). **Async** — balas `202` + `jobId`, progress via `GET /jobs/:id`.

**Response 202:** `{ "data": { "jobId": "..." } }`
**Error khusus:** `PROJECT_NOT_FOUND` (404).

### `POST /project/:name/rollback` — 🔒 butuh `confirm`
Balikin project ke commit deploy **sebelumnya** (`git checkout` ke `previousCommit` yang otomatis dicatat tiap kali `redeploy`/webhook sukses, lalu install+build+restart ulang). Cuma nyimpen 1 slot "sebelumnya" — gak bisa mundur >1 langkah, dan bisa di-toggle bolak-balik (rollback lagi = balik ke yang tadi di-rollback). **Async** — balas `202` + `jobId`.

**Body:** `{ "confirm": true }`
**Response 202:** `{ "data": { "jobId": "..." } }`
**Error khusus:** `PROJECT_NOT_FOUND` (404), `NO_ROLLBACK_TARGET` (400 — project belum pernah redeploy lewat panel ini, jadi belum ada `previousCommit`).

### `PATCH /project/:name/webhook`
Toggle on/off auto-deploy via webhook GitHub untuk project ini (opt-in per-project, default OFF — lihat section `Webhook GitHub`).

**Body:** `{ "enabled": true }`
**Response 200:** `{ "success": true, "message": "..." }`

---

## Git

Semua endpoint di sini beroperasi atas project yang **sudah terdaftar di registry** (path & deploy_user di-resolve dari `:name`, bukan dari body — supaya tidak bisa disuruh menjalankan command atas nama user sembarang).

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/git/:name/status` | sync | – | Branch aktif, ahead/behind, file berubah |
| GET | `/git/:name/branches` | sync | – | Daftar branch lokal & remote |
| GET | `/git/:name/log?limit=10` | sync | – | Histori commit (`limit` 1–200, default 10) |
| POST | `/git/:name/pull` | sync | – | `git pull` |
| POST | `/git/:name/checkout` | sync | – | Pindah branch |
| POST | `/git/:name/stash` | sync | – | Stash perubahan lokal (bisa di-`stash pop` manual di server) |
| POST | `/git/:name/credentials` | sync | – | Ganti remote URL (apply akun GitHub tersimpan / URL manual) |

**`POST /git/:name/pull`** body (opsional): `{ "accountLabel": "akun-pribadi" }` — kalau diisi & cocok akun tersimpan di Configuration, token di-embed sementara ke remote URL cuma buat durasi pull ini.

**`POST /git/:name/checkout`** body: `{ "branch": "develop" }` (wajib).

**`POST /git/:name/credentials`** body: kirim **salah satu**:
```json
{ "accountLabel": "akun-pribadi" }
```
atau
```json
{ "manualUrl": "https://github.com/user/repo.git" }
```
Endpoint ini **beneran mengubah remote origin** project (beda dari `POST /config/github` yang cuma menyimpan daftar akun).

**Error khusus:** `PROJECT_NOT_FOUND` (404), `GIT_STATUS_FAILED`/`GIT_PULL_FAILED`/`GIT_CHECKOUT_FAILED`/`GIT_STASH_FAILED`/`GIT_CREDENTIALS_UPDATE_FAILED` (400), `ACCOUNT_NOT_FOUND` (400/404).

---

## PM2

`:name` = nama app PM2 (dicari dulu di registry, fallback ke daftar PM2 langsung kalau app di-start manual di luar tool ini).

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/pm2` | sync | – | List semua app (termasuk yang terdaftar tapi belum pernah di-start) |
| GET | `/pm2/:name` | sync | – | Detail (`pm2 describe`) |
| GET | `/pm2/:name/logs?lines=50` | sync | – | Log app (`lines` 1–1000, default 50) |
| POST | `/pm2/:name/start` | sync | – | Start (auto-generate full command dari data registry kalau belum pernah start) |
| POST | `/pm2/:name/stop` | sync | – | Stop |
| POST | `/pm2/:name/restart` | sync | – | Restart |
| DELETE | `/pm2/:name` | sync | ✅ | Hapus app dari PM2 (app langsung down) |
| POST | `/pm2/save-startup` | sync | – | `pm2 save` untuk semua deploy_user relevan |

**Response `GET /pm2`:** `{ "data": { "apps": [...], "warnings": [] } }`

**`DELETE /pm2/:name`** body: `{ "confirm": true }`

**`POST /pm2/save-startup` response:** `207` kalau sebagian user gagal (`data.results` per-user).

**Error khusus:** `APP_NOT_FOUND` (404, muncul di semua endpoint `:name`), `PM2_LIST_FAILED` (500), lainnya 400 (`PM2_START_FAILED`, dst).

---

## Nginx

`:file` = nama file `.conf` (harus persis salah satu hasil `GET /nginx/sites`, tidak sekadar lolos format).

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/nginx/sites` | sync | – | List semua site |
| GET | `/nginx/sites/:file` | sync | – | Isi config 1 site |
| GET | `/nginx/sites/:file/error-log?lines=60` | sync | – | Error log domain site ini (`lines` 1–1000, default 60) |
| GET | `/nginx/test-config` | sync | – | Validasi syntax config nginx saat ini |
| POST | `/nginx/sites` | sync | – | Buat site reverse-proxy baru |
| POST | `/nginx/reload` | sync | – | Reload nginx (auto test-config dulu, batal kalau invalid) |
| DELETE | `/nginx/sites/:file` | sync | ✅ | Hapus site (domain langsung unreachable) |

**`POST /nginx/sites`** body: `{ "domain": "app.example.com", "port": 3001 }` (keduanya wajib). Ditolak `409 DOMAIN_CONFLICT` kalau domain sudah dipakai site lain.

**`GET /nginx/sites/:file/error-log`** — baca `{nginx_log_dir}/{domain}.error.log` (konvensi aaPanel; `nginx_log_dir` diatur di Configuration). Domain diambil otomatis dari site yang cocok dengan `:file`, bukan dari input bebas.

**Response 200 — `data`:**
```json
{
  "file": "app.example.com.conf",
  "domain": "app.example.com",
  "lines": [
    { "line": "2026/07/28 10:00:00 [error] ... upstream timed out ...", "level": "error" },
    { "line": "2026/07/28 09:59:00 [warn] ... conflicting server name ...", "level": "warn" },
    { "line": "2026/07/28 09:58:00 ...", "level": "normal" }
  ]
}
```
`level` salah satu dari `error` / `warn` / `normal` (klasifikasi kata kunci sederhana, bukan parsing log terstruktur).

**Error khusus:** `SITE_NOT_FOUND` (404), `NGINX_LOG_FAILED` (400 — termasuk kalau file log belum ada, cek `nginx_log_dir` di Configuration), `NGINX_LIST_FAILED`/`NGINX_VIEW_FAILED`/`NGINX_CREATE_FAILED`/`NGINX_RELOAD_FAILED`/`NGINX_DELETE_FAILED` (400).

**`DELETE /nginx/sites/:file`** body: `{ "confirm": true }`

---

## SSL

Terbitkan sertifikat HTTPS lewat Let's Encrypt (certbot webroot). **Job-based (async).**

### `POST /ssl/issue`
**Body:** `{ "domain": "app.example.com" }`

Domain **wajib sudah terdaftar** di registry (sudah ada project yang deploy ke domain itu) — endpoint ini bukan "issue cert buat domain sembarang", supaya tidak disalahgunakan buat spam request ke Let's Encrypt.

**Response 202:** `{ "data": { "jobId": "..." } }` — poll lewat `GET /jobs/:jobId`.

**Error khusus:** `DOMAIN_NOT_REGISTERED` (404), `INVALID_INPUT` (400, format domain salah).

> Cek expiry & renew-all sertifikat ada di modul `ssl.js`/menu CLI tapi **belum di-expose lewat API** di fase ini.

---

## Database

Kelola database MySQL/MariaDB. Sebagian besar sync (statement SQL cepat), bukan job.

| Method | Path | Confirm? | Keterangan |
|---|---|---|---|
| POST | `/database` | – | Buat database + user baru |
| GET | `/database` | – | List semua database (kecuali database sistem) |
| GET | `/database/:dbName/tables` | – | List tabel |
| GET | `/database/:dbName/tables/:tableName/describe` | – | Struktur kolom (`DESCRIBE`) |
| GET | `/database/:dbName/tables/:tableName/count` | – | Jumlah baris |
| GET | `/database/:dbName/tables/:tableName/preview` | – | Preview isi tabel (beberapa baris pertama) |
| POST | `/database/:dbName/reset-password` | – | Reset password user database |
| DELETE | `/database/:dbName` | ✅ | Drop database (+ optional user) |
| GET | `/database/test-connection` | – | Tes koneksi pakai kredensial root Configuration |
| POST | `/database/test-credentials` | – | Tes koneksi pakai kredensial spesifik (bukan root) |

**`POST /database`** body: `{ "dbName": "myapp_db", "dbUser": "myapp_user", "password": "opsional, auto-generate kalau kosong" }`

**Response 201 — `data`:** `{ "dbName", "dbUser", "password", "connectionUrl" }` (password ditampilkan **satu kali** di response ini — database juga otomatis didaftarkan ke `dbRegistry` lokal).

**`POST /database/:dbName/reset-password`** body: `{ "dbUser": "myapp_user", "password": "opsional" }` (dbUser wajib, tidak ada auto-fill dari registry seperti di CLI karena API tidak ada "prompt").

**`DELETE /database/:dbName`** body: `{ "dbUser": "opsional, ikut dihapus kalau diisi", "confirm": true }`

**`POST /database/test-credentials`** body: `{ "dbName": "...", "dbUser": "...", "password": "..." }`

**Error khusus:** `CREATE_DATABASE_FAILED`, `LIST_DATABASES_FAILED` (500), `DATABASE_NOT_FOUND`/`TABLE_NOT_FOUND` (404), `RESET_PASSWORD_FAILED`, `DROP_DATABASE_FAILED`, `TEST_CONNECTION_FAILED`, `TEST_CREDENTIALS_FAILED` (400).

---

## Backup

Backup/restore project (folder → `.tar.gz`) & database (`.sql.gz`), plus import file SQL lepas.

| Method | Path | Confirm? | Keterangan |
|---|---|---|---|
| GET | `/backup` | – | List semua file backup |
| POST | `/backup/projects/:name` | – | Backup folder project |
| POST | `/backup/databases/:dbName` | – | Backup database |
| POST | `/backup/projects/:name/restore` | ✅ | Restore folder project (menimpa isi folder tujuan) |
| POST | `/backup/databases/:dbName/restore` | ✅ | Restore database (menimpa isi database tujuan) |
| DELETE | `/backup/:filename` | ✅ | Hapus file backup permanen |
| GET | `/backup/sql-files` | – | Scan file `.sql`/`.sql.gz` lepas di folder umum VPS |
| POST | `/backup/import-sql` | ✅ | Import salah satu hasil scan di atas ke database tujuan |

**`POST /backup/projects/:name/restore`** body: `{ "filename": "myapp-2026-07-28.tar.gz", "confirm": true }` — `filename` wajib persis salah satu hasil `GET /backup`.

**`POST /backup/databases/:dbName/restore`** body: sama pola, `{ "filename": "...", "confirm": true }`.

**`POST /backup/import-sql`** body: `{ "dbName": "myapp_db", "fullPath": "/root/dump.sql", "confirm": true }` — `fullPath` wajib persis salah satu `fullPath` dari hasil `GET /backup/sql-files` **terbaru** (bukan sekadar path yang "kelihatan" valid).

**Response 201** untuk `POST /backup/projects/:name` & `POST /backup/databases/:dbName` — `data.file` = nama file backup yang baru dibuat.

**Error khusus:** `BACKUP_NOT_FOUND` (404), `BACKUP_PROJECT_FAILED`/`BACKUP_DATABASE_FAILED`/`RESTORE_PROJECT_FAILED`/`RESTORE_DATABASE_FAILED`/`DELETE_BACKUP_FAILED`/`IMPORT_SQL_FAILED` (400), `SQL_FILE_NOT_FOUND` (404).

---

## Build / Install Manual

Jalankan install/Prisma/build/restart PM2 secara manual di luar alur Deploy (misal setelah `git pull` manual, atau ganti dependency). **Job-based (async).**

### `POST /project/:name/build`
**Body:**
| Field | Tipe | Keterangan |
|---|---|---|
| `install` | boolean | Jalankan `npm install` |
| `prismaMode` | `none`\|`generate`\|`push`\|`migrate` | Default `none` |
| `build` | boolean | Jalankan build |
| `restartPm2` | boolean | Restart app PM2 setelahnya |

Minimal 1 dari 4 step di atas harus dipilih (kalau semua kosong/`none`, `INVALID_INPUT`).

**Response 202:** `{ "data": { "jobId": "..." } }`

### `POST /project/:name/seed`
Jalankan `prisma db seed`. Tidak ada body. **Response 202:** `{ "data": { "jobId": "..." } }`

> ⚠️ Isi seed script di luar kendali tool ini — bisa insert/timpa data tergantung script-nya sendiri. Tidak `confirmRequired` di level API (dianggap operator yang manggil sudah paham isi seed-nya), tapi tetap **destruktif secara potensial** — client sebaiknya tetap konfirmasi ke user.

---

## Security (read-only)

Audit kondisi keamanan server. **Semua endpoint di sini read-only**, tidak ada yang mengubah apa pun.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/security/firewall` | Status `ufw`/`firewalld`, mana yang aktif |
| GET | `/security/ports` | Daftar port TCP listening (`ss -tlnp`) |
| GET | `/security/fail2ban` | Status fail2ban (terinstall & aktif atau tidak) |
| GET | `/security/ssh` | Setting krusial `sshd_config` (`PermitRootLogin`, `PasswordAuthentication`, `Port`) |

**Error khusus (semua 400):** `SECURITY_CHECKFIREWALL_FAILED`, `SECURITY_LISTOPENPORTS_FAILED`, `SECURITY_CHECKFAIL2BAN_FAILED`, `SECURITY_CHECKSSHCONFIG_FAILED`.

---

## Scanner (read-only)

Deteksi kondisi **nyata** server dan bandingkan dengan registry (buat nemuin project/app yang "nyasar" — jalan tapi tidak tercatat, atau tercatat tapi ternyata mati).

| Method | Path | Keterangan |
|---|---|---|
| GET | `/scanner/pm2` | Semua app PM2 dari semua user relevan, dikelompokkan per owner |
| GET | `/scanner/ports` | Port yang beneran terbuka vs tercatat di registry + port asing (orphan) |
| GET | `/scanner/api-health` | Health-check HTTP 1x ke tiap project yang punya port |
| GET | `/scanner/full` | Semua di atas sekaligus + cocokkan folder/PM2/port/domain ke registry |

**Error khusus:** `SCAN_PM2_FAILED`/`SCAN_PORTS_FAILED`/`SCAN_FULL_FAILED` (400).

---

## Cleanup

Scan & hapus cache/file regenerable (build cache, npm/yarn/pnpm/pip cache, log PM2) buat hemat storage.

| Method | Path | Confirm? | Keterangan |
|---|---|---|---|
| GET | `/cleanup/scan/user/:username` | – | Scan cache di home folder 1 user OS |
| GET | `/cleanup/scan/projects` | – | Scan cache di semua folder project (path dari cwd PM2) |
| POST | `/cleanup/delete` | ✅ | Hapus 1 item hasil scan (folder/file) |
| GET | `/cleanup/scan/system` | – | Scan cache **level sistem** (npm cache semua user, APT package cache, Docker image/build cache reclaimable, systemd journal) — beda dari 2 endpoint di atas yang per-user/per-project |
| POST | `/cleanup/clean/system` | ✅ | Bersihkan 1 kategori hasil scan system (`{ "key": "npm_cache"|"apt_cache"|"docker_prune"|"journal", "confirm": true }`) — semua kategori regenerable otomatis oleh tool masing-masing |

**Response scan — `data`:** `{ "items": [...], "totalBytes": 123456, "totalBytesLabel": "120.5 MB" }`

**Response `GET /cleanup/scan/system` — `data`:** `{ "categories": [{ "key": "npm_cache", "label": "...", "bytes": 123, "bytesLabel": "...", "detail": [...] }, ...], "totalBytes": 123 }`

**`POST /cleanup/delete`** body: `{ "username": "www", "targetPath": "/home/www/app/.next/cache", "confirm": true }` — `targetPath` divalidasi harus di dalam boundary yang wajar (home folder user itu, atau folder cwd salah satu app PM2), tidak bisa path sembarang.

**Error khusus:** `USER_HOME_NOT_FOUND` (400), `SCAN_USER_CACHE_FAILED`/`SCAN_PROJECT_CACHES_FAILED`/`CLEANUP_DELETE_FAILED` (400).

---

## Configuration

Baca & ubah konfigurasi **tool ini sendiri** (bukan config per-project) — deploy_user default, folder default, path nginx/certbot, kredensial MySQL root, dan akun GitHub tersimpan. Ini modul yang paling relevan buat halaman "Settings" di mobile app.

| Method | Path | Confirm? | Keterangan |
|---|---|---|---|
| GET | `/config` | – | Baca konfigurasi umum (kredensial di-mask) |
| PUT | `/config` | ✅ | Update field konfigurasi umum |
| GET | `/config/github` | – | List akun GitHub tersimpan (label + username saja) |
| POST | `/config/github` | – | Tambah/replace akun GitHub (PAT) |
| DELETE | `/config/github/:label` | ✅ | Hapus akun GitHub tersimpan |

### `GET /config` — `data`
```json
{
  "deploy_user": "ubuntu",
  "nginx_user": "www-data",
  "default_folder": "/opt/apps",
  "docker_projects_dir": "/opt/docker",
  "git_branch": "main",
  "starting_port": 3000,
  "nginx_conf_dir": "/etc/nginx/sites-available",
  "nginx_binary": "/usr/sbin/nginx",
  "certbot_webroot": "/opt/certbot",
  "certbot_email": "",
  "db_root_user": "root",
  "backup_dir": "/www/backup_manager",
  "backup_retention_days": 7,
  "nginx_log_dir": "/var/log/nginx",
  "runtime_default": { "node": "20.9.0", "php": "8.2" },
  "hasDbPassword": true,
  "api": { "port": 4001 },
  "githubAccountsCount": 1
}
```
`db_root_password` **tidak pernah** dikirim mentah (cuma flag `hasDbPassword`). `api.key_hash`/`key_salt` dan isi `github_accounts` (token) juga tidak pernah ikut di response ini.

### `PUT /config` — 🔒 butuh `confirm`
Kirim salah satu atau lebih field yang mau diubah (whitelist — field di luar daftar ini diabaikan, bukan error):

`deploy_user`, `nginx_user`, `default_folder`, `git_branch`, `starting_port`, `nginx_conf_dir`, `nginx_binary`, `certbot_webroot`, `certbot_email`, `db_root_user`, `db_root_password`, `backup_dir`, `backup_retention_days`, `nginx_log_dir`.

**Body contoh:** `{ "certbot_email": "ops@example.com", "confirm": true }`

**Response 200 — `data`:** config lengkap (ter-mask) setelah update, format sama seperti `GET /config`.

⚠️ Field ini dipakai **hampir semua fitur lain** (nginx, ssl, database, cleanup) — salah isi (misal `nginx_conf_dir` yang salah) bisa bikin banyak fitur lain langsung rusak. Karena itu `confirm: true` wajib.

### `GET /config/github` — `data`
```json
{ "accounts": [ { "label": "akun-pribadi", "username": "githubuser" } ] }
```
Token **tidak pernah** dikirim balik.

### `POST /config/github`
**Body:** `{ "label": "akun-pribadi", "username": "githubuser", "token": "ghp_xxx" }` — ketiganya wajib. Label yang sama akan **menimpa** akun lama dengan label itu (bukan error duplikat).

### `DELETE /config/github/:label` — 🔒 butuh `confirm`
**Body:** `{ "confirm": true }`

⚠️ Repo yang masih pakai token akun ini di remote URL-nya **tidak ikut ter-update** — kalau perlu, update manual per-project lewat `POST /git/:name/credentials`.

---

## Doctor

Self-check kesiapan sistem — dipanggil biasanya saat pertama buka app/tab "Diagnostik", biar masalah (sudoers belum di-setup, command external belum ke-install, dll) ketahuan dari awal, bukan pas user coba deploy dan gagal tanpa konteks jelas.

### `GET /doctor/permissions`
Read-only.

**Response 200 — `data`:**
```json
{
  "ok": false,
  "issues": [
    { "level": "error", "message": "sudoers NOPASSWD untuk user 'www' belum di-setup." }
  ]
}
```
`ok: true` kalau tidak ada isu sama sekali. `issues` bisa kosong.

---

## System

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| POST | `/system/exec` | sync | – | Jalankan 1 command shell whitelist (dari `commandPolicy.js`), bukan command bebas dari body |

---

## Domains / SSL Aliases

`:domain` = domain utama (harus punya site Nginx terdaftar). Beda dari `Domains` di menu CLI — endpoint ini fokus ke ringkasan status (Nginx/SSL/project) + kelola alias domain (`www.` dst) per domain.

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/domains` | sync | – | List semua domain (site Nginx) + status Nginx/SSL/project per domain |
| GET | `/domains/:domain` | sync | – | Detail 1 domain |
| POST | `/domains/:domain/aliases` | sync | – | Tambah alias (mis. `www.domain.com`) — otomatis include di SSL & Nginx server_name |
| DELETE | `/domains/:domain/aliases/:alias` | sync | ✅ | Hapus 1 alias |

---

## Node Manager

Kelola versi Node.js per-user (via `nvm`) dan pin versi tertentu per-project.

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/node/projects` | sync | – | List semua project + `node_version` yang di-pin (kalau ada) |
| GET | `/node/versions` | sync | – | Versi Node terinstall (`nvm ls`) untuk `deploy_user` |
| GET | `/node/global-info` | sync | – | Info Node aktif: versi npm, global packages, path node/npm, platform |
| GET | `/node/versions/available` | sync | – | Versi LTS terbaru per major (`nvm ls-remote --lts`), buat dropdown install |
| POST | `/node/versions/install` | sync | – | Install 1 versi Node baru lewat `nvm install` |
| DELETE | `/node/versions/:version` | sync | – | Uninstall 1 versi Node (`nvm uninstall`) |
| POST | `/node/versions/default` | sync | – | Set versi Node default (`nvm alias default`) |
| POST | `/node/project/:name` | sync | – | Pin/lepas pin versi Node khusus 1 project (dipakai PM2 start-nya) |

---

## Docker

Container Docker biasa (bukan Docker Compose — lihat section terpisah di bawah). Semua command lewat `sudo docker ...` scoped ketat di sudoers.

`:name` = nama container Docker (harus lolos `isValidContainerName`).

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/docker` | sync | – | List semua container (jalan + berhenti). Kalau Docker belum terinstall, balikin `200` dengan `data.notInstalled: true` (bukan error) |
| GET | `/docker/stats` | sync | – | CPU/Mem live semua container (`docker stats --no-stream`) |
| GET | `/docker/:name/inspect` | sync | – | Detail container: image, working dir, user, env vars (value sensitif di-redact), mounts, network |
| GET | `/docker/:name/logs?lines=100` | sync | – | Log container |
| POST | `/docker` | sync | – | Jalankan container baru (`docker run`) dari image tertentu |
| DELETE | `/docker/:name` | sync | ✅ | Hapus container (`docker rm -f`) |
| POST | `/docker/:name/start` | sync | – | Start |
| POST | `/docker/:name/stop` | sync | – | Stop |
| POST | `/docker/:name/restart` | sync | – | Restart |

**Terminal masuk container**: bukan lewat REST, tapi WebSocket `wss://.../docker-exec?container=<name>&shell=sh|bash`. Dashboard memakai session cookie; client lama dapat menambahkan `key=<apikey>`. Nama container divalidasi terhadap `docker ps -a` sebelum PTY di-spawn.

---

## Docker Compose

Deploy app berbasis `docker-compose.yml` (auto-detect framework, mis. Laravel — generate Dockerfile+nginx+supervisor sendiri kalau perlu).

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| POST | `/docker-compose` | **async** | – | Deploy stack baru dari git repo (clone → build → up). Balikin `jobId`, progress via `GET /jobs/:id` |
| GET | `/docker-compose` | sync | – | List semua stack yang terdaftar |
| POST | `/docker-compose/action/:action` | sync | – | Aksi ke stack (`up`/`down`/`restart`/dst) — `:action` di-whitelist, stack ditentukan dari body, BUKAN dari registry (Docker Compose stack tidak masuk `registry.json`) |

---

## Tools / Installer

Deteksi & install/uninstall paket sistem (nginx, mysql-server, redis-server, docker.io, dst — daftar tetap di kode, bukan dari input).

Install memakai lock global agar dua operasi tidak berjalan bersamaan. Instalasi dibatalkan jika apt berencana menghapus paket lain, jika engine konflik (MySQL/MariaDB atau docker.io/Docker CE) masih terpasang, atau jika port service target sudah dipakai daemon/container lain.

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/tools` | sync | – | List semua tool + status terinstall/belum (`which`/`dpkg -s`) |
| POST | `/tools/:key/install` | sync | ✅ | `sudo apt-get install -y <pkg>` (pkg dari whitelist internal by key) |
| POST | `/tools/:key/uninstall` | sync | ✅ | `sudo apt-get remove -y <pkg>` (bukan `purge` — config/data dibiarin) |

---

## SSH Keys

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/ssh-keys` | sync | – | List public key di `authorized_keys` deploy_user |
| POST | `/ssh-keys` | sync | – | Tambah public key baru |
| DELETE | `/ssh-keys/:fingerprint` | sync | ✅ | Hapus 1 key by fingerprint |

---

## File Manager

Akses filesystem scoped (blacklist folder sistem, sama prinsip dengan `cleanup.js`).

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/filemanager/list?path=` | sync | – | List isi folder |
| GET | `/filemanager/read?path=` | sync | – | Baca isi 1 file text |
| POST | `/filemanager/write` | sync | – | Tulis/timpa isi file |
| POST | `/filemanager/mkdir` | sync | – | Buat folder baru |
| GET | `/filemanager/users` | sync | – | List user OS (buat dropdown "ganti owner") |
| POST | `/filemanager/chown` | sync | – | Ganti owner file/folder |
| POST | `/filemanager/chmod` | sync | – | Ganti permission (mode octal) |
| POST | `/filemanager/rename` | sync | – | Rename/pindah file/folder |
| DELETE | `/filemanager/` | sync | ✅ | Hapus file/folder (body: `{ path, confirm: true }`) |
| POST | `/filemanager/upload` | sync (multipart) | – | Upload file (field `file`) |
| GET | `/filemanager/download?path=` | sync | – | Download 1 file |

---

## AI Assistant

Chat dengan LLM (OpenAI-compatible endpoint, model/base URL/API key diatur di Configuration) yang bisa manggil tool internal panel (restart app, cek log, dst) lewat function-calling.

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/ai/models` | sync | – | List model yang tersedia dari provider yang dikonfigurasi |
| POST | `/ai/chat` | sync | – | Kirim pesan chat, balikin respons (termasuk tool-call request kalau ada) |
| POST | `/ai/confirm-action` | sync | – | Konfirmasi eksekusi 1 tool-call yang diminta AI (aksi destruktif tetap butuh confirm eksplisit user, AI tidak bisa lewatin ini) |

---

## Notifications (feed)

Beda dari setting Discord/Telegram (`PUT /config`) — ini baca histori notifikasi REAL dari `data/audit.log`, dipakai halaman "Notifikasi" di dashboard.

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/notifications` | sync | – | List event terbaru (deploy sukses/gagal, backup gagal, disk penuh, PM2 crash-loop, dll) — status baca/belum-baca disimpan di `localStorage` browser, bukan di server |

---

## Cron Jobs

Kelola `crontab` per-user OS. Job baru otomatis dibungkus wrapper (`scripts/cron-wrapper.sh`) yang catat run history — job lama (dibuat manual di luar panel) tetap kebaca tapi tanpa history.

`:index` = posisi baris di crontab user tsb (dari `GET /cron`, bisa berubah kalau baris lain ditambah/dihapus — selalu refresh dulu sebelum update/delete).

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/cron?user=` | sync | – | List cron job user tsb, termasuk `lastRun` (status/durasi run terakhir) kalau ada |
| GET | `/cron/:index/history?user=` | sync | – | Histori run (sampai 20 terakhir) 1 job |
| POST | `/cron` | sync | – | Tambah job baru (`{ user, schedule, command }`) |
| PUT | `/cron/:index?user=` | sync | – | Update jadwal/command 1 job |
| POST | `/cron/:index/toggle?user=` | sync | – | Enable/disable tanpa hapus (prefix `#DISABLED#`) |
| DELETE | `/cron/:index?user=` | sync | ✅ | Hapus job permanen |

---

## Cloudflare Integration

Butuh `cloudflare_api_token` diisi di Configuration (App Settings). `:domain` boleh apex ATAU subdomain — otomatis diresolve ke zone induknya kalau subdomain gak match langsung.

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/cloudflare/security-level?domain=` | sync | – | Baca status Under Attack Mode saat ini (`medium`/`under_attack`) |
| POST | `/cloudflare/purge-cache` | sync | – | Purge semua cache Cloudflare utk domain ini |
| POST | `/cloudflare/under-attack` | sync | – | Toggle Under Attack Mode (`{ domain, enabled: true|false }`) |

---

## Redis Monitoring

Read-only, cuma jalan kalau `redis-server` terinstall & aktif.

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/redis/status` | sync | – | Snapshot lengkap: memory, ops/sec, hit rate, clients, persistence (RDB/AOF), replication, keyspace per-db, top commands. Balikin `data.notInstalled: true` kalau Redis belum ada |

---

## PostgreSQL

Engine kedua selain MySQL/MariaDB (section `Database` di atas) — API terpisah karena syntax SQL & mekanisme auth beda (TCP + password `scram-sha-256`, kredensial `pg_root_user`/`pg_root_password` di Configuration).

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| GET | `/postgres` | sync | – | List database (exclude template & `postgres` bawaan) + ukuran + versi server. `data.notInstalled: true` kalau PostgreSQL belum ada |
| POST | `/postgres` | sync | – | Buat database + role baru sekaligus (`{ dbName, dbUser, password? }`) |
| POST | `/postgres/:dbName/reset-password` | sync | – | Reset password 1 role (`{ dbUser, password? }`) |
| DELETE | `/postgres/:dbName` | sync | ✅ | Hapus database (paksa putus semua koneksi aktif dulu) + role-nya (`{ dbUser?, confirm: true }`) |
| POST | `/postgres/test` | sync | – | Test koneksi pakai kredensial root di Configuration |

---

## Webhook GitHub (auto-deploy)

**Bukan** di bawah `apiKeyAuth` — auth-nya sendiri lewat HMAC signature (`X-Hub-Signature-256`, dicek pakai `webhook_secret` di Configuration). Harus diaktifkan eksplisit per-project dulu (opt-in, default OFF — lihat `PATCH /project/:name/webhook` di section `Project`).

| Method | Path | Tipe | Confirm? | Keterangan |
|---|---|---|---|---|
| POST | `/webhooks/github/:projectName` | **async** | – | Dipanggil GitHub tiap `git push`. Balas `202` segera, proses (pull+install+build+restart) lanjut di background. Ditolak `403 WEBHOOK_NOT_ENABLED` kalau project ini belum diaktifkan webhook-nya |

---

## Terminal (WebSocket)

Bukan REST. Dashboard memakai session cookie otomatis: `wss://.../terminal?user=<optional>`. Client lama/API masih dapat memakai `?key=<apikey>`. Default jalan sebagai user proses API (`deploy_user`), dan user lain harus ada di whitelist eksplisit. Auth dicek sebelum PTY di-spawn. Ping/pong keepalive tiap 25 detik.

---

## Ringkasan Cakupan vs Menu CLI

Hampir semua menu CLI (Deploy, Git, PM2, Nginx, SSL issue, Database, Backup, Security, Scanner, Cleanup, Configuration + akun GitHub, Permission/Doctor, Project `.env` & delete, Build/Install/Seed manual, Nginx error log) plus seluruh fitur dashboard web (Docker, Docker Compose, Node Manager, Tools/Installer, SSH Keys, File Manager, AI Assistant, Notifikasi, Cron Jobs, Cloudflare, Redis, PostgreSQL, Webhook auto-deploy, Deploy rollback, Terminal) sudah punya endpoint yang terdokumentasi di sini. Dokumen ini sempat ketinggalan cukup jauh dari implementasi asli — audit lewat `graphify` (lihat `graphify-out/GRAPH_REPORT.md`) yang menemukan gap ini.

**Belum ada endpoint-nya** (masih CLI-only atau UI-only) per fase ini:
- Menu 1 "Import Project ke Registry" (registrasi project existing yang belum tercatat)
- List semua project di registry (`GET /project`) — API saat ini cuma bisa akses project **per-nama** (`:name`) yang harus sudah kamu tahu, belum ada endpoint list-nya
- Cek expiry & renew-all sertifikat SSL (`ssl.checkExpiry` / `ssl.renewAll` di menu SSL Manager)
- PM2 Logs & Nginx Error Log via menu "Log Viewer" gabungan — PM2 log sudah ada (`GET /pm2/:name/logs`) dan Nginx error log sudah ada (`GET /nginx/sites/:file/error-log`), tapi tidak ada 1 endpoint gabungan seperti tampilan menu CLI-nya
- Deploy rollback: **cuma tersedia untuk app PM2 native**, belum ada untuk stack Docker Compose (arsitekturnya beda — stack Compose tidak tercatat di `registry.json` seperti project PM2, jadi belum ada tempat nyimpen `previousCommit`-nya)
- Bandwidth & Quota Monitoring, Disk Cleanup — fitur ini ada di dashboard tapi belum ditulis section API-nya secara terpisah di dokumen ini (lihat `GET /monitor/bandwidth`, `GET /cleanup/scan/system`, `POST /cleanup/clean/system` di kode `monitor.routes.js`/`cleanup.routes.js` kalau butuh detail)

Kalau kamu butuh salah satu di atas untuk mobile app-nya, tinggal bilang — pola & tempatnya (route + `commandPolicy.js`) sudah konsisten, tinggal ditambah.
