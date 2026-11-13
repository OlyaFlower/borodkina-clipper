#!/usr/bin/env bash
# Usage: motion-gates.sh   Quality gates for a motion render in $WORK_DIR (after motion-render.sh):
#   - master.mp4 and every video in out/ last 8 s within one frame;
#   - frame 0 matches the prepared cover (SSIM >= 0.98): every effect starts at zero;
#   - the last frame matches frame 0 (SSIM >= 0.98): the 8 s loop has no visible jump;
#   - the middle frame differs from frame 0 (SSIM < 0.97): the composition really moves;
#   - determinism: three frames snapshotted twice with HyperFrames (software WebGL) are identical
#     pixel for pixel, or at least SSIM >= 0.999.
# Writes $WORK_DIR/gates.json and, in Actions, a table to the job summary; keeps the snapshots in
# $WORK_DIR/gates/snap-a. On failure writes error-code render_failed and exits 1.
# Needs ffmpeg, ffprobe, jq and motion/node_modules.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
work="${WORK_DIR:?}"
comp="$work/composition"
master="$work/master.mp4"
gates="$work/gates"

fail() { echo "$1" > "$work/error-message"; echo render_failed > "$work/error-code"; echo "motion gate failed: $1" >&2; exit 1; }
[[ -s "$master" && -s "$comp/assets/cover.jpg" ]] || fail "The render to check is missing"
rm -rf "$gates"
mkdir -p "$gates"
began=$SECONDS

# ---- duration, 8 s within one frame
frame=$(awk 'BEGIN { printf "%.4f", 1 / 30 }')
for f in "$master" "$work"/out/*.webm "$work"/out/*.mp4; do
  [[ -f "$f" ]] || continue
  d="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"
  awk -v d="$d" -v f="$frame" 'BEGIN { exit !((d - 8) <= f && (8 - d) <= f) }' \
    || fail "$(basename "$f") lasts $d s, expected 8 s within one frame"
done

# ---- frame 0, middle and last against the cover and each other
grab() { # index output
  ffmpeg -hide_banner -loglevel error -nostdin -y -i "$master" \
    -vf "select=eq(n\,$1)" -fps_mode passthrough -frames:v 1 "$2"
}
ssim() { # a b -> SSIM "All" value
  ffmpeg -hide_banner -nostdin -i "$1" -i "$2" \
    -lavfi "[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim" -f null - 2>&1 \
    | sed -n 's/.*All:\([0-9.]*\).*/\1/p' | tail -n 1
}
grab 0 "$gates/f000.png"
grab 120 "$gates/f120.png"
grab 239 "$gates/f239.png"
cover_ssim="$(ssim "$gates/f000.png" "$comp/assets/cover.jpg")"
loop_ssim="$(ssim "$gates/f000.png" "$gates/f239.png")"
mid_ssim="$(ssim "$gates/f000.png" "$gates/f120.png")"
[[ -n "$cover_ssim" && -n "$loop_ssim" && -n "$mid_ssim" ]] || fail "SSIM could not be measured"

# ---- determinism: the same three frames twice, from two fresh browser sessions
hf="$root/motion/node_modules/.bin/hyperframes"
export HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_TELEMETRY=1
at=0.5,4,6.5
for run in a b; do
  "$hf" snapshot "$comp" --at "$at" --no-end --no-browser-gpu -o "$gates/snap-$run" > "$gates/snap-$run.log" 2>&1 \
    || { tail -n 20 "$gates/snap-$run.log" >&2; fail "HyperFrames could not snapshot the composition"; }
done
rm -f "$gates"/snap-?/contact-sheet.jpg
pixels() { ffmpeg -hide_banner -loglevel error -nostdin -i "$1" -f md5 - 2>/dev/null; }
det_min=1
det_identical=true
shots=0
for a in "$gates"/snap-a/*.png; do
  b="$gates/snap-b/$(basename "$a")"
  [[ -f "$b" ]] || fail "Snapshot $(basename "$a") is missing from the second run"
  shots=$((shots + 1))
  if [[ "$(pixels "$a")" != "$(pixels "$b")" ]]; then
    det_identical=false
    s="$(ssim "$a" "$b")"
    det_min="$(awk -v a="$det_min" -v b="${s:-0}" 'BEGIN { print (b < a ? b : a) }')"
  fi
done
(( shots == 3 )) || fail "Expected 3 determinism snapshots, got $shots"
gate_seconds=$((SECONDS - began))

jq -n --argjson cover "$cover_ssim" --argjson loop "$loop_ssim" --argjson mid "$mid_ssim" \
  --argjson identical "$det_identical" --argjson detMin "$det_min" --argjson seconds "$gate_seconds" \
  '{ssimFrame0Cover: $cover, ssimFirstLast: $loop, ssimFirstMiddle: $mid,
    snapshotsIdentical: $identical, snapshotsMinSsim: $detMin, gateSeconds: $seconds}' > "$work/gates.json"
echo "gates: frame 0 vs cover $cover_ssim, first vs last $loop_ssim, first vs middle $mid_ssim," \
  "snapshots identical $det_identical (min SSIM $det_min), ${gate_seconds} s"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "| Gate | Value |"
    echo "| --- | --- |"
    echo "| SSIM frame 0 vs cover (>= 0.98) | $cover_ssim |"
    echo "| SSIM first vs last frame (>= 0.98) | $loop_ssim |"
    echo "| SSIM first vs middle frame (< 0.97) | $mid_ssim |"
    echo "| Snapshots identical twice | $det_identical (min SSIM $det_min, >= 0.999) |"
    echo "| Gates (wall) | ${gate_seconds} s |"
    echo
  } >> "$GITHUB_STEP_SUMMARY"
fi

awk -v s="$cover_ssim" 'BEGIN { exit !(s >= 0.98) }' || fail "Frame 0 does not match the cover (SSIM $cover_ssim)"
awk -v s="$loop_ssim" 'BEGIN { exit !(s >= 0.98) }' || fail "The last frame does not match frame 0 (SSIM $loop_ssim)"
awk -v s="$mid_ssim" 'BEGIN { exit !(s < 0.97) }' || fail "The middle frame barely differs from frame 0 (SSIM $mid_ssim)"
awk -v s="$det_min" 'BEGIN { exit !(s >= 0.999) }' || fail "The composition is not deterministic (SSIM $det_min)"
echo "motion gates passed"
