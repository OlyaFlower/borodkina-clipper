#!/usr/bin/env bash
# Usage: motion-author-setup.sh <prepare-dir> <brief.json> <author-root>
# Sets up the Claude author step of motion.yml. In <author-root> (the checkout: Claude's working directory)
# it creates, replacing what is there:
#   prepare/         a copy of the prepared cover (the output of motion-prepare.sh)
#   brief.json       a copy of the brief
#   work/            empty; Claude writes work/scene.json, optional work/blocks/<name>.js and work/REVIEW.md
#   .claude/skills/  the authoring skill (motion/skills/borodkina-motion) and the official HyperFrames skills
#                    shipped in the pinned hyperframes package (motion/package-lock.json): hyperframes and
#                    hyperframes-cli. Nothing is downloaded.
# Prints the model: the brief's optional "model" when it is on the allow-list below, else the default, and
# writes CLAUDE_MODEL=<model> to $GITHUB_ENV when that is set. Nothing else from the brief is printed.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
if [[ $# -ne 3 ]]; then echo "usage: motion-author-setup.sh <prepare-dir> <brief.json> <author-root>" >&2; exit 2; fi
prepared="$1"; brief="$2"; dest="$3"

# The allow-list; the first is the default.
models=(claude-sonnet-5-5 claude-opus-5-5)
model="${models[0]}"
wanted="$(jq -r 'if type == "object" and (.model | type) == "string" then .model else "" end' "$brief" 2>/dev/null || true)"
for m in "${models[@]}"; do
  if [[ "$wanted" == "$m" ]]; then model="$m"; fi
done
if [[ -n "$wanted" && "$wanted" != "$model" ]]; then
  echo "motion-author-setup: the brief names a model that is not on the allow-list; using $model" >&2
fi

[[ -s "$prepared/meta.json" ]] || { echo "motion-author-setup: $prepared/meta.json is missing" >&2; exit 1; }
rm -rf "$dest/prepare" "$dest/work" "$dest/brief.json"
cp -R "$prepared" "$dest/prepare"
cp "$brief" "$dest/brief.json"
mkdir -p "$dest/work"

skills="$dest/.claude/skills"
mkdir -p "$skills"
rm -rf "$skills/borodkina-motion" "$skills/hyperframes" "$skills/hyperframes-cli"
cp -R "$root/motion/skills/borodkina-motion" "$skills/"
for s in hyperframes hyperframes-cli; do
  src="$root/motion/node_modules/hyperframes/dist/skills/$s"
  if [[ -f "$src/SKILL.md" ]]; then
    cp -R "$src" "$skills/"
  else
    echo "motion-author-setup: the pinned hyperframes package has no $s skill" >&2
  fi
done

if [[ -n "${GITHUB_ENV:-}" ]]; then echo "CLAUDE_MODEL=$model" >> "$GITHUB_ENV"; fi
echo "$model"
