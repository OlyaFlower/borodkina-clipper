#!/usr/bin/env bash
# Usage: motion-decide.sh <author-dir> <prepare-dir>           decide, render and gate (motion.yml)
#        motion-decide.sh --check <author-dir> <prepare-dir>   only the checks before the render (exit 0/1)
# Deterministic choice between the composition Claude wrote and the fallback preset, after the author step.
# With MOTION_BRIEF set, the brief's settings (scripts/motion-brief.sh) apply: authoring "preset" skips 1
# (Claude's composition is not even looked at; reason preset-only), and a valid "preset" replaces the
# chooser's pick in 2 (printed as "choose: <name> (forced by the brief)").
#   1. Claude's composition is <author-dir>/scene.json with optional <author-dir>/blocks/<name>.js. It is
#      used only if scene.json exists and every check passes, in this order:
#        - the files: scene.json a plain file, blocks/ only plain files named [a-z][a-z0-9-]*.js;
#        - motion/kit/validate.mjs (schema and kit rules) against the prepared meta.json;
#        - motion/kit/check-blocks.mjs (custom blocks: kit imports only, no time, randomness, network,
#          page globals or code generation);
#        - motion-assemble.sh, then `hyperframes lint` on the assembled project (errorCount 0);
#        - motion-render.sh (render, master checks, encode, verify) and motion-gates.sh with authoring
#          claude (frame 0 = cover, seamless loop, deterministic snapshots, and it must move).
#      Then $WORK_DIR/motion.json is {"authoring":"claude","model":$CLAUDE_MODEL,"kitVersion":"kit-2.1"}.
#   2. Otherwise the brief's preset, or else the one motion/kit/choose.mjs picks from meta.json, is rendered
#      and gated, and
#      motion.json is {"authoring":"fallback","model":null,"kitVersion":"kit-2.1"}.
#   3. If that preset fails its render or gates, the safe scene motion/kit/safe.json (a still picture: no
#      camera, no geometry change, only a soft light and the corners breathing) is rendered and gated with
#      MOTION_GATES_SAFE=1 (a frame 0 a little under the cover only warns), motion.json as in 2.
# Claude can never fail the job: anything wrong with its composition only leads to the fallback, and a
# failing preset only leads to the safe scene. Only a failing safe scene fails (exit 1, with the error code
# motion-render.sh or motion-gates.sh wrote).
# The workflow log is public, so the details of a refused composition (validator messages, render and
# gate logs) go to $WORK_DIR/decide.log, never to stdout; only the fixed reason is printed:
# preset-only, no-scene, model-not-allowed, files, scene-invalid, blocks-refused, assemble-failed, lint-failed, render-failed or
# gates-failed. Writes $WORK_DIR/decision.json {"authoring","reason","scene"} (scene: claude, the preset's
# name or safe-breath) and a line to the job summary.
# Env: WORK_DIR; optional MOTION_BRIEF (the brief's path); CLAUDE_MODEL (allow-listed; default claude-sonnet-5-5); optional MOTION_CLAUDE_RENDER_LIMIT
# and MOTION_CLAUDE_GATES_LIMIT (seconds, default 420 and 240) bound the attempt with Claude's composition;
# MOTION_PRESETS_DIR (default motion/kit/presets; tests point it at a broken preset).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
check_only=false
if [[ "${1-}" == --check ]]; then check_only=true; shift; fi
if [[ $# -ne 2 ]]; then echo "usage: motion-decide.sh [--check] <author-dir> <prepare-dir>" >&2; exit 2; fi
author="$1"; prepared="$2"
work="${WORK_DIR:?}"
mkdir -p "$work"
kit_version=kit-2.1
log="$work/decide.log"
: > "$log"
hf="$root/motion/node_modules/.bin/hyperframes"
presets="${MOTION_PRESETS_DIR:-$root/motion/kit/presets}"
export HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_TELEMETRY=1

models=(claude-sonnet-5-5 claude-opus-5-5)
model=""
for m in "${models[@]}"; do
  if [[ "${CLAUDE_MODEL:-${models[0]}}" == "$m" ]]; then model="$m"; fi
done

# ---- the brief's settings: fixed words only (scripts/motion-brief.sh); its warnings go to decide.log
authoring_mode=claude
forced=""
if [[ -n "${MOTION_BRIEF:-}" ]]; then
  settings="$(bash "$here/motion-brief.sh" "$MOTION_BRIEF" 2>> "$log")" || settings=""
  while IFS='=' read -r key value; do
    case "$key" in
      authoring) if [[ "$value" == preset ]]; then authoring_mode=preset; fi ;;
      preset) forced="$value" ;;
    esac
  done <<< "$settings"
  if [[ -n "$forced" && ! -f "$presets/$forced.json" ]]; then forced=""; fi
fi

limit() { # seconds command... : runs with a time limit where timeout(1) exists
  local s="$1"; shift
  if command -v timeout > /dev/null; then timeout "$s" "$@"; else "$@"; fi
}

# ---- the checks before the render; prints the reason and returns 1 when Claude's composition is refused
staged="$work/scene-claude"
check_claude() {
  local f name
  if [[ ! -e "$author/scene.json" ]]; then echo no-scene; return 1; fi
  if [[ -z "$model" ]]; then echo model-not-allowed; return 1; fi
  [[ -f "$author/scene.json" && ! -L "$author/scene.json" ]] || { echo files; return 1; }
  rm -rf "$staged"
  mkdir -p "$staged/blocks"
  cp "$author/scene.json" "$staged/scene.json"
  if [[ -e "$author/blocks" || -L "$author/blocks" ]]; then
    [[ -d "$author/blocks" && ! -L "$author/blocks" ]] || { echo files; return 1; }
    while IFS= read -r -d '' f; do
      name="$(basename "$f")"
      [[ -f "$f" && ! -L "$f" && "$name" =~ ^[a-z][a-z0-9-]*\.js$ ]] || { echo "refused entry in blocks/" >> "$log"; echo files; return 1; }
      cp "$f" "$staged/blocks/$name"
    done < <(find "$author/blocks" -mindepth 1 -maxdepth 1 -print0)
  fi
  node "$root/motion/kit/validate.mjs" "$staged/scene.json" "$prepared/meta.json" >> "$log" 2>&1 || { echo scene-invalid; return 1; }
  node "$root/motion/kit/check-blocks.mjs" "$staged/blocks" >> "$log" 2>&1 || { echo blocks-refused; return 1; }
  bash "$here/motion-assemble.sh" "$staged" "$prepared" "$work/lint-project" >> "$log" 2>&1 || { echo assemble-failed; return 1; }
  "$hf" lint --json "$work/lint-project" > "$work/lint.json" 2>> "$log" || true
  jq -e '.errorCount == 0' "$work/lint.json" > /dev/null 2>&1 || { cat "$work/lint.json" >> "$log" 2>/dev/null || true; echo lint-failed; return 1; }
  return 0
}

motion_json() { # authoring model-json
  jq -nc --arg a "$1" --argjson m "$2" --arg k "$kit_version" '{authoring: $a, model: $m, kitVersion: $k}' > "$work/motion.json"
}
clean_render() {
  rm -rf "$work/out" "$work/master.mp4" "$work/composition" "$work/gates" "$work/gates.json" \
    "$work/error-code" "$work/error-message"
}
decided() { # authoring reason scene
  jq -nc --arg a "$1" --arg r "$2" --arg s "$3" '{authoring: $a, reason: $r, scene: $s}' > "$work/decision.json"
  echo "motion authoring: $1 ($2), scene $3"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "Motion authoring: **$1** ($2), scene $3" >> "$GITHUB_STEP_SUMMARY"
    echo >> "$GITHUB_STEP_SUMMARY"
  fi
}

if [[ "$authoring_mode" == preset ]]; then
  reason="preset-only"
  ok=1
else
  set +e
  reason="$(check_claude)"
  ok=$?
  set -e
fi
if $check_only; then
  if (( ok == 0 )); then echo "claude composition passes the checks"; else echo "claude composition refused: $reason"; fi
  exit "$ok"
fi

# ---- 1. Claude's composition: render and gate it; its logs stay in decide.log
if (( ok == 0 )); then
  motion_json claude "\"$model\""
  clean_render
  if limit "${MOTION_CLAUDE_RENDER_LIMIT:-420}" bash "$here/motion-render.sh" "$staged" "$prepared" >> "$log" 2>&1; then
    if limit "${MOTION_CLAUDE_GATES_LIMIT:-240}" bash "$here/motion-gates.sh" >> "$log" 2>&1; then
      jq -c '{ssimFrame0Cover, ssimSnapshot0Cover, ssimFirstLast, snapshotsIdentical, motion, motionGate}' "$work/gates.json" || true
      decided claude passed claude
      exit 0
    fi
    reason=gates-failed
  else
    reason=render-failed
  fi
  echo "claude composition refused: $reason; rendering the fallback"
fi

# ---- 2. the fallback: the brief's preset or the chooser's, logs shown as usual
clean_render
if [[ -n "$forced" ]]; then
  preset="$forced"
  echo "choose: $preset (forced by the brief)"
else
  preset="$(node "$root/motion/kit/choose.mjs" "$prepared/meta.json" || echo none)"
fi
rm -rf "$work/scene-fallback"
mkdir -p "$work/scene-fallback"
cp "$presets/$preset.json" "$work/scene-fallback/scene.json" 2>/dev/null || echo '{}' > "$work/scene-fallback/scene.json"
motion_json fallback null
if bash "$here/motion-render.sh" "$work/scene-fallback" "$prepared"; then
  if bash "$here/motion-gates.sh"; then
    decided fallback "$reason" "$preset"
    exit 0
  fi
  preset_reason=gates-failed
else
  preset_reason=render-failed
fi
echo "fallback preset refused: $preset_reason; rendering the safe scene"

# ---- 3. the safe scene: a still picture whose light and corners breathe; a frame 0 that misses the
# cover by a small margin only warns (MOTION_GATES_SAFE=1). Only this one failing fails the job.
clean_render
rm -rf "$work/scene-safe"
mkdir -p "$work/scene-safe"
cp "$root/motion/kit/safe.json" "$work/scene-safe/scene.json"
motion_json fallback null
bash "$here/motion-render.sh" "$work/scene-safe" "$prepared"
MOTION_GATES_SAFE=1 bash "$here/motion-gates.sh"
decided fallback "$reason" safe-breath
