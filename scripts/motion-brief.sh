#!/usr/bin/env bash
# Usage: motion-brief.sh <brief.json>
# Reads the job settings of a motion brief (the admin's private JSON object) and prints them as fixed words:
#   authoring=claude|preset   "preset" skips the Claude author step (no Claude credential is used); a missing
#                             field or any other value means "claude".
#   preset=<name>             the brief's "preset" when it is one of motion/kit/choose.mjs PRESETS (it then
#                             replaces the chooser's pick for the fallback), else empty.
# Appends the same lines to $GITHUB_OUTPUT when that is set. The workflow log is public, so nothing else from
# the brief is printed: an invalid field only gets a fixed warning on stderr that never echoes its value.
# Also warns when "style" (the owner's standing direction, a string of at most 1000 characters) is invalid;
# motion-author-setup.sh then leaves it out of Claude's copy of the brief.
# An unreadable brief gives the defaults (authoring=claude, no preset). Exits 0 unless misused.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
if [[ $# -ne 1 ]]; then echo "usage: motion-brief.sh <brief.json>" >&2; exit 2; fi
brief="$1"

field() { # name -> the field's value when it is a string, else empty; "<non-string>" when present otherwise
  jq -r --arg f "$1" 'if type != "object" or has($f) == false or .[$f] == null then ""
    elif (.[$f] | type) == "string" then .[$f] | gsub("[\\n\\r]"; " ") else "<non-string>" end' "$brief" 2>/dev/null || true
}

authoring=claude
wanted="$(field authoring)"
if [[ "$wanted" == preset ]]; then
  authoring=preset
elif [[ -n "$wanted" && "$wanted" != claude ]]; then
  echo "motion-brief: the brief's authoring is neither claude nor preset; using claude" >&2
fi

preset=""
wanted="$(field preset)"
if [[ -n "$wanted" ]]; then
  while IFS= read -r p; do
    if [[ "$wanted" == "$p" ]]; then preset="$p"; fi
  done < <(node "$root/motion/kit/choose.mjs" --list)
  if [[ -z "$preset" ]]; then
    echo "motion-brief: the brief's preset is not one of the kit's presets; ignored" >&2
  fi
fi

if jq -e 'type == "object" and .style != null
    and ((.style | type) != "string" or (.style | length) > 1000)' "$brief" > /dev/null 2>&1; then
  echo "motion-brief: the brief's style is not a string of at most 1000 characters; ignored" >&2
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'authoring=%s\npreset=%s\n' "$authoring" "$preset" >> "$GITHUB_OUTPUT"
fi
printf 'authoring=%s\npreset=%s\n' "$authoring" "$preset"
