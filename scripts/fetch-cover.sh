#!/usr/bin/env bash
# Gets a motion job's inputs from R2 into $WORK_DIR/source and prints nothing secret:
#   $SOURCE_KEY       -> $WORK_DIR/source/cover       (the event cover: JPEG, PNG or WebP, at most 20 MiB)
#   $SOURCE_KEY.json  -> $WORK_DIR/source/brief.json  (the brief: a JSON object, at most 64 KiB)
# Env: WORK_DIR SOURCE_KEY R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET (R2_ENDPOINT overrides, for tests).
# On failure writes $WORK_DIR/error-code (source_invalid) and error-message, and exits 1.
set -euo pipefail

work="${WORK_DIR:?}"
mkdir -p "$work/source"

fail() { echo "$1" > "$work/error-message"; echo source_invalid > "$work/error-code"; echo "source error: $1" >&2; exit 1; }

key="${SOURCE_KEY:?}"
[[ "$key" =~ ^sources/[A-Za-z0-9_-]{1,64}$ ]] || fail "The source key is not valid"
endpoint="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID:?}.eu.r2.cloudflarestorage.com}"
export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?}"
export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
bucket="${R2_BUCKET:?}"

cover="$work/source/cover"
brief="$work/source/brief.json"
aws s3 cp --only-show-errors --endpoint-url "$endpoint" "s3://$bucket/$key" "$cover" 2> "$work/aws.err" \
  || fail "The cover could not be downloaded from storage"
aws s3 cp --only-show-errors --endpoint-url "$endpoint" "s3://$bucket/$key.json" "$brief" 2> "$work/aws.err" \
  || fail "The brief could not be downloaded from storage"

size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }
(( $(size "$cover") > 0 && $(size "$cover") <= 20 * 1024 * 1024 )) || fail "The cover is empty or larger than 20 MiB"
(( $(size "$brief") <= 64 * 1024 )) || fail "The brief is larger than 64 KiB"
jq -e 'type == "object"' "$brief" > /dev/null 2>&1 || fail "The brief is not a JSON object"

echo "cover and brief ready"
