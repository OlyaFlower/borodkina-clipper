#!/usr/bin/env bash
# Usage: verify.sh <outdir> <durationSec>
# Checks codec, size, duration (+-0.15 s), no audio, and byte limits. AV1 files are optional.
set -euo pipefail
out="$1"; dur="$2"
max_video=$((4 * 1024 * 1024))
max_poster=$((512 * 1024))
problems=0
bad() { echo "verify: $1" >&2; problems=$((problems + 1)); }

check_video() { # name codec width height required
  local f="$out/$1" json
  if [[ ! -f "$f" ]]; then
    if [[ "$5" == yes ]]; then bad "$1 missing"; fi
    return 0
  fi
  json="$(ffprobe -v error -show_entries stream=codec_type,codec_name,width,height:format=duration -of json "$f")" \
    || { bad "$1 unreadable"; return 0; }
  jq -e --arg c "$2" --argjson w "$3" --argjson h "$4" --argjson d "$dur" '
      ([.streams[]|select(.codec_type=="audio")]|length)==0
      and ([.streams[]|select(.codec_type=="video")]|length)==1
      and (.streams[]|select(.codec_type=="video")|.codec_name==$c and .width==$w and .height==$h)
      and ((.format.duration|tonumber) - $d | fabs) <= 0.15' <<<"$json" >/dev/null \
    || bad "$1 failed codec/size/duration/audio check"
  (( $(stat -c %s "$f") <= max_video )) || bad "$1 is over 4 MiB"
}

check_video 1280.av1.webm av1 1280 720 no
check_video 640.av1.webm av1 640 360 no
check_video 1280.h264.mp4 h264 1280 720 yes
check_video 640.h264.mp4 h264 640 360 yes

p="$out/poster.webp"
if [[ ! -f "$p" ]]; then
  bad "poster.webp missing"
else
  ps="$(ffprobe -v error -show_entries stream=codec_name,width,height -of csv=p=0 "$p" || true)"
  [[ "$ps" == "webp,1280,720" ]] || bad "poster.webp is not a 1280x720 webp"
  (( $(stat -c %s "$p") <= max_poster )) || bad "poster.webp is over 512 KiB"
fi

if (( problems > 0 )); then exit 1; fi
echo "verify ok"
