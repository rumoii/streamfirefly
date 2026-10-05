#!/usr/bin/env bash
# Builds the minimal LGPL ffmpeg.exe bundled with the StreamFirefly native helper.
# Usage: build.sh <x64|arm64> <output-dir>
# Inputs are pinned in ffmpeg-lgpl.json next to this script; downloads are verified by SHA-256.
# Fixed work paths keep the binary byte-for-byte reproducible for the same inputs.
set -euo pipefail

arch=${1:?architecture x64 or arm64}
out=${2:?output directory}
here=$(cd "$(dirname "$0")" && pwd)
pins="$here/ffmpeg-lgpl.json"
pin() { python3 -c 'import json, sys
v = json.load(open(sys.argv[1]))
for k in sys.argv[2:]: v = v[k]
print(v)' "$pins" "$@"; }

case "$arch" in
  x64) triple=x86_64-w64-mingw32; cpu=x86_64 ;;
  arm64) triple=aarch64-w64-mingw32; cpu=aarch64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 2 ;;
esac

work=/tmp/streamfirefly-ffmpeg
downloads=${STREAMFIREFLY_FFMPEG_DOWNLOADS:-$work/downloads}
mkdir -p "$downloads" "$out"

fetch() { # url sha256 file
  local file="$downloads/$3"
  if [ ! -f "$file" ] || [ "$(sha256sum "$file" | cut -d' ' -f1)" != "$2" ]; then
    curl -fL --retry 3 -o "$file.partial" "$1"
    mv "$file.partial" "$file"
  fi
  [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$2" ] || { echo "SHA-256 mismatch: $3" >&2; exit 1; }
  echo "$file"
}

source_archive=$(fetch "$(pin source url)" "$(pin source sha256)" "$(pin source file)")
toolchain_archive=$(fetch "$(pin toolchain url)" "$(pin toolchain sha256)" "$(pin toolchain file)")

rm -rf "$work/toolchain" "$work/$arch"
mkdir -p "$work/toolchain" "$work/$arch/src" "$work/$arch/build"
tar -xJf "$toolchain_archive" -C "$work/toolchain" --strip-components=1
tar -xJf "$source_archive" -C "$work/$arch/src" --strip-components=1
export PATH="$work/toolchain/bin:$PATH"
export SOURCE_DATE_EPOCH=0

cd "$work/$arch/build"
../src/configure \
  --target-os=mingw32 --arch="$cpu" --enable-cross-compile --cross-prefix="$triple-" --cc="$triple-clang" \
  --pkg-config=false --disable-autodetect --enable-w32threads \
  --disable-everything --disable-network --disable-asm --disable-doc --disable-debug --enable-small \
  --disable-ffplay --disable-ffprobe --disable-avdevice --disable-swscale \
  --enable-protocol=file,pipe \
  --enable-demuxer=hls,mpegts,mov,matroska,aac,mp3,ac3,eac3,webvtt \
  --enable-muxer=mp4,ipod,matroska,webm,webvtt \
  --enable-parser=h264,hevc,aac,aac_latm,ac3,mpegaudio,av1,vp9,vp8,opus,vorbis,flac \
  --enable-bsf=aac_adtstoasc,extract_extradata,vp9_superframe \
  --enable-decoder=webvtt --enable-encoder=webvtt \
  --extra-ldflags='-static -s -Wl,--no-insert-timestamp'
make -j"$(nproc)" ffmpeg.exe

cp ffmpeg.exe "$out/ffmpeg-$arch.exe"
cp ../src/COPYING.LGPLv2.1 "$out/ffmpeg-license.txt"
sha256sum "$out/ffmpeg-$arch.exe"
