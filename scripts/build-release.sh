#!/bin/sh
# Builds a release into dist/v<VERSION>/: gnito for every supported platform, the app bundle, both
# install scripts and SHA256SUMS. Upload everything in that folder to the GitHub release v<VERSION>.
#
#   scripts/build-release.sh            (needs Go 1.24+; server/node_modules installed with Node 22)
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
V=$(cat VERSION)
out="$root/dist/v$V"
rm -rf "$out"; mkdir -p "$out"

[ -f server/node_modules/@mercuryworkshop/scramjet/package.json ] \
  || { echo "server/node_modules is missing: run \"cd server && npm ci\" (Node 22) first." >&2; exit 1; }

echo "== gnito $V"
# os/arch[/variant] -> file name. CGO off: one static binary per platform, any distribution.
for t in linux/amd64 linux/arm64 linux/arm/7 linux/386 linux/riscv64 linux/ppc64le linux/s390x linux/loong64 \
         darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
  os=${t%%/*}; rest=${t#*/}; arch=${rest%%/*}; armv=""
  [ "$rest" != "$arch" ] && armv=${rest#*/}
  name="gnito-$os-$arch"; [ "$arch" = arm ] && name="gnito-$os-armv$armv"
  [ "$os" = windows ] && name="$name.exe"
  (cd cli && GOOS=$os GOARCH=$arch GOARM=$armv CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.Version=$V" -o "$out/$name" .)
  echo "  $name"
done

echo "== app bundle"
host="$out/gnito-$(go env GOOS)-$(go env GOARCH)"
[ -x "$host" ] || host="$out/gnito-linux-armv7"
"$host" __bundle "$root" "$out/indognito-app-$V.tar.gz" >/dev/null
echo "  indognito-app-$V.tar.gz"

cp install/install.sh install/install.ps1 "$out/"

echo "== checksums"
(cd "$out" && for f in *; do case "$f" in SHA256SUMS|*.sha256) ;; *) sha256sum "$f";; esac; done > SHA256SUMS)
cat "$out/SHA256SUMS" | sed 's/^/  /'
echo "Done: $out"
