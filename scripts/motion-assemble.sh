#!/usr/bin/env bash
# Usage: motion-assemble.sh <scene-dir> <prepare-dir> <out-dir>
# Builds a renderable HyperFrames project in <out-dir> (replaced) from a scene spec and a prepared cover:
#   <scene-dir>/scene.json        the scene spec (motion/kit/scene.schema.json), required
#   <scene-dir>/blocks/<name>.js  custom blocks named custom/<name> in the spec, optional
#   <prepare-dir>                 the output of motion-prepare.sh (cover.jpg, depth.png, meta.json, ...)
# The project is motion/kit/compose/index.html with motion/kit/lib and motion/kit/blocks in kit/, the custom
# blocks in blocks/, the pinned GSAP in assets/vendor/, the prepared files in assets/, assets/scene.js
# (window.__MOTION_SCENE = meta.json) and assets/spec.js (window.__MOTION_SPEC = scene.json).
# The spec is checked first with motion/kit/validate.mjs (schema and kit rules). Custom blocks: at most 8
# files of at most 64 KiB, named [a-z][a-z0-9-]*.js, that pass motion/kit/check-blocks.mjs (so even the
# authoring step's own snapshots never load a block that reaches for time, randomness or the network).
# Exits 1 with the reason on stderr when anything is wrong.
# Needs node, jq and motion/node_modules.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
if [[ $# -ne 3 ]]; then echo "usage: motion-assemble.sh <scene-dir> <prepare-dir> <out-dir>" >&2; exit 2; fi
scene_dir="$1"; prepared="$2"; comp="$3"
kit="$root/motion/kit"
gsap_js="$root/motion/node_modules/gsap/dist/gsap.min.js"

die() { echo "motion-assemble: $1" >&2; exit 1; }
size_of() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }

[[ -f "$gsap_js" ]] || die "motion/node_modules is missing (run npm ci in motion/)"
spec="$scene_dir/scene.json"
[[ -f "$spec" ]] || die "$spec is missing"
(( $(size_of "$spec") <= 65536 )) || die "scene.json is larger than 64 KiB"
for f in cover.jpg depth.png meta.json; do
  [[ -s "$prepared/$f" ]] || die "the prepared $f is missing"
done
scene_json="$(jq -ce 'select(type == "object")' "$prepared/meta.json" 2>/dev/null)" || die "the prepared meta.json is not a JSON object"
spec_json="$(jq -ce 'select(type == "object")' "$spec" 2>/dev/null)" || die "scene.json is not a JSON object"
node "$kit/validate.mjs" "$spec" "$prepared/meta.json" >&2 || die "scene.json does not pass motion/kit/validate.mjs"

customs=()
if [[ -d "$scene_dir/blocks" ]]; then
  while IFS= read -r -d '' f; do customs+=("$f"); done < <(find "$scene_dir/blocks" -mindepth 1 -maxdepth 1 -print0 | sort -z)
fi
(( ${#customs[@]} <= 8 )) || die "at most 8 custom blocks"
for f in ${customs[@]+"${customs[@]}"}; do
  name="$(basename "$f")"
  [[ -f "$f" && ! -L "$f" && "$name" =~ ^[a-z][a-z0-9-]*\.js$ ]] || die "custom block $name must be a file named [a-z][a-z0-9-]*.js"
  (( $(size_of "$f") <= 65536 )) || die "custom block $name is larger than 64 KiB"
done
if (( ${#customs[@]} > 0 )); then
  node "$kit/check-blocks.mjs" "$scene_dir/blocks" >&2 || die "a custom block does not pass motion/kit/check-blocks.mjs"
fi
# Every custom/<name> in the spec needs blocks/<name>.js.
while IFS= read -r name; do
  [[ -f "$scene_dir/blocks/$name.js" ]] || die "the spec uses custom/$name but blocks/$name.js is missing"
done < <(jq -r '.blocks[].block | select(startswith("custom/")) | sub("^custom/"; "")' <<<"$spec_json")

rm -rf "$comp"
mkdir -p "$comp/kit" "$comp/blocks" "$comp/assets/vendor"
cp "$kit/compose/index.html" "$comp/index.html"
cp -R "$kit/lib" "$kit/blocks" "$comp/kit/"
for f in ${customs[@]+"${customs[@]}"}; do cp "$f" "$comp/blocks/"; done
cp "$gsap_js" "$comp/assets/vendor/gsap.min.js"
for f in cover.jpg depth.png background.jpg plate.jpg plate-depth.png edges.png glow.png meta.json faces.json palette.json focus.json; do
  if [[ -f "$prepared/$f" ]]; then cp "$prepared/$f" "$comp/assets/$f"; fi
done
printf 'window.__MOTION_SCENE = %s;\n' "$scene_json" > "$comp/assets/scene.js"
printf 'window.__MOTION_SPEC = %s;\n' "$spec_json" > "$comp/assets/spec.js"
echo "assembled $(jq -r '.name // "scene"' <<<"$spec_json") with ${#customs[@]} custom block(s) in $comp" >&2
