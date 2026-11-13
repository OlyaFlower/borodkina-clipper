#!/usr/bin/env bash
# Integration test: renders motion/compositions/smoke with the fixture cover through scripts/motion-render.sh
# (HyperFrames render, encode.sh, verify.sh) and checks the loop:
#   - all five outputs exist and every video lasts 8 s within one frame;
#   - frame 0 matches the cover (SSIM >= 0.95): the effects start at zero intensity and the transform is identity,
#     so only H.264 (CRF, yuv420p chroma subsampling) loss remains. That loss keeps SSIM around 0.97-0.99 on this
#     saturated test pattern, while a 1.06 push-in, a light sweep or the dust left on at frame 0 drops it well below;
#   - the last frame matches frame 0 (SSIM >= 0.98), so the 8 s loop has no visible jump;
#   - the middle frame differs from frame 0 (SSIM < 0.95), so the composition really animates.
# Needs: ffmpeg, ffprobe, jq, node and motion/node_modules. Writes a summary to $GITHUB_STEP_SUMMARY when set.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ---- a cover that is not an image is refused before any render
printf '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\nfile:///etc/passwd\n' > "$work/playlist"
if WORK_DIR="$work/bad" bash "$root/scripts/motion-render.sh" "$root/motion/compositions/smoke" "$work/playlist" 2>/dev/null; then
  echo "a playlist must not be accepted as a cover"; exit 1
fi
[[ "$(cat "$work/bad/error-code")" == source_invalid ]] || { echo "expected source_invalid for a non-image cover"; exit 1; }
echo "non-image cover refused"

# ---- the real render; the cover has no extension, like sources/<id> fetched from R2
cp "$root/tests/fixtures/cover.jpg" "$work/cover"
WORK_DIR="$work/run" bash "$root/scripts/motion-render.sh" "$root/motion/compositions/smoke" "$work/cover"
run="$work/run"
out="$run/out"

for f in 1280.av1.webm 640.av1.webm 1280.h264.mp4 640.h264.mp4 poster.webp; do
  [[ -s "$out/$f" ]] || { echo "missing $f"; exit 1; }
done

frame=$(awk 'BEGIN { printf "%.4f", 1 / 30 }')
for f in master.mp4 out/1280.av1.webm out/640.av1.webm out/1280.h264.mp4 out/640.h264.mp4; do
  d="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$run/$f")"
  awk -v d="$d" -v f="$frame" 'BEGIN { exit !((d - 8) <= f && (8 - d) <= f) }' \
    || { echo "$f lasts $d s, expected 8 s within one frame"; exit 1; }
  echo "$f: ${d} s"
done

grab() { # index output
  ffmpeg -hide_banner -loglevel error -nostdin -y -i "$run/master.mp4" \
    -vf "select=eq(n\,$1)" -fps_mode passthrough -frames:v 1 "$2"
}
ssim() { # a b -> SSIM "All" value
  ffmpeg -hide_banner -nostdin -i "$1" -i "$2" \
    -lavfi "[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim" -f null - 2>&1 \
    | sed -n 's/.*All:\([0-9.]*\).*/\1/p' | tail -n 1
}
grab 0 "$work/f0.png"
grab 120 "$work/f120.png"
grab 239 "$work/f239.png"

cover_ssim="$(ssim "$work/f0.png" "$run/composition/assets/cover.png")"
loop_ssim="$(ssim "$work/f0.png" "$work/f239.png")"
mid_ssim="$(ssim "$work/f0.png" "$work/f120.png")"
echo "SSIM frame 0 vs cover: $cover_ssim; frame 0 vs last: $loop_ssim; frame 0 vs middle: $mid_ssim"
render_seconds="$(cat "$run/render-seconds")"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Motion smoke render"
    echo "| Measure | Value |"
    echo "| --- | --- |"
    echo "| HyperFrames render (wall) | ${render_seconds} s |"
    echo "| SSIM frame 0 vs cover (>= 0.95) | $cover_ssim |"
    echo "| SSIM frame 0 vs last frame (>= 0.98) | $loop_ssim |"
    echo "| SSIM frame 0 vs middle frame (< 0.95) | $mid_ssim |"
    for f in 1280.av1.webm 640.av1.webm 1280.h264.mp4 640.h264.mp4 poster.webp; do
      echo "| $f | $(stat -c %s "$out/$f") bytes |"
    done
    echo
    echo '```'
    grep -E 'rendered in|capture ·|gpu' "$run/render.log" | head -n 5 || true
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

awk -v s="$cover_ssim" 'BEGIN { exit !(s >= 0.95) }' || { echo "frame 0 does not match the cover"; exit 1; }
awk -v s="$loop_ssim" 'BEGIN { exit !(s >= 0.98) }' || { echo "the last frame does not match frame 0"; exit 1; }
awk -v s="$mid_ssim" 'BEGIN { exit !(s < 0.95) }' || { echo "the middle frame barely differs from frame 0"; exit 1; }
echo "motion smoke test passed (render ${render_seconds} s)"
