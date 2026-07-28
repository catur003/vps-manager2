# Changelog

> **Handoff untuk AI/sesi berikutnya** - baca ini dulu sebelum lanjut kerja di project ini.
>
> **Project ini**: VPS Manager - CLI Node.js (`bin/vps-manager.js`) + REST API (`bin/vps-api.js`)
> buat deploy & kelola project Next.js di VPS dari HP (lewat app Expo/React Native
> "ZenVPSApp", repo terpisah), tanpa perlu buka terminal. User: Zen/Catur, VPS Ubuntu,
> project di-deploy ke `/opt/apps` (bukan default `/www/wwwroot` bawaan config - CEK
> `default_folder` di `config.json` sebelum asumsi path).
>
> **Urutan kerja yang disepakati**: rampungkan SEMUA API backend dulu (termasuk
> yang masih gap di bawah), BARU lanjut wiring ke mobile app. Jangan lompat ke app
> sebelum backend beneran lengkap - itu keputusan eksplisit dari user, bukan asumsi.
>
> **Status per sesi ini (2026-07-27)**:
> - Fase A-F (dasar CLI+API+app) sudah selesai semua.
> - Sesi ini nambah: Configuration API (`/config`, `/config/github`), Git Credentials
>   per-project (`POST /git/:name/credentials`), self-check `/doctor/permissions`,
>   `scripts/setup-sudoers.sh`, DAN build/install/seed manual job-based
>   (`POST /project/:name/build`, `POST /project/:name/seed`). Detail lengkap
>   di 2 entry paling atas di bawah ini.
> - **Semua API backend dari audit awal sekarang SUDAH ADA** (bukan berarti sudah
>   diuji - lihat poin di bawah). Sisa kerjaan yang jelas SEKARANG cuma: wiring
>   ke mobile app, testing di VPS asli, dan item "ditunda" lama (VPS Scanner versi
>   full-compare, grouping menu CLI).
> - **Belum dites di VPS asli** - semua baru lolos `node --check` (syntax) di sandbox
>   tanpa `sudo`/`mysql`/`nginx`/`npm`/`prisma`/`pm2` beneran. Wajib smoke-test di
>   VPS asli sebelum lanjut ke app, terutama endpoint destruktif (`build.runManual`,
>   `config.update`) dan yang bergantung ke sudoers (`cleanup.deletePath`).
>
> **Yang masih jadi gap (backend)**:
> 1. ~~Git Manager - Install/Build/Restart manual & Jalankan Seed~~ **SUDAH DIBUAT**
>    sesi ini (`build.routes.js`, job-based) - tinggal dites di VPS asli.
> 2. **Reload Nginx manual, PM2 Save Startup, Test Koneksi MySQL** - API-nya
>    SUDAH ADA (`nginx.reload`, `pm2.saveStartup`, `database.testConnection/
>    testCredentials` semua sudah di commandPolicy & route), ini gap di sisi APP
>    (belum ada tombol) bukan backend - ingat ini pas mulai fase mobile app.
> 3. **Sudoers di VPS asli** belum di-apply pakai `scripts/setup-sudoers.sh` yang baru
>    dibuat - user (`catur`) belum ada di `/etc/sudoers` sama sekali sebelumnya, jadi
>    `cleanup.deletePath()` (dan aksi `sudo -u` lain) kemungkinan masih gagal permission
>    sampai script ini dijalankan manual di server.
>
> **Yang belum disentuh sama sekali**: app mobile (ZenVPSApp) untuk semua endpoint baru
> di atas - sesuai rencana, backend dulu baru app.

## [Unreleased] - 2026-07-27 (Build/Install/Seed manual - job-based, Fase K)

### Added - Build API (`src/api/routes/build.routes.js`, baru, job-based)
- **`POST /project/:name/build`** - jalanin kombinasi `npm install` / `prisma generate|db push|migrate deploy` / `npm run build` / restart PM2 secara manual di luar alur Deploy, sesuai step yang dipilih di body (`install`, `prismaMode`, `build`, `restartPm2`). Job-based (`fork buildWorker.js`, pola sama persis `deploy.routes.js`) - command ini bisa makan waktu menitan, gak boleh nge-block API. Berhenti di step pertama yang gagal, step sesudahnya sengaja tidak dilanjut. Progress dipoll lewat `GET /jobs/:id` yang sudah ada.
- **`POST /project/:name/seed`** - jalanin `prisma db seed` sendirian (dipisah dari `/build` karena di CLI ini menu tersendiri). Job-based (`fork seedWorker.js`).
- Semua logic shell (`npmInstall`, `prismaGenerate/DbPush/MigrateDeploy/Seed`, `npmBuild`) sudah ada dari awal di `src/build/build.js` (dipakai CLI) - sesi ini murni nge-expose lewat job-based API, TIDAK ada perubahan di `build.js` itu sendiri.
- Action baru: `build.runManual`, `build.runSeed` (keduanya `confirmRequired: false` - rebuild gampang diulang, bukan hapus data; seed sengaja gak dipaksa confirm karena efeknya tergantung isi seed script sendiri, di luar kendali tool ini).
- **Ini menutup gap terakhir dari audit awal**: satu-satunya fitur CLI yang tadinya belum ada API-nya sama sekali (Git Manager > Install/Build/Restart Manual + Jalankan Seed).

### Notes
- Belum dites di VPS asli (baru lolos `node --check`, sandbox ini gak ada `npm`/`prisma`/`pm2` beneran).
- Belum wiring ke app mobile - sesuai rencana, backend dulu.

## [Unreleased] - 2026-07-27 (Configuration API + Git Credentials + Doctor/Self-check)

### Added - Configuration API (`src/api/routes/config.routes.js`, baru)
- **`GET /config`** - baca konfigurasi umum tool (`config.loadConfig()`). Kredensial di-mask: `db_root_password` cuma jadi `hasDbPassword: true/false`, `api.key_hash`/`key_salt` gak pernah ikut ke response.
- **`PUT /config`** - update field umum (whitelist `EDITABLE_FIELDS`, bukan terima body mentah). `confirmRequired: true` karena bisa mempengaruhi hampir semua fitur lain (nginx, ssl, database, cleanup) kalau salah isi.
- **`GET /config/github`** - list akun GitHub tersimpan, token TIDAK PERNAH dikirim balik.
- **`POST /config/github`** / **`DELETE /config/github/:label`** - tambah/hapus akun (`config.addGithubAccount`/`removeGithubAccount` yang sudah ada, tinggal di-expose). Delete `confirmRequired: true`.
- Ini menutup gap: menu "Configuration" & "Kelola akun GitHub" sudah ada lengkap di CLI (`mainMenu.js` baris ~366-482) dari awal, tapi belum pernah ada API-nya buat app/bot.

### Added - Git Credentials per-project (`src/api/routes/git.routes.js`)
- **`POST /:name/credentials`** - ganti remote URL origin project (pakai akun GitHub tersimpan via `accountLabel`, atau `manualUrl` langsung). Membungkus `git.setRemoteUrl()`+`git.buildAuthenticatedUrl()` yang sudah ada di `src/git/git.js` tapi belum di-expose. Sesuai fitur "Update Kredensial GitHub" yang sudah ada di CLI (baris ~848) tapi belum ada endpoint API-nya.
- URL disimpan ke audit log SUDAH di-strip token (`git.stripCredentials()`) sebelum masuk `params`, biar PAT gak nyangkut di audit log.

### Added - Doctor / self-check (`src/doctor/doctor.js` + `src/api/routes/doctor.routes.js`, baru)
- **`GET /doctor/permissions`** - self-check read-only: (1) `sudo -n -u <deploy_user> true` buat deteksi sudoers NOPASSWD belum diset (gagal cepat, non-interactive, gak hang nunggu password), (2) owner folder `default_folder` cocok/gak sama `deploy_user` di config, (3) ketersediaan command eksternal (`git`, `nginx`, `certbot`) lewat `shell.commandExists()` yang sudah ada.
- Tujuan: masalah permission (mis. cleanup delete gagal karena sudoers belum diset) ketauan dari awal lewat tab Diagnostik app, bukan pas user coba eksekusi aksi destruktif dan dapet error generik.

### Added - `scripts/setup-sudoers.sh` (baru)
- Script sekali-jalan buat VPS baru: deteksi otomatis `deploy_user` dari `config.json`, tanya `API_USER` (user yang jalanin proses vps-api), generate rule sudoers **scoped per-command** (bukan blanket `ALL=(ALL) NOPASSWD: ALL`) ke `/etc/sudoers.d/vps-manager`.
- **Wajib lolos `visudo -c` sebelum di-apply** - kalau syntax rusak, TIDAK ditulis ke sudoers asli (mencegah sudo ke-lock di seluruh server).
- Idempotent - dijalankan ulang gak bikin duplikat/gak nulis ulang kalau isinya sudah sama.
- Sekalian warning kalau owner folder deploy != deploy_user yang dikonfigurasi (mismatch yang sebelumnya cuma ketauan pas gagal jalan).

### Notes
- Field yang bisa diedit lewat `PUT /config` sengaja **tidak termasuk** `api.port`/`api.key_hash` (rotate API key tetap lewat `bin/vps-api-keygen.js`, bukan endpoint config) dan `github_accounts` (punya endpoint sendiri, karena tiap akun butuh validasi berbeda).
- Belum termasuk di fase ini: wiring ke app mobile (menu Configuration, tab Diagnostik section "Izin Sistem", tombol Update Kredensial GitHub di Git Manager) - sesuai rencana, backend/API dirampungkan dulu sebelum sentuh app.

---

## Riwayat ringkas (sebelum sesi ini)

Detail lengkap tiap poin di bawah (kode yang diubah, alasan, hasil test) sudah diringkas
dari sini atas permintaan user - histori lengkapnya masih ada di git history/transcript lama
kalau perlu ditelusuri lagi.

- **Fase 1-2 (PM2, Nginx, SSL, Database dasar)**: API dasar buat PM2 (list/start/stop/restart/delete/logs), Nginx (list/view/create/delete/reload/test), SSL (issue/renew/checkExpiry), Database (create) - semua di-hardening pakai `execFileSync`/`runArgs` (bukan shell string interpolation) dari awal.
- **Fase 3 (Git) + 3.1 (hardening)**: API Git (status/branches/log/pull/checkout/stash). Fix command-injection di `checkout`/`log`/`diffNameOnly` (pindah dari `runAsUser` string ke `runAsUserArgs` argv-based).
- **Fase 4 (Backup) + 4.1 (hardening)**: API backup/restore project & database, scan file `.sql` lepas, hardening `backup.js`/`cleanup.js`/`security.js` ke `execFileSync`.
- **Fase 5 (Security, Scanner, Cleanup)**: API read-only firewall/fail2ban/ssh/ports, scanner PM2/port/API-health, scan cache user & project. Lanjutan: `POST /cleanup/delete` buat eksekusi hapus cache (sebelumnya cuma scan).
- **Fase 6 (Project Management)**: API `.env` (read/write) dan Delete Project (preview + execute, PM2/nginx/database/folder opsional).
- **API Database lengkap**: nambah list/listTables/describeTable/countRows/previewTable/resetPassword/drop (sebelumnya cuma create). Sekalian jadi endpoint pertama yang beneran menegakkan `confirmRequired` (sebelumnya field itu ada tapi gak pernah dicek).
- **Bug fixes penting yang sudah kelar**:
  - Stale registry entry salah blokir Safety Check pas deploy ulang ke port/domain project yang sudah dihapus manual → fix `isProjectAlive()` + auto-prune fail-safe.
  - Password database tersimpan plaintext di `db-registry.json` → dienkripsi AES-256-GCM (`secretCrypto.js`), backward-compatible sama data lama.
  - Retry deploy pakai source clone lama (bukan commit terbaru GitHub) → `refreshSourceFromGit()`, otomatis `git fetch`+`reset --hard` sebelum resume.
  - Retry deploy gak bisa override `.env`/port/domain yang salah dari awal → sekarang bisa, dengan resume point yang ikut mundur ke step relevan.
  - `nginx.routes.js` sempat hilang total dari satu paket rilis (bikin API crash total saat start) → sudah diperbaiki & di-smoke-test.
- **Belum dites di VPS asli** (dari sesi-sesi lama, kemungkinan masih relevan kalau belum pernah dicoba user): Delete Project, fix stale-registry, refresh-source retry - semua baru dites lewat shell mock di sandbox dev (gak ada `sudo`/`pm2`/`mysql`/`git` beneran).
- **Ditunda/belum dikerjain (dari sesi-sesi lama)**: fitur VPS Scanner "full compare vs registry" versi lengkap (desain sudah ada, butuh fix `pm2.js getRelevantUsers()` dulu), review grouping menu CLI (flat, belum dikelompokkan).

---

## Ringkasan status project (per 2026-07-27, diperbarui - versi sebelumnya sudah basi)

**VPS Manager** - CLI DevOps tool (`bin/vps-manager.js`) + REST API (`bin/vps-api.js`) buat deploy/kelola project Next.js di VPS, dipakai dari HP lewat app Expo/React Native (ZenVPSApp) tanpa akses terminal lokal. Fitur utama: Deploy Project Baru (clone → install → build → PM2 → nginx → opsional SSL, job-based & bisa di-retry dengan override), Git/PM2/Nginx/Database/Backup/Security/Scanner/Cleanup/Project/Configuration Manager - hampir semua sudah lengkap API-nya.

**Security posture**: command injection sudah di-hardening penuh (`execFileSync`/`runArgs`, bukan shell string interpolation) untuk semua path yang nerima input dari API. Kredensial: API key via scrypt hash, db root password & database password encrypted-at-rest, GitHub token dimasking di semua response API (list akun cuma balikin label+username). File kredensial permission 600. Atomic write + file lock buat cegah corrupt/race condition di registry. `confirmRequired` di commandPolicy sekarang ditegakkan beneran (bukan cuma metadata) untuk semua aksi destruktif.

**Yang sudah lengkap API-nya**: PM2, Nginx, SSL, Database (full CRUD + tools), Git (termasuk credentials per-project), Backup/Restore, Security (read-only), Scanner (read-only), Cleanup (scan + delete), Project (.env + delete), Configuration (umum + akun GitHub), Doctor (self-check permission), Build/Install/Seed manual (job-based).

**Masih perlu kerjaan (lihat blok Handoff di paling atas file ini buat detail)**:
1. Wiring ke app mobile untuk SEMUA endpoint yang sudah ada API-nya tapi belum ada tombolnya (env, delete project, save startup PM2, reload nginx manual, test koneksi MySQL, configuration, git credentials, doctor/diagnostik, build/install/seed manual).
2. VPS Scanner versi "full compare" (desain sudah ada, blocked oleh fix `pm2.js getRelevantUsers()`).
3. Review & implementasi grouping menu CLI (saran sudah diberikan, belum dieksekusi).
4. Sudoers di VPS asli belum di-apply (`scripts/setup-sudoers.sh` baru dibuat, belum pernah dijalankan user).
5. Semua API baru (sesi ini) belum dites di VPS asli sama sekali.
