#!/usr/bin/env bash
# Usage: motion-render.sh <scene-dir> <prepare-dir>
# Renders a scene spec (<scene-dir>/scene.json, optional <scene-dir>/blocks/*.js; see motion/kit/API.md) over
# the output of motion-prepare.sh to $WORK_DIR/master.mp4 (1920x1080, 30 fps, 8 s), checks it, then runs
# encode.sh (start 0, duration 8, which runs verify.sh) into $WORK_DIR/out. The HyperFrames project is
# assembled by motion-assemble.sh into $WORK_DIR/composition (motion/kit/compose with the kit, the custom
# blocks, the pinned GSAP and the prepared files). Writes the render wall time to $WORK_DIR/render-seconds.
# Env: WORK_DIR, optional MOTION_WORKERS (default 3: a 4-vCPU ubuntu-latest runner keeps one core
# for ffmpeg and the producer), MOTION_QUALITY (default delivery).
# Needs motion/node_modules (npm ci in motion/), node, ffmpeg, ffprobe and jq on PATH.
# On failure writes $WORK_DIR/error-code: render_failed (missing prepared files, an invalid scene spec,
# HyperFrames setup, render or master checks) or encode_failed (renditions), then exits 1.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

if [[ $# -ne 2 ]]; then echo "usage: motion-render.sh <scene-dir> <prepare-dir>" >&2; exit 2; fi
scene_dir="$1"; prepared="$2"
work="${WORK_DIR:?}"
mkdir -p "$work"

fail() { # code message
  echo "$2" > "$work/error-message"; echo "$1" > "$work/error-code"; echo "motion error: $1: $2" >&2; exit 1
}

duration=8
fps=30
frames=$((duration * fps))
hf="$root/motion/node_modules/.bin/hyperframes"
[[ -x "$hf" ]] || fail render_failed "HyperFrames is not installed (run npm ci in motion/)"

export HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_TELEMETRY=1
HYPERFRAMES_FFMPEG_PATH="${HYPERFRAMES_FFMPEG_PATH:-$(command -v ffmpeg)}"
HYPERFRAMES_FFPROBE_PATH="${HYPERFRAMES_FFPROBE_PATH:-$(command -v ffprobe)}"
export HYPERFRAMES_FFMPEG_PATH HYPERFRAMES_FFPROBE_PATH

# A private HyperFrames project: the compose page, the kit, custom blocks, GSAP and the prepared assets.
comp="$work/composition"
bash "$here/motion-assemble.sh" "$scene_dir" "$prepared" "$comp" 2> "$work/assemble.log" \
  || { cat "$work/assemble.log" >&2; fail render_failed "The scene could not be assembled: $(tail -n 1 "$work/assemble.log" | cut -c1-200)"; }
cat "$work/assemble.log" >&2
"$hf" browser ensure > "$work/browser.log" 2>&1 \
  || { cat "$work/browser.log" >&2; fail render_failed "The HyperFrames browser could not be installed"; }
# doctor --json always exits 0 and its top-level .ok also counts optional tools (Docker, whisper, TTS),
# so only the checks a render needs are gated.
"$hf" doctor --json > "$work/doctor.json" 2> "$work/doctor.err" || true
jq -e '[.checks[] | select(.name == "Node.js" or .name == "FFmpeg" or .name == "FFprobe" or .name == "Chrome")]
  | length == 4 and all(.ok)' "$work/doctor.json" > /dev/null \
  || { jq -c '.checks[]? | {name, ok}' "$work/doctor.json" >&2 || true; fail render_failed "HyperFrames doctor failed"; }

began=$SECONDS
set +e
"$hf" render "$comp" --output "$work/master.mp4" --fps "$fps" --quality "${MOTION_QUALITY:-delivery}" \
  --workers "${MOTION_WORKERS:-3}" --no-low-memory-mode --strict --no-best-effort \
  > "$work/render.log" 2>&1
rc=$?
set -e
echo $((SECONDS - began)) > "$work/render-seconds"
grep -vE '^@hf-progress|█' "$work/render.log" | tail -n 40 >&2 || true
(( rc == 0 )) || fail render_failed "The HyperFrames render failed"
[[ -s "$work/master.mp4" ]] || fail render_failed "The HyperFrames render produced no file"

# The master must be exactly 1920x1080 at 30 fps with 240 frames (8 s).
probe="$(ffprobe -v error -select_streams v:0 -count_frames \
  -show_entries stream=width,height,r_frame_rate,nb_read_frames -of json "$work/master.mp4" 2>/dev/null || true)"
jq -e --argjson n "$frames" '.streams[0] | .width == 1920 and .height == 1080 and .r_frame_rate == "30/1"
  and (.nb_read_frames | tonumber) == $n' <<<"$probe" > /dev/null \
  || { echo "$probe" >&2; fail render_failed "The rendered master is not 1920x1080, 30 fps, 8 s"; }
echo "master ok: $(stat -c %s "$work/master.mp4" 2>/dev/null || stat -f %z "$work/master.mp4") bytes, render $(cat "$work/render-seconds") s"

mkdir -p "$work/out"
bash "$here/encode.sh" "$work/master.mp4" 0 "$duration" "$work/out" \
  || fail encode_failed "Encoding the motion renditions failed"
