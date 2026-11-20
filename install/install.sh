#!/bin/sh
# Indognito installer for Linux (any distribution) and macOS.
#
#   curl -fsSL https://github.com/aswartzlander2-school/indognito/releases/latest/download/install.sh | sh
#
# It downloads only the `gnito` command (checksum-verified) and, where it can, the few system packages
# Indognito uses (bubblewrap for sandboxed terminals, a GUI toolkit for the setup wizard, and on
# distributions without an official Node.js build, Node.js 22). Then run `gnito start`: setup runs once,
# on the first start.
#
# Options (environment variables):
#   GNITO_VERSION=0.1.0      a specific version (default: the latest release)
#   GNITO_BIN_DIR=/path      where to put `gnito` (default: /usr/local/bin as root, else ~/.local/bin)
#   GNITO_NO_DEPS=1          don't install system packages
#   GITHUB_TOKEN=…           needed while the repository is private (or be signed in with `gh auth login`)
set -eu

REPO="aswartzlander2-school/indognito"
say()  { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- platform
os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "Unsupported system: $os. Indognito runs on Linux, macOS and Windows (use install.ps1 on Windows)." ;;
esac
m=$(uname -m)
case "$m" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  armv7l|armv7*|armv8l) arch=armv7 ;;
  i386|i486|i586|i686|x86) arch=386 ;;
  riscv64) arch=riscv64 ;;
  ppc64le) arch=ppc64le ;;
  s390x) arch=s390x ;;
  loongarch64|loong64) arch=loong64 ;;
  *) die "Unsupported CPU: $m" ;;
esac
if [ "$os" = darwin ] && [ "$arch" != amd64 ] && [ "$arch" != arm64 ]; then die "Unsupported Mac CPU: $m"; fi

if [ "$(id -u)" = 0 ]; then SUDO=""; elif have sudo; then SUDO="sudo"; elif have doas; then SUDO="doas"; else SUDO=""; fi

# ---------------------------------------------------------------- downloads (public, or private with a token)
token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -z "$token" ] && have gh; then token=$(gh auth token 2>/dev/null || true); fi

fetch() { # fetch URL FILE
  if have curl; then
    if [ -n "$token" ]; then curl -fsSL -H "Authorization: Bearer $token" -o "$2" "$1"
    else curl -fsSL -o "$2" "$1"; fi
  elif have wget; then
    if [ -n "$token" ]; then wget -q --header="Authorization: Bearer $token" -O "$2" "$1"
    else wget -q -O "$2" "$1"; fi
  else die "Need curl or wget."; fi
}

api() { # api PATH FILE  (GitHub REST API)
  fetch "https://api.github.com/repos/$REPO/$1" "$2"
}

asset() { # asset NAME FILE — a release file, through the API when the repository is private
  url="https://github.com/$REPO/releases/download/v$VERSION/$1"
  if [ -z "$token" ]; then fetch "$url" "$2"; return; fi
  api "releases/tags/v$VERSION" "$tmp/release.json"
  id=$(tr '{' '\n' < "$tmp/release.json" | grep "\"name\": *\"$1\"" | grep -o '"id": *[0-9]*' | head -n1 | grep -o '[0-9]*$' || true)
  [ -n "$id" ] || die "Release v$VERSION has no file $1."
  if have curl; then curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/octet-stream" -o "$2" "https://api.github.com/repos/$REPO/releases/assets/$id"
  else wget -q --header="Authorization: Bearer $token" --header="Accept: application/octet-stream" -O "$2" "https://api.github.com/repos/$REPO/releases/assets/$id"; fi
}

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t gnito)
trap 'rm -rf "$tmp"' EXIT INT TERM

VERSION="${GNITO_VERSION:-}"
if [ -z "$VERSION" ]; then
  api "releases/latest" "$tmp/latest.json" 2>/dev/null \
    || die "Couldn't find the latest release. If the repository is private, set GITHUB_TOKEN or run \"gh auth login\" first."
  VERSION=$(grep -o '"tag_name": *"v[^"]*"' "$tmp/latest.json" | head -n1 | sed 's/.*"v//; s/"$//')
  [ -n "$VERSION" ] || die "Couldn't read the latest version."
fi

say "Installing Indognito $VERSION for $os/$arch"
name="gnito-$os-$arch"
asset "$name" "$tmp/gnito" || die "Download failed ($name)."
asset "SHA256SUMS" "$tmp/SHA256SUMS" || die "Download failed (SHA256SUMS)."
want=$(grep " $name\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
if have sha256sum; then got=$(sha256sum "$tmp/gnito" | cut -d' ' -f1)
elif have shasum; then got=$(shasum -a 256 "$tmp/gnito" | cut -d' ' -f1)
else got=$(openssl dgst -sha256 "$tmp/gnito" | sed 's/.*= //'); fi
[ -n "$want" ] && [ "$want" = "$got" ] || die "Checksum mismatch for $name — refusing to install."
chmod 755 "$tmp/gnito"
note "gnito downloaded and verified"

# ---------------------------------------------------------------- system packages (best effort)
musl=0
if [ "$os" = linux ] && { ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then musl=1; fi
needs_node=0
case "$arch" in 386|riscv64|loong64) needs_node=1 ;; esac
[ "$musl" = 1 ] && needs_node=1   # an unofficial musl build is tried first; system Node.js is the fallback

pm_install() {
  [ -n "$SUDO" ] || [ "$(id -u)" = 0 ] || { warn "Not root and no sudo/doas: install these yourself: $*"; return 0; }
  if have apt-get; then $SUDO apt-get install -y "$@" || { $SUDO apt-get update && $SUDO apt-get install -y "$@"; }
  elif have dnf; then $SUDO dnf install -y "$@"
  elif have yum; then $SUDO yum install -y "$@"
  elif have zypper; then $SUDO zypper --non-interactive install "$@"
  elif have pacman; then $SUDO pacman -S --needed --noconfirm "$@"
  elif have apk; then $SUDO apk add "$@"
  elif have xbps-install; then $SUDO xbps-install -Sy "$@"
  elif have emerge; then $SUDO emerge --noreplace "$@"
  elif have eopkg; then $SUDO eopkg install -y "$@"
  elif have swupd; then $SUDO swupd bundle-add "$@"
  elif have urpmi; then $SUDO urpmi --auto "$@"
  elif have slackpkg; then $SUDO slackpkg -batch=on -default_answer=y install "$@"
  elif have nix-env; then for p in "$@"; do nix-env -iA "nixpkgs.$p"; done
  else warn "Unknown package manager: install these yourself: $*"; fi
}

if [ "$os" = linux ] && [ "${GNITO_NO_DEPS:-0}" != 1 ]; then
  pkgs=""
  if have apt-get; then pkgs="ca-certificates bubblewrap python3-gi gir1.2-gtk-3.0"; [ "$needs_node" = 1 ] && pkgs="$pkgs nodejs"
  elif have dnf || have yum; then pkgs="ca-certificates bubblewrap python3-gobject gtk3"; [ "$needs_node" = 1 ] && pkgs="$pkgs nodejs"
  elif have zypper; then pkgs="ca-certificates bubblewrap python3-gobject typelib-1_0-Gtk-3_0"; [ "$needs_node" = 1 ] && pkgs="$pkgs nodejs22"
  elif have pacman; then pkgs="ca-certificates bubblewrap python-gobject gtk3"; [ "$needs_node" = 1 ] && pkgs="$pkgs nodejs"
  elif have apk; then pkgs="ca-certificates bubblewrap py3-gobject3 gtk+3.0"; [ "$needs_node" = 1 ] && pkgs="$pkgs nodejs"
  elif have xbps-install; then pkgs="ca-certificates bubblewrap python3-gobject gtk+3"; [ "$needs_node" = 1 ] && pkgs="$pkgs nodejs"
  elif have emerge; then pkgs="app-misc/ca-certificates sys-apps/bubblewrap dev-python/pygobject"; [ "$needs_node" = 1 ] && pkgs="$pkgs net-libs/nodejs"
  elif have eopkg; then pkgs="ca-certs bubblewrap python-gobject"; [ "$needs_node" = 1 ] && pkgs="$pkgs nodejs"
  elif have swupd; then pkgs="bubblewrap python3-basic desktop-gnomelibs"; [ "$needs_node" = 1 ] && pkgs="$pkgs nodejs-basic"
  elif have nix-env; then pkgs="bubblewrap"; [ "$needs_node" = 1 ] && pkgs="$pkgs nodejs_22"
  fi
  if [ -n "$pkgs" ]; then
    say "Installing system packages: $pkgs"
    # shellcheck disable=SC2086
    pm_install $pkgs || warn "Some packages didn't install. Indognito still works: the setup wizard falls back to text mode (gnito start --tui), and without bubblewrap terminals run unsandboxed."
  fi
fi

# ---------------------------------------------------------------- put gnito on PATH
dest="${GNITO_BIN_DIR:-}"
if [ -z "$dest" ]; then
  if [ "$(id -u)" = 0 ]; then dest=/usr/local/bin
  elif [ -n "$SUDO" ] && [ -d /usr/local/bin ]; then dest=/usr/local/bin
  else dest="$HOME/.local/bin"; fi
fi
if [ -w "$dest" ] || { [ ! -e "$dest" ] && mkdir -p "$dest" 2>/dev/null; }; then
  mv "$tmp/gnito" "$dest/gnito"
else
  say "Installing gnito to $dest (asks for your password)"
  $SUDO mkdir -p "$dest" && $SUDO mv "$tmp/gnito" "$dest/gnito" && $SUDO chmod 755 "$dest/gnito"
fi
note "gnito → $dest/gnito"
if [ "$os" = darwin ]; then xattr -d com.apple.quarantine "$dest/gnito" 2>/dev/null || true; fi

case ":$PATH:" in
  *":$dest:"*) ;;
  *)
    for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
      [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ] || continue
      grep -qs "$dest" "$rc" || printf '\nexport PATH="%s:$PATH"\n' "$dest" >> "$rc"
    done
    warn "$dest wasn't on your PATH; it was added for new terminals. For this one run: export PATH=\"$dest:\$PATH\""
    ;;
esac

echo
say "Done. Now run:  gnito start"
note "Setup runs once, the first time. After that, gnito start just starts Indognito."
