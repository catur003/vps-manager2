# Changelog

Changelog lama dihapus & mulai dari sini lagi sesuai permintaan. Riwayat fase
sebelumnya masih ada di histori chat kalau sewaktu-waktu dibutuhkan.

## Fase 1 - Configuration Menu 13 Lengkap (2026-07-29)

### Changed
- `src/menu/mainMenu.js` - `configurationMenu()`: sebelumnya opsi "Ubah
  konfigurasi umum" cuma bisa edit 4 field (`deploy_user`, `default_folder`,
  `git_branch`, `starting_port`) padahal `config.json` punya 15+ field. Sekarang
  dipecah jadi submenu kategori baru `configEditCategoryMenu()`:
  - **Deploy & Git**: `deploy_user`, `default_folder`, `git_branch`, `starting_port`
  - **Nginx**: `nginx_user`, `nginx_binary`, `nginx_conf_dir`, `nginx_log_dir`
    (plus info singkat perbedaan path aaPanel vs Ubuntu/Debian polos, karena ini
    yang bikin "Kesiapan Sistem" gagal di server non-aaPanel)
  - **SSL / Certbot**: `certbot_webroot`, `certbot_email`
  - **Database**: `db_root_user`, ganti password opsional (lewat konfirmasi
    terpisah biar gak ke-reset gak sengaja)
  - **Backup**: `backup_dir`, `backup_retention_days`
  - **Runtime Default**: `runtime_default.node`, `runtime_default.php`
  - Tiap kategori simpan sendiri-sendiri lalu balik ke submenu kategori (bisa
    edit beberapa kategori berturut-turut tanpa ulang dari awal).

## Fase 2 - Fix SSL Alias Domain (www) + Node Version Manager (2026-08-16)

### Fixed
- **Root cause "www.domain gabisa SSL"**: `registry.findByDomain()` cuma
  exact-match ke field `domain` project, dan nginx cuma pernah nulis SATU
  nama ke `server_name`. Akibatnya `www.zenin.my.id` (walau `zenin.my.id`
  sudah jadi project terdaftar) SELALU dianggap "belum ada project"
  (`DOMAIN_NOT_REGISTERED`) oleh `POST /ssl/issue`.
- Ditambahkan konsep **alias domain** per project (`project.aliases: string[]`).
  Alias TIDAK didaftarkan sebagai project terpisah (beda port/folder) - cuma
  nempel ke domain utama yang sudah ada, lalu satu vhost nginx (`server_name`
  gabungan) dan SATU sertifikat SSL (SAN multi-domain, `--cert-name` dipin ke
  domain utama + `--expand`) meng-cover keduanya sekaligus.

### Added
- `src/registry/registry.js`: `findByDomain()` sekarang cocok ke `domain`
  ATAU salah satu `aliases`. `addProject()` cek konflik alias juga.
- `src/ssl/ssl.js`: `issueCertificate(domain, aliases)` - certbot dipanggil
  dengan banyak `-d` sekaligus, `--cert-name` + `--expand` biar lineage cert
  konsisten & bisa di-expand ulang pas alias baru ditambah.
- `src/nginx/nginx.js`: `createReverseProxySite()`/`upgradeToSSL()` terima
  `aliases`, digabung ke satu baris `server_name`.
- `src/api/routes/domains.routes.js`: endpoint baru
  `POST /domains/:domain/aliases` dan `DELETE /domains/:domain/aliases/:alias`
  buat nambah/lepas alias (auto regenerate nginx config). `buildDomainStatus()`
  & `GET /domains` sekarang pecah `server_name` multi-nama jadi entri per-nama,
  dan nunjukkin `isAlias`/`aliasOf`/`aliases` per domain.
- `src/api/routes/ssl.routes.js` & `src/api/jobs/sslWorker.js`: issue SSL
  sekarang selalu resolve ke domain UTAMA project + semua alias-nya (satu
  cert SAN), gak peduli domain mana yang diketik user (apex atau alias).
- `src/api/commandPolicy.js`: action baru `domains.addAlias`,
  `domains.removeAlias`, plus 5 action `node.*` (lihat bawah).

### Added - Node Version Manager (nvm)
- Module baru `src/node/node.js`: install/list/uninstall versi Node lewat
  `nvm`, per `deploy_user` (auto-install nvm dulu kalau user itu belum
  punya). `resolveBinDir()` buat cari folder `bin` versi tertentu.
- Route baru `src/api/routes/node.routes.js`, didaftarkan di `server.js`
  sebagai `/node`: `GET /node/versions`, `POST /node/versions/install`,
  `DELETE /node/versions/:version`, `POST /node/versions/default`,
  `POST /node/project/:name` (pin versi Node KHUSUS satu project, override
  default).
- `src/pm2/pm2.js`: `start()` sekarang baca `project.node_version` (kalau
  di-pin) dan nge-override `PATH` ke folder bin versi itu sebelum
  `pm2 start npm ...`, biar `npm run start` beneran jalan pakai Node versi
  yang dipin - bukan cuma `--interpreter` pm2 yang cuma ngatur binary `node`
  doang.

### Notes
- Alias yang dilepas TIDAK otomatis nge-shrink sertifikat SSL yang sudah
  terbit (certbot `--expand` cuma nambah SAN, bukan ngurangin) - efeknya
  cuma alias-nya berhenti dilayani nginx, sertifikatnya "nganggur" sampai
  renew/reissue berikutnya. Bukan masalah keamanan.
- `node.uninstall` WAJIB `{ confirm: true }` di body - destruktif, app yang
  masih pin ke versi itu bisa gagal start ulang.

## Fase 3 - Auto-clean Job History + Node Projects Endpoint (2026-08-17)

### Added
- **Auto-clean job history**: `src/api/jobs/jobStore.js` sekarang otomatis
  buang job lama tiap ada job baru masuk (`createJob()`) + pas API start
  (`reconcileInterruptedJobs()`). Dua aturan retensi: job final (bukan
  pending/running) lebih tua dari 14 hari dibuang, dan kalau jumlah job final
  masih >50 biji, yang paling lama dibuang duluan sampai pas 50. Job yang
  masih pending/running gak pernah kebuang otomatis.
- `deleteJob(id)` + `clearFinishedJobs()` di jobStore, plus endpoint baru:
  `DELETE /jobs/:id` (hapus 1 job, ditolak kalau masih jalan) dan
  `DELETE /jobs` (bersihkan semua job final sekaligus, butuh `confirm:true`).
- `GET /node/projects` (node.routes.js) - daftar project registry + versi
  Node yang lagi di-pin per project, buat konsumsi layar Node Manager di app
  (sebelumnya app cuma bisa lihat daftar PM2 apps, gak ada info pin per
  project langsung dari registry).
- `commandPolicy.js`: action baru `jobs.delete`, `jobs.clear`.
