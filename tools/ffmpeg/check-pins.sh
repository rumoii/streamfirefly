#!/usr/bin/env bash
# Compares built ffmpeg.exe hashes with ffmpeg-lgpl.json. Unpinned hashes pass unless --require is given.
# Usage: check-pins.sh <output-dir> [--require]
set -euo pipefail
out=${1:?output directory}
require=${2:-}
pins="$(cd "$(dirname "$0")" && pwd)/ffmpeg-lgpl.json"
status=0
for arch in x64 arm64; do
  actual=$(sha256sum "$out/ffmpeg-$arch.exe" | cut -d' ' -f1)
  expected=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["binaries"][sys.argv[2]])' "$pins" "$arch")
  size=$(stat -c %s "$out/ffmpeg-$arch.exe")
  if [ -z "$expected" ]; then
    echo "$arch: $actual ($size bytes) not pinned yet"
    [ "$require" = "--require" ] && status=1
  elif [ "$expected" = "$actual" ]; then
    echo "$arch: $actual ($size bytes) matches the pin"
  else
    echo "$arch: $actual ($size bytes) differs from pinned $expected" >&2
    status=1
  fi
done
exit $status
