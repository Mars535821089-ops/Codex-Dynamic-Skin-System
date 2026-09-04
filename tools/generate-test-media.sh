#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT="$ROOT/tools/tests/fixtures/media"
FFMPEG="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
CWEBP="${CWEBP:-/opt/homebrew/bin/cwebp}"

if [ ! -x "$FFMPEG" ]; then
  printf 'ffmpeg is required: %s\n' "$FFMPEG" >&2
  exit 2
fi
if [ ! -x "$CWEBP" ]; then
  printf 'cwebp is required: %s\n' "$CWEBP" >&2
  exit 2
fi

/bin/mkdir -p "$OUT"
for name in tiny.png tiny.jpg tiny.webp tiny.gif loop-h264.mp4 loop-vp9.webm tone-pcm.wav tone.mp3 tone-aac.m4a SHA256SUMS; do
  /bin/rm -f "$OUT/$name"
done

COMMON=(-hide_banner -loglevel error -y -threads 1)
"$FFMPEG" "${COMMON[@]}" -f lavfi -i color=c=0x345678:s=64x36:d=1 -frames:v 1 -map_metadata -1 "$OUT/tiny.png"
"$FFMPEG" "${COMMON[@]}" -f lavfi -i color=c=0x345678:s=64x36:d=1 -frames:v 1 -map_metadata -1 "$OUT/tiny.jpg"
"$CWEBP" -quiet -lossless -metadata none "$OUT/tiny.png" -o "$OUT/tiny.webp"
"$FFMPEG" "${COMMON[@]}" -f lavfi -i color=c=0x345678:s=64x36:d=1 -frames:v 1 -map_metadata -1 "$OUT/tiny.gif"
"$FFMPEG" "${COMMON[@]}" -f lavfi -i testsrc2=s=160x90:r=24:d=1 -f lavfi -i sine=f=440:d=1 \
  -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.0 -c:a aac -b:a 64k -movflags +faststart -map_metadata -1 \
  "$OUT/loop-h264.mp4"
"$FFMPEG" "${COMMON[@]}" -f lavfi -i testsrc2=s=160x90:r=24:d=1 -an \
  -c:v libvpx-vp9 -deadline good -cpu-used 4 -row-mt 0 -flags:v +bitexact \
  -fflags +bitexact -map_metadata -1 "$OUT/loop-vp9.webm"
"$FFMPEG" "${COMMON[@]}" -f lavfi -i sine=f=440:d=1 -c:a pcm_s16le -ar 48000 -ac 2 -map_metadata -1 "$OUT/tone-pcm.wav"
"$FFMPEG" "${COMMON[@]}" -f lavfi -i sine=f=440:d=1 -c:a libmp3lame -b:a 96k -ar 44100 -ac 2 -map_metadata -1 "$OUT/tone.mp3"
"$FFMPEG" "${COMMON[@]}" -f lavfi -i sine=f=440:d=1 -c:a aac -b:a 64k -ar 48000 -ac 2 -map_metadata -1 "$OUT/tone-aac.m4a"

(
  cd "$OUT"
  /usr/bin/shasum -a 256 tiny.png tiny.jpg tiny.webp tiny.gif loop-h264.mp4 loop-vp9.webm \
    tone-pcm.wav tone.mp3 tone-aac.m4a > SHA256SUMS
)
