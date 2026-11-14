#!/usr/bin/env bash
# Usage: motion-gates.sh   Quality gates for a motion render in $WORK_DIR (after motion-render.sh):
#   - master.mp4 and every video in out/ last 8 s within one frame;
#   - frame 0 matches the prepared cover (SSIM >= 0.98), measured twice:
#       - the lossless HyperFrames snapshot at 0 s against the cover, in full colour: every effect starts
#         at zero, so the composition's first frame is the cover itself;
#       - frame 0 of master.mp4 against the cover in luma only. HyperFrames captures every frame as a 4:2:0
#         JPEG and encodes yuv420p, so the master keeps a quarter of the chroma; on a saturated poster with
#         small coloured lettering that alone costs more than 0.02 of a colour SSIM against the 4:4:4 cover
#         although every pixel was drawn right. Luma keeps the encode check honest (a broken or shifted
#         encode still fails); the colour SSIM is only reported (ssimFrame0CoverColour);
#   - the last frame matches frame 0 (SSIM >= 0.98; both went through the same encode): the 8 s loop has
#     no visible jump;
#   - determinism: five frames (0, 2, 4, 6, 8 s) snapshotted twice with HyperFrames (software WebGL)
#     are identical pixel for pixel, or at least SSIM >= 0.999;
#   - it moves: scripts/motion-measure.py on those snapshots (luminance change against frame 0, relative
#     to the cover's own gradient, so a flat cover is judged as fairly as a textured one) scores >= 0.25.
#     The fallback composition ($WORK_DIR/motion.json authoring "fallback") only warns on this one:
#     a calm fixed preset must never fail a job; a composition Claude wrote fails.
# Writes $WORK_DIR/gates.json and, in Actions, a table to the job summary; keeps the snapshots in
# $WORK_DIR/gates/snap-a (at-0s.png ... at-8s.png). On failure writes error-code render_failed, exits 1.
# MOTION_GATES_SAFE=1 (motion-decide.sh's last resort, the minimal safe scene): a frame 0 that misses 0.98
# by a small margin (still >= 0.95 on both measures) only warns; duration, seam, determinism and a broken
# output still fail.
# Needs ffmpeg, ffprobe, jq, motion/node_modules and the prepare venv (motion-prepare.sh --setup).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
work="${WORK_DIR:?}"
comp="$work/composition"
master="$work/master.mp4"
gates="$work/gates"
motion_limit=0.25
frame0_limit=0.98
safe_frame0_limit=0.95

fail() { echo "$1" > "$work/error-message"; echo render_failed > "$work/error-code"; echo "motion gate failed: $1" >&2; exit 1; }
[[ -s "$master" && -s "$comp/assets/cover.jpg" ]] || fail "The render to check is missing"
rm -rf "$gates"
mkdir -p "$gates"
began=$SECONDS
authoring="$(jq -r '.authoring // "fallback"' "$work/motion.json" 2>/dev/null || echo fallback)"

# ---- duration, 8 s within one frame
frame=$(awk 'BEGIN { printf "%.4f", 1 / 30 }')
for f in "$master" "$work"/out/*.webm "$work"/out/*.mp4; do
  [[ -f "$f" ]] || continue
  d="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"
  awk -v d="$d" -v f="$frame" 'BEGIN { exit !((d - 8) <= f && (8 - d) <= f) }' \
    || fail "$(basename "$f") lasts $d s, expected 8 s within one frame"
done

# ---- frame 0 and the last frame of the master against the cover and each other
grab() { # index output
  ffmpeg -hide_banner -loglevel error -nostdin -y -i "$master" \
    -vf "select=eq(n\,$1)" -fps_mode passthrough -frames:v 1 "$2"
}
ssim() { # a b [plane: All (default) or Y] -> that SSIM value
  ffmpeg -hide_banner -nostdin -i "$1" -i "$2" \
    -lavfi "[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim" -f null - 2>&1 \
    | sed -n "s/.* ${3:-All}:\([0-9.]*\).*/\1/p" | tail -n 1
}
grab 0 "$gates/f000.png"
grab 120 "$gates/f120.png"
grab 239 "$gates/f239.png"
cover_ssim="$(ssim "$gates/f000.png" "$comp/assets/cover.jpg" Y)"
cover_colour="$(ssim "$gates/f000.png" "$comp/assets/cover.jpg")"
loop_ssim="$(ssim "$gates/f000.png" "$gates/f239.png")"
mid_ssim="$(ssim "$gates/f000.png" "$gates/f120.png")"
[[ -n "$cover_ssim" && -n "$cover_colour" && -n "$loop_ssim" && -n "$mid_ssim" ]] || fail "SSIM could not be measured"

# ---- determinism: five frames twice, from two fresh browser sessions
hf="$root/motion/node_modules/.bin/hyperframes"
export HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_TELEMETRY=1
times=(0 2 4 6 8)
for run in a b; do
  "$hf" snapshot "$comp" --at "$(IFS=,; echo "${times[*]}")" --no-end --no-browser-gpu --keep -o "$gates/snap-$run" \
    > "$gates/snap-$run.log" 2>&1 \
    || { tail -n 20 "$gates/snap-$run.log" >&2; fail "HyperFrames could not snapshot the composition"; }
done
pixels() { ffmpeg -hide_banner -loglevel error -nostdin -i "$1" -f md5 - 2>/dev/null; }
det_min=1
det_identical=true
shots=()
for t in "${times[@]}"; do
  a="$gates/snap-a/at-${t}s.png"
  b="$gates/snap-b/at-${t}s.png"
  [[ -f "$a" && -f "$b" ]] || fail "Snapshot at ${t} s is missing"
  shots+=("$a")
  if [[ "$(pixels "$a")" != "$(pixels "$b")" ]]; then
    det_identical=false
    s="$(ssim "$a" "$b")"
    det_min="$(awk -v a="$det_min" -v b="${s:-0}" 'BEGIN { print (b < a ? b : a) }')"
  fi
done
snap_ssim="$(ssim "$gates/snap-a/at-0s.png" "$comp/assets/cover.jpg")"
[[ -n "$snap_ssim" ]] || fail "SSIM could not be measured"

# ---- it moves, measured on the lossless snapshots
py="$(bash "$here/motion-prepare.sh" --setup 2> "$gates/setup.log")" \
  || { tail -n 5 "$gates/setup.log" >&2; fail "The measuring environment could not be set up"; }
measure="$("$py" -I "$here/motion-measure.py" "${shots[@]}")" || fail "Motion could not be measured"
motion="$(jq -r .motion <<<"$measure")"
moves=true
awk -v m="$motion" -v l="$motion_limit" 'BEGIN { exit !(m >= l) }' || moves=false
motion_gate=pass
if ! $moves; then
  if [[ "$authoring" == fallback ]]; then motion_gate=warn; else motion_gate=fail; fi
fi
gate_seconds=$((SECONDS - began))

# ---- frame 0: both measures >= 0.98; the safe scene only warns down to 0.95
at_least() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a >= b) }'; }
frame0_gate=pass
if ! at_least "$cover_ssim" "$frame0_limit" || ! at_least "$snap_ssim" "$frame0_limit"; then
  frame0_gate=fail
  if [[ "${MOTION_GATES_SAFE:-}" == 1 ]] && at_least "$cover_ssim" "$safe_frame0_limit" \
    && at_least "$snap_ssim" "$safe_frame0_limit"; then
    frame0_gate=warn
  fi
fi

jq -n --argjson cover "$cover_ssim" --argjson colour "$cover_colour" --argjson snap "$snap_ssim" \
  --arg frame0Gate "$frame0_gate" --argjson loop "$loop_ssim" --argjson mid "$mid_ssim" \
  --argjson identical "$det_identical" --argjson detMin "$det_min" --argjson seconds "$gate_seconds" \
  --argjson measure "$measure" --arg motionGate "$motion_gate" --arg authoring "$authoring" \
  '{ssimFrame0Cover: $cover, ssimSnapshot0Cover: $snap, ssimFrame0CoverColour: $colour, frame0Gate: $frame0Gate,
    ssimFirstLast: $loop, ssimFirstMiddle: $mid,
    snapshotsIdentical: $identical, snapshotsMinSsim: $detMin,
    motion: $measure.motion, motionScores: $measure.scores, motionGate: $motionGate, authoring: $authoring,
    gateSeconds: $seconds}' > "$work/gates.json"
echo "gates: frame 0 vs cover $cover_ssim (luma; colour $cover_colour), snapshot 0 s vs cover $snap_ssim ($frame0_gate)," \
  "first vs last $loop_ssim, first vs middle $mid_ssim," \
  "snapshots identical $det_identical (min SSIM $det_min), motion $motion ($motion_gate), ${gate_seconds} s"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "| Gate | Value |"
    echo "| --- | --- |"
    echo "| SSIM frame 0 of the master vs cover, luma (>= $frame0_limit) | $cover_ssim (colour $cover_colour, reported) |"
    echo "| SSIM snapshot at 0 s vs cover, lossless (>= $frame0_limit) | $snap_ssim $frame0_gate |"
    echo "| SSIM first vs last frame (>= 0.98) | $loop_ssim |"
    echo "| SSIM first vs middle frame (reported) | $mid_ssim |"
    echo "| Motion at 2/4/6 s (>= $motion_limit; $authoring) | $motion $(jq -c .scores <<<"$measure") $motion_gate |"
    echo "| Snapshots identical twice | $det_identical (min SSIM $det_min, >= 0.999) |"
    echo "| Gates (wall) | ${gate_seconds} s |"
    echo
  } >> "$GITHUB_STEP_SUMMARY"
fi

[[ "$frame0_gate" != fail ]] || fail "Frame 0 does not match the cover (SSIM $cover_ssim luma, snapshot $snap_ssim)"
awk -v s="$loop_ssim" 'BEGIN { exit !(s >= 0.98) }' || fail "The last frame does not match frame 0 (SSIM $loop_ssim)"
awk -v s="$det_min" 'BEGIN { exit !(s >= 0.999) }' || fail "The composition is not deterministic (SSIM $det_min)"
[[ "$motion_gate" != fail ]] || fail "The composition barely moves (motion $motion < $motion_limit)"
if [[ "$motion_gate" == warn ]]; then
  echo "::warning::The fallback composition barely moves (motion $motion < $motion_limit); shipped anyway"
fi
if [[ "$frame0_gate" == warn ]]; then
  echo "::warning::The safe scene's frame 0 is close to the cover but under $frame0_limit (SSIM $cover_ssim luma, snapshot $snap_ssim); shipped anyway"
fi
echo "motion gates passed"
