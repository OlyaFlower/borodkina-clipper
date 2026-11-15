#!/usr/bin/env bash
# Usage: validate-inputs.sh [clip|motion]   (default clip)
# Validates the workflow inputs, passed ONLY through the environment:
#   clip:   JOB_ID MEDIA_ID CLIPPER_ENV YOUTUBE_VIDEO_ID SOURCE_KEY START_SEC DURATION_SEC CALLBACK_URL
#   motion: JOB_ID MEDIA_ID CLIPPER_ENV SOURCE_KEY CALLBACK_URL
# Exits 1 with a short message on the first problem. Never echoes a rejected value.
set -euo pipefail

fail() { echo "invalid input: $1" >&2; exit 1; }

mode="${1:-clip}"
[[ "$mode" == clip || "$mode" == motion ]] || { echo "usage: validate-inputs.sh [clip|motion]" >&2; exit 2; }

id_re='^[A-Za-z0-9_-]{1,64}$'
# The admin's video media ids (newVideoMediaId): "med_vid_" and 10 lowercase hex digits. Nothing else is published.
media_re='^med_vid_[0-9a-f]{10}$'
source_re='^sources/[A-Za-z0-9_-]{1,64}$'
[[ "${JOB_ID-}" =~ $id_re ]] || fail "jobId"
[[ "${MEDIA_ID-}" =~ $media_re ]] || fail "mediaId"

if [[ "$mode" == motion ]]; then
  [[ "${SOURCE_KEY-}" =~ $source_re ]] || fail "sourceKey"
else
  yt="${YOUTUBE_VIDEO_ID-}"
  src="${SOURCE_KEY-}"
  if [[ -n "$yt" && -n "$src" ]] || [[ -z "$yt" && -z "$src" ]]; then
    fail "exactly one of youtubeVideoId and sourceKey is required"
  fi
  if [[ -n "$yt" ]]; then
    [[ "$yt" =~ ^[A-Za-z0-9_-]{11}$ ]] || fail "youtubeVideoId"
  else
    [[ "$src" =~ $source_re ]] || fail "sourceKey"
  fi

  num_re='^(0|[1-9][0-9]{0,5})$'
  [[ "${START_SEC-}" =~ $num_re ]] || fail "startSec"
  (( START_SEC <= 86400 )) || fail "startSec"
  [[ "${DURATION_SEC-}" =~ $num_re ]] || fail "durationSec"
  (( DURATION_SEC >= 5 && DURATION_SEC <= 10 )) || fail "durationSec"
fi

# The environment (and with it the GitHub Environment and its secrets) is one of exactly two names.
case "${CLIPPER_ENV-}" in
  dev) prefix='https://dev-admin.borodkinamusic.com/api/v1/video-jobs/' ;;
  prod) prefix='https://admin.borodkinamusic.com/api/v1/video-jobs/' ;;
  *) fail "env" ;;
esac
# Exactly the admin's callback route for this job, <prefix><jobId>/callback, so the job the callback is
# signed for (scripts/callback.mjs) is the job that was dispatched.
[[ "${CALLBACK_URL-}" == "${prefix}${JOB_ID}/callback" ]] || fail "callbackUrl"
echo "inputs ok"
