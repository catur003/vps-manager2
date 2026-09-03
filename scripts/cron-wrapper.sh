#!/bin/bash
# Dipanggil otomatis oleh crontab entry yang dibuat lewat panel (cron.js
# add()) - BUKAN dipanggil manual. Tugasnya cuma 1: jalankan command asli
# APA ADANYA (lewat bash -c, biar `&&`/`cd`/redirect di command asli tetap
# jalan normal), lalu catat hasil eksekusinya (exit code, durasi, waktu
# mulai) ke file history per-user - dipakai fitur "Cron run history" di
# dashboard biar ketauan kalau ada job yang diam-diam gagal terus tanpa
# perlu buka log manual satu-satu.
#
# Usage: cron-wrapper.sh <jobId> '<command asli lengkap>'
set -u

JOB_ID="$1"
COMMAND="$2"
HISTORY_FILE="$HOME/.vps-manager-cron-history.jsonl"
MAX_HISTORY_LINES=200

START_EPOCH=$(date +%s)
START_ISO=$(date -Iseconds)

bash -c "$COMMAND"
EXIT_CODE=$?

END_EPOCH=$(date +%s)
DURATION_SEC=$((END_EPOCH - START_EPOCH))

printf '{"jobId":"%s","startedAt":"%s","exitCode":%d,"durationSec":%d}\n' \
  "$JOB_ID" "$START_ISO" "$EXIT_CODE" "$DURATION_SEC" >> "$HISTORY_FILE"

# Batasi ukuran file history biar gak numpuk selamanya (200 baris terakhir
# lintas SEMUA job user ini cukup buat kebutuhan "last run" per job).
if [ "$(wc -l < "$HISTORY_FILE" 2>/dev/null || echo 0)" -gt "$MAX_HISTORY_LINES" ]; then
  tail -n "$MAX_HISTORY_LINES" "$HISTORY_FILE" > "${HISTORY_FILE}.tmp" && mv "${HISTORY_FILE}.tmp" "$HISTORY_FILE"
fi

exit "$EXIT_CODE"
