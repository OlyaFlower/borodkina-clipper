#!/usr/bin/env bash
# Usage: motion-kit.test.sh <fixture>   (stage, poster or landscape from tests/fixtures/motion)
# Integration test of the fallback motion pipeline, as motion.yml runs it: motion-prepare.sh, the kit default
# composition through motion-render.sh (HyperFrames render, encode.sh, verify.sh) and motion-gates.sh.
# Also checks that a non-image cover is refused as source_invalid, runs the prepare unit tests and checks
# what prepare found for the fixture:
#   stage      16:10 concert scene: cropped, no faces (silhouettes are not faces);
#   poster     4:5 drawn portrait: blurred extension, the drawn face is detected;
#   landscape  2.2:1 hills: cropped, no faces.
# Copies the three determinism snapshots to $SNAPSHOT_DIR/<fixture>/ when set (CI uploads them for review).
# Needs: ffmpeg, ffprobe, jq, node, Python 3.12 and motion/node_modules. Writes timings to $GITHUB_STEP_SUMMARY when set.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
fixture="${1:?usage: motion-kit.test.sh <fixture>}"
[[ "$fixture" =~ ^(stage|poster|landscape)$ ]] || { echo "unknown fixture $fixture"; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ---- setup (pinned packages and models), then the prepare unit tests
py="$(bash "$root/scripts/motion-prepare.sh" --setup)"
"$py" -I "$here/motion_prepare_test.py"

# ---- a cover that is not an image is refused before any analysis
printf '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\nfile:///etc/passwd\n' > "$work/playlist"
if WORK_DIR="$work/bad" bash "$root/scripts/motion-prepare.sh" "$work/playlist" "$work/bad/prepare" 2>/dev/null; then
  echo "a playlist must not be accepted as a cover"; exit 1
fi
[[ "$(cat "$work/bad/error-code")" == source_invalid ]] || { echo "expected source_invalid for a non-image cover"; exit 1; }
echo "non-image cover refused"

# ---- prepare; the cover has no extension, like sources/<id> fetched from R2
run="$work/run"
mkdir -p "$run/source"
cp "$root/tests/fixtures/motion/$fixture.jpg" "$run/source/cover"
WORK_DIR="$run" bash "$root/scripts/motion-prepare.sh" "$run/source/cover" "$run/prepare"
meta="$run/prepare/meta.json"
mode="$(jq -r .framing.mode "$meta")"
faces="$(jq '.faces | length' "$meta")"
case "$fixture" in
  stage | landscape) [[ "$mode" == crop && "$faces" == 0 ]] || { echo "$fixture: expected crop and no faces, got $mode, $faces"; exit 1; } ;;
  poster)
    [[ "$mode" == extend && "$faces" -ge 1 && -s "$run/prepare/background.jpg" ]] \
      || { echo "poster: expected extend with a face, got $mode, $faces"; exit 1; }
    ;;
esac
jq -e '.palette.colors | length == 5' "$meta" > /dev/null || { echo "palette must have 5 colours"; exit 1; }
jq -e '.focus | .x >= 0 and .x <= 1 and .y >= 0 and .y <= 1 and .depth >= 0 and .depth <= 1' "$meta" > /dev/null \
  || { echo "focus out of range"; exit 1; }
size="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$run/prepare/cover.jpg")"
[[ "$size" == 1920,1080 ]] || { echo "prepared cover is $size, expected 1920x1080"; exit 1; }

# ---- render, encode, verify, gates
WORK_DIR="$run" bash "$root/scripts/motion-render.sh" "$root/motion/kit/default" "$run/prepare"
for f in 1280.av1.webm 640.av1.webm 1280.h264.mp4 640.h264.mp4 poster.webp; do
  [[ -s "$run/out/$f" ]] || { echo "missing $f"; exit 1; }
done
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Motion kit: $fixture"
    echo "| Step | Value |"
    echo "| --- | --- |"
    echo "| Framing | $mode, $faces face(s), focus $(jq -r '.focus.source' "$meta") |"
    echo "| Prepare (wall, with setup) | $(cat "$run/prepare-seconds") s |"
    echo "| Prepare timings (ms) | $(jq -c .timings "$meta") |"
    echo "| HyperFrames render (wall) | $(cat "$run/render-seconds") s |"
    for f in 1280.av1.webm 640.av1.webm 1280.h264.mp4 640.h264.mp4 poster.webp; do
      echo "| $f | $(stat -c %s "$run/out/$f") bytes |"
    done
    echo
  } >> "$GITHUB_STEP_SUMMARY"
fi
WORK_DIR="$run" bash "$root/scripts/motion-gates.sh"

if [[ -n "${SNAPSHOT_DIR:-}" ]]; then
  mkdir -p "$SNAPSHOT_DIR/$fixture"
  cp "$run"/gates/snap-a/*.png "$SNAPSHOT_DIR/$fixture/"
fi
echo "motion kit test passed for $fixture (prepare $(cat "$run/prepare-seconds") s, render $(cat "$run/render-seconds") s)"
