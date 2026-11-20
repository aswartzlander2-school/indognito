#!/bin/sh
# Indognito CLI installer (Linux + macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/aswartzlander2-school/indognito/main/install.sh | sh
#
# Downloads only the `gnito` CLI. Run `gnito start` afterwards to open the setup wizard, which
# downloads the Node.js runtime and the Indognito application and starts it.
#
# Overrides (env):
#   GNITO_VERSION       release tag to install (default: latest)
#   GNITO_RELEASE_URL   base URL for the gnito binaries (default: GitHub releases)
#   GNITO_INSTALL_DIR   where to put the binary (default: /usr/local/bin, else ~/.local/bin)
set -eu

REPO="aswartzlander2-school/indognito"
RED='\033[1;31m'; GRN='\033[1;32m'; YLW='\033[33m'; DIM='\033[2m'; NC='\033[0m'

say()  { printf '%s\n' "$*"; }
die()  { printf "${RED}✗ %s${NC}\n" "$*" >&2; exit 1; }

# --- detect OS / arch ---
os=$(uname -s)
case "$os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) die "Unsupported OS: $os. Indognito's installer supports Linux and macOS; on Windows use install.ps1." ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64)  arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "Unsupported CPU architecture: $arch (need x86_64 or arm64)." ;;
esac

asset="gnito-${os}-${arch}"
ver="${GNITO_VERSION:-latest}"
if [ -n "${GNITO_RELEASE_URL:-}" ]; then
  url="${GNITO_RELEASE_URL%/}/${asset}"
elif [ "$ver" = latest ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${ver}/${asset}"
fi

# --- pick an install dir on PATH ---
if [ -n "${GNITO_INSTALL_DIR:-}" ]; then
  dir="$GNITO_INSTALL_DIR"; sudo=''
elif [ -w /usr/local/bin ] 2>/dev/null; then
  dir=/usr/local/bin; sudo=''
elif command -v sudo >/dev/null 2>&1; then
  dir=/usr/local/bin; sudo='sudo'
else
  dir="$HOME/.local/bin"; sudo=''
fi
mkdir -p "$dir" 2>/dev/null || true

printf "${RED}INDOGNITO${NC} ${DIM}installer${NC}\n"
say "  OS/arch : ${os}/${arch}"
say "  Source  : ${url}"
say "  Install : ${dir}/gnito"
say ""

# --- download ---
tmp=$(mktemp) || die "cannot create a temp file"
trap 'rm -f "$tmp"' EXIT
say "${DIM}Downloading gnito…${NC}"
if command -v curl >/dev/null 2>&1; then
  curl -fSL --progress-bar "$url" -o "$tmp" || die "download failed from $url (is the release published?)"
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress "$url" -O "$tmp" || die "download failed from $url"
else
  die "need curl or wget to download gnito."
fi
[ -s "$tmp" ] || die "downloaded file is empty."

# --- install ---
chmod +x "$tmp"
$sudo install -m 0755 "$tmp" "$dir/gnito" || die "could not install to $dir (try: GNITO_INSTALL_DIR=\$HOME/.local/bin)"

printf "${GRN}✓ gnito installed to %s/gnito${NC}\n\n" "$dir"

# --- PATH hint ---
case ":$PATH:" in
  *":$dir:"*) ;;
  *) printf "${YLW}Note:${NC} %s is not on your PATH. Add it, e.g.:\n  echo 'export PATH=\"%s:\$PATH\"' >> ~/.profile && . ~/.profile\n\n" "$dir" "$dir" ;;
esac

say "Next:"
say "  ${GRN}gnito start${NC}    # opens the setup wizard, then runs Indognito"
