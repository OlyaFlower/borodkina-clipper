#!/usr/bin/env bash
# Usage: motion-decide.sh <author-dir> <prepare-dir>           decide, render and gate (motion.yml)
#        motion-decide.sh --check <author-dir> <prepare-dir>   only the checks before the render (exit 0/1)
# Deterministic choice between the composition Claude wrote and the fallback preset, after the author step:
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
#   2. Otherwise the preset motion/kit/choose.mjs picks from meta.json is rendered and gated, and
#      motion.json is {"authoring":"fallback","model":null,"kitVersion":"kit-2.1"}.
# Claude can never fail the job: anything wrong with its composition only leads to the fallback. Only a
# failing fallback fails (exit 1, with the error code motion-render.sh or motion-gates.sh wrote).
# The workflow log is public, so the details of a refused composition (validator messages, render and
# gate logs) go to $WORK_DIR/decide.log, never to stdout; only the fixed reason is printed:
# no-scene, model-not-allowed, files, scene-invalid, blocks-refused, assemble-failed, lint-failed, render-failed or
# gates-failed. Writes $WORK_DIR/decision.json {"authoring","reason"} and a line to the job summary.
# Env: WORK_DIR; CLAUDE_MODEL (allow-listed; default claude-sonnet-5-5); optional MOTION_CLAUDE_RENDER_LIMIT
# and MOTION_CLAUDE_GATES_LIMIT (seconds, default 420 and 240) bound the attempt with Claude's composition.
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
export HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_TELEMETRY=1

models=(claude-sonnet-5-5 claude-opus-5-5)
model=""
for m in "${models[@]}"; do
  if [[ "${CLAUDE_MODEL:-${models[0]}}" == "$m" ]]; then model="$m"; fi
done

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
decided() { # authoring reason
  jq -nc --arg a "$1" --arg r "$2" '{authoring: $a, reason: $r}' > "$work/decision.json"
  echo "motion authoring: $1 ($2)"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "Motion authoring: **$1** ($2)" >> "$GITHUB_STEP_SUMMARY"
    echo >> "$GITHUB_STEP_SUMMARY"
  fi
}

set +e
reason="$(check_claude)"
ok=$?
set -e
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
      jq -c '{ssimFrame0Cover, ssimFirstLast, snapshotsIdentical, motion, motionGate}' "$work/gates.json" || true
      decided claude passed
      exit 0
    fi
    reason=gates-failed
  else
    reason=render-failed
  fi
  echo "claude composition refused: $reason; rendering the fallback"
fi

# ---- 2. the fallback: the chooser's preset, logs shown as usual
clean_render
preset="$(node "$root/motion/kit/choose.mjs" "$prepared/meta.json")"
rm -rf "$work/scene-fallback"
mkdir -p "$work/scene-fallback"
cp "$root/motion/kit/presets/$preset.json" "$work/scene-fallback/scene.json"
motion_json fallback null
bash "$here/motion-render.sh" "$work/scene-fallback" "$prepared"
bash "$here/motion-gates.sh"
decided fallback "$reason"
