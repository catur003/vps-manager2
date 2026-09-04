#!/usr/bin/env bash
#
# install.sh - installer resmi vps-manager, one-shot dari SSH.
#
# Ngurus seluruh instalasi: package sistem, deploy user, folder /opt,
# npm, sudoers, database, PM2, nginx/SSL, dan setup administrator.
# diserahin ke bin/vps-bootstrap.js - JANGAN reimplement logic itu di sini,
# supaya gak ada 2 sumber kebenaran yang bisa divergen (lihat komentar
# panjang di bin/vps-bootstrap.js soal kenapa).
#
# PAKAI:
#   git clone https://github.com/catur003/vps-manager2.git
#   cd vps-manager2
#   sudo bash setup-otomatis.sh
#
# Bisa non-interaktif penuh lewat env var (misal buat automation/testing):
#   sudo INSTALL_PUBLIC_HOST=203.0.113.10 INSTALL_DEPLOY_USER=catur \
#     bash scripts/install.sh
#   sudo INSTALL_DOMAIN=api.zenlab.id INSTALL_DEPLOY_USER=catur \
#     INSTALL_REPO_URL=https://github.com/catur003/vps-manager2.git \
#     bash scripts/install.sh
#
# Aman dijalankan berkali-kali (idempotent) - tiap step ngecek dulu apa
# udah beres sebelum ngerjain ulang.

set -euo pipefail

# --- 0. Wajib root ---
if [ "$(id -u)" -ne 0 ]; then
  echo "Script ini wajib dijalankan sebagai root/sudo: sudo bash setup-otomatis.sh" >&2
  exit 1
fi

echo "=================================================="
echo " vps-manager - Installer"
echo "=================================================="
echo

# --- 1. Input (interaktif kalau env var belum diisi) ---
DEFAULT_DEPLOY_USER=""
if [ -n "${INSTALL_SOURCE_REPO:-}" ] && [ -e "${INSTALL_SOURCE_REPO}" ]; then
  REPO_OWNER="$(stat -c '%U' "${INSTALL_SOURCE_REPO}" 2>/dev/null || true)"
  if [ -n "$REPO_OWNER" ] && [ "$REPO_OWNER" != "root" ]; then
    DEFAULT_DEPLOY_USER="$REPO_OWNER"
  fi
fi
DEFAULT_DEPLOY_USER="${DEFAULT_DEPLOY_USER:-${SUDO_USER:-}}"
if [ -z "$DEFAULT_DEPLOY_USER" ] || [ "$DEFAULT_DEPLOY_USER" = "root" ]; then
  if id ubuntu >/dev/null 2>&1; then
    DEFAULT_DEPLOY_USER="ubuntu"
  else
    DEFAULT_DEPLOY_USER="vpsmanager"
  fi
fi

DEPLOY_USER="${INSTALL_DEPLOY_USER:-}"
if [ -z "$DEPLOY_USER" ]; then
  read -rp "Nama deploy user (dibuat kalau belum ada) [$DEFAULT_DEPLOY_USER]: " DEPLOY_USER
  DEPLOY_USER="${DEPLOY_USER:-$DEFAULT_DEPLOY_USER}"
fi
if ! [[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "Nama deploy user tidak valid: $DEPLOY_USER" >&2
  exit 1
fi

DOMAIN="${INSTALL_DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -t 0 ]; then
  read -rp "Domain panel (kosongkan untuk akses langsung IP:4001): " DOMAIN
fi

DIRECT_ACCESS=0
PUBLIC_HOST="${INSTALL_PUBLIC_HOST:-}"
PUBLIC_PORT="${INSTALL_PUBLIC_PORT:-4001}"
INTERNAL_PORT="${INSTALL_INTERNAL_PORT:-4001}"
if [ -z "$DOMAIN" ]; then
  DIRECT_ACCESS=1
  INTERNAL_PORT="${INSTALL_INTERNAL_PORT:-4002}"
  if [ -z "$PUBLIC_HOST" ]; then
    if command -v curl >/dev/null 2>&1; then
      PUBLIC_HOST="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
    fi
  fi
  if [ -z "$PUBLIC_HOST" ] && [ -t 0 ]; then
    read -rp "IP publik VPS: " PUBLIC_HOST
  fi
  if ! [[ "$PUBLIC_HOST" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[A-Za-z0-9.-]+$ ]]; then
    echo "IP/hostname publik tidak valid. Isi INSTALL_PUBLIC_HOST lalu jalankan ulang." >&2
    exit 1
  fi
fi

REPO_URL="${INSTALL_REPO_URL:-https://github.com/catur003/vps-manager2.git}"
REPO_DIRNAME="vps-manager2"
SOURCE_REPO="${INSTALL_SOURCE_REPO:-}"
APPS_DIR="${INSTALL_APPS_DIR:-/opt/apps}"
DOCKER_DIR="${INSTALL_DOCKER_DIR:-/opt/docker}"
CERTBOT_DIR="${INSTALL_CERTBOT_DIR:-/opt/certbot}"

for required_path in "$APPS_DIR" "$DOCKER_DIR" "$CERTBOT_DIR"; do
  if [[ "$required_path" != /* ]]; then
    echo "Path instalasi wajib absolut: $required_path" >&2
    exit 1
  fi
done

# --- 2. Deteksi OS (dukungan resmi: Ubuntu 22.04/24.04) ---
if [ -f /etc/os-release ]; then
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ]; then
    echo "PERINGATAN: script ini ditest di Ubuntu. Terdeteksi \"${PRETTY_NAME:-unknown}\" - lanjut dengan risiko sendiri."
  fi
fi

# --- 3. Install package sistem yang dibutuhin ---
echo "--- Install package sistem ---"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  git curl ca-certificates gnupg \
  openssl \
  nginx certbot \
  mariadb-server default-mysql-client \
  fail2ban \
  ufw \
  build-essential

# Node.js - kalau belum ada atau versi terlalu lama (<16), install via NodeSource
NEED_NODE_INSTALL=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 16 ]; then
    NEED_NODE_INSTALL=0
  fi
fi
if [ "$NEED_NODE_INSTALL" -eq 1 ]; then
  echo "--- Install Node.js (NodeSource, LTS) ---"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
else
  echo "Node.js sudah terpasang ($(node -v)) - dilewatin."
fi

# --- 4. Firewall dasar - buka port yang WAJIB (SSH, HTTP, HTTPS) ---
# FIXED: pelajaran dari kejadian nyata - banyak provider cloud (Oracle Cloud
# Always Free contohnya) TIDAK ship ufw aktif atau malah punya iptables raw
# yang default-nya nutup semua kecuali SSH. Kalau ini dilewatin, certbot
# selalu gagal validasi HTTP-01 dan operator harus debug manual dari nol
# (persis yang kejadian). `ufw allow` idempotent - aman dipanggil berkali².
echo "--- Setup firewall dasar (ufw) ---"
ufw allow 22/tcp >/dev/null 2>&1 || true
if [ "$DIRECT_ACCESS" -eq 1 ]; then
  ufw allow "$PUBLIC_PORT/tcp" >/dev/null 2>&1 || true
else
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi
if ! ufw status | grep -q "Status: active"; then
  ufw --force enable
fi

# --- 5. PM2 global (kalau belum ada) ---
if ! command -v pm2 >/dev/null 2>&1; then
  echo "--- Install PM2 global ---"
  npm install -g pm2
fi

# --- 6. Deploy user (idempotent - `useradd -m`, TANPA passwd) ---
echo "--- Setup deploy user \"$DEPLOY_USER\" ---"
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "User \"$DEPLOY_USER\" sudah ada - dilewatin."
else
  useradd -m -s /bin/bash "$DEPLOY_USER"
  echo "User \"$DEPLOY_USER\" dibuat (tanpa password - akses cuma lewat sudo -u/root, sesuai desain)."
fi
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"

echo "--- Setup folder kerja ---"
install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APPS_DIR" "$DOCKER_DIR"
install -d -m 0755 "$CERTBOT_DIR/.well-known/acme-challenge"

# Fresh Ubuntu memakai Nginx paket distro. Kalau aaPanel benar-benar ada,
# pertahankan path aaPanel agar installer juga aman buat server existing.
if [ -x /www/server/nginx/sbin/nginx ] && [ -d /www/server/panel/vhost/nginx ]; then
  NGINX_BINARY="${INSTALL_NGINX_BINARY:-/www/server/nginx/sbin/nginx}"
  NGINX_CONF_DIR="${INSTALL_NGINX_CONF_DIR:-/www/server/panel/vhost/nginx}"
  NGINX_LOG_DIR="${INSTALL_NGINX_LOG_DIR:-/www/wwwlogs}"
  echo "Nginx aaPanel terdeteksi."
else
  NGINX_BINARY="${INSTALL_NGINX_BINARY:-/usr/sbin/nginx}"
  NGINX_CONF_DIR="${INSTALL_NGINX_CONF_DIR:-/etc/nginx/sites-available}"
  NGINX_LOG_DIR="${INSTALL_NGINX_LOG_DIR:-/var/log/nginx}"
  echo "Nginx Ubuntu standar terdeteksi."
fi

# --- 7. Gunakan clone tempat setup-otomatis.sh dijalankan ---
if [ -n "$SOURCE_REPO" ]; then
  REPO_PATH="$(cd "$SOURCE_REPO" && pwd)"
  if [ ! -d "$REPO_PATH/.git" ] || [ ! -f "$REPO_PATH/package.json" ]; then
    echo "Folder sumber bukan clone vps-manager2 yang valid: $REPO_PATH" >&2
    exit 1
  fi
  echo "--- Pakai repository hasil clone: $REPO_PATH ---"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$REPO_PATH"
  if ! sudo -u "$DEPLOY_USER" test -x "$(dirname "$REPO_PATH")"; then
    echo "Deploy user tidak bisa mengakses parent folder repository: $(dirname "$REPO_PATH")" >&2
    echo "Clone repository dari home user biasa, jangan di bawah /root." >&2
    exit 1
  fi
else
  REPO_PATH="$DEPLOY_HOME/$REPO_DIRNAME"
  echo "--- Clone/update repo ke $REPO_PATH ---"
  if [ -d "$REPO_PATH/.git" ]; then
    sudo -u "$DEPLOY_USER" git -C "$REPO_PATH" pull --ff-only
  else
    sudo -u "$DEPLOY_USER" git clone "$REPO_URL" "$REPO_PATH"
  fi
fi

# --- 8. npm install ---
echo "--- npm install ---"
sudo -u "$DEPLOY_USER" bash -c "cd '$REPO_PATH' && npm install"

# Database disiapkan saat installer masih root. Bootstrap/API setelah ini
# berjalan sebagai deploy user dan tidak perlu sudo mysql/systemctl yang luas.
echo "--- Setup MariaDB dan konfigurasi awal ---"
if [ -f "$REPO_PATH/data/config.json" ]; then
  PRESERVE_PLATFORM_CONFIG=1
else
  PRESERVE_PLATFORM_CONFIG=0
fi
BOOTSTRAP_DEPLOY_USER="$DEPLOY_USER" \
BOOTSTRAP_APPS_DIR="$APPS_DIR" \
BOOTSTRAP_DOCKER_DIR="$DOCKER_DIR" \
BOOTSTRAP_CERTBOT_DIR="$CERTBOT_DIR" \
BOOTSTRAP_NGINX_BINARY="$NGINX_BINARY" \
BOOTSTRAP_NGINX_CONF_DIR="$NGINX_CONF_DIR" \
BOOTSTRAP_NGINX_LOG_DIR="$NGINX_LOG_DIR" \
BOOTSTRAP_PRESERVE_PLATFORM_CONFIG="$PRESERVE_PLATFORM_CONFIG" \
node "$REPO_PATH/bin/vps-database-bootstrap.js"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$REPO_PATH"

# --- 9. npm link (biar command 'vps-manager' bisa dipanggil global) ---
# FIXED: `sudo -u <user> npm link` dari direktori yang gak bisa diakses
# user itu (mis. dijalanin dari /root atau /home/user-lain) bisa gagal
# EACCES pas Node coba chdir ke situ SEBELUM exec - selalu jalanin dari
# DALAM repo path yang jelas-jelas sudah dimiliki deploy_user.
echo "--- npm link (global CLI) ---"
sudo -u "$DEPLOY_USER" bash -c "cd '$REPO_PATH' && npm link" || \
  echo "PERINGATAN: npm link gagal - command 'vps-manager' mungkin gak kepasang global, tapi service tetap bisa jalan normal lewat PM2. Bisa dicoba manual belakangan: cd $REPO_PATH && sudo npm link"

# --- 10. Sudoers scoped (WAJIB, bukan opsional) ---
echo "--- Setup sudoers scoped ---"
API_USER="$DEPLOY_USER" DEPLOY_USER="$DEPLOY_USER" bash "$REPO_PATH/scripts/setup-sudoers.sh"

# Direct-IP memakai HTTPS self-signed di port publik. Private key hanya
# dapat dibaca deploy user yang menjalankan API.
TLS_KEY=""
TLS_CERT=""
if [ "$DIRECT_ACCESS" -eq 1 ]; then
  TLS_DIR="$REPO_PATH/data/tls"
  TLS_KEY="$TLS_DIR/direct-access.key"
  TLS_CERT="$TLS_DIR/direct-access.crt"
  mkdir -p "$TLS_DIR"
  if [ ! -s "$TLS_KEY" ] || [ ! -s "$TLS_CERT" ]; then
    if [[ "$PUBLIC_HOST" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      TLS_SAN="IP:$PUBLIC_HOST"
    else
      TLS_SAN="DNS:$PUBLIC_HOST"
    fi
    openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 825 \
      -keyout "$TLS_KEY" -out "$TLS_CERT" \
      -subj "/CN=$PUBLIC_HOST" -addext "subjectAltName=$TLS_SAN"
    chown -R "$DEPLOY_USER:$DEPLOY_USER" "$TLS_DIR"
    chmod 700 "$TLS_DIR"
    chmod 600 "$TLS_KEY"
    chmod 644 "$TLS_CERT"
  fi
  echo
  echo "--- Direct HTTPS ---"
  echo "URL setup : https://$PUBLIC_HOST:$PUBLIC_PORT/setup.html"
  echo "Fingerprint sertifikat:"
  openssl x509 -in "$TLS_CERT" -noout -fingerprint -sha256
  echo
  echo "UFW server sudah membuka TCP $PUBLIC_PORT."
  echo "Firewall PROVIDER tetap harus dibuka manual:"
  echo "  Oracle Cloud: Security List / NSG"
  echo "  AWS: Security Group | GCP: VPC Firewall | provider lain: Cloud Firewall"
  echo "  Rule: inbound TCP $PUBLIC_PORT, sebaiknya source IP perangkatmu/32."
fi

# --- 11. Serah terima ke bootstrap Node ---
echo
echo "--- Lanjut provisioning (database, auth, PM2, nginx/SSL bila ada domain) ---"
sudo -u "$DEPLOY_USER" env \
  BOOTSTRAP_DOMAIN="$DOMAIN" \
  BOOTSTRAP_DIRECT_HTTPS="$DIRECT_ACCESS" \
  BOOTSTRAP_PUBLIC_HOST="$PUBLIC_HOST" \
  BOOTSTRAP_PUBLIC_PORT="$PUBLIC_PORT" \
  BOOTSTRAP_PORT="$INTERNAL_PORT" \
  BOOTSTRAP_TLS_KEY="$TLS_KEY" \
  BOOTSTRAP_TLS_CERT="$TLS_CERT" \
  BOOTSTRAP_DEPLOY_USER="$DEPLOY_USER" \
  BOOTSTRAP_REPO_PATH="$REPO_PATH" \
  BOOTSTRAP_APPS_DIR="$APPS_DIR" \
  BOOTSTRAP_DOCKER_DIR="$DOCKER_DIR" \
  BOOTSTRAP_CERTBOT_DIR="$CERTBOT_DIR" \
  BOOTSTRAP_NGINX_BINARY="$NGINX_BINARY" \
  BOOTSTRAP_NGINX_CONF_DIR="$NGINX_CONF_DIR" \
  BOOTSTRAP_NGINX_LOG_DIR="$NGINX_LOG_DIR" \
  BOOTSTRAP_PRESERVE_PLATFORM_CONFIG="$PRESERVE_PLATFORM_CONFIG" \
  BOOTSTRAP_DEFER_PM2_STARTUP=1 \
  node "$REPO_PATH/bin/vps-bootstrap.js"

# Registrasi systemd memang membutuhkan root. Dikerjakan di sini, bukan
# meminta deploy user mengeksekusi command sudo dinamis dari output PM2.
echo
echo "--- Aktifkan PM2 saat boot ---"
env PATH="$PATH" pm2 startup systemd -u "$DEPLOY_USER" --hp "$DEPLOY_HOME" >/dev/null
sudo -u "$DEPLOY_USER" env HOME="$DEPLOY_HOME" PATH="$PATH" pm2 save >/dev/null

# --- 12. Self-heal ownership final ---
# FIXED: jaring pengaman terakhir, dijalankan SEBAGAI ROOT (cakupan paling
# luas, gak kebatas sudoers scope kayak dari dalam vps-bootstrap.js). Kalau
# ADA aja step di atas yang gak sengaja nyisain file/folder kepemilikan
# root di dalam $REPO_PATH (termasuk data/config.json yang PALING SERING
# jadi korban - proses PM2 yang jalan sebagai $DEPLOY_USER bakal EACCES
# pas baca file itu kalau kepemilikannya salah), ini benerin sekali lagi
# di titik paling akhir sebelum instalasi dianggap kelar.
echo
echo "--- Self-heal ownership final ---"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$REPO_PATH"

echo
echo "=================================================="
echo " Instalasi selesai."
echo " Kalau ini instalasi pertama, simpan setup token dan buka URL yang ditampilkan di atas."
echo "=================================================="
