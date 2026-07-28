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
