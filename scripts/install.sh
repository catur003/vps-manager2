#!/usr/bin/env bash
#
# install.sh - installer resmi vps-manager, one-shot dari SSH.
#
# CUMA ngurus level OS: package sistem, deploy user, clone repo,
# npm install/link, sudoers. Sisanya (database, PM2, nginx, SSL, API key)
# diserahin ke bin/vps-bootstrap.js - JANGAN reimplement logic itu di sini,
# supaya gak ada 2 sumber kebenaran yang bisa divergen (lihat komentar
# panjang di bin/vps-bootstrap.js soal kenapa).
#
# PAKAI:
#   sudo bash scripts/install.sh
#
# Bisa non-interaktif penuh lewat env var (misal buat automation/testing):
#   sudo INSTALL_DOMAIN=api.zenlab.id INSTALL_DEPLOY_USER=catur \
#     INSTALL_REPO_URL=https://github.com/catur003/vps-manager2.git \
#     bash scripts/install.sh
#
# Aman dijalankan berkali-kali (idempotent) - tiap step ngecek dulu apa
# udah beres sebelum ngerjain ulang.

set -euo pipefail

# --- 0. Wajib root ---
if [ "$(id -u)" -ne 0 ]; then
  echo "Script ini wajib dijalankan sebagai root/sudo: sudo bash scripts/install.sh" >&2
  exit 1
fi

echo "=================================================="
echo " vps-manager - Installer"
echo "=================================================="
echo

# --- 1. Input (interaktif kalau env var belum diisi) ---
DEPLOY_USER="${INSTALL_DEPLOY_USER:-}"
if [ -z "$DEPLOY_USER" ]; then
  read -rp "Nama deploy user (dibuat kalau belum ada) [catur]: " DEPLOY_USER
  DEPLOY_USER="${DEPLOY_USER:-catur}"
fi

DOMAIN="${INSTALL_DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  read -rp "Domain buat vps-manager-api ini (mis. api.zenlab.id, HARUS sudah diarahkan A record ke VPS ini): " DOMAIN
fi
if [ -z "$DOMAIN" ]; then
  echo "Domain wajib diisi." >&2
  exit 1
fi

REPO_URL="${INSTALL_REPO_URL:-https://github.com/catur003/vps-manager2.git}"
REPO_DIRNAME="vps-manager2"

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
  nginx certbot \
  default-mysql-client \
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
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
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
REPO_PATH="$DEPLOY_HOME/$REPO_DIRNAME"

# --- 7. Clone / pull repo ---
echo "--- Clone/update repo ke $REPO_PATH ---"
if [ -d "$REPO_PATH/.git" ]; then
  sudo -u "$DEPLOY_USER" git -C "$REPO_PATH" pull --ff-only
else
  sudo -u "$DEPLOY_USER" git clone "$REPO_URL" "$REPO_PATH"
fi

# --- 8. npm install ---
echo "--- npm install ---"
sudo -u "$DEPLOY_USER" bash -c "cd '$REPO_PATH' && npm install"

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

# --- 11. Serah terima ke bootstrap Node - database, API key, PM2, registry, nginx, SSL ---
echo
echo "--- Lanjut provisioning (database, PM2, nginx, SSL) ---"
sudo -u "$DEPLOY_USER" env \
  BOOTSTRAP_DOMAIN="$DOMAIN" \
  BOOTSTRAP_DEPLOY_USER="$DEPLOY_USER" \
  BOOTSTRAP_REPO_PATH="$REPO_PATH" \
  node "$REPO_PATH/bin/vps-bootstrap.js"

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
echo " Kalau API key ditampilkan di atas, SIMPAN SEKARANG."
echo "=================================================="
