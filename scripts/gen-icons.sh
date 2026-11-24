#!/usr/bin/env bash
# Render the app icon and the menu bar (tray) icons from the SVG sources in assets/.
#
#   scripts/gen-icons.sh
#
# Requires rsvg-convert (brew install librsvg) and iconutil (ships with macOS).
# Outputs: resources/icon.png (1024 px), resources/icon.icns, resources/tray/*.png (template images).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/resources"
mkdir -p "$OUT/tray"

rsvg-convert -w 1024 -h 1024 "$ROOT/assets/app-icon.svg" -o "$OUT/icon.png"

ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  rsvg-convert -w "$s" -h "$s" "$ROOT/assets/app-icon.svg" -o "$ICONSET/icon_${s}x${s}.png"
  rsvg-convert -w "$((s * 2))" -h "$((s * 2))" "$ROOT/assets/app-icon.svg" -o "$ICONSET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$OUT/icon.icns"
rm -rf "$(dirname "$ICONSET")"

# Template images: black with alpha. macOS tints them for light and dark menu bars.
for pair in "tray:trayTemplate" "tray-recording:trayRecordingTemplate"; do
  src="${pair%%:*}"
  name="${pair##*:}"
  rsvg-convert -w 18 -h 18 "$ROOT/assets/$src.svg" -o "$OUT/tray/$name.png"
  rsvg-convert -w 36 -h 36 "$ROOT/assets/$src.svg" -o "$OUT/tray/$name@2x.png"
done
echo "wrote $OUT/icon.png, $OUT/icon.icns and $OUT/tray/"
