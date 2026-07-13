#!/usr/bin/env bash
# Regenerate the README badges as local PNGs from shields.io.
# Badges are static (no dynamic data), baked locally so the README is
# self-contained and needs no shields.io at render time. Rerun after editing a
# label. Requires: curl, rsvg-convert (brew install librsvg).
set -euo pipefail
cd "$(dirname "$0")"

declare -a BADGES=(
  "vscode|https://img.shields.io/badge/VS%20Code-%5E1.91-2AABEE?logo=visualstudiocode&logoColor=white"
  "telegram|https://img.shields.io/badge/Telegram-full-2AABEE?logo=telegram&logoColor=white"
  "whatsapp|https://img.shields.io/badge/WhatsApp-BETA-25D366?logo=whatsapp&logoColor=white"
  "i18n|https://img.shields.io/badge/i18n-EN%20%C2%B7%20RU-blue"
  "license|https://img.shields.io/badge/License-MIT-green"
)

for item in "${BADGES[@]}"; do
  name="${item%%|*}"; url="${item#*|}"
  curl -fsS --max-time 20 "$url" -o "$name.svg"
  w=$(grep -oE 'width="[0-9]+"' "$name.svg" | head -1 | grep -oE '[0-9]+')
  h=$(grep -oE 'height="[0-9]+"' "$name.svg" | head -1 | grep -oE '[0-9]+')
  rsvg-convert -w $((w * 2)) -h $((h * 2)) "$name.svg" -o "$name.png"  # @2x for crisp retina
  echo "regenerated $name.png (${w}x${h} @2x)"
done
