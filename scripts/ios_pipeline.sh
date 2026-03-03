#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$1"
}

cd "$ROOT_DIR"

step "Generating Xcode project"
npm run ios:project:generate

step "Resolving Swift package dependencies"
(
  cd "$ROOT_DIR/apps/ios"
  xcodebuild -resolvePackageDependencies \
    -project LandingPattern.xcodeproj \
    -scheme LandingPattern
)

step "Syncing TS->Swift parity fixtures"
npm run ios:fixtures:sync

step "Running Swift core tests"
npm run ios:core:test

step "Building iOS app for Simulator"
npm run ios:app:build:sim

step "Done"
echo "iOS pipeline completed successfully."
