#!/usr/bin/env bash
# The injection cases are single-quoted on purpose: they must reach the validator unexpanded.
# shellcheck disable=SC2016
# Unit tests for scripts/validate-inputs.sh: good inputs pass, bad and hostile inputs fail.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../scripts/validate-inputs.sh"
failures=0

DEV='https://dev-admin.borodkinamusic.com/api/v1/video-jobs/'
PROD='https://admin.borodkinamusic.com/api/v1/video-jobs/'

# run <expect ok|fail> <label> [VAR=value overrides...]
run() {
  local expect="$1" label="$2"; shift 2
  local -a base=(
    "JOB_ID=job_1-A" "MEDIA_ID=media-1" "CLIPPER_ENV=dev" "YOUTUBE_VIDEO_ID=dQw4w9WgXcQ"
    "SOURCE_KEY=" "START_SEC=10" "DURATION_SEC=8" "CALLBACK_URL=${DEV}job_1-A/callback"
  )
  local -a final=() item key skip
  for item in "${base[@]}"; do
    key="${item%%=*}"; skip=0
    for o in "$@"; do [[ "${o%%=*}" == "$key" ]] && skip=1; done
    (( skip )) || final+=("$item")
  done
  final+=("$@")
  if env -i PATH="$PATH" "${final[@]}" bash "$script" >/dev/null 2>&1; then got=ok; else got=fail; fi
  if [[ "$got" != "$expect" ]]; then echo "FAIL: $label (expected $expect, got $got)"; failures=$((failures + 1)); else echo "ok: $label"; fi
}

run ok "baseline youtube"
run ok "prod env" CLIPPER_ENV=prod "CALLBACK_URL=${PROD}x/callback"
run ok "source file" YOUTUBE_VIDEO_ID= SOURCE_KEY=sources/abc_DEF-1
run ok "start 0 / duration 5" START_SEC=0 DURATION_SEC=5
run ok "start 86400 / duration 10" START_SEC=86400 DURATION_SEC=10

run fail "empty jobId" JOB_ID=
run fail "jobId too long" "JOB_ID=$(printf 'a%.0s' {1..65})"
run fail "jobId with space" "JOB_ID=a b"
run fail "jobId injection" 'JOB_ID=a$(touch pwned)'
run fail "jobId backtick" 'JOB_ID=a`id`'
run fail "jobId semicolon" 'JOB_ID=a;rm -rf /'
run fail "jobId newline" "JOB_ID=$(printf 'abc\nWORK=1')"
run fail "mediaId slash" MEDIA_ID=../etc
run fail "both youtube and source" SOURCE_KEY=sources/abc
run fail "neither youtube nor source" YOUTUBE_VIDEO_ID=
run fail "youtube id too short" YOUTUBE_VIDEO_ID=abc
run fail "youtube id with option" YOUTUBE_VIDEO_ID=--exec-calc1
run fail "youtube id injection" 'YOUTUBE_VIDEO_ID=$(id)aaaaaaaa'
run fail "sourceKey traversal" YOUTUBE_VIDEO_ID= SOURCE_KEY=sources/../x
run fail "sourceKey wrong folder" YOUTUBE_VIDEO_ID= SOURCE_KEY=videos/abc
run fail "sourceKey nested" YOUTUBE_VIDEO_ID= SOURCE_KEY=sources/a/b
run fail "startSec negative" START_SEC=-1
run fail "startSec too large" START_SEC=86401
run fail "startSec float" START_SEC=1.5
run fail "startSec leading zero" START_SEC=01
run fail "startSec arithmetic injection" 'START_SEC=a[$(id)]'
run fail "durationSec 4" DURATION_SEC=4
run fail "durationSec 11" DURATION_SEC=11
run fail "durationSec text" DURATION_SEC=eight
run fail "env staging" CLIPPER_ENV=staging
run fail "env empty" CLIPPER_ENV=
run fail "dev env with prod url" "CALLBACK_URL=${PROD}x"
run fail "prod env with dev url" CLIPPER_ENV=prod "CALLBACK_URL=${DEV}x"
run fail "callback other host" CALLBACK_URL=https://evil.example/api/v1/video-jobs/x
run fail "callback userinfo trick" "CALLBACK_URL=https://dev-admin.borodkinamusic.com.evil.example/api/v1/video-jobs/x"
run fail "callback http" CALLBACK_URL=http://dev-admin.borodkinamusic.com/api/v1/video-jobs/x
run fail "callback query" "CALLBACK_URL=${DEV}x?a=b"
run fail "callback fragment" "CALLBACK_URL=${DEV}x#y"
run fail "callback traversal" "CALLBACK_URL=${DEV}../../other"
run fail "callback at sign" "CALLBACK_URL=${DEV}x@evil.example"
run fail "callback with space" "CALLBACK_URL=${DEV}x y"
run fail "callback newline" "CALLBACK_URL=$(printf '%sx\nfoo' "$DEV")"

if (( failures > 0 )); then echo "$failures failure(s)"; exit 1; fi
echo "all validation tests passed"
