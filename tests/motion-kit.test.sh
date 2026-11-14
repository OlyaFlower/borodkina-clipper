#!/usr/bin/env bash
# Usage: motion-kit.test.sh <fixture> [<preset>|auto]   (fixtures in tests/fixtures/motion; default auto)
# Integration test of the fallback motion pipeline, as motion.yml runs it: motion-prepare.sh, the preset the
# chooser picks (motion/kit/choose.mjs; or the named preset) rendered through motion-render.sh (assemble,
# HyperFrames render, encode.sh, verify.sh) and motion-gates.sh. With auto it also runs the prepare unit
# tests, checks that a non-image cover is refused as source_invalid, and checks what prepare and the
# chooser found for the fixture:
#   stage      16:10 concert scene: cropped, no faces (silhouettes are not faces)  -> concert-glow;
#   poster     4:5 drawn portrait: blurred extension, the drawn face is detected     -> poster-float;
#   landscape  2.2:1 hills at dusk: cropped, no faces, the sun is a light            -> sunlit-depth;
#   flat       an almost uniform dark wash: no edges, no lights                      -> night-stage.
# Copies the five gate snapshots (0, 2, 4, 6, 8 s) to $SNAPSHOT_DIR/<fixture>-<preset>/ when set.
# Needs: ffmpeg, ffprobe, jq, node, Python 3.12 and motion/node_modules. Writes timings to $GITHUB_STEP_SUMMARY when set.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
fixture="${1:?usage: motion-kit.test.sh <fixture> [<preset>|auto]}"
preset="${2:-auto}"
[[ "$fixture" =~ ^(stage|poster|landscape|flat)$ ]] || { echo "unknown fixture $fixture"; exit 2; }
[[ "$preset" == auto || -f "$root/motion/kit/presets/$preset.json" ]] || { echo "unknown preset $preset"; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

py="$(bash "$root/scripts/motion-prepare.sh" --setup)"
if [[ "$preset" == auto ]]; then
  "$py" -I "$here/motion_prepare_test.py"
  # A cover that is not an image is refused before any analysis.
  printf '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\nfile:///etc/passwd\n' > "$work/playlist"
  if WORK_DIR="$work/bad" bash "$root/scripts/motion-prepare.sh" "$work/playlist" "$work/bad/prepare" 2>/dev/null; then
    echo "a playlist must not be accepted as a cover"; exit 1
  fi
  [[ "$(cat "$work/bad/error-code")" == source_invalid ]] || { echo "expected source_invalid for a non-image cover"; exit 1; }
  echo "non-image cover refused"
fi

# ---- prepare; the cover has no extension, like sources/<id> fetched from R2
run="$work/run"
mkdir -p "$run/source"
cp "$root/tests/fixtures/motion/$fixture.jpg" "$run/source/cover"
WORK_DIR="$run" bash "$root/scripts/motion-prepare.sh" "$run/source/cover" "$run/prepare"
meta="$run/prepare/meta.json"
mode="$(jq -r .framing.mode "$meta")"
faces="$(jq '.faces | length' "$meta")"
case "$fixture" in
  stage | landscape | flat) [[ "$mode" == crop && "$faces" == 0 ]] || { echo "$fixture: expected crop and no faces, got $mode, $faces"; exit 1; } ;;
  poster)
    [[ "$mode" == extend && "$faces" -ge 1 && -s "$run/prepare/background.jpg" ]] \
      || { echo "poster: expected extend with a face, got $mode, $faces"; exit 1; }
    ;;
esac
if [[ "$mode" == crop ]]; then
  [[ -s "$run/prepare/plate.jpg" && -s "$run/prepare/plate-depth.png" ]] || { echo "crop mode needs the occlusion plate"; exit 1; }
fi
for f in edges.png glow.png; do [[ -s "$run/prepare/$f" ]] || { echo "missing $f"; exit 1; }; done
jq -e '.palette.colors | length == 5' "$meta" > /dev/null || { echo "palette must have 5 colours"; exit 1; }
jq -e '.focus | .x >= 0 and .x <= 1 and .y >= 0 and .y <= 1 and .depth >= 0 and .depth <= 1' "$meta" > /dev/null \
  || { echo "focus out of range"; exit 1; }
jq -e '.tone.key and (.lights | type == "array")' "$meta" > /dev/null || { echo "tone and lights are missing"; exit 1; }
size="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$run/prepare/cover.jpg")"
[[ "$size" == 1920,1080 ]] || { echo "prepared cover is $size, expected 1920x1080"; exit 1; }

# ---- the fallback author step: the chooser's preset (motion.yml does the same)
chosen="$(node "$root/motion/kit/choose.mjs" "$meta")"
if [[ "$preset" == auto ]]; then
  declare -A expected=([stage]=concert-glow [poster]=poster-float [landscape]=sunlit-depth [flat]=night-stage)
  [[ "$chosen" == "${expected[$fixture]}" ]] || { echo "$fixture: the chooser picked $chosen, expected ${expected[$fixture]}"; exit 1; }
  preset="$chosen"
fi
mkdir -p "$run/scene"
cp "$root/motion/kit/presets/$preset.json" "$run/scene/scene.json"
echo '{"authoring":"fallback","model":null,"kitVersion":"kit-2"}' > "$run/motion.json"

# ---- render, encode, verify, gates
WORK_DIR="$run" bash "$root/scripts/motion-render.sh" "$run/scene" "$run/prepare"
for f in 1280.av1.webm 640.av1.webm 1280.h264.mp4 640.h264.mp4 poster.webp; do
  [[ -s "$run/out/$f" ]] || { echo "missing $f"; exit 1; }
done
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Motion kit: $fixture, $preset"
    echo "| Step | Value |"
    echo "| --- | --- |"
    echo "| Framing | $mode, $faces face(s), focus $(jq -r '.focus.source' "$meta"), tone $(jq -c .tone "$meta") |"
    echo "| Chooser | $chosen |"
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
  mkdir -p "$SNAPSHOT_DIR/$fixture-$preset"
  cp "$run"/gates/snap-a/at-*s.png "$SNAPSHOT_DIR/$fixture-$preset/"
fi
echo "motion kit test passed for $fixture with $preset (prepare $(cat "$run/prepare-seconds") s, render $(cat "$run/render-seconds") s)"
