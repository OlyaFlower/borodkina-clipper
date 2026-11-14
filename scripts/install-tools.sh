#!/usr/bin/env bash
# Usage: install-tools.sh <ffmpeg|yt-dlp|deno|bun>...   Installs pinned, sha256-verified tools into $TOOLS_DIR
# (default $RUNNER_TEMP/bin) and adds that directory to $GITHUB_PATH when running in Actions.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$here/versions.env"
dir="${TOOLS_DIR:-${RUNNER_TEMP:-/tmp}/bin}"
mkdir -p "$dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  *) arch=x64 ;;
esac

check() { echo "$1  $2" | sha256sum --check --status || { echo "sha256 mismatch for $2" >&2; exit 1; }; }

for tool in "$@"; do
  case "$tool" in
    yt-dlp)
      asset=yt-dlp_linux; sum="$YTDLP_SHA256"
      if [[ "$arch" == arm64 ]]; then asset=yt-dlp_linux_aarch64; sum="$YTDLP_SHA256_ARM64"; fi
      curl -fsSL --retry 3 -o "$tmp/yt-dlp" \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}"
      check "$sum" "$tmp/yt-dlp"
      install -m 0755 "$tmp/yt-dlp" "$dir/yt-dlp"
      ;;
    ffmpeg)
      asset="$FFMPEG_ASSET"; sum="$FFMPEG_SHA256"
      if [[ "$arch" == arm64 ]]; then asset="$FFMPEG_ASSET_ARM64"; sum="$FFMPEG_SHA256_ARM64"; fi
      curl -fsSL --retry 3 -o "$tmp/ffmpeg.tar.xz" \
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${asset}"
      check "$sum" "$tmp/ffmpeg.tar.xz"
      mkdir "$tmp/ff"
      tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp/ff" --strip-components=1
      install -m 0755 "$tmp/ff/bin/ffmpeg" "$tmp/ff/bin/ffprobe" "$dir/"
      ;;
    deno)
      asset=deno-x86_64-unknown-linux-gnu.zip; sum="$DENO_SHA256_X64"
      if [[ "$arch" == arm64 ]]; then asset=deno-aarch64-unknown-linux-gnu.zip; sum="$DENO_SHA256_ARM64"; fi
      curl -fsSL --retry 3 -o "$tmp/deno.zip" \
        "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/${asset}"
      check "$sum" "$tmp/deno.zip"
      unzip -q -o "$tmp/deno.zip" -d "$tmp/dn"
      install -m 0755 "$tmp/dn/deno" "$dir/deno"
      ;;
    bun)
      asset=bun-linux-x64; sum="$BUN_SHA256_X64"
      if [[ "$arch" == arm64 ]]; then asset=bun-linux-aarch64; sum="$BUN_SHA256_ARM64"; fi
      curl -fsSL --retry 3 -o "$tmp/bun.zip" \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}.zip"
      check "$sum" "$tmp/bun.zip"
      unzip -q -o "$tmp/bun.zip" -d "$tmp/bn"
      install -m 0755 "$tmp/bn/$asset/bun" "$dir/bun"
      ;;
    *) echo "unknown tool: $tool" >&2; exit 2 ;;
  esac
done
if [[ -n "${GITHUB_PATH:-}" ]]; then echo "$dir" >> "$GITHUB_PATH"; fi
