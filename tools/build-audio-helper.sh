#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_ROOT="${TMPDIR:-${HOME}/Library/Caches}"
BUILD="$(mktemp -d "$TEMP_ROOT/spotify-audio-build.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
ARCH="$(uname -m)"
APP="$ROOT/native/SpotifyAudioHelper.app"
mkdir -p "$BUILD/ModuleCache" "$APP/Contents/MacOS"
xcrun swiftc -swift-version 6 -O -target "$ARCH-apple-macos26.0" \
  -module-cache-path "$BUILD/ModuleCache" \
  -framework Foundation -framework CoreAudio -framework Accelerate \
  "$ROOT/native/SpotifyAudioHelper.swift" -o "$BUILD/SpotifyAudioHelper"
cp "$ROOT/native/Info.plist" "$APP/Contents/Info.plist"
cp "$BUILD/SpotifyAudioHelper" "$APP/Contents/MacOS/SpotifyAudioHelper"
codesign --force --sign - --entitlements "$ROOT/native/SpotifyAudioHelper.entitlements" "$APP"
"$APP/Contents/MacOS/SpotifyAudioHelper" --self-test
printf '%s\n' "$APP"
