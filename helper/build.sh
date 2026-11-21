#!/bin/bash
# Builds the keyboard helper. It has to be a real binary with its own path,
# because macOS attaches the Accessibility permission to it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/../bin/mycast-helper}"

mkdir -p "$(dirname "$out")"
swiftc -O -o "$out" "$here/main.swift"
codesign --force --sign - --identifier mycast-helper -r='designated => identifier "mycast-helper"' "$out"
echo "built $out"
