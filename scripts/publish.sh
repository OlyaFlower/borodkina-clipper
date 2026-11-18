#!/usr/bin/env bash
# Usage: publish.sh <outdir>
# Uploads the renditions and poster to videos/<MEDIA_ID>/ in R2 (S3 API). Never overwrites: it refuses when
# anything already exists under videos/<MEDIA_ID>/, and each upload is a conditional put (If-None-Match: *),
# so an object that appears in the meantime is not replaced either (HTTP 412). The admin gives every job a new
# media id, so a legitimate job never meets an existing object; a dispatch that names an existing media id
# (for example someone else's video in prod) fails here without touching it.
# Env: MEDIA_ID R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET (R2_ENDPOINT: see r2-endpoint.sh).
set -euo pipefail
out="$1"
media="${MEDIA_ID:?}"
[[ "$media" =~ ^med_vid_[0-9a-f]{10}$ ]] || { echo "bad MEDIA_ID" >&2; exit 2; }
source "$(dirname "${BASH_SOURCE[0]}")/r2-endpoint.sh"
export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?}"
export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
bucket="${R2_BUCKET:?}"

for required in 1280.h264.mp4 640.h264.mp4 poster.webp; do
  [[ -f "$out/$required" ]] || { echo "missing $required" >&2; exit 1; }
done

existing="$(aws s3api list-objects-v2 --endpoint-url "$endpoint" --bucket "$bucket" \
  --prefix "videos/$media/" --max-keys 1 --no-paginate --query 'KeyCount' --output text)"
if [[ "$existing" != 0 ]]; then
  echo "refusing to publish: videos/$media/ already has objects" >&2
  exit 1
fi

upload() { # file content-type
  [[ -f "$out/$1" ]] || return 0
  aws s3api put-object --endpoint-url "$endpoint" --bucket "$bucket" --key "videos/$media/$1" \
    --body "$out/$1" --content-type "$2" --cache-control "public, max-age=31536000, immutable" \
    --if-none-match '*' > /dev/null
  echo "uploaded $1"
}

upload 1280.av1.webm video/webm
upload 640.av1.webm video/webm
upload 1280.h264.mp4 video/mp4
upload 640.h264.mp4 video/mp4
upload poster.webp image/webp
