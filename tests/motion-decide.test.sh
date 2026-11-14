#!/usr/bin/env bash
# Usage: motion-decide.test.sh <fallback|claude|invalid>
# Tests scripts/motion-decide.sh (the choice after motion.yml's Claude author step) on the prepared stage
# fixture, without calling Claude: the author step's output is simulated by hand-written files.
#   fallback  no work/scene.json (the step was skipped, as without the Claude secret, or wrote nothing)
#             -> the chooser's preset is rendered, authoring fallback, reason no-scene;
#   claude    a valid hand-written scene with a custom block (tests/fixtures/motion/claude-scene)
#             -> rendered and gated as Claude's, authoring claude with the allow-listed model;
#             also checks motion-author-setup.sh (model allow-list, the work tree and the skills);
#   invalid   broken scenes and blocks are refused before any render, each with its reason, and a full
#             run with an unsafe block renders the fallback, reason blocks-refused, without printing
#             the refused composition.
#   safe      the chooser's preset is broken (MOTION_PRESETS_DIR with an invalid concert-glow): its render
#             fails, the safe scene motion/kit/safe.json is rendered and gated instead, authoring fallback,
#             scene safe-breath, and the job still gets its video.
# Needs: ffmpeg, ffprobe, jq, node, Python 3.12 and motion/node_modules.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
case_name="${1:?usage: motion-decide.test.sh <fallback|claude|invalid|safe>}"
[[ "$case_name" =~ ^(fallback|claude|invalid|safe)$ ]] || { echo "unknown case $case_name"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fixture="$root/tests/fixtures/motion/claude-scene"

# ---- the prepared stage fixture
run="$tmp/run"
mkdir -p "$run/source"
cp "$root/tests/fixtures/motion/stage.jpg" "$run/source/cover"
WORK_DIR="$run" bash "$root/scripts/motion-prepare.sh" "$run/source/cover" "$run/prepare"
prepared="$run/prepare"

expect() { # authoring model reason scene
  jq -e --arg a "$1" --argjson m "$2" --arg k kit-2.1 '. == {authoring: $a, model: $m, kitVersion: $k}' "$run/motion.json" > /dev/null \
    || { echo "motion.json: $(cat "$run/motion.json"), expected $1 $2"; exit 1; }
  jq -e --arg a "$1" --arg r "$3" --arg s "$4" '. == {authoring: $a, reason: $r, scene: $s}' "$run/decision.json" > /dev/null \
    || { echo "decision.json: $(cat "$run/decision.json"), expected $1 $3 $4"; exit 1; }
  for f in 1280.av1.webm 640.av1.webm 1280.h264.mp4 640.h264.mp4 poster.webp; do
    [[ -s "$run/out/$f" ]] || { echo "missing $f"; exit 1; }
  done
  jq -e --arg a "$1" '.authoring == $a' "$run/gates.json" > /dev/null || { echo "the gates did not run for $1"; exit 1; }
}
refused() { # reason author-dir
  local out
  set +e
  out="$(WORK_DIR="$tmp/check" bash "$root/scripts/motion-decide.sh" --check "$2" "$prepared")"
  local rc=$?
  set -e
  [[ $rc -ne 0 && "$out" == "claude composition refused: $1" ]] || { echo "expected refusal $1 for $2, got rc $rc: $out"; exit 1; }
  echo "refused as $1: $(basename "$2")"
}
variant() { # name -> a fresh copy of the fixture in $tmp/<name>
  rm -rf "${tmp:?}/$1"
  cp -R "$fixture" "$tmp/$1"
  echo "$tmp/$1"
}

case "$case_name" in
  fallback)
    mkdir -p "$tmp/work"
    WORK_DIR="$run" bash "$root/scripts/motion-decide.sh" "$tmp/work" "$prepared"
    expect fallback null no-scene concert-glow
    # A missing author dir (the setup step skipped too) is the same.
    refused no-scene "$tmp/absent"
    ;;

  claude)
    # motion-author-setup.sh: the model allow-list, the work tree and the skills.
    author="$tmp/author"
    mkdir -p "$author"
    echo '{"model":"claude-opus-5-5"}' > "$tmp/brief-opus.json"
    printf '%s\n' '{"model":"claude-sonnet-5-5\nX=1","mood":"calm"}' > "$tmp/brief-bad.json"
    echo '{"mood":"calm"}' > "$tmp/brief-none.json"
    [[ "$(bash "$root/scripts/motion-author-setup.sh" "$prepared" "$tmp/brief-bad.json" "$author" 2>/dev/null)" == claude-sonnet-5-5 ]] \
      || { echo "a model off the allow-list must fall back to the default"; exit 1; }
    [[ "$(bash "$root/scripts/motion-author-setup.sh" "$prepared" "$tmp/brief-none.json" "$author")" == claude-sonnet-5-5 ]] \
      || { echo "the default model is claude-sonnet-5-5"; exit 1; }
    model="$(GITHUB_ENV="$tmp/github-env" bash "$root/scripts/motion-author-setup.sh" "$prepared" "$tmp/brief-opus.json" "$author")"
    [[ "$model" == claude-opus-5-5 && "$(cat "$tmp/github-env")" == CLAUDE_MODEL=claude-opus-5-5 ]] \
      || { echo "the brief's allow-listed model must be used"; exit 1; }
    for f in prepare/meta.json prepare/cover.jpg brief.json .claude/skills/borodkina-motion/SKILL.md \
      .claude/skills/hyperframes/SKILL.md .claude/skills/hyperframes-cli/SKILL.md; do
      [[ -s "$author/$f" ]] || { echo "motion-author-setup.sh did not provide $f"; exit 1; }
    done
    [[ -d "$author/work" && -z "$(ls -A "$author/work")" ]] || { echo "work/ must exist and be empty"; exit 1; }
    echo "motion-author-setup.sh ok"

    # The hand-written scene stands in for Claude's output in work/.
    cp -R "$fixture/." "$author/work/"
    WORK_DIR="$tmp/check" bash "$root/scripts/motion-decide.sh" --check "$author/work" "$prepared"
    WORK_DIR="$run" CLAUDE_MODEL="$model" bash "$root/scripts/motion-decide.sh" "$author/work" "$prepared"
    expect claude '"claude-opus-5-5"' passed claude
    ;;

  invalid)
    v="$(variant unknown-block)"
    jq '.blocks[1].block = "lasers"' "$fixture/scene.json" > "$v/scene.json"
    refused scene-invalid "$v"
    v="$(variant bad-beat)"
    jq '.beats = [0.1]' "$fixture/scene.json" > "$v/scene.json"
    refused scene-invalid "$v"
    v="$(variant not-json)"
    echo 'not json' > "$v/scene.json"
    refused scene-invalid "$v"
    v="$(variant random-block)"
    sed -i.bak 's/const center = \[kit.focus.x, kit.focus.y\];/const center = [Math.random(), kit.focus.y];/' "$v/blocks/halo.js"
    rm -f "$v/blocks/halo.js.bak"
    refused blocks-refused "$v"
    v="$(variant fetch-block)"
    printf '%s\n' "fetch('https://example.com/');" >> "$v/blocks/halo.js"
    refused blocks-refused "$v"
    v="$(variant missing-block)"
    rm "$v/blocks/halo.js"
    refused assemble-failed "$v"
    v="$(variant stray-file)"
    echo notes > "$v/blocks/README.md"
    refused files "$v"
    v="$(variant linked-scene)"
    rm "$v/scene.json"
    ln -s "$fixture/scene.json" "$v/scene.json"
    refused files "$v"
    v="$(variant linked-blocks)"
    rm -rf "$v/blocks"
    ln -s "$fixture/blocks" "$v/blocks"
    refused files "$v"
    out="$(WORK_DIR="$tmp/check" CLAUDE_MODEL=gpt-9 bash "$root/scripts/motion-decide.sh" --check "$(variant bad-model)" "$prepared" || true)"
    [[ "$out" == "claude composition refused: model-not-allowed" ]] || { echo "a model off the allow-list must be refused, got: $out"; exit 1; }

    # A full run with the unsafe block: the fallback is rendered and the refused composition is not printed.
    v="$(variant random-block-run)"
    sed -i.bak 's/const center = \[kit.focus.x, kit.focus.y\];/const center = [Math.random(), kit.focus.y];/' "$v/blocks/halo.js"
    rm -f "$v/blocks/halo.js.bak"
    WORK_DIR="$run" bash "$root/scripts/motion-decide.sh" "$v" "$prepared" > "$tmp/decide.out" 2>&1 \
      || { cat "$tmp/decide.out"; exit 1; }
    cat "$tmp/decide.out"
    expect fallback null blocks-refused concert-glow
    if grep -qE 'Math\.random|decide-test-halo|halo\.js' "$tmp/decide.out"; then
      echo "the refused composition must not reach the log"; exit 1
    fi
    grep -q 'Math.random' "$run/decide.log" || { echo "decide.log must keep the reason"; exit 1; }
    ;;

  safe)
    # The chooser picks concert-glow for the stage; a broken concert-glow fails its render, so the safe
    # scene must still give the job a video.
    [[ "$(node "$root/motion/kit/choose.mjs" "$prepared/meta.json" 2>/dev/null)" == concert-glow ]] \
      || { echo "the stage fixture should choose concert-glow"; exit 1; }
    cp -R "$root/motion/kit/presets" "$tmp/presets"
    jq '.blocks[1].block = "lasers"' "$root/motion/kit/presets/concert-glow.json" > "$tmp/presets/concert-glow.json"
    mkdir -p "$tmp/work"
    WORK_DIR="$run" MOTION_PRESETS_DIR="$tmp/presets" bash "$root/scripts/motion-decide.sh" "$tmp/work" "$prepared" \
      | tee "$tmp/decide.out"
    grep -qx 'fallback preset refused: render-failed; rendering the safe scene' "$tmp/decide.out" \
      || { echo "the preset failure must be reported by its reason"; exit 1; }
    expect fallback null no-scene safe-breath
    jq -e '.frame0Gate == "pass" and .motionGate != "fail"' "$run/gates.json" > /dev/null \
      || { echo "the safe scene's gates: $(cat "$run/gates.json")"; exit 1; }
    ;;
esac
echo "motion decide test passed: $case_name"
