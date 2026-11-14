#!/usr/bin/env bash
# Usage: motion-measure.sh <at-0s.png> <at-2s.png> ...   Scores how much snapshots move against the first one
# (scripts/motion-measure.py, the same measure motion-gates.sh uses) with the prepare venv's Python.
# For the authoring skill: one command it may run, instead of locating the venv itself.
# Sets the venv up first if needed (motion-prepare.sh --setup, cached), in a scratch dir so a failure
# here never leaves an error code in the job's $WORK_DIR. Prints the measure's JSON.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -lt 2 ]]; then echo "usage: motion-measure.sh <first.png> <other.png>..." >&2; exit 2; fi
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
py="$(WORK_DIR="$scratch" bash "$here/motion-prepare.sh" --setup 2> "$scratch/setup.log")" \
  || { tail -n 5 "$scratch/setup.log" >&2; echo "motion-measure: the prepare venv could not be set up" >&2; exit 1; }
"$py" -I "$here/motion-measure.py" "$@"
