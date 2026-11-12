#!/usr/bin/env bash
# Usage: publish.sh <outdir>
# Uploads the renditions and poster to videos/<MEDIA_ID>/ in R2 (S3 API).
# Env: MEDIA_ID R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET (R2_ENDPOINT overrides, for tests).
set -euo pipefail
out="$1"
media="${MEDIA_ID:?}"
[[ "$media" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "bad MEDIA_ID" >&2; exit 2; }
endpoint="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID:?}.eu.r2.cloudflarestorage.com}"
export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?}"
export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
bucket="${R2_BUCKET:?}"

for required in 1280.h264.mp4 640.h264.mp4 poster.webp; do
  [[ -f "$out/$required" ]] || { echo "missing $required" >&2; exit 1; }
done

upload() { # file content-type
  [[ -f "$out/$1" ]] || return 0
  aws s3 cp --only-show-errors --endpoint-url "$endpoint" \
    --content-type "$2" --cache-control "public, max-age=31536000, immutable" \
    "$out/$1" "s3://$bucket/videos/$media/$1"
  echo "uploaded $1"
}

upload 1280.av1.webm video/webm
upload 640.av1.webm video/webm
upload 1280.h264.mp4 video/mp4
upload 640.h264.mp4 video/mp4
upload poster.webp image/webp
