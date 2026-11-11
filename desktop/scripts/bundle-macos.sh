#!/usr/bin/env bash
# Build Beadsmith.app, a macOS bundle of the release binary, and optionally
# install it.
#
# A bare binary works from a terminal, but only a bundle gets a Dock icon, a
# name in the menu bar, a Retina-resolution window and a place in
# /Applications, Spotlight and Launchpad. Rune does not bundle apps, so this
# script does: it needs only what macOS ships (sips, iconutil, plutil,
# codesign, ditto) plus cargo.
#
# Usage: scripts/bundle-macos.sh [build|install|uninstall]
#   build      (default) target/bundle/Beadsmith.app
#   install    build, then copy the app to /Applications
#   uninstall  remove the installed app (settings and the Keychain item stay;
#              the README says how to remove those)
#
# Environment:
#   BEADSMITH_TARGETS        Rust target triples to build, space separated;
#                            more than one makes a universal binary (lipo).
#                            Default: the host.
#   BEADSMITH_SIGN_IDENTITY  codesign identity. Default "-", an ad-hoc
#                            signature: enough to run on the machine that
#                            built it (Apple silicon refuses unsigned code),
#                            not enough to pass Gatekeeper on another one.
#   BEADSMITH_INSTALL_DIR    Where install and uninstall work.
#                            Default: /Applications.
set -euo pipefail

cd "$(dirname "$0")/.."

name=Beadsmith
# Launch Services, the Keychain's access list and the saved window state key
# on this, so it must not change between versions.
bundle_id=io.github.vonshlovens.beadsmith
bin=beadsmith-desktop
out=target/bundle
app=$out/$name.app
install_dir=${BEADSMITH_INSTALL_DIR:-/Applications}
installed=$install_dir/$name.app
identity=${BEADSMITH_SIGN_IDENTITY:--}

die() {
  echo "bundle-macos: $*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || die "this builds a macOS bundle and needs macOS"

# The crate's version is the bundle's: one number to bump, in Cargo.toml.
version=$(sed -n '/^\[package\]/,/^\[/s/^version = "\(.*\)"$/\1/p' Cargo.toml)
[ -n "$version" ] || die "no package version in Cargo.toml"

build_binary() {
  local built=()
  if [ -z "${BEADSMITH_TARGETS:-}" ]; then
    cargo build --release --locked
    built=("target/release/$bin")
  else
    local target
    for target in $BEADSMITH_TARGETS; do
      cargo build --release --locked --target "$target"
      built+=("target/$target/release/$bin")
    done
  fi
  if [ "${#built[@]}" -eq 1 ]; then
    cp -f "${built[0]}" "$app/Contents/MacOS/$name"
  else
    lipo -create -output "$app/Contents/MacOS/$name" "${built[@]}"
  fi
}

# assets/icon.svg -> Beadsmith.icns. The sizes are the ones iconutil
# requires: 16, 32, 128, 256 and 512 points at 1x and 2x. Each is scaled
# from one 1024 px render so every size is the same drawing. The iconset is
# left in target/bundle to look at.
build_icon() {
  local set=$out/$name.iconset master=$out/icon-1024.png
  rm -rf "$set"
  mkdir -p "$set"
  sips -s format png assets/icon.svg --out "$master" >/dev/null
  [ "$(sips -g pixelWidth "$master" | awk '/pixelWidth/ {print $2}')" = 1024 ] ||
    die "sips did not render assets/icon.svg at 1024 px"
  local pt
  for pt in 16 32 128 256 512; do
    sips -z "$pt" "$pt" "$master" --out "$set/icon_${pt}x${pt}.png" >/dev/null
    sips -z $((pt * 2)) $((pt * 2)) "$master" --out "$set/icon_${pt}x${pt}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o "$app/Contents/Resources/$name.icns"
}

write_plist() {
  cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>$name</string>
  <key>CFBundleDisplayName</key>
  <string>$name</string>
  <key>CFBundleIdentifier</key>
  <string>$bundle_id</string>
  <key>CFBundleExecutable</key>
  <string>$name</string>
  <key>CFBundleIconFile</key>
  <string>$name</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleShortVersionString</key>
  <string>$version</string>
  <key>CFBundleVersion</key>
  <string>$version</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST
  plutil -lint "$app/Contents/Info.plist" >/dev/null
}

sign() {
  if [ "$identity" = - ]; then
    codesign --force --sign - "$app"
  else
    # A real identity is for distribution: notarization wants the hardened
    # runtime and a secure timestamp.
    codesign --force --options runtime --timestamp --sign "$identity" "$app"
  fi
  codesign --verify --strict --verbose=2 "$app"
}

build() {
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  build_binary
  build_icon
  write_plist
  sign
  echo "bundle-macos: built $app ($version)"
}

install() {
  [ -d "$install_dir" ] || die "$install_dir does not exist"
  # Copy beside the destination, then swap, so a failed copy never leaves a
  # half-written app where the working one was.
  local staged=$install_dir/.$name.app.installing
  rm -rf "$staged"
  ditto "$app" "$staged"
  rm -rf "$installed"
  mv "$staged" "$installed"
  codesign --verify --strict "$installed"
  echo "bundle-macos: installed $installed"
  if pgrep -xq "$name"; then
    echo "bundle-macos: $name is running; quit and reopen it to use this build"
  fi
}

uninstall() {
  if [ -d "$installed" ]; then
    rm -rf "$installed"
    echo "bundle-macos: removed $installed"
  else
    echo "bundle-macos: $installed is not installed"
  fi
}

case ${1:-build} in
  build) build ;;
  install)
    build
    install
    ;;
  uninstall) uninstall ;;
  *) die "usage: scripts/bundle-macos.sh [build|install|uninstall]" ;;
esac
