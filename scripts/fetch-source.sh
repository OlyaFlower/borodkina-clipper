#!/usr/bin/env bash
# Gets the source video into $WORK_DIR and prints nothing secret.
# Env: WORK_DIR, YOUTUBE_VIDEO_ID | SOURCE_KEY, START_SEC, DURATION_SEC,
#      and for SOURCE_KEY: R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET.
# Writes $WORK_DIR/source.path and $WORK_DIR/source.start (seconds to seek in that file).
# On failure writes $WORK_DIR/error-code (youtube_blocked | source_invalid) and exits 1.
set -euo pipefail

work="${WORK_DIR:?}"
mkdir -p "$work/source"

fail() { echo "$2" > "$work/error-message"; echo "$1" > "$work/error-code"; echo "source error: $1" >&2; exit 1; }

dur="${DURATION_SEC:?}"
start="${START_SEC:?}"

if [[ -n "${YOUTUBE_VIDEO_ID:-}" ]]; then
  end=$((start + dur + 1))
  set +e
  yt-dlp --no-playlist --no-progress --no-warnings --no-cache-dir \
    --download-sections "*${start}-${end}" --force-keyframes-at-cuts \
    -f "bv*[height<=1080]" \
    -o "$work/source/clip.%(ext)s" \
    -- "https://www.youtube.com/watch?v=${YOUTUBE_VIDEO_ID}" 2> "$work/ytdlp.err"
  rc=$?
  set -e
  if (( rc != 0 )); then
    cat "$work/ytdlp.err" >&2
    if grep -qiE 'sign in to confirm|not a bot|HTTP Error 429|Too Many Requests' "$work/ytdlp.err"; then
      fail youtube_blocked "YouTube blocked the download from this runner"
    fi
    fail source_invalid "The YouTube video could not be downloaded (private, removed or unavailable)"
  fi
  file="$(find "$work/source" -maxdepth 1 -type f -name 'clip.*' ! -name '*.part' | head -n 1)"
  [[ -n "$file" ]] || fail source_invalid "yt-dlp produced no file"
  seek=0
else
  endpoint="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID:?}.eu.r2.cloudflarestorage.com}"
  file="$work/source/file"
  export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?}"
  export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  aws s3 cp --only-show-errors --endpoint-url "$endpoint" \
    "s3://${R2_BUCKET:?}/${SOURCE_KEY:?}" "$file" 2> "$work/aws.err" \
    || fail source_invalid "The source file could not be downloaded from storage"
  seek="$start"
fi

codec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$file" 2>/dev/null || true)"
[[ -n "$codec" ]] || fail source_invalid "The source has no readable video stream"
length="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$file" 2>/dev/null || true)"
awk -v l="${length:-0}" -v need="$((seek + dur))" 'BEGIN { exit !(l + 0.3 >= need) }' \
  || fail source_invalid "The source is shorter than the requested clip"

echo "$file" > "$work/source.path"
echo "$seek" > "$work/source.start"
echo "source ready"
