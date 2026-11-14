#!/usr/bin/env bash
# Usage: motion-brief.test.sh
# Tests the brief's job settings without rendering anything:
#   - scripts/motion-brief.sh: authoring (claude by default, preset only when exactly "preset"), preset
#     (only the names of motion/kit/choose.mjs PRESETS), style (warned when not a string of at most 1000
#     characters), $GITHUB_OUTPUT, and that no brief value other than these fixed words is ever printed;
#   - scripts/motion-author-setup.sh: Claude's copy of the brief keeps a valid style and drops an invalid one;
#   - scripts/motion-decide.sh --check: authoring "preset" refuses Claude's composition as preset-only
#     without looking at it.
# Needs: jq and node.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
secret="SECRET-brief-words"

settings() { # brief-json expected-stdout [expected-warning-regex]
  local out err
  printf '%s\n' "$1" > "$tmp/brief.json"
  out="$(bash "$root/scripts/motion-brief.sh" "$tmp/brief.json" 2> "$tmp/err")"
  err="$(cat "$tmp/err")"
  [[ "$out" == "$2" ]] || { echo "brief $1: got '$out', expected '$2'"; exit 1; }
  if [[ -n "${3-}" ]]; then
    grep -qE "$3" <<< "$err" || { echo "brief $1: expected a warning matching '$3', got '$err'"; exit 1; }
  else
    [[ -z "$err" ]] || { echo "brief $1: unexpected warning '$err'"; exit 1; }
  fi
  if grep -q "$secret" <<< "$out$err"; then echo "brief $1: a brief value reached the log"; exit 1; fi
}
nl=$'\n'

settings '{"title":"SECRET-brief-words","note":"SECRET-brief-words"}' "authoring=claude${nl}preset="
settings '{"authoring":"claude"}' "authoring=claude${nl}preset="
settings '{"authoring":"preset"}' "authoring=preset${nl}preset="
settings '{"authoring":"SECRET-brief-words"}' "authoring=claude${nl}preset=" 'authoring is neither claude nor preset'
settings '{"authoring":"preset\nX"}' "authoring=claude${nl}preset=" 'authoring is neither'
settings '{"authoring":["preset"]}' "authoring=claude${nl}preset=" 'authoring is neither'
for p in $(node "$root/motion/kit/choose.mjs" --list); do
  settings "{\"authoring\":\"preset\",\"preset\":\"$p\"}" "authoring=preset${nl}preset=$p"
done
[[ "$(node "$root/motion/kit/choose.mjs" --list | wc -l | tr -d ' ')" == 6 ]] || { echo "expected six presets"; exit 1; }
settings '{"preset":"night-stage"}' "authoring=claude${nl}preset=night-stage"
settings '{"preset":"SECRET-brief-words"}' "authoring=claude${nl}preset=" "preset is not one of the kit's presets; ignored"
settings '{"preset":"../safe"}' "authoring=claude${nl}preset=" "preset is not one"
settings '{"preset":"night-stage\nconcert-glow"}' "authoring=claude${nl}preset=" "preset is not one"
settings '{"preset":7}' "authoring=claude${nl}preset=" "preset is not one"
settings '{"preset":null,"authoring":null,"style":null}' "authoring=claude${nl}preset="
settings "{\"style\":\"$(printf 'a%.0s' {1..1000})\"}" "authoring=claude${nl}preset="
settings "{\"style\":\"$secret$(printf 'a%.0s' {1..1000})\"}" "authoring=claude${nl}preset=" 'style is not a string of at most 1000'
settings '{"style":["SECRET-brief-words"]}' "authoring=claude${nl}preset=" 'style is not a string'
settings 'not json' "authoring=claude${nl}preset="
settings '["preset"]' "authoring=claude${nl}preset="

printf '%s\n' '{"authoring":"preset","preset":"pencil-reveal"}' > "$tmp/brief.json"
: > "$tmp/output"
GITHUB_OUTPUT="$tmp/output" bash "$root/scripts/motion-brief.sh" "$tmp/brief.json" > /dev/null
[[ "$(cat "$tmp/output")" == "authoring=preset${nl}preset=pencil-reveal" ]] || { echo "GITHUB_OUTPUT: $(cat "$tmp/output")"; exit 1; }
echo "motion-brief.sh ok"

# motion-author-setup.sh: Claude's copy of the brief keeps a valid style and drops an invalid one.
mkdir -p "$tmp/prepare" "$tmp/author"
echo '{}' > "$tmp/prepare/meta.json"
printf '%s\n' '{"title":"t","note":"n","style":"slow, warm light","preset":"night-stage"}' > "$tmp/brief.json"
bash "$root/scripts/motion-author-setup.sh" "$tmp/prepare" "$tmp/brief.json" "$tmp/author" > /dev/null 2>&1
jq -e '. == {"title":"t","note":"n","style":"slow, warm light","preset":"night-stage"}' "$tmp/author/brief.json" > /dev/null \
  || { echo "the brief copy must be unchanged: $(cat "$tmp/author/brief.json")"; exit 1; }
printf '{"note":"n","style":"%s"}\n' "$(printf 'b%.0s' {1..1001})" > "$tmp/brief.json"
bash "$root/scripts/motion-author-setup.sh" "$tmp/prepare" "$tmp/brief.json" "$tmp/author" > /dev/null 2>&1
jq -e '. == {"note":"n"}' "$tmp/author/brief.json" > /dev/null || { echo "a style over 1000 characters must be dropped"; exit 1; }
printf '%s\n' '{"note":"n","style":{"a":1}}' > "$tmp/brief.json"
bash "$root/scripts/motion-author-setup.sh" "$tmp/prepare" "$tmp/brief.json" "$tmp/author" > /dev/null 2>&1
jq -e '. == {"note":"n"}' "$tmp/author/brief.json" > /dev/null || { echo "a style that is not a string must be dropped"; exit 1; }
echo "motion-author-setup.sh brief copy ok"

# motion-decide.sh --check: authoring "preset" refuses Claude's composition without looking at it.
mkdir -p "$tmp/work"
echo '{"kit":"kit-2.1"}' > "$tmp/work/scene.json"
printf '%s\n' '{"authoring":"preset"}' > "$tmp/brief.json"
set +e
out="$(WORK_DIR="$tmp/check" MOTION_BRIEF="$tmp/brief.json" bash "$root/scripts/motion-decide.sh" --check "$tmp/work" "$tmp/prepare")"
rc=$?
set -e
[[ $rc -ne 0 && "$out" == "claude composition refused: preset-only" ]] || { echo "expected preset-only, got rc $rc: $out"; exit 1; }
echo "motion-decide.sh preset-only ok"
echo "motion brief test passed"
