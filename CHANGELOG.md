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

## Fix Node Uninstall + Landing Page (2026-08-17)

### Fixed
- `src/node/node.js` `uninstallVersion()`: "hapus versi Node gak ilang dari
  list" - `nvm uninstall` nolak hapus versi yang lagi dianggap "aktif" di
  sesi shell itu (versi default OTOMATIS jadi "aktif" tiap sesi bash baru,
  yang emang selalu terjadi karena tiap command dijalanin lewat sesi baru).
  Fix: `nvm deactivate` dulu sebelum `nvm uninstall`.

### Added
- `public/index.html` + route `GET /` (publik, tanpa API key) di
  `src/api/server.js` - sebelumnya buka domain API langsung
  (`https://api.zenin.my.id/`) nunjukin JSON mentah (404 handler default),
  sekarang landing page HTML kecil (status online, endpoint health check).

## Fix PM2 Registry Visibility + Node Uninstall Verification (2026-08-17)

### Fixed
- `src/pm2/pm2.js` `getRelevantUsers()`: "vps-manager-api gak masuk daftar
  App yang jalan" - user yang dicek `pm2 jlist` CUMA diambil dari project
  yang terdaftar di registry, `vps-manager-api` sendiri bukan "project"
  (gak pernah lewat `addProject()`). `config.deploy_user` sekarang SELALU
  masuk daftar yang dicek (union, bukan cuma fallback pas registry kosong).
- `src/node/node.js` `uninstallVersion()`: dugaan kemarin ("nvm nolak hapus
  versi aktif") TERBUKTI GUGUR - versi non-default/non-aktif (`v4.9.1`) juga
  gak ke-hapus. Sekarang di-VERIFIKASI BENERAN (re-cek `nvm ls` abis
  uninstall, bukan percaya exit code doang) - kalau versi MASIH ada, balikin
  `ok:false` + output MENTAH `nvm uninstall` di pesan error, biar kebaca
  akar masalah sebenernya (bukan nebak lagi).

## Wildcard SSL via Cloudflare DNS-01 (2026-08-17)

### Added
- `config.js`: field baru `cloudflare_credentials_path` (default `null`,
  SENGAJA gak masuk `EDITABLE_FIELDS` - cuma bisa diisi lewat endpoint
  khusus, bukan `PUT /config` bebas).
- `ssl.js`: `issueCertificate(domain, aliases, { wildcard })` - kalau
  `wildcard: true`, JALUR TOTAL BEDA dari sebelumnya: certbot pakai plugin
  `--dns-cloudflare` (DNS-01 challenge, satu-satunya cara ACME bisa
  nerbitin `*.domain` - webroot/HTTP-01 gak bisa sama sekali, batasan
  protokol). `aliases` diabaikan kalau wildcard true (`*.domain` udah nyakup
  semuanya). Fungsi baru `setupCloudflareCredentials(apiToken)` - install
  plugin `python3-certbot-dns-cloudflare` + tulis
  `/etc/letsencrypt/cloudflare.ini` (chmod 600, setara ketat config.json).
- `nginx.js` `upgradeToSSL()`: parameter baru `wildcard` - nambahin
  `*.domain` ke `server_name` biar nginx BENERAN ngelayanin semua subdomain
  yang udah dicover sertifikatnya.
- Endpoint baru: `POST /ssl/cloudflare-setup { apiToken }` (setup sekali per
  server), `GET /ssl/cloudflare-status` (cek udah di-setup apa belum), dan
  `POST /ssl/issue` sekarang terima `wildcard: boolean` di body.
- `commandPolicy.js`: action baru `ssl.cloudflareSetup`.

### Fixed
- `pm2.js` `getRelevantUsers()`: "vps-manager-api gak masuk daftar App yang
  jalan" - `config.deploy_user` sekarang SELALU masuk daftar user yang
  dicek `pm2 jlist`, bukan cuma fallback pas registry kosong.
- `node.js` `uninstallVersion()`: sekarang di-VERIFIKASI BENERAN (re-cek
  `nvm ls` abis uninstall) - dugaan sebelumnya ("nolak hapus versi aktif")
  gugur, `v4.9.1` (bukan default/aktif) juga gak ke-hapus, jadi errornya
  sekarang nunjukin output MENTAH `nvm uninstall` buat diagnosa lanjut.

## Fix Node Uninstall "N/A" (2026-08-17)

### Fixed
- `node.js` `uninstallVersion()`: pesan asli akhirnya kebaca ("N/A: version
  is not installed") - `nvm deactivate` yang ditambah sebelumnya (teori
  udah kebukti salah) DICABUT, dicurigai itu yang ngerusak state resolve
  versi nvm di command chain yang sama.

## Fix Total: Node Manager Nampilin Versi Hantu (2026-08-17)

### Fixed
- `node.js` `listInstalled()`: rombak total, akar masalah beneran ketemu
  (dikonfirmasi manual lewat `ls -la ~/.nvm/versions/node/` di VPS - folder
  KOSONG, sementara `nvm ls` nampilin 11 baris versi). Parsing lama cuma
  regex angka versi dari teks `nvm ls`, TANPA cek marker `(-> N/A)` yang
  nvm SENDIRI pakai buat nandain "alias ini nunjuk ke versi yang GAK
  BENERAN keinstall" - semua alias LTS bawaan (`lts/argon`, `lts/boron`,
  dst, SELALU ADA di nvm siapapun) ke-parse sebagai "terinstall" padahal
  cuma file kecil 7-12 byte di `~/.nvm/alias/lts/`, bukan folder instalasi.
  Sekarang `versions` GROUND TRUTH dari `ls $NVM_DIR/versions/node/`
  langsung (satu-satunya sumber yang gak bisa "bohong"), `nvm ls` cuma
  dipakai cari default/current dan di-cross-check ke ground truth itu.
