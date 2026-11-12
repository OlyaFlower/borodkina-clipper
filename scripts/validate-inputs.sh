#!/usr/bin/env bash
# Validates the workflow inputs, passed ONLY through the environment:
# JOB_ID MEDIA_ID CLIPPER_ENV YOUTUBE_VIDEO_ID SOURCE_KEY START_SEC DURATION_SEC CALLBACK_URL
# Exits 1 with a short message on the first problem. Never echoes a rejected value.
set -euo pipefail

fail() { echo "invalid input: $1" >&2; exit 1; }

id_re='^[A-Za-z0-9_-]{1,64}$'
[[ "${JOB_ID-}" =~ $id_re ]] || fail "jobId"
[[ "${MEDIA_ID-}" =~ $id_re ]] || fail "mediaId"

yt="${YOUTUBE_VIDEO_ID-}"
src="${SOURCE_KEY-}"
if [[ -n "$yt" && -n "$src" ]] || [[ -z "$yt" && -z "$src" ]]; then
  fail "exactly one of youtubeVideoId and sourceKey is required"
fi
if [[ -n "$yt" ]]; then
  [[ "$yt" =~ ^[A-Za-z0-9_-]{11}$ ]] || fail "youtubeVideoId"
else
  [[ "$src" =~ ^sources/[A-Za-z0-9_-]{1,64}$ ]] || fail "sourceKey"
fi

num_re='^(0|[1-9][0-9]{0,5})$'
[[ "${START_SEC-}" =~ $num_re ]] || fail "startSec"
(( START_SEC <= 86400 )) || fail "startSec"
[[ "${DURATION_SEC-}" =~ $num_re ]] || fail "durationSec"
(( DURATION_SEC >= 5 && DURATION_SEC <= 10 )) || fail "durationSec"

case "${CLIPPER_ENV-}" in
  dev) prefix='https://dev-admin.borodkinamusic.com/api/v1/video-jobs/' ;;
  prod) prefix='https://admin.borodkinamusic.com/api/v1/video-jobs/' ;;
  *) fail "env" ;;
esac
url="${CALLBACK_URL-}"
[[ "$url" == "$prefix"* ]] || fail "callbackUrl"
rest="${url#"$prefix"}"
[[ "$rest" =~ ^[A-Za-z0-9_./-]*$ ]] || fail "callbackUrl"
[[ "$rest" != *..* ]] || fail "callbackUrl"
echo "inputs ok"
