
#!/usr/bin/env bash
#
# setup-sudoers.sh
#
# Setup sudoers SEKALI untuk VPS baru, biar vps-manager (CLI/API) bisa
# jalanin command sebagai deploy_user (git, npm, rm cache, dll) dan sebagai
# root (nginx reload, certbot) tanpa password - tapi TETAP scoped ke command
# yang benar-benar dibutuhkan, BUKAN blanket "ALL=(ALL) NOPASSWD: ALL".
#
# Aman dijalankan berkali-kali (idempotent) - kalau file target sudah ada
# dan isinya sama, tidak ditulis ulang.
#
# Pakai:
#   sudo bash scripts/setup-sudoers.sh
#
# Bisa juga override lewat env var:
#   sudo API_USER=catur DEPLOY_USER=www bash scripts/setup-sudoers.sh

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Script ini wajib dijalankan sebagai root (pakai 'sudo bash scripts/setup-sudoers.sh')." >&2
  exit 1
fi

# --- 1. Tentuin API_USER (user yang menjalankan proses vps-api) ---
if [ -z "${API_USER:-}" ]; then
  read -rp "User yang menjalankan proses vps-api (mis. dari 'pm2 ls' / 'whoami' pas start): " API_USER
fi
if ! id "$API_USER" >/dev/null 2>&1; then
  echo "User \"$API_USER\" tidak ditemukan di sistem ini." >&2
  exit 1
fi

# --- 2. Tentuin DEPLOY_USER (dari config.json kalau ada, atau tanya) ---
CONFIG_PATH="$(dirname "$0")/../data/config.json"
DETECTED_DEPLOY_USER=""
if [ -f "$CONFIG_PATH" ] && command -v node >/dev/null 2>&1; then
  DETECTED_DEPLOY_USER="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONFIG_PATH','utf-8')).deploy_user||'')}catch(e){}" 2>/dev/null || true)"
fi

if [ -z "${DEPLOY_USER:-}" ]; then
  if [ -n "$DETECTED_DEPLOY_USER" ]; then
    read -rp "Deploy user terdeteksi dari config.json = \"$DETECTED_DEPLOY_USER\". Pakai ini? [Y/n] " CONFIRM
    if [[ "$CONFIRM" =~ ^[Nn]$ ]]; then
      read -rp "Deploy user yang mau dipakai: " DEPLOY_USER
    else
      DEPLOY_USER="$DETECTED_DEPLOY_USER"
    fi
  else
    read -rp "Deploy user (owner folder project, mis. 'www' atau 'ubuntu'): " DEPLOY_USER
  fi
fi

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "Peringatan: user \"$DEPLOY_USER\" belum ada di sistem ini - lanjut tetap ditulis, tapi pastikan dibuat sebelum dipakai." >&2
fi

# --- 3. Cek default_folder owner-nya cocok gak sama DEPLOY_USER ---
DEFAULT_FOLDER="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONFIG_PATH','utf-8')).default_folder||'')}catch(e){}" 2>/dev/null || true)"

# --- 3b. Deteksi nginx_binary dari config.json - JANGAN hardcode /usr/sbin/nginx,
# karena banyak server (aaPanel) pakai binary custom (mis. /www/server/nginx/sbin/nginx).
# Kalau rule sudoers cuma whitelist path yang beda dari yang benar-benar dipanggil
# app (config.nginx_binary), nginx -t / reload bakal kena "password required" juga.
# (FIXED: sebelumnya versi hardcode /usr/sbin/nginx MASIH ditulis juga di rule di
# bawah, dobel sama variable ${NGINX_BINARY} - kalau default sama persis jadi
# entry duplikat, kalau beda malah nyisain whitelist path yang gak pernah dipanggil
# app. Sekarang rule cuma pakai ${NGINX_BINARY} biar sesuai maksud comment ini.)
NGINX_BINARY="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONFIG_PATH','utf-8')).nginx_binary||'')}catch(e){}" 2>/dev/null || true)"
if [ -z "$NGINX_BINARY" ]; then
  NGINX_BINARY="/usr/sbin/nginx"
fi
# FIXED: sama seperti BIN_TEST di atas - kalau nginx_binary di config.json somehow
# keisi value yang bukan path absolut (typo, relative path, dll), rule sudoers-nya
# bakal invalid syntax juga. Validasi dulu, fallback ke default kalau gak valid.
if [[ "$NGINX_BINARY" != /* ]]; then
  echo "Peringatan: nginx_binary di config.json (\"$NGINX_BINARY\") bukan path absolut - pakai default /usr/sbin/nginx." >&2
  NGINX_BINARY="/usr/sbin/nginx"
fi

# --- 3c. Resolve path absolut command dasar (ls/cat/cp/ln/mkdir/rm/test) yang
# dipakai src/nginx/nginx.js buat baca & tulis config site (listSites, viewSite,
# ensureEnabled/ensureDisabled, writeConfFile, deleteSite, dst). Dicari otomatis
# lewat `command -v` karena lokasinya bisa beda antar distro (/bin vs /usr/bin).
# FIXED: `command -v` buat command yang juga ada sebagai shell builtin (mis. "test")
# balikin nama doang TANPA path ("test", bukan "/usr/bin/test"). Sudoers WAJIB
# fully-qualified path (harus mulai "/"), jadi hasil "test" bikin visudo -c gagal
# parse ("syntax error") pas ditaruh di rule - ini akar masalah error line 20 di atas.
# Makanya sekarang hasil `command -v` divalidasi: dipakai HANYA kalau mulai "/",
# selain itu jatuh ke fallback /usr/bin/<nama>.
resolve_bin() {
  local resolved
  resolved="$(command -v "$1" 2>/dev/null || true)"
  if [[ "$resolved" == /* ]]; then
    echo "$resolved"
  else
    echo "/usr/bin/$1"
  fi
}
BIN_LS="$(resolve_bin ls)"
BIN_CAT="$(resolve_bin cat)"
BIN_CP="$(resolve_bin cp)"
BIN_LN="$(resolve_bin ln)"
BIN_MKDIR="$(resolve_bin mkdir)"
BIN_RM="$(resolve_bin rm)"
# FIXED: src/ssl/ssl.js manggil `sudo openssl x509 -enddate -noout -in ...`
# (checkCertExpiry) dan `sudo mkdir ... && sudo chmod -R 755 ...` (siapin
# webroot ACME challenge) - dua-duanya (openssl, chmod) gak pernah masuk
# rule (root) di bawah walau "SSL cert" udah disebut di komentarnya.
# Akibatnya fitur SSL Manager (cek expiry cert) selalu minta password sudo
# beneran ke API_USER, padahal command SSL lain (certbot, nginx reload)
# udah jalan normal tanpa password - karena openssl/chmod SAMA SEKALI gak
# match rule manapun (bukan salah user/scope, commandnya emang gak ada).
BIN_OPENSSL="$(resolve_bin openssl)"
BIN_CHMOD="$(resolve_bin chmod)"
# FIXED: src/deploy/deployNew.js step "Siapkan Folder" manggil
# `sudo chown -R deployUser:deployUser folderPath` SETELAH mkdir, tapi
# `chown` sebelumnya gak pernah dicantumkan di rule (root) di bawah -
# akibatnya SETIAP deploy project baru gagal persis di step ini dengan
# "sudo: a terminal is required to read the password", walau mkdir-nya
# sendiri sukses (mkdir ADA di rule, chown enggak).
BIN_CHOWN="$(resolve_bin chown)"
BIN_TEST="$(resolve_bin test)"
# FIXED: src/doctor/doctor.js checkSudoAccess() nge-tes akses `sudo -n -u
# ${DEPLOY_USER} true` sebagai probe read-only - tapi `/usr/bin/true` gak
# pernah dicantumkan di rule (${DEPLOY_USER}) di bawah. Akibatnya probe ini
# SELALU gagal ("not allowed to execute '/usr/bin/true'") walau rule lain
# buat deploy_user sudah benar - ini akar masalah kartu "Kesiapan Sistem"
# masih merah walau script ini sudah pernah dijalankan.
BIN_TRUE="$(resolve_bin true)"
# FIXED: src/doctor/doctor.js checkSudoCommands() nge-tes `sudo -n pm2 list`
# SEBAGAI ROOT (bukan `-u ${DEPLOY_USER}`) buat verifikasi app bisa baca
# status PM2 dari konteks API. `pm2` sebelumnya cuma ada di rule
# (${DEPLOY_USER}) di atas, gak pernah di rule (root) - jadi probe ini
# SELALU minta password walau rule lain sudah benar. Discope ke argumen
# "list" doang (least-privilege, sama pola kayak "ufw status").
BIN_PM2="$(resolve_bin pm2)"
# FIXED: src/security/security.js checkSshConfig() dan checkFail2ban()
# manggil `sudo grep ...` dan `sudo fail2ban-client status`, tapi dua-duanya
# sebelumnya TIDAK ada di rule sudoers ini sama sekali - jadi selalu gagal
# dengan "password is required" walau firewall/user/config-nya sendiri
# benar. Ini akar masalah kartu Diagnostik "Konfigurasi SSH: sshd_config
# tidak terbaca" dan "Fail2ban: Stopped" yang muncul terus walau sshd_config
# ada isinya / fail2ban sudah terinstall.
BIN_GREP="$(resolve_bin grep)"
# fail2ban-client mungkin belum terinstall pas script ini dijalankan -
# resolve_bin fallback ke /usr/bin/fail2ban-client kalau `command -v` kosong,
# jadi rule tetap valid & langsung jalan begitu fail2ban di-`apt install`
# belakangan (tanpa perlu jalanin ulang script ini).
BIN_FAIL2BAN="$(resolve_bin fail2ban-client)"
# FIXED: src/deploy/deployNew.js step "Prisma (generate/push/migrate)" manggil
# `sudo -u ${DEPLOY_USER} npx --yes prisma ...` lewat runAsUserArgs() (execFileSync
# langsung ke `sudo`, BUKAN lewat bash -c) - jadi sudo ngecek command "npx" apa
# adanya, bukan "bash". Rule (${DEPLOY_USER}) di bawah sebelumnya cuma nyantumin
# npm/node/pm2/bash - "npx" gak pernah ditambahin sama sekali. Akibatnya SETIAP
# deploy dengan Mode Prisma diisi (generate/push/migrate) selalu gagal dengan
# "user X is not allowed to execute '/usr/bin/npx ...'", walau npm/node/git/bash
# semua sudah jalan normal. Diresolve dinamis (bukan hardcode /usr/bin/npx) karena
# instalasi Node lewat nvm/aaPanel biasa naruh npx di path lain.
BIN_NPX="$(resolve_bin npx)"

if [ -n "$DEFAULT_FOLDER" ] && [ -d "$DEFAULT_FOLDER" ]; then
  ACTUAL_OWNER="$(stat -c '%U' "$DEFAULT_FOLDER")"

  if [ "$ACTUAL_OWNER" != "$DEPLOY_USER" ]; then
    echo ""
    echo "⚠️  PERHATIAN: owner folder \"$DEFAULT_FOLDER\" = \"$ACTUAL_OWNER\", tapi deploy_user yang dipakai = \"$DEPLOY_USER\"."
    echo "   Ini bikin sudo -u $DEPLOY_USER gagal akses folder tersebut (EACCES)."
    echo "   Update deploy_user di Configuration (app/CLI) biar sama dengan \"$ACTUAL_OWNER\", atau chown folder ini."
    echo ""
  fi
fi

# --- 4. Generate isi rule, tulis ke file sementara, validasi, baru apply ---
SUDOERS_FILE="/etc/sudoers.d/vps-manager"
TMP_FILE="$(mktemp)"

cat > "$TMP_FILE" <<EOF
# Dibuat otomatis oleh scripts/setup-sudoers.sh - JANGAN diedit manual.
# Jalankan ulang script ini kalau perlu mengubah user/command.
#
# ${API_USER}: proses vps-api/CLI jalan sebagai user ini.
# Command dibatasi cuma yang benar-benar dipanggil dari src/utils/shell.js,
# src/cleanup/cleanup.js, src/git/git.js, src/build/build.js - BUKAN blanket ALL.

# FIXED: step "PM2 Start" (deployNew.js) manggil `sudo -u ${DEPLOY_USER}
# PORT=<port> pm2 start ...` buat nyetel env var PORT ke proses PM2. Sudo
# SECARA DEFAULT nolak siapapun nyetel env var apapun lewat command line
# (`VAR=value command`) kecuali rule-nya dikasih tag SETENV eksplisit -
# tanpa ini SETIAP deploy/retry yang nyampe step PM2 Start selalu gagal
# dengan "sudo: sorry, you are not allowed to set the following environment
# variables: PORT", walau command pm2-nya sendiri sudah ada di whitelist.
${API_USER} ALL=(${DEPLOY_USER}) NOPASSWD:SETENV: /bin/rm, /usr/bin/find, /usr/bin/du, /bin/mkdir, /usr/bin/git, /usr/bin/npm, /usr/bin/node, /usr/bin/pm2, ${BIN_NPX}, /bin/bash, /usr/bin/lsof, ${BIN_TRUE}

# Root command:
# - nginx reload/test (pakai nginx_binary asli dari config.json, BUKAN dihardcode -
#   biar cocok baik server standar (/usr/sbin/nginx) maupun aaPanel/custom install)
# - SSL cert
# - scan port
# - firewall status
# - baca/tulis file config site nginx (src/nginx/nginx.js: listSites, viewSite,
#   ensureEnabled/ensureDisabled, writeConfFile, backupSite, deleteSite) - SEBELUMNYA
#   command ini TIDAK ada di rule, jadi tiap fitur "Site Nginx" (list/view/tambah/hapus
#   site) gagal dengan "sudo: a terminal is required to read the password".
#
# FIXED (scoping): src/security/security.js & src/scanner/scanner.js cuma pernah
# manggil \`sudo ufw status\` dan \`sudo ss -tlnp\` - bukan ufw/ss polos tanpa argumen.
# Command tanpa argumen di sudoers artinya user boleh isi ARGUMEN APAPUN (mis.
# "sudo ufw" polos juga meng-cover "sudo ufw disable"), jadi di-scope ke argumen
# yang benar-benar dipakai app biar tetap least-privilege.
#
# CATATAN: /usr/bin/lsof dipertahankan di rule ini untuk jaga-jaga, tapi src/safety/
# safety.js manggil \`lsof\` LANGSUNG tanpa sudo (jalan sebagai user proses vps-api),
# jadi entry ini sebenarnya tidak dipakai saat ini.
#
# CATATAN: certbot TETAP tanpa argumen tetap karena src/ssl/ssl.js manggil dengan
# domain/email yang dinamis (certonly -w ... -d <domain>, renew) - gak bisa di-scope
# ke satu argumen tetap tanpa bikin fitur SSL rusak. Sama alasannya openssl gak
# di-scope ke argumen tetap (path fullchain per-domain beda-beda).
${API_USER} ALL=(root) NOPASSWD: ${NGINX_BINARY} -t, ${NGINX_BINARY} -s reload, /bin/systemctl restart nginx, /bin/systemctl reload nginx, /usr/bin/certbot, ${BIN_OPENSSL}, /usr/bin/ss -tlnp, /bin/ss -tlnp, /usr/sbin/ufw status, /usr/bin/lsof, ${BIN_LS}, ${BIN_CAT}, ${BIN_CP}, ${BIN_LN}, ${BIN_MKDIR}, ${BIN_CHMOD}, ${BIN_CHOWN}, ${BIN_RM}, ${BIN_TEST}, ${BIN_GREP}, ${BIN_FAIL2BAN} status, ${BIN_PM2} list
EOF

if ! visudo -c -f "$TMP_FILE" >/dev/null 2>&1; then
  echo "Syntax rule sudoers tidak valid - TIDAK di-apply. Cek isi $TMP_FILE." >&2
  visudo -c -f "$TMP_FILE" || true
  exit 1
fi

if [ -f "$SUDOERS_FILE" ] && diff -q "$SUDOERS_FILE" "$TMP_FILE" >/dev/null 2>&1; then
  echo "Rule sudoers sudah sesuai, tidak ada perubahan (\"$SUDOERS_FILE\")."
  rm -f "$TMP_FILE"
  exit 0
fi

install -m 0440 "$TMP_FILE" "$SUDOERS_FILE"
rm -f "$TMP_FILE"

echo ""
echo "✅ Rule sudoers berhasil ditulis ke $SUDOERS_FILE"
echo "   API user  : $API_USER"
echo "   Deploy user: $DEPLOY_USER"
echo ""
echo "Verifikasi cepat:"
echo "  sudo -n -u $DEPLOY_USER true && echo 'OK: sudo tanpa password berhasil'"

chmod +x scripts/setup-sudoers.sh