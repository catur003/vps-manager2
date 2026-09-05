# Setup VPS Manager

Panduan ini untuk fresh install di Ubuntu 22.04/24.04. Setelah repository
di-clone, seluruh provisioning dijalankan oleh satu script.

Referensi endpoint REST tersedia di [docs/API.md](docs/API.md).

## 1. Sebelum mulai

Yang dibutuhkan:

- VPS Ubuntu dengan akses SSH dan `sudo`.
- `git` untuk clone repository.
- Jika memakai domain, DNS A record sebaiknya sudah mengarah ke IP VPS.
- Clone dari home user SSH biasa, jangan dari `/root`.

Perlu diketahui bahwa installer akan memasang paket sistem, mengaktifkan UFW,
menulis rule sudoers scoped, serta membuat service PM2. MariaDB hanya dipasang
jika belum ada engine database. MySQL/MariaDB existing dipertahankan dan wajib
memakai kredensial admin TCP yang sudah ada.

## 2. Instalasi otomatis

Jalankan:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/catur003/vps-manager2.git
cd vps-manager2
sudo bash setup-otomatis.sh
```

Setelah clone, cukup jalankan `setup-otomatis.sh`. Tidak perlu menjalankan
`npm install`, setup sudoers, setup database, atau PM2 satu per satu.

Installer menanyakan:

1. Deploy user. Default-nya user SSH yang menjalankan `sudo`.
2. Domain panel. Kosongkan untuk akses langsung melalui
   `https://IP_VPS:4001`.
3. User/password admin database jika MySQL/MariaDB existing belum punya
   kredensial valid di konfigurasi panel. Password dibaca tanpa echo.

Script idempotent: kalau koneksi terminal terputus atau suatu langkah gagal,
masuk lagi ke folder repository lalu jalankan perintah yang sama.

### Mode non-interaktif

Direct IP:

```bash
sudo INSTALL_DEPLOY_USER=ubuntu \
  INSTALL_PUBLIC_HOST=203.0.113.10 \
  bash setup-otomatis.sh
```

Domain:

```bash
sudo INSTALL_DEPLOY_USER=ubuntu \
  INSTALL_DOMAIN=panel.example.com \
  bash setup-otomatis.sh
```

## 3. Yang dikerjakan installer

Installer otomatis:

1. Memasang Node.js LTS, PM2, Nginx, Certbot, UFW, Fail2ban, dan build tools.
   MariaDB hanya ditambahkan pada server yang belum memiliki engine database.
2. Membuat deploy user bila belum ada. User baru dibuat tanpa password login.
3. Membuat folder:
   - `/opt/apps` untuk project biasa.
   - `/opt/docker` untuk stack Compose dan persistent data aplikasi.
   - `/opt/certbot` untuk ACME webroot.
4. Mendeteksi Nginx Ubuntu standar atau instalasi aaPanel yang sudah ada.
5. Memasang dependency Node dan mencoba memasang command global
   `vps-manager`.
6. Menulis rule sudoers scoped yang dibutuhkan panel.
7. Memakai MySQL/MariaDB existing tanpa mengubah akun atau database. Pada
   fresh MariaDB, installer membuat akun lokal `vpsmanager_admin@127.0.0.1`
   dengan recovery state; autentikasi root tidak diubah. Kredensial panel
   disimpan dalam `data/config.json` dengan permission `600`.
8. Membuat setup token administrator yang berlaku 24 jam dan sekali pakai.
9. Menjalankan API dengan PM2 dan mendaftarkannya agar aktif lagi setelah
   reboot.
10. Membuka UFW:
    - SSH: TCP 22.
    - Direct IP: TCP 4001.
    - Domain: TCP 80 dan 443.
11. Membuat sertifikat self-signed untuk direct IP, atau mencoba menerbitkan
    Let's Encrypt untuk domain.

UFW hanya firewall di dalam VPS. Firewall milik provider tetap harus dibuka
manual melalui panel provider:

- Oracle Cloud: Security List atau NSG.
- AWS: Security Group.
- GCP: VPC Firewall.
- Provider lain: Cloud Firewall atau Network Firewall.

Untuk direct IP, buka inbound TCP 4001. Sebaiknya batasi source ke IP perangkat
operator (`IP/32`). Jangan membuka port internal 4002.

## 4. Login pertama

Di akhir instalasi, terminal menampilkan setup token dan URL seperti:

```text
Setup URL : https://IP_VPS:4001/setup.html
Setup token: ...
```

Untuk mode direct IP, browser akan memperingatkan bahwa sertifikat self-signed.
Cocokkan fingerprint SHA-256 di browser dengan fingerprint yang ditampilkan
installer sebelum melanjutkan.

Setup token:

- Berlaku 24 jam.
- Hanya dapat digunakan sekali.
- Hanya ada satu token aktif.
- Membuat token baru langsung membatalkan token sebelumnya.
- Setelah administrator berhasil dibuat, endpoint setup tidak dapat digunakan
  untuk membuat admin kedua.

Jika token hilang, kedaluwarsa, atau terminal tertutup:

```bash
cd /path/ke/vps-manager2
node bin/vps-manager.js setup-token regenerate
```

Perintah ini tidak bergantung pada keberhasilan `npm link`. Cek status dengan:

```bash
node bin/vps-manager.js setup-status
```

## 5. API key

Dashboard memakai username/password dan session cookie. API key hanya untuk
mobile app, bot, atau script otomatis.

Setelah login:

1. Buka menu **API Keys**.
2. Pilih **Create API Key**.
3. Isi nama yang menjelaskan pemakaiannya.
4. Salin atau reveal key dari menu tersebut.
5. Cabut key tertentu jika perangkat/integrasi tidak lagi digunakan.

Format CLI `vps-api-keygen.js` adalah legacy dan tidak digunakan untuk
instalasi baru. API key lama yang pernah terekspos harus di-rotate.

Contoh request:

```bash
curl https://panel.example.com/monitor \
  -H "Authorization: Bearer <API_KEY>"
```

## 6. Default konfigurasi

Konfigurasi tersimpan di `data/config.json`:

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
  "nginx_log_dir": "/var/log/nginx",
  "certbot_webroot": "/opt/certbot",
  "certbot_email": "",
  "db_root_user": "root",
  "db_root_password": "(kredensial admin database)",
  "backup_dir": "/www/backup_manager",
  "backup_retention_days": 7
}
```

`deploy_user` akan mengikuti pilihan saat instalasi. Jika aaPanel terdeteksi,
installer mengganti konfigurasi Nginx ke path aaPanel yang benar secara
otomatis.

Folder `/opt/docker` hanya menyimpan file project seperti
`docker-compose.yml`, `.env`, dan persistent application data. Storage
internal Docker tetap di `/var/lib/docker`, sedangkan containerd tetap di
`/var/lib/containerd`.

## 7. Pemeriksaan setelah instalasi

```bash
pm2 status
pm2 logs vps-manager-api
curl http://127.0.0.1:4001/health
```

Pada mode direct IP, API internal memakai port 4002:

```bash
curl http://127.0.0.1:4002/health
```

Untuk melihat service PM2 saat boot, ganti `USER_DEPLOY` dengan deploy user:

```bash
systemctl status pm2-USER_DEPLOY
```

## 8. Update dan jalankan ulang

```bash
cd /path/ke/vps-manager2
git pull --ff-only
sudo bash setup-otomatis.sh
```

Administrator yang sudah ada tidak dibuat ulang dan installer tidak
menampilkan setup token baru. Database yang kredensialnya masih valid juga
tidak di-reset.

## 9. Troubleshooting

| Gejala | Penyebab umum | Tindakan |
|---|---|---|
| Setup token hilang/kedaluwarsa | Token hanya tampil saat dibuat atau sudah lewat 24 jam | Jalankan `node bin/vps-manager.js setup-token regenerate` |
| IP:4001 tidak dapat dibuka | Firewall provider belum membuka port | Tambahkan inbound TCP 4001 di panel provider |
| Lupa password admin | Password tidak dapat dilihat kembali | Jalankan `node bin/vps-manager.js admin reset-password` |
| Domain hanya HTTP | DNS belum benar atau Certbot gagal | Perbaiki DNS, lalu terbitkan SSL dari menu SSL Manager |
| PM2 tidak aktif setelah reboot | Service `pm2-USER_DEPLOY` gagal didaftarkan | Cek `systemctl status pm2-USER_DEPLOY` |
| Nginx Manager gagal | Path Nginx tidak cocok dengan instalasi aktif | Periksa Configuration dan jalankan `sudo nginx -t` |
| Banyak fitur gagal permission | Rule sudoers tidak lengkap/terhapus | Jalankan ulang `sudo bash setup-otomatis.sh` |
