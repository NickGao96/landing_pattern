# Landing Pattern iOS (SwiftUI)

Native iPhone implementation for the landing pattern simulator, with no backend dependency.

## Structure

- `LandingPattern/` - SwiftUI app code.
- `LandingPatternCore/` - shared Swift package (`Models`, `Engine`, `Data`) with tests.
- `project.yml` - XcodeGen spec (source of truth for project file).
- `LandingPattern.xcodeproj/` - generated Xcode project.

## Current map decision

- Default stack: `MapKit`.
- App UI is currently MapKit-only.
- Reason: MapKit satisfies tokenless baseline requirement; Mapbox iOS path is not yet implemented.

## Prerequisites

- macOS with Xcode 15+ (full app, iOS 17 SDK).
- Command-line tools alone are not enough for running `swift test`/`xcodebuild` against iOS-targeted package content.
- XcodeGen installed (`brew install xcodegen`).

## Generate project

From repository root:

```bash
npm run ios:project:generate
```

## One-command local pipeline

From repository root:

```bash
npm run ios:pipeline
```

## Run parity fixtures and Swift tests

From repository root:

```bash
npm run ios:fixtures:sync
npm run ios:core:test
```

## Build app for iOS Simulator (CLI)

```bash
npm run ios:app:build:sim
```

## Open in Xcode and run

1. Open `apps/ios/LandingPattern.xcodeproj`.
2. Select scheme `LandingPattern`.
3. Select an iPhone simulator (for example `iPhone 16`).
4. Press `Cmd+R`.

If no iPhone simulator appears:
- Xcode > Settings > Components > install at least one iOS simulator runtime.

## Run on your iPhone

1. Connect iPhone by cable.
2. In Xcode, sign in: Xcode > Settings > Accounts.
3. Target `LandingPattern` > Signing & Capabilities:
   - Team: your Apple ID team.
   - Bundle identifier: unique value if needed.
4. On iPhone, enable Developer Mode if prompted.
5. Choose your iPhone as run destination and press `Cmd+R`.

## Test checklist (manual)

- Search location and apply result.
- Fetch wind (NOAA/Open-Meteo fallback) and manual layer edits.
- Toggle left/right and drift.
- Drag touchdown marker and heading handle.
- Confirm turn labels and pattern arrows render.
- Export snapshot JSON and import it back.

## TestFlight checklist (internal)

1. Configure signing/team/bundle ID.
2. Provide app icon + launch screen assets.
3. Archive and upload using Organizer.
4. Validate scenarios:
   - NOAA success in US.
   - Open-Meteo fallback outside US.
   - left/right + drift toggle behavior.
   - touchdown drag and heading handle circular drag.
   - snapshot export/import.
