# Konteks Lengkap: VPS Manager 2 (untuk AI lain / Codex / GPT)

Dokumen ini dibuat otomatis untuk memberi AI lain (GPT, Codex, dll) konteks penuh soal project ini tanpa perlu membaca ulang seluruh riwayat chat. Ditulis per 3 September 2026.

---

## 1. Infrastruktur Server

- **Provider**: Oracle Cloud Infrastructure (OCI), tier **Always Free**.
- **Instance**: `A1-Free` (Ampere ARM, arm64/aarch64), region `ap-batam-1`.
- **OS**: Ubuntu 24.04 (Noble).
- **Disk**: Awalnya 2 disk terpisah (boot 47GB + block volume tambahan `OracleFree` 149GB dipasang di `/data`). **Sudah dikonsolidasi**: block volume `OracleFree` sudah dihapus permanen, boot volume di-resize ke **199GB** — sekarang cuma 1 disk (`/`, 192GB usable). Semua data yang tadinya di `/data/apps/*` dan `/data/home-ubuntu/*` sudah dipindah balik jadi direktori asli (bukan symlink lagi) di `/opt/apps/*` dan `/home/ubuntu/*`.
- **User OS yang relevan**:
  - `catur` — user yang menjalankan proses `vps-manager-api` (panel ini sendiri) via PM2. Akses sudo SANGAT terbatas (scoped per-command lewat `/etc/sudoers.d/vps-manager`, generated oleh `scripts/setup-sudoers.sh` — TIDAK PERNAH `ALL=(ALL) NOPASSWD: ALL`).
  - `ubuntu` — user asli VPS, punya sudo grup penuh + akses langsung ke Docker socket (jauh lebih luas dari `catur`). Beberapa app scraper/bot jalan sebagai user ini via PM2 daemon TERPISAH (`~/.pm2` beda per user OS — ini penting, lihat poin "Multi-user PM2" di bawah).
- **Apps yang terdaftar di registry** (`data/registry.json`, dikelola `vps-manager2`):
  - `vps-manager-api` — panel ini sendiri (Next.js/Node), domain `api.zenlab.id`, port 4001.
  - `anime` — Next.js app, domain `anime.zenlab.id`, port 3000, repo `github.com/catur003/anime-web`.
  - `zenlab-core` — domain `zenlab.id` (apex), port 4300.
  - `repo-flow` — domain `repo.zenlab.id`, port 4400.
- **Apps PM2 yang jalan sebagai `ubuntu`** (bukan lewat panel, project lama/manual): `crm-overnight`, `kuramanime-ui`, `kuramanime-watchdog`, `tiktok-yt-bot`, `local-bot-api-server` (Telegram Bot API server, data di `/opt/telegram-bot-api-data`), plus scraper `kuramanime-manual-scraper` yang punya 2 cron job (rescan R2 tiap 6 jam, build catalog tiap Minggu).
- **Docker containers** (bukan lewat panel Docker Compose fitur, deploy manual): `n8n`, `pocketbase` (data `/opt/pocketbase-data`), `flaresolverr`.
- **Database engine terinstall**: MySQL/MariaDB (utama, dipakai `animedb` dkk), **PostgreSQL 16** (baru diinstal, belum ada data project yang pakai), **Redis 7.0.15** (baru diinstal, kosong/belum dipakai project manapun).
- **Backup**: script `/home/ubuntu/backup-all.sh` jalan tiap jam 3 pagi via cron — tar semua project (exclude `node_modules`/`.next`/`.git`) → simpan lokal (retensi 14 hari) → upload ke **Cloudflare R2** (bucket `anime`) via `rclone` (config `/home/ubuntu/.config/rclone/rclone.conf`) → auto-hapus di R2 juga setelah 14 hari. Notifikasi Discord otomatis kalau backup gagal (baik tahap tar maupun upload).
- **Cloudflare**: dipakai buat DNS zone `zenlab.id` (apex) + subdomain-subdomainnya. API Token sudah di-setup di Configuration panel (`cloudflare_api_token`), dipakai fitur Purge Cache & Under Attack Mode.

---

## 2. Apa itu `vps-manager2`

Custom VPS control panel (mirip aaPanel/CyberPanel tapi self-built), full-stack Node.js:
- **Backend**: Express REST API (`src/api/`), berjalan di port 4001, **cuma bind ke `127.0.0.1`** (tidak pernah expose langsung ke internet — akses publik lewat Nginx reverse proxy + SSL).
- **Frontend**: 1 file HTML+CSS+JS besar (`public/dashboard.html`, ~3900+ baris JS inline) — dark theme, SPA-style (semua "page" di-toggle via JS, bukan routing beneran).
- **CLI**: `src/menu/mainMenu.js` — menu interaktif (dipakai sebelum dashboard web dibangun, sebagian fitur cuma ada di sini).
- **Auth**: web memakai username/password + session cookie HttpOnly/Secure/SameSite=Strict dan CSRF. Setup admin pertama memakai token 24 jam sekali pakai. API key global lama tetap kompatibel khusus mobile/bot/script; WebSocket dashboard memakai cookie, sedangkan query `?key=` hanya fallback client lama.
- **Config**: `data/config.json` (permission 600, isi macam-macam kredensial: `db_root_password`, `pg_root_password`, `cloudflare_api_token`, `webhook_secret`, `github_accounts[]`, dll). File ini **sengaja tidak masuk git** (`.gitignore`).
- **Registry**: `data/registry.json` — daftar project PM2-native yang "dikenal" panel (beda dari Docker Compose stack yang TIDAK masuk sini).
- **Audit log**: `data/audit.log` — SEMUA aksi lewat API (hampir semua route) dicatat start/end dengan redaksi otomatis field sensitif (password/token/secret/key), plus deteksi credential yang nyempil di URL (`user:TOKEN@github.com/...`).
- **Job system**: aksi berat (deploy, build, SSL issue, dst) jalan sebagai job async (`data/jobs.json` + `jobStore.js`), client polling `GET /jobs/:id`.
- **Dokumentasi API lengkap**: `docs/API.md` (baru saja dilengkapi — lihat bagian 6).

### Repo & Deploy

- Repo GitHub: `https://github.com/catur003/vps-manager2` (private, akun `catur003`).
- Deploy PM2-native app: clone → `npm install` → `npm build` → `pm2 start` (lihat `src/deploy/deployNew.js`).
- Deploy Docker Compose app: auto-detect framework (mis. Laravel → generate Dockerfile+nginx+supervisor sendiri, base image custom karena `richarvey/nginx-php-fpm` pernah gagal di produksi — versi PHP salah).
- Redeploy: `git pull` + install + build + restart (`src/deploy/redeploy.js`), dipakai baik manual (tombol dashboard) maupun otomatis (webhook GitHub).
- **Rollback** (baru): checkout ke commit SEBELUMNYA (`previousCommit`, tercatat otomatis tiap redeploy sukses) + rebuild + restart. Cuma 1 slot histori (bisa toggle bolak-balik, gak bisa mundur >1 langkah). **Cuma untuk PM2-native**, belum ada untuk Docker Compose (beda arsitektur registry).

---

## 3. Semua Fitur (kronologis, per kategori)

### Dashboard pages yang ada sekarang (nav sidebar)
Overview, Terminal, File Manager, Apps (PM2), Docker, Docker Exec, Deployments, Node Manager, Redis, Database (MySQL), PostgreSQL, Domains/SSL, Nginx, Backup, Tools/Installer, Cron Jobs, Disk Cleanup, Bandwidth & Quota, Security, SSH Keys, Notifikasi, App Settings, AI Assistant.

### Fitur besar yang dibangun sepanjang sesi ini (urutan mengerjakan)
1. **Multi-user PM2 visibility** — app yang jalan sebagai `ubuntu` (bukan `catur`) awalnya invisible di halaman Apps/Docker karena PM2 daemon terpisah per OS user. Fix: config `additional_pm2_users` (bukan migrasi app, zero-risk).
2. **Redesign halaman**: Database, Notifications→jadi feed asli (bukan cuma settings), Node Manager, Apps (PM2) dengan border warna status, Docker table.
3. **Unify "Deploy Baru" + "Projects"** jadi 1 halaman "Deployments".
4. **Fix keamanan nyata**: PAT GitHub sempat ke-log plaintext di `data/audit.log` & PM2 log (`shell.js` gak dikasih `silent:true` di 3 tempat) — sudah di-fix + token lama di-revoke user.
5. **Fix keamanan nyata #2**: `data/.secret.key` (kunci enkripsi kredensial database) sempat ke-commit ke git karena `.gitignore` gak lengkap — sudah di-untrack + key di-rotate.
6. **Un-symlink semua project** — sebelumnya `/opt/apps/*` dan `/home/ubuntu/*` adalah symlink ke `/data/...`. User minta dihilangkan semua (bikin bingung), jadi real folder dipindah balik ke lokasi aslinya.
7. **Konsolidasi disk** — hapus block volume 149GB, resize boot ke 199GB (lihat bagian 1).
8. **Backup otomatis + offsite R2** (lihat bagian 1).
9. **8 fitur besar** (dikerjakan berurutan, semua tervalidasi + di-push):
   - Notifikasi otomatis (backup gagal, disk >85%, PM2 crash-loop >=3x restart/5menit) — modul `src/monitor/alerting.js`.
   - Cron run history — job baru dibungkus `scripts/cron-wrapper.sh`, catat exit code/durasi/waktu ke `~/.vps-manager-cron-history.jsonl` per-user.
   - Disk Cleanup — scan+bersihkan npm cache/apt cache/docker prune/journal (`src/cleanup/systemCleanup.js`).
   - Docker Exec/Shell — WebSocket `/docker-exec` (mirip `/terminal` tapi `docker exec -it <container> sh/bash`), plus info bar (image/workdir/user/CPU/mem via `docker inspect`), Quick Commands, Environment Variables (redacted).
   - Deploy rollback (PM2-native, lihat bagian 2).
   - Webhook GitHub per-project — sekarang **opt-in** (`webhook_enabled` di registry, default `false`), ada toggle + URL otomatis per project di dashboard.
   - Bandwidth & Quota Monitoring — sampler `/proc/net/dev` tiap jam (`src/monitor/bandwidth.js`), + Docker network I/O + storage R2 real (`rclone size`).
   - Cloudflare Integration — purge cache & toggle Under Attack Mode per domain, **auto-resolve subdomain ke apex zone** (fix bug: awalnya cuma cocok domain persis, subdomain selalu gagal).
10. **Perbaikan UX**: App Settings dipisah dari Notifikasi (sebelumnya numpuk semua setting di 1 modal "Notification Settings" — sekarang Notifikasi cuma Discord/Telegram, sisanya di halaman App Settings baru), indikator status Under Attack ON/OFF yang jelas (sebelumnya cuma 2 tombol blind), hapus emoji di button baru.
11. **Redis Monitoring** — halaman baru (`src/redis/redis.js`, parsing `redis-cli info`), setelah user install Redis via panel.
12. **Pesan "belum terinstall" yang ramah** — Docker/Database page sebelumnya nunjukin error teknis mentah (`sudo: docker: command not found`) kalau service belum ada, sekarang nunjukin pesan jelas + tombol ke Tools/Installer.
13. **PostgreSQL dual-engine support** — halaman baru terpisah dari Database (MySQL), `src/database/postgres.js`, auth via TCP+password (`scram-sha-256`), pola keamanan sama persis dgn MySQL (execFileSync argv, password via env var `PGPASSWORD`, bukan command-line flag).
14. **Uninstall di Tools/Installer** — sebelumnya cuma bisa install, sekarang bisa uninstall juga (`apt-get remove`, bukan `purge` — config/data dibiarin), wajib confirm di UI.
15. **Audit graphify** — menemukan `docs/API.md` ketinggalan jauh dari implementasi asli (17 endpoint group gak terdokumentasi). **Sudah diperbaiki** — semua endpoint sekarang terdokumentasi lengkap di `docs/API.md`.

---

## 4. Keputusan Desain & Prinsip Keamanan yang Dipegang

- **Least privilege lewat sudoers**: `catur` (user proses panel) TIDAK PERNAH dikasih `ALL=(ALL) NOPASSWD: ALL`. Semua command sudo di-scope exact per-command/per-argumen di `/etc/sudoers.d/vps-manager` (generated dari `scripts/setup-sudoers.sh`, idempotent, aman dijalankan ulang).
- **Command injection defense**: SEMUA input dari body request yang dipakai buat command shell WAJIB lewat `execFileSync` (argv terpisah, `shell.runArgs`/`shell.runAsUserArgs`), TIDAK PERNAH `execSync` dengan string interpolation kalau ada input eksternal.
- **Password/secret gak pernah di command-line**: selalu lewat env var (`MYSQL_PWD`, `PGPASSWORD`) — supaya gak nongol di `ps aux`.
- **Redact di 2 lapis**: log (`shell.js` `silent:true` buat command sensitif) DAN audit log (`audit.js` `redact()` — deteksi nama field sensitif + pola credential ke-embed di URL).
- **Aksi destruktif wajib `confirm:true`** eksplisit di body — pola konsisten di seluruh API (drop database, hapus project, uninstall tool, dll).
- **Opt-in daripada opt-out** buat fitur yang berresiko (webhook GitHub per-project default OFF, dst).
- **Backup dulu sebelum edit config kritis** (Nginx config edit selalu `backupSite()` dulu + test-before-reload dengan auto-rollback kalau syntax invalid).

---

## 5. Known Limitations / Gap yang Masih Ada

- **Docker Compose rollback**: belum ada (arsitektur beda, stack Compose gak masuk `registry.json`).
- **List semua project** (`GET /project` tanpa `:name`): belum ada endpoint-nya, API cuma bisa akses per-nama yang harus sudah diketahui.
- **Import project existing** ke registry: masih CLI-only.
- **SSL check-expiry/renew-all manual**: masih CLI-only (auto-renew via toggle sudah ada di App Settings, tapi trigger manual belum ada endpoint API).
- **PM2 + Nginx Log Viewer gabungan**: masing-masing endpoint terpisah sudah ada, tapi gak ada 1 endpoint gabungan seperti tampilan menu CLI.
- **PostgreSQL**: baru CRUD dasar (list/create/reset-password/drop) — belum ada browse tabel/preview data seperti yang MySQL punya.
- **Redis Monitoring**: snapshot real-time doang, belum ada histori/trend chart (beda dari Bandwidth Monitoring yang udah punya historical sampler).

---

## 6. File-file Penting (kalau AI lain perlu baca kode langsung)

- `src/api/server.js` — daftar semua route yang aktif (`app.use(...)`).
- `src/api/commandPolicy.js` — daftar SEMUA action + apakah butuh `confirm` + audit level.
- `src/config/config.js` — schema config + default values.
- `src/registry/registry.js` — CRUD project PM2-native.
- `scripts/setup-sudoers.sh` — SEMUA sudo rule yang diberikan ke `catur`, idempotent.
- `docs/API.md` — dokumentasi REST API lengkap (baru saja diperbaiki, sekarang akurat).
- `graphify-out/GRAPH_REPORT.md` — hasil audit knowledge-graph codebase ini (god nodes, community structure, gap yang ditemukan).
- `public/dashboard.html` — SATU file berisi seluruh frontend (cari nama fungsi JS via grep kalau butuh lokasi spesifik).

---

## 7. Preferensi Standing User (berlaku lintas sesi, bukan cuma project ini)

Ringkasan cepat:
- **Major version upgrade dependency** (Next.js dkk): jangan force-upgrade app yang sudah production/jalan. Versi major terbaru cuma dipakai buat project BARU.
- **App mobile "zenime" (Aniro)**: sudah terinstall di HP user — WAJIB kasih notice dulu sebelum ubah kode apapun di app itu.
- **Verifikasi sebelum setuju**: user minta verifikasi independen dulu terhadap klaim/diagnosis teknis, jangan langsung percaya laporan begitu saja.
- User lebih suka dikasih **saran dulu, baru eksekusi** untuk pekerjaan besar/ambigu (bukan langsung jalan tanpa preview rencana).
- **Gak suka emoji** di UI tombol/label yang baru ditambahkan.
- **Security-first**: kalau ada dilema antara kemudahan vs keamanan (mis. sudoers scope, redact log), pilih yang lebih aman meski lebih ribet.

### Isi lengkap (verbatim dari memory persisten Claude, biar konteksnya utuh)

**major-version-upgrade-policy**
> When a running production app has a dependency with known security vulnerabilities that are only fully patched by a major version bump (e.g. Next.js 14 -> 16), the user prefers to apply the safe same-major patch release (e.g. 14.2.35) rather than force the major upgrade on an app that's already live and working. Major upgrades carry real risk of breaking changes and aren't worth it just to close out lower-severity findings (e.g. DoS/cache-poisoning issues that need specific conditions, as opposed to something like RCE).
>
> Instead, the user's rule is: adopt the latest major version (e.g. Next.js 16) only when starting a brand-new project from scratch, not by upgrading an existing app in place. So when scaffolding a new project, default to the latest stable major of the framework being used; when patching an existing app's vulnerabilities, prefer the minimal same-major fix and only propose a major upgrade if the user asks for one.

**verify-before-agreeing**
> When the user shares a proposed diagnosis, root-cause analysis, or fix (whether from another tool, another agent's report, or their own hypothesis) and asks whether it should be applied, do not simply agree or implement it on the strength of the write-up alone. The user has explicitly called this out before ("kamu cek apa cuma langsung setuju" — "did you actually check, or did you just agree?") after being given a proposed fix. Independently verify the underlying claim against real data first — run the actual code path, fetch the actual page/API, inspect the actual file — and only then recommend applying, modifying, or rejecting the proposal. This mirrors an earlier, more specific correction in the same vein: the user demanded real-browser verification (not `curl`) for a scraper bug, rejecting reasoning based on assumptions about what a page "should" show. The pattern generalizes: prefer direct empirical verification over trusting a plausible-sounding explanation, especially before making a code change.

**zenime-changes-need-notice**
> For the `zenime` mobile app (repo at `/home/ubuntu/zenime`, branded "Aniro"), the user has already built an EAS APK and installed it on their own device. Because of this, they explicitly asked that any future code change to `zenime` come with advance notice first, rather than being applied silently — unlike other repos (e.g. `anime-web`) where direct fixes are fine once approved in the conversation. In practice this means: before editing files in `zenime`, flag what's about to change and why, and treat committing/pushing/rebuilding as a separate step the user should be told about (or asked about) rather than something to do automatically right after an edit — since a change that isn't reflected in a rebuilt APK could otherwise cause confusion about what's actually running on their installed app.

---

## 8. Catatan buat AI yang menerima dokumen ini

- Password/token/API key **TIDAK ADA** di dokumen ini — semua kredensial asli tersimpan di `data/config.json` (600, gitignored) di server, tidak pernah disalin ke chat/dokumen manapun.
- Kalau butuh detail implementasi 1 fitur spesifik, rujuk ke `docs/API.md` (kontrak API) atau baca langsung file kode yang disebut di bagian 6.
- `graphify-out/graph.json` (kalau ikut disalin) adalah representasi graph lengkap codebase ini (1201 node, ~1950 edge, 65 community) — bisa di-query lebih lanjut kalau tool GPT/Codex-nya support baca JSON besar.
