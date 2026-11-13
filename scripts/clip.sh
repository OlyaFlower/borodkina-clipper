#!/usr/bin/env bash
# Usage: clip --youtube <11-char id> --start <sec> --end <sec>
# Cuts a 5-10 second YouTube section and writes the carousel renditions, poster.webp and clip.json
# to $OUT_ROOT/<id>-<start>-<end>/ (default /out). Exit 3 when YouTube refuses the download.
# Test-only: clip --file <video> --start <sec> --end <sec> encodes a local file instead of downloading.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=versions.env
source "$here/versions.env"

usage() { echo "usage: clip --youtube <11-char id> --start <sec> --end <sec>" >&2; exit 2; }
die() { echo "clip: $1" >&2; exit 2; }

# The image's ENTRYPOINT is clip, so `docker run image clip --youtube ...` passes a leading "clip".
if [[ "${1:-}" == clip ]]; then shift; fi

id=""; file=""; start=""; end=""
while (( $# > 0 )); do
  case "$1" in
    --youtube) [[ $# -ge 2 ]] || usage; id="$2"; shift 2 ;;
    --file) [[ $# -ge 2 ]] || usage; file="$2"; shift 2 ;;
    --start) [[ $# -ge 2 ]] || usage; start="$2"; shift 2 ;;
    --end) [[ $# -ge 2 ]] || usage; end="$2"; shift 2 ;;
    *) usage ;;
  esac
done

if [[ -n "$id" && -n "$file" ]]; then die "use either --youtube or --file"; fi
if [[ -z "$id" && -z "$file" ]]; then usage; fi
if [[ -n "$id" && ! "$id" =~ ^[A-Za-z0-9_-]{11}$ ]]; then die "youtube id must be 11 characters of A-Z a-z 0-9 _ -"; fi
[[ "$start" =~ ^(0|[1-9][0-9]{0,5})$ ]] || die "start must be whole seconds"
[[ "$end" =~ ^(0|[1-9][0-9]{0,5})$ ]] || die "end must be whole seconds"
dur=$((end - start))
if (( dur < 5 || dur > 10 )); then die "end - start must be between 5 and 10 seconds"; fi
if [[ -n "$file" && ! -f "$file" ]]; then die "file not found"; fi

root="${OUT_ROOT:-/out}"
name="${id:-file}-${start}-${end}"
dest="$root/$name"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$root"

if [[ -n "$id" ]]; then
  set +e
  WORK_DIR="$work" YOUTUBE_VIDEO_ID="$id" START_SEC="$start" DURATION_SEC="$dur" bash "$here/fetch-source.sh"
  rc=$?
  set -e
  if (( rc != 0 )); then
    code="$(cat "$work/error-code" 2>/dev/null || true)"
    if [[ "$code" == youtube_blocked ]]; then
      echo "clip: YouTube refused the download (sign in / not a bot / rate limit). Try again later or from another network." >&2
      exit 3
    fi
    echo "clip: $(cat "$work/error-message" 2>/dev/null || echo "download failed")" >&2
    exit 1
  fi
  src="$(cat "$work/source.path")"; seek="$(cat "$work/source.start")"
else
  src="$file"; seek="$start"
fi

mkdir -p "$work/out"
bash "$here/encode.sh" "$src" "$seek" "$dur" "$work/out"

size() { stat -c %s "$1"; }
renditions="[]"
for f in 1280.av1.webm 640.av1.webm 1280.h264.mp4 640.h264.mp4; do
  if [[ -f "$work/out/$f" ]]; then
    renditions="$(jq -c --arg f "$f" --argjson b "$(size "$work/out/$f")" '. + [{file: $f, bytes: $b}]' <<<"$renditions")"
  fi
done
ms="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$work/out/1280.h264.mp4" | awk '{ printf "%d", $1 * 1000 + 0.5 }')"
jq -cn --arg id "$id" --argjson s "$start" --argjson e "$end" --argjson ms "$ms" \
  --argjson r "$renditions" --argjson pb "$(size "$work/out/poster.webp")" \
  --arg y "$YTDLP_VERSION" --arg f "$FFMPEG_RELEASE" \
  '{version: 1, youtubeVideoId: $id, startSec: $s, endSec: $e, durationMs: $ms, renditions: $r,
    poster: {bytes: $pb}, tools: {ytDlp: $y, ffmpeg: $f}}' > "$work/out/clip.json"

rm -rf "$dest"
mkdir -p "$dest"
cp "$work"/out/* "$dest/"
echo "clip: done. Files are in ~/Downloads/borodkina-clips/$name (host path, if you mounted ~/Downloads/borodkina-clips on /out)"
