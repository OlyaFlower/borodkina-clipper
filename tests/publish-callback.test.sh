#!/usr/bin/env bash
# Integration test: publish.sh against an S3 stand-in (moto) at $R2_ENDPOINT, then callback.mjs against a local HMAC-verifying server.
# Needs: an S3 stand-in running with $R2_ACCESS_KEY_ID/$R2_SECRET_ACCESS_KEY, aws CLI, node, jq, and an encoded dir ($1).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/.."
out="${1:?encoded outdir}"
work="$(mktemp -d)"
export R2_BUCKET=clipper-test MEDIA_ID=med_vid_000000042a DURATION_SEC=8 CLIPPER_ALLOW_LOCAL_CALLBACK=1
export CLIPPER_CALLBACK_SECRET=test-secret-not-real CLIPPER_RETRY_DELAY_MS=50 CLIPPER_ENV=dev
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
server_pid=""
cleanup() { [[ -n "$server_pid" ]] && kill "$server_pid" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

aws --endpoint-url "$R2_ENDPOINT" s3 mb "s3://$R2_BUCKET" >/dev/null

# ---- publish
bash "$root/scripts/publish.sh" "$out"
for f in 1280.h264.mp4:video/mp4 640.h264.mp4:video/mp4 poster.webp:image/webp 1280.av1.webm:video/webm 640.av1.webm:video/webm; do
  name="${f%%:*}"; type="${f##*:}"
  head="$(aws --endpoint-url "$R2_ENDPOINT" s3api head-object --bucket "$R2_BUCKET" --key "videos/$MEDIA_ID/$name")"
  [[ "$(jq -r .ContentType <<<"$head")" == "$type" ]] || { echo "wrong content type for $name"; exit 1; }
  [[ "$(jq -r .CacheControl <<<"$head")" == "public, max-age=31536000, immutable" ]] || { echo "wrong cache-control for $name"; exit 1; }
  [[ "$(jq -r .ContentLength <<<"$head")" == "$(stat -c %s "$out/$name")" ]] || { echo "wrong size for $name"; exit 1; }
done
echo "publish ok"

# ---- publish never overwrites: a second publish of the same media id fails and leaves every object as it was
etags() {
  aws --endpoint-url "$R2_ENDPOINT" s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix "videos/$1/" \
    --query 'Contents[].[Key,ETag,LastModified]' --output text
}
before="$(etags "$MEDIA_ID")"
if bash "$root/scripts/publish.sh" "$out" 2>/dev/null; then echo "a second publish of $MEDIA_ID must fail"; exit 1; fi
[[ "$(etags "$MEDIA_ID")" == "$before" ]] || { echo "a refused publish changed objects"; exit 1; }
# One object of the media id is enough to refuse (an AV1 file the first job did not have must not be added).
aws --endpoint-url "$R2_ENDPOINT" s3 cp "$out/poster.webp" "s3://$R2_BUCKET/videos/med_vid_000000042b/poster.webp" >/dev/null
if MEDIA_ID=med_vid_000000042b bash "$root/scripts/publish.sh" "$out" 2>/dev/null; then
  echo "a media id with any object must be refused"; exit 1
fi
[[ "$(etags med_vid_000000042b | wc -l | tr -d ' ')" == 1 ]] || { echo "a refused publish added objects"; exit 1; }
# The conditional put publish.sh uses is refused by the store when the key exists (the race after the check).
if aws --endpoint-url "$R2_ENDPOINT" s3api put-object --bucket "$R2_BUCKET" --key "videos/$MEDIA_ID/poster.webp" \
  --body "$out/poster.webp" --if-none-match '*' >/dev/null 2>"$work/412.err"; then
  echo "a conditional put over an existing object must fail"; exit 1
fi
grep -q 'PreconditionFailed\|412' "$work/412.err" || { echo "expected 412 Precondition Failed"; cat "$work/412.err"; exit 1; }
[[ "$(etags "$MEDIA_ID")" == "$before" ]] || { echo "a conditional put changed an object"; exit 1; }
if MEDIA_ID=media_42 bash "$root/scripts/publish.sh" "$out" 2>/dev/null; then echo "a non-video media id must be refused"; exit 1; fi
echo "publish refuses to overwrite ok"

# ---- source download path (file mode)
aws --endpoint-url "$R2_ENDPOINT" s3 cp "$out/1280.h264.mp4" "s3://$R2_BUCKET/sources/abc_1" >/dev/null
WORK_DIR="$work/fetch" SOURCE_KEY=sources/abc_1 START_SEC=0 YOUTUBE_VIDEO_ID='' \
  bash "$root/scripts/fetch-source.sh"
[[ -s "$work/fetch/source.path" ]] || { echo "fetch-source wrote no path"; exit 1; }
if WORK_DIR="$work/fetch2" SOURCE_KEY=sources/missing START_SEC=0 YOUTUBE_VIDEO_ID='' \
  bash "$root/scripts/fetch-source.sh" 2>/dev/null; then echo "missing source should fail"; exit 1; fi
[[ "$(cat "$work/fetch2/error-code")" == source_invalid ]] || { echo "expected source_invalid"; exit 1; }
echo "fetch ok"

# ---- a browser recording (MediaRecorder WebM) has no duration in its header: the length comes from
# its packets, so a 10 s recording passes for start 1 and is too short for start 5.
ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i "testsrc2=size=640x360:rate=30:duration=10" \
  -c:v libvpx-vp9 -deadline realtime -b:v 300k -f webm -live 1 "$work/live.webm"
[[ "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$work/live.webm")" == N/A ]] \
  || { echo "fixture should have no header duration"; exit 1; }
aws --endpoint-url "$R2_ENDPOINT" s3 cp "$work/live.webm" "s3://$R2_BUCKET/sources/live_1" >/dev/null
WORK_DIR="$work/live1" SOURCE_KEY=sources/live_1 START_SEC=1 YOUTUBE_VIDEO_ID='' \
  bash "$root/scripts/fetch-source.sh"
[[ -s "$work/live1/source.path" ]] || { echo "a WebM without a header duration should be accepted"; exit 1; }
if WORK_DIR="$work/live5" SOURCE_KEY=sources/live_1 START_SEC=5 YOUTUBE_VIDEO_ID='' \
  bash "$root/scripts/fetch-source.sh" 2>/dev/null; then echo "a 10 s WebM is too short for 5 + 8 s"; exit 1; fi
echo "fetch without header duration ok"

# ---- motion inputs: the cover at sources/<id> and its brief at sources/<id>.json
ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i "testsrc2=size=320x180" -frames:v 1 "$work/cover.jpg"
aws --endpoint-url "$R2_ENDPOINT" s3 cp "$work/cover.jpg" "s3://$R2_BUCKET/sources/cover_1" >/dev/null
echo '{"title":"Test event"}' > "$work/brief.json"
aws --endpoint-url "$R2_ENDPOINT" s3 cp "$work/brief.json" "s3://$R2_BUCKET/sources/cover_1.json" >/dev/null
WORK_DIR="$work/cover1" SOURCE_KEY=sources/cover_1 bash "$root/scripts/fetch-cover.sh"
cmp -s "$work/cover.jpg" "$work/cover1/source/cover" || { echo "fetch-cover got the wrong cover"; exit 1; }
jq -e '.title == "Test event"' "$work/cover1/source/brief.json" >/dev/null || { echo "fetch-cover got the wrong brief"; exit 1; }
aws --endpoint-url "$R2_ENDPOINT" s3 cp "$work/cover.jpg" "s3://$R2_BUCKET/sources/cover_2" >/dev/null
if WORK_DIR="$work/cover2" SOURCE_KEY=sources/cover_2 bash "$root/scripts/fetch-cover.sh" 2>/dev/null; then
  echo "a cover without a brief must fail"; exit 1
fi
[[ "$(cat "$work/cover2/error-code")" == source_invalid ]] || { echo "expected source_invalid without a brief"; exit 1; }
echo '[1,2]' > "$work/array.json"
aws --endpoint-url "$R2_ENDPOINT" s3 cp "$work/array.json" "s3://$R2_BUCKET/sources/cover_2.json" >/dev/null
if WORK_DIR="$work/cover3" SOURCE_KEY=sources/cover_2 bash "$root/scripts/fetch-cover.sh" 2>/dev/null; then
  echo "a brief that is not a JSON object must fail"; exit 1
fi
echo "fetch-cover ok"

# ---- callbacks
mkdir "$work/recv"
FAIL_FIRST=1 node "$here/callback-server.mjs" 18080 "$work/recv" & server_pid=$!
sleep 1
export CALLBACK_URL=http://127.0.0.1:18080/api/v1/video-jobs/job1/callback

node "$root/scripts/callback.mjs" success "$out"   # first attempt gets 503 and is retried
jq -e '.status=="succeeded" and .durationMs==8000 and (.poster.bytes>0)
  and ([.renditions[].file]|index("1280.h264.mp4")!=null) and (.renditions|all(.bytes>0))' \
  "$work/recv/received-1.json" >/dev/null || { echo "bad success body"; cat "$work/recv/received-1.json"; exit 1; }
echo "success callback ok (retry after 503 worked)"

# Both signatures share one timestamp; check them with an independent HMAC (openssl), the legacy one as the
# production admin computes it and v2 as the admin's verifyClipperSignature does.
{ read -r ts; read -r legacy; read -r v2; read -r job; } < "$work/recv/received-1.headers"
hmac() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$CLIPPER_CALLBACK_SECRET" | awk '{print $NF}'; }
body="$(cat "$work/recv/received-1.json")"
[[ "$job" == job1 ]] || { echo "server saw job $job"; exit 1; }
[[ "$legacy" == "$(hmac "$ts.$body")" ]] || { echo "x-clipper-signature is not HMAC(ts.body)"; exit 1; }
[[ "$v2" == "$(hmac "$ts.job1.$body")" ]] || { echo "x-clipper-signature-v2 is not HMAC(ts.jobId.body)"; exit 1; }
[[ "$legacy" != "$v2" ]] || { echo "the two signatures must differ"; exit 1; }
echo "dual signature ok"

# No job in the URL, or a job other than JOB_ID: refused before anything is sent.
if CALLBACK_URL=http://127.0.0.1:18080/api/v1/video-jobs/job1 node "$root/scripts/callback.mjs" failed 2>"$work/nojob.err"; then
  echo "a callback URL without /video-jobs/<id>/callback must be refused"; exit 1
fi
grep -q 'names no job' "$work/nojob.err" || { echo "expected a clear no-job message"; cat "$work/nojob.err"; exit 1; }
if JOB_ID=job2 node "$root/scripts/callback.mjs" failed 2>/dev/null; then
  echo "a callback URL for another job than JOB_ID must be refused"; exit 1
fi
[[ ! -e "$work/recv/received-2.json" ]] || { echo "a refused callback was sent"; exit 1; }

mkdir "$work/wd"; echo youtube_blocked > "$work/wd/error-code"; echo "blocked" > "$work/wd/error-message"
WORK_DIR="$work/wd" node "$root/scripts/callback.mjs" failed
jq -e '.status=="failed" and .error=="youtube_blocked" and .message=="blocked"' "$work/recv/received-2.json" >/dev/null \
  || { echo "bad failed body"; exit 1; }
WORK_DIR="$work/none" node "$root/scripts/callback.mjs" failed
jq -e '.error=="encode_failed"' "$work/recv/received-3.json" >/dev/null || { echo "default error code wrong"; exit 1; }

if CLIPPER_CALLBACK_SECRET=wrong node "$root/scripts/callback.mjs" failed 2>/dev/null; then
  echo "wrong secret must fail"; exit 1
fi
if CALLBACK_URL=https://evil.example/x CLIPPER_ALLOW_LOCAL_CALLBACK=0 node "$root/scripts/callback.mjs" failed 2>/dev/null; then
  echo "foreign URL must be refused"; exit 1
fi

# ---- motion jobs: $WORK_DIR/motion.json adds "motion" to the success body; render_failed is a known code
mkdir "$work/motion"
echo '{"authoring":"claude","model":"claude-opus-5-5","kitVersion":"m1.0"}' > "$work/motion/motion.json"
WORK_DIR="$work/motion" node "$root/scripts/callback.mjs" success "$out"
jq -e '.status=="succeeded" and .motion=={"authoring":"claude","model":"claude-opus-5-5","kitVersion":"m1.0"}' \
  "$work/recv/received-4.json" >/dev/null || { echo "bad motion success body"; cat "$work/recv/received-4.json"; exit 1; }
echo '{"authoring":"fallback","model":null,"kitVersion":"m1.0"}' > "$work/motion/motion.json"
WORK_DIR="$work/motion" node "$root/scripts/callback.mjs" success "$out"
jq -e '.motion.authoring=="fallback" and .motion.model==null' "$work/recv/received-5.json" >/dev/null \
  || { echo "bad fallback motion body"; exit 1; }
for bad in '{"authoring":"human","model":null,"kitVersion":"m1.0"}' \
  '{"authoring":"claude","model":"x y","kitVersion":"m1.0"}' \
  '{"authoring":"claude","model":null,"kitVersion":"m1.0","extra":1}' \
  '{"authoring":"claude","model":null}' '[]' 'not json'; do
  echo "$bad" > "$work/motion/motion.json"
  if WORK_DIR="$work/motion" node "$root/scripts/callback.mjs" success "$out" 2>/dev/null; then
    echo "invalid motion.json must be refused: $bad"; exit 1
  fi
done
[[ ! -e "$work/recv/received-6.json" ]] || { echo "an invalid motion.json was sent"; exit 1; }
mkdir "$work/rf"; echo render_failed > "$work/rf/error-code"
WORK_DIR="$work/rf" node "$root/scripts/callback.mjs" failed
jq -e '.error=="render_failed" and .message=="Rendering the motion video failed"' "$work/recv/received-6.json" >/dev/null \
  || { echo "render_failed body wrong"; exit 1; }
echo "callback tests passed"
