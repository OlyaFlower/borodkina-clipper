#!/usr/bin/env bash
# The injection cases are single-quoted on purpose: they must reach the script unexpanded.
# shellcheck disable=SC2016
# Argument validation tests for scripts/clip.sh. Valid arguments are checked up to the first
# step that would need the network or ffmpeg: --file with a missing path stops with "file not found".
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../scripts/clip.sh"
failures=0

# run <pass|fail> <label> args...   pass = arguments accepted, fail = rejected with exit 2
run() {
  local expect="$1" label="$2" out rc; shift 2
  out="$(OUT_ROOT="$(mktemp -d)" bash "$script" "$@" 2>&1)"; rc=$?
  if [[ "$expect" == pass ]]; then
    if [[ "$rc" == 2 && "$out" == *"file not found"* ]]; then echo "ok: $label"; return; fi
  else
    if [[ "$rc" == 2 && "$out" != *"file not found"* ]]; then echo "ok: $label"; return; fi
  fi
  echo "FAIL: $label (rc=$rc: $out)"; failures=$((failures + 1))
}

run pass "file, 8 seconds" --file /nonexistent.mp4 --start 0 --end 8
run pass "file, 5 seconds" --file /nonexistent.mp4 --start 30 --end 35
run pass "file, 10 seconds" --file /nonexistent.mp4 --start 30 --end 40

run fail "no arguments"
run fail "unknown flag" --bogus 1
run fail "missing value" --youtube
run fail "youtube and file" --youtube dQw4w9WgXcQ --file /x.mp4 --start 0 --end 8
run fail "no source" --start 0 --end 8
run fail "id too short" --youtube abc --start 0 --end 8
run fail "id too long" --youtube dQw4w9WgXcQa --start 0 --end 8
run fail "id option-like" --youtube --exec-calc1 --start 0 --end 8
run fail "id injection" --youtube 'a$(id)aaaaaaa' --start 0 --end 8
run fail "id slash" --youtube 'dQw4w9WgX/Q' --start 0 --end 8
run fail "start missing" --youtube dQw4w9WgXcQ --end 8
run fail "end missing" --youtube dQw4w9WgXcQ --start 0
run fail "start negative" --youtube dQw4w9WgXcQ --start -1 --end 8
run fail "start float" --youtube dQw4w9WgXcQ --start 1.5 --end 9
run fail "start leading zero" --youtube dQw4w9WgXcQ --start 01 --end 9
run fail "arithmetic injection" --youtube dQw4w9WgXcQ --start 'a[$(id)]' --end 9
run fail "duration 4" --youtube dQw4w9WgXcQ --start 0 --end 4
run fail "duration 11" --youtube dQw4w9WgXcQ --start 0 --end 11
run fail "end before start" --youtube dQw4w9WgXcQ --start 20 --end 10

if (( failures > 0 )); then echo "$failures failure(s)"; exit 1; fi
echo "all passed"
