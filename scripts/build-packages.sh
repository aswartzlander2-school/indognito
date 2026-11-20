#!/bin/sh
# Builds OS packages from the binaries produced by build-release.sh, into the same dist/v<VERSION>/:
#   - .deb   (Debian/Ubuntu: amd64, arm64) with a menu entry and the Indognito icon
#   - .tar.gz (Linux, macOS: one per os/arch) containing the binary + README + LICENSE
#   - .zip   (Windows: one per arch) containing gnito.exe + README + LICENSE
# The raw binaries, app bundle, install scripts and checksums are left as build-release.sh made them.
#
#   scripts/build-release.sh && scripts/build-packages.sh
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
V=$(cat VERSION)
out="$root/dist/v$V"
[ -d "$out" ] || { echo "run scripts/build-release.sh first ($out missing)" >&2; exit 1; }
icon="$root/assets/icons/indognito-256.png"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

deb_arch() { case "$1" in amd64) echo amd64;; arm64) echo arm64;; armv7) echo armhf;; 386) echo i386;; *) echo "$1";; esac; }

echo "== .deb packages"
for arch in amd64 arm64; do
  bin="$out/gnito-linux-$arch"
  [ -f "$bin" ] || { echo "  skip $arch (no binary)"; continue; }
  da=$(deb_arch "$arch")
  pkg="$work/deb-$arch"
  rm -rf "$pkg"
  install -D -m 0755 "$bin" "$pkg/usr/bin/gnito"
  install -D -m 0644 "$icon" "$pkg/usr/share/icons/hicolor/256x256/apps/indognito.png"
  # Desktop entry (the GUI setup wizard shows a window; this gives a menu item with the logo).
  install -d "$pkg/usr/share/applications"
  cat > "$pkg/usr/share/applications/indognito.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Indognito
Comment=Isolated browser, terminal and workspace platform
Exec=gnito start
Icon=indognito
Terminal=true
Categories=Network;System;
EOF
  install -d "$pkg/usr/share/doc/indognito"
  install -m 0644 README.md LICENSE NOTICE.md "$pkg/usr/share/doc/indognito/" 2>/dev/null || true
  size=$(du -ks "$pkg/usr" | cut -f1)
  install -d "$pkg/DEBIAN"
  cat > "$pkg/DEBIAN/control" <<EOF
Package: indognito
Version: $V
Section: net
Priority: optional
Architecture: $da
Maintainer: aswartzlander2-school <noreply@users.noreply.github.com>
Installed-Size: $size
Recommends: bubblewrap, python3-gi, gir1.2-gtk-3.0
Description: Indognito - isolated browser, terminal and workspace platform
 Self-hosted platform giving each user an isolated proxied browser, a real
 terminal in their workspace, a file explorer, and a role-based admin console.
 Run "gnito start" after installing to set it up.
Homepage: https://github.com/aswartzlander2-school/indognito
EOF
  cat > "$pkg/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q /usr/share/icons/hicolor 2>/dev/null || true
echo "Indognito installed. Run 'gnito start' to set it up."
exit 0
EOF
  chmod 0755 "$pkg/DEBIAN/postinst"
  deb="$out/indognito_${V}_${da}.deb"
  dpkg-deb --build --root-owner-group -Zxz "$pkg" "$deb" >/dev/null
  echo "  $(basename "$deb")"
done

echo "== tarballs (Linux, macOS)"
for bin in "$out"/gnito-linux-* "$out"/gnito-darwin-*; do
  [ -f "$bin" ] || continue
  case "$bin" in *.sha256|*SHA256SUMS) continue;; esac
  base=$(basename "$bin")                 # gnito-linux-amd64
  stage="$work/$base"; rm -rf "$stage"; mkdir -p "$stage"
  install -m 0755 "$bin" "$stage/gnito"
  install -m 0644 README.md LICENSE NOTICE.md "$stage/" 2>/dev/null || true
  tar -C "$work" -czf "$out/$base.tar.gz" "$base"
  echo "  $base.tar.gz"
done

echo "== zips (Windows)"
for bin in "$out"/gnito-windows-*.exe; do
  [ -f "$bin" ] || continue
  base=$(basename "$bin" .exe)            # gnito-windows-amd64
  stage="$work/$base"; rm -rf "$stage"; mkdir -p "$stage"
  install -m 0755 "$bin" "$stage/gnito.exe"
  install -m 0644 README.md LICENSE NOTICE.md "$stage/" 2>/dev/null || true
  (cd "$work" && zip -q -r "$out/$base.zip" "$base")
  echo "  $base.zip"
done

echo "== refresh checksums"
(cd "$out" && for f in *; do case "$f" in SHA256SUMS|*.sha256) ;; *) sha256sum "$f";; esac; done > SHA256SUMS)
echo "Done: $out"
ls -1 "$out"
