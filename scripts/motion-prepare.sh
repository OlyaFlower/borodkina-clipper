#!/usr/bin/env bash
# Usage: motion-prepare.sh <cover-image> <out-dir>   Prepares a cover for the motion kit (motion/prepare/prepare.py):
#          cover.jpg (1920x1080), depth.png, faces.json, palette.json, focus.json, meta.json [, background.jpg]
#        motion-prepare.sh --setup                    Only installs the Python packages and models; prints the python path.
# The Python packages (motion/prepare/requirements.txt) are installed by sha256 into a venv, and the ONNX models
# (motion/prepare/models.env) are downloaded at pinned revisions and checked by sha256, both under $MOTION_CACHE
# (default ~/.cache/borodkina-motion), so a cached runner skips the downloads.
# Env: WORK_DIR (error-code and error-message go there; default <out-dir>), MOTION_PYTHON (default python3, must be 3.12).
# On failure writes error-code source_invalid (the cover is not a usable JPEG, PNG or WebP image of at most 20 MiB)
# or render_failed (setup, models or the analysis itself), then exits 1. Must finish in 2 minutes.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
prep="$root/motion/prepare"

setup_only=false
if [[ "${1-}" == --setup && $# -eq 1 ]]; then
  setup_only=true
  out=""
  work="${WORK_DIR:-$(mktemp -d)}"
elif [[ $# -eq 2 ]]; then
  cover="$1"; out="$2"
  work="${WORK_DIR:-$out}"
else
  echo "usage: motion-prepare.sh <cover-image> <out-dir> | --setup" >&2; exit 2
fi
mkdir -p "$work"

fail() { # code message
  echo "$2" > "$work/error-message"; echo "$1" > "$work/error-code"; echo "motion error: $1: $2" >&2; exit 1
}
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
began=$SECONDS

# ---- the cover: only JPEG, PNG and WebP by their magic bytes, at most 20 MiB
if ! $setup_only; then
  [[ -f "$cover" ]] || fail source_invalid "The cover image is missing"
  size="$(stat -c %s "$cover" 2>/dev/null || stat -f %z "$cover")"
  (( size > 0 && size <= 20 * 1024 * 1024 )) || fail source_invalid "The cover is empty or larger than 20 MiB"
  magic="$(head -c 12 "$cover" | od -An -tx1 | tr -d ' \n')"
  case "$magic" in
    ffd8ff* | 89504e470d0a1a0a* | 52494646????????57454250) ;;
    *) fail source_invalid "The cover is not a JPEG, PNG or WebP image" ;;
  esac
fi

# ---- Python packages, pinned by sha256
cache="${MOTION_CACHE:-$HOME/.cache/borodkina-motion}"
mkdir -p "$cache"
python="${MOTION_PYTHON:-python3}"
pyver="$("$python" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" \
  || fail render_failed "Python is not available for the motion prepare step"
[[ "$pyver" == 3.12 ]] || fail render_failed "The motion prepare step needs Python 3.12 (found $pyver)"
venv="$cache/venv-py$pyver-$(sha256 "$prep/requirements.txt" | cut -c1-16)"
if [[ ! -f "$venv/.complete" ]]; then
  rm -rf "$venv"
  { "$python" -m venv "$venv" \
      && "$venv/bin/python" -m pip install --quiet --disable-pip-version-check --no-input \
           --require-hashes --no-deps --only-binary :all: -r "$prep/requirements.txt"; } > "$work/pip.log" 2>&1 \
    || { tail -n 20 "$work/pip.log" >&2; fail render_failed "Installing the pinned prepare packages failed"; }
  touch "$venv/.complete"
fi

# ---- ONNX models, pinned by revision and sha256
# shellcheck source=../motion/prepare/models.env
source "$prep/models.env"
fetch_model() { # url sha256 -> path on stdout
  local dest="$cache/models/$2.onnx"
  if [[ ! -f "$dest" || "$(sha256 "$dest")" != "$2" ]]; then
    mkdir -p "$cache/models"
    curl -fsSL --retry 3 --max-time 90 -o "$dest.part" "$1" || return 1
    [[ "$(sha256 "$dest.part")" == "$2" ]] || { rm -f "$dest.part"; echo "sha256 mismatch for $1" >&2; return 1; }
    mv "$dest.part" "$dest"
  fi
  echo "$dest"
}
depth_model="$(fetch_model "$DEPTH_MODEL_URL" "$DEPTH_MODEL_SHA256")" || fail render_failed "The depth model could not be downloaded"
face_model="$(fetch_model "$FACE_MODEL_URL" "$FACE_MODEL_SHA256")" || fail render_failed "The face model could not be downloaded"

if $setup_only; then echo "$venv/bin/python"; exit 0; fi

# ---- the analysis; prepare.py exits 3 for an unusable image and 4 for anything else
rm -rf "$out"
mkdir -p "$out"
limit=$((120 - (SECONDS - began)))
(( limit > 10 )) || fail render_failed "The prepare setup took longer than 2 minutes"
to=()
if command -v timeout > /dev/null; then to=(timeout "$limit"); fi
set +e
${to[@]+"${to[@]}"} "$venv/bin/python" -I "$prep/prepare.py" "$cover" "$out" "$depth_model" "$face_model" 2> "$work/prepare.log"
rc=$?
set -e
cat "$work/prepare.log" >&2
reason="$(grep -v '^prepare: ' "$work/prepare.log" | tail -n 1 | cut -c1-200 || true)"
case "$rc" in
  0) ;;
  3) fail source_invalid "${reason:-The cover image could not be read}" ;;
  124) fail render_failed "Preparing the cover took longer than 2 minutes" ;;
  *) fail render_failed "Preparing the cover failed${reason:+: $reason}" ;;
esac
for f in cover.jpg depth.png faces.json palette.json focus.json meta.json; do
  [[ -s "$out/$f" ]] || fail render_failed "The prepare step did not write $f"
done
echo $((SECONDS - began)) > "$work/prepare-seconds"
echo "prepare ok in $(cat "$work/prepare-seconds") s"
