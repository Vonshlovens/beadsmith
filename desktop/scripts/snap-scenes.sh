#!/usr/bin/env bash
# Render every headless scene in both themes: <out>/<scene>-<theme>.png.
#
# The scene list comes from the app (`--list-scenes`), so a new scene is
# covered without editing this script or the CI workflow that calls it. Both
# themes are named explicitly: a snapshot must not depend on the appearance
# of the machine that renders it.
#
# Usage: scripts/snap-scenes.sh [out-dir]     (default: target/scenes)
#   BEADSMITH_DESKTOP_BIN  use this built binary instead of `cargo run`.
set -euo pipefail

cd "$(dirname "$0")/.."
out=${1:-target/scenes}
mkdir -p "$out"

app() {
  if [ -n "${BEADSMITH_DESKTOP_BIN:-}" ]; then
    "$BEADSMITH_DESKTOP_BIN" "$@"
  else
    cargo run --quiet --locked -- "$@"
  fi
}

scenes=$(app --list-scenes)
if [ -z "$scenes" ]; then
  echo "snap-scenes: the app listed no scenes" >&2
  exit 1
fi

count=0
for scene in $scenes; do
  for theme in dark light; do
    png="$out/$scene-$theme.png"
    rm -f "$png"
    app --snap "$png" --scene "$scene" --theme "$theme"
    # A renderer that exits 0 without writing pixels would otherwise pass.
    if [ ! -s "$png" ]; then
      echo "snap-scenes: $scene ($theme) wrote no image" >&2
      exit 1
    fi
    count=$((count + 1))
  done
done
echo "snap-scenes: $count images in $out"
