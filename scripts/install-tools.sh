#!/usr/bin/env bash
# Usage: install-tools.sh <ffmpeg|yt-dlp>...   Installs pinned, sha256-verified tools into $TOOLS_DIR
# (default $RUNNER_TEMP/bin) and adds that directory to $GITHUB_PATH when running in Actions.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$here/versions.env"
dir="${TOOLS_DIR:-${RUNNER_TEMP:-/tmp}/bin}"
mkdir -p "$dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

check() { echo "$1  $2" | sha256sum --check --status || { echo "sha256 mismatch for $2" >&2; exit 1; }; }

for tool in "$@"; do
  case "$tool" in
    yt-dlp)
      curl -fsSL --retry 3 -o "$tmp/yt-dlp" \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux"
      check "$YTDLP_SHA256" "$tmp/yt-dlp"
      install -m 0755 "$tmp/yt-dlp" "$dir/yt-dlp"
      ;;
    ffmpeg)
      curl -fsSL --retry 3 -o "$tmp/ffmpeg.tar.xz" \
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${FFMPEG_ASSET}"
      check "$FFMPEG_SHA256" "$tmp/ffmpeg.tar.xz"
      mkdir "$tmp/ff"
      tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp/ff" --strip-components=1
      install -m 0755 "$tmp/ff/bin/ffmpeg" "$tmp/ff/bin/ffprobe" "$dir/"
      ;;
    *) echo "unknown tool: $tool" >&2; exit 2 ;;
  esac
done
if [[ -n "${GITHUB_PATH:-}" ]]; then echo "$dir" >> "$GITHUB_PATH"; fi
