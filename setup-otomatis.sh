#!/usr/bin/env bash

# Entry point instalasi setelah repository selesai di-clone.
# Pemakaian: sudo bash setup-otomatis.sh

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export INSTALL_SOURCE_REPO="${INSTALL_SOURCE_REPO:-$REPO_DIR}"

exec bash "$REPO_DIR/scripts/install.sh"
