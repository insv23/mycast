#!/bin/bash
set -euo pipefail

app="${1:-build/darwin-arm64/MyCast.app}"
helper="$app/Contents/Resources/mycast-helper"

codesign --force --sign - --identifier mycast-helper -r='designated => identifier "mycast-helper"' "$helper"
codesign --force --sign - --identifier com.example.mycast -r='designated => identifier "com.example.mycast"' "$app"
