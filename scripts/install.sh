#!/usr/bin/env bash
# Canonical installer: OptimatistAI/langlangbot scripts/install.sh
# Published copy: https://optimatist.ai/langlangbot/install.sh
# Do not put sidecar/runtime logic in this repo — it would drift from CDN.
set -euo pipefail

CDN_INSTALL="${LANGLANGBOT_INSTALL_SH:-https://optimatist.ai/langlangbot/install.sh}"
tmp="$(mktemp)"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

curl -fsSL "$CDN_INSTALL" -o "$tmp"
chmod +x "$tmp"
exec bash "$tmp" "$@"
