#!/usr/bin/env bash
# Usage: encode.sh <input> <startSec> <durationSec> <outdir>
# Makes the silent 8-second renditions and the poster, then runs verify.sh on them.
# An AV1 rendition that fails or is oversize is dropped; any H.264 or poster problem fails the script.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -ne 4 ]]; then echo "usage: encode.sh <input> <startSec> <durationSec> <outdir>" >&2; exit 2; fi
input="$1"; start="$2"; dur="$3"; out="$4"
[[ -f "$input" ]] || { echo "input not found" >&2; exit 2; }
[[ "$start" =~ ^[0-9]{1,6}$ ]] || { echo "bad startSec" >&2; exit 2; }
[[ "$dur" =~ ^[0-9]{1,2}$ ]] || { echo "bad durationSec" >&2; exit 2; }
mkdir -p "$out"

max_video=$((4 * 1024 * 1024))

ff() { ffmpeg -hide_banner -loglevel error -nostdin -y -ss "$start" -t "$dur" -i "$input" -an "$@"; }
vf() { echo "scale=$1:$2:force_original_aspect_ratio=increase,crop=$1:$2,fps=30,format=yuv420p"; }

av1() { # name width height maxkbps
  if ! ff -vf "$(vf "$2" "$3")" -c:v libsvtav1 -preset 6 -crf 36 -g 60 -level 4.0 \
      -svtav1-params "mbr=$4" -f webm "$out/$1"; then
    echo "warning: $1 failed, dropping it" >&2; rm -f "$out/$1"; return 0
  fi
  if (( $(stat -c %s "$out/$1") > max_video )); then
    echo "warning: $1 is over 4 MiB, dropping it" >&2; rm -f "$out/$1"
  fi
}

h264() { # name width height level maxrate bufsize
  ff -vf "$(vf "$2" "$3")" -c:v libx264 -preset slow -crf 23 -maxrate "$5" -bufsize "$6" \
    -profile:v high -level:v "$4" -g 60 -movflags +faststart -f mp4 "$out/$1"
}

av1 1280.av1.webm 1280 720 1000
av1 640.av1.webm 640 360 400
h264 1280.h264.mp4 1280 720 3.2 2M 4M
h264 640.h264.mp4 640 360 3.0 800k 1600k

ffmpeg -hide_banner -loglevel error -nostdin -y -ss "$start" -t "$dur" -i "$input" -an \
  -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p" \
  -frames:v 1 -c:v libwebp -quality 80 "$out/poster.webp"

"$here/verify.sh" "$out" "$dur"
