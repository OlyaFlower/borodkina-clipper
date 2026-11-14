#!/usr/bin/env bash
# Usage: motion-presets.test.sh <out-dir>
# Every preset of motion/kit/presets on every fixture of tests/fixtures/motion (poster-float only on the
# extended poster), snapshotted with HyperFrames at 0, 2, 4, 6 and 8 s into <out-dir>/<fixture>-<preset>/
# for review, without a full render. For each: frame 0 equals the cover, the 8 s frame equals frame 0, and
# it moves (scripts/motion-measure.py >= 0.25). Writes a table to $GITHUB_STEP_SUMMARY when set.
# Needs: jq, node, Python 3.12 and motion/node_modules.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
out="${1:?usage: motion-presets.test.sh <out-dir>}"
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_TELEMETRY=1
hf="$root/motion/node_modules/.bin/hyperframes"
"$hf" browser ensure > /dev/null
py="$(bash "$root/scripts/motion-prepare.sh" --setup)"

rows=()
failed=0
for fixture in stage poster landscape flat; do
  mkdir -p "$work/$fixture/source"
  cp "$root/tests/fixtures/motion/$fixture.jpg" "$work/$fixture/source/cover"
  WORK_DIR="$work/$fixture" bash "$root/scripts/motion-prepare.sh" "$work/$fixture/source/cover" "$work/$fixture/prepare" 2> /dev/null
  mode="$(jq -r .framing.mode "$work/$fixture/prepare/meta.json")"
  chosen="$(node "$root/motion/kit/choose.mjs" "$work/$fixture/prepare/meta.json" 2> /dev/null)"
  for spec in "$root"/motion/kit/presets/*.json; do
    preset="$(basename "$spec" .json)"
    if [[ "$(jq -r '.blocks[0].block' "$spec")" == card-float && "$mode" != extend ]]; then continue; fi
    scene="$work/scene-$preset"
    mkdir -p "$scene"
    cp "$spec" "$scene/scene.json"
    comp="$work/comp-$fixture-$preset"
    bash "$root/scripts/motion-assemble.sh" "$scene" "$work/$fixture/prepare" "$comp" 2> /dev/null
    dest="$out/$fixture-$preset"
    began=$SECONDS
    "$hf" snapshot "$comp" --at 0,2,4,6,8 --no-end --no-browser-gpu --keep -o "$dest" > "$work/snap.log" 2>&1 \
      || { tail -n 20 "$work/snap.log"; echo "FAIL $fixture $preset: snapshot"; failed=$((failed + 1)); continue; }
    seconds=$((SECONDS - began))
    m="$("$py" -I "$root/scripts/motion-measure.py" "$dest/at-0s.png" "$dest/at-2s.png" "$dest/at-4s.png" "$dest/at-6s.png" "$dest/at-8s.png")"
    rest="$("$py" -I "$root/scripts/motion-measure.py" "$work/$fixture/prepare/cover.jpg" "$dest/at-0s.png")"
    motion="$(jq .motion <<<"$m")"
    seam="$(jq '.scores[3]' <<<"$m")"
    start="$(jq .motion <<<"$rest")"
    verdict=ok
    awk -v m="$motion" 'BEGIN { exit !(m >= 0.25) }' || verdict="does not move"
    awk -v s="$seam" 'BEGIN { exit !(s < 0.02) }' || verdict="8 s differs from 0 s ($seam)"
    awk -v s="$start" 'BEGIN { exit !(s < 0.05) }' || verdict="frame 0 differs from the cover ($start)"
    [[ "$verdict" == ok ]] || failed=$((failed + 1))
    mark=""
    [[ "$preset" == "$chosen" ]] && mark=" (chosen)"
    rows+=("| $fixture | $preset$mark | $motion $(jq -c .scores <<<"$m") | $start | ${seconds} s | $verdict |")
    echo "$fixture $preset$mark: motion $motion, frame 0 vs cover $start, ${seconds} s: $verdict"
  done
done

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Motion presets on every fixture (snapshots only)"
    echo "| Fixture | Preset | Motion (2/4/6/8 s) | Frame 0 vs cover | Snapshot | Verdict |"
    echo "| --- | --- | --- | --- | --- | --- |"
    printf '%s\n' "${rows[@]}"
    echo
  } >> "$GITHUB_STEP_SUMMARY"
fi
(( failed == 0 )) || { echo "$failed preset check(s) failed"; exit 1; }
echo "all presets passed on every fixture"
