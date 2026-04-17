# Component Map

> Concrete repository map for engineers. Describes major directories, files, and how they relate.

## Top-Level Layout

```
landing_pattern/
├── apps/
│   ├── web/                 # React + Vite web app
│   └── ios/                 # SwiftUI iOS app + Swift core package
├── packages/
│   ├── ui-types/            # Shared TypeScript type contracts
│   ├── engine/              # Pattern solver and wingsuit auto solver
│   ├── data/                # Wind data fetchers and canopy presets
│   └── fixtures/            # Parity test fixture generators
├── scripts/                 # CI/build helper scripts
├── docs/                    # Documentation (this directory)
├── package.json             # Monorepo root (npm workspaces)
└── tsconfig.base.json       # Shared TypeScript config
```

## Package Details

### `packages/ui-types` — Type Contracts

| File | Description |
|------|-------------|
| `src/index.ts` | All shared TypeScript interfaces and type aliases |

Key types defined here:
- `PatternInput`, `PatternOutput` — canopy/wingsuit manual solver I/O
- `WingsuitAutoInput`, `WingsuitAutoOutput` — auto solver I/O
- `WindLayer`, `GeoPoint`, `CanopyProfile`, `WingsuitProfile`, `JumperInput`
- `ResolvedJumpRun`, `ResolvedJumpRunSlot`, `RadiusBand`
- `WingsuitAutoJumpRunConfig`, `WingsuitAutoTuning`, `WingsuitAutoDiagnostics`
- `FlightMode` (`"canopy" | "wingsuit"`), `PatternSide` (`"left" | "right"`)

### `packages/engine` — Solver

| File | Description |
|------|-------------|
| `src/index.ts` | Main solver module: `computePattern()`, `solveWingsuitAuto()`, `validatePatternInput()`, `validateWingsuitAutoInput()` |
| `src/math.ts` | Vector math, heading utilities, wind interpolation, coordinate transforms (`localFeetToLatLng`, `latLngToLocalFeet`, `getWindForAltitude`) |
| `test/engine.test.ts` | Vitest test suite covering canopy pattern, wingsuit manual, wingsuit auto, validation edge cases |

**Exported functions:**
- `computePattern(input: PatternInput): PatternOutput`
- `solveWingsuitAuto(input: WingsuitAutoInput): WingsuitAutoOutput`
- `validatePatternInput(input: PatternInput): ValidationResult`
- `validateWingsuitAutoInput(input: WingsuitAutoInput): ValidationResult`

**Important constants (engine defaults):**
- `DEFAULT_WINGSUIT_AUTO_TURN_RATIOS` — `{ turn1: 0.75, turn2: 0.3125 }`
- `DEFAULT_WINGSUIT_AUTO_ASSUMPTIONS` — plane airspeed 85 kt, groupCount 4, separation 1500 ft, etc.
- `DEFAULT_WINGSUIT_AUTO_TUNING` — corridor 250 ft, deploy bearing window 90°, max deploy radius 6562 ft, etc.
- `WL_MAX = 1.7` — wing loading safety threshold

### `packages/data` — Wind + Presets

| File | Description |
|------|-------------|
| `src/index.ts` | `fetchNoaaSurfaceWind()`, `fetchWingsuitWindProfile()`, `extrapolateWindProfile()` |
| `src/presets.ts` | `canopyPresets` array (PD Sabre3 170, Sabre3 150, Storm 150, Pulse 170), `findPresetByModel()` |

**Wind fetch chain:** NOAA observation → NOAA forecast → Open-Meteo (fallback).
**Upper-air winds:** Open-Meteo pressure-level data at 9 pressure levels (1000–600 hPa).

### `packages/fixtures` — Parity Test Data

| File | Description |
|------|-------------|
| `engine/generate-fixtures.mjs` | Generates `fixtures.json` for canopy/wingsuit pattern parity tests |
| `engine/generate-auto-fixtures.mjs` | Generates `wingsuit-auto-fixtures.json` for auto mode parity tests |
| `engine/fixtures.json` | Generated fixture data consumed by Swift tests |
| `engine/wingsuit-auto-fixtures.json` | Generated auto mode fixture data |

## Web App (`apps/web`)

| File/Directory | Description |
|----------------|-------------|
| `src/main.tsx` | React entry point, renders `<App />` |
| `src/App.tsx` | **Main application component** (~2085 lines). Contains all sidebar UI, mode switching, input building, auto mode integration, i18n strings, import/export logic |
| `src/store.ts` | Zustand store with `persist` middleware. All app state (mode, touchdown, heading, side, canopy/wingsuit/auto settings, named spots, language). Persisted to `localStorage` as `landing-pattern-store-v1`. |
| `src/wingsuits.ts` | Wingsuit preset definitions (SWIFT, ATC, FREAK, AURA), normalization, inference, and default gates/wind layers |
| `src/components/MapPanel.tsx` | **Map rendering** (~1191 lines). Uses MapLibre-GL JS. Builds GeoJSON overlays for manual and auto modes. Handles draggable markers (touchdown, heading handle), zone polygons, route lines, waypoint labels. |
| `src/lib/mapStyle.ts` | Map tile style resolution: Esri satellite default, OSM fallback, optional Mapbox via `VITE_MAPBOX_TOKEN` |
| `src/lib/units.ts` | Unit conversion helpers (`feetToMeters`, `knotsToMps`, etc.) |
| `src/styles.css` | Global CSS styles |
| `src/App.test.tsx` | React component tests |
| `src/test/setup.ts` | Test setup |
| `vite.config.ts` | Vite build config |

### Key web data flow

```
App.tsx:
  const patternInput = buildPatternInput(storeState)
  const patternOutput = computePattern(patternInput)
  // or for auto:
  const autoInput = buildWingsuitAutoInput(storeState)
  const autoOutput = solveWingsuitAuto(autoInput)
  
  <MapPanel variant="manual" | "auto" ... />
```

## iOS App (`apps/ios`)

### SwiftUI App (`apps/ios/LandingPattern/`)

| File/Directory | Description |
|----------------|-------------|
| `LandingPatternApp.swift` | App entry point |
| `AppStrings.swift` | i18n strings for English and Chinese |
| `WingsuitPresets.swift` | Wingsuit preset definitions (mirrors web `wingsuits.ts`) |
| `State/LandingStore.swift` | **Main state management** (~810 lines). `@MainActor ObservableObject`. All state, persistence via `@AppStorage`, wind fetching, location search (MapKit + CLGeocoder + Open-Meteo fallback), snapshot export/import. **Auto mode gated by `iosWingsuitAutoModeEnabled = false`.** |
| `Views/ContentView.swift` | Main UI view (~32k). Sidebar controls mirroring web UI. |
| `Views/SnapshotDocument.swift` | Document type for snapshot import/export |
| `Map/LandingMapProtocol.swift` | Protocol for map view abstraction |
| `Map/MapKitLandingMapView.swift` | **MapKit implementation** (~42k). Overlays, draggable markers, pattern rendering. |
| `Map/MapboxLandingMapView.swift` | Mapbox stub (not implemented yet) |
| `Map/MapStackEvaluator.swift` | Map stack selection logic (always selects MapKit currently) |
| `Data/` | Empty (data logic is in LandingPatternCore) |
| `Models/` | Empty (model definitions are in LandingPatternCore) |
| `Engine/` | Empty (engine is in LandingPatternCore) |
| `Resources/` | Info.plist, assets |

### Swift Core Package (`apps/ios/LandingPatternCore/`)

| File/Directory | Description |
|----------------|-------------|
| `Package.swift` | Swift package manifest (iOS 17+, macOS 13+) |
| `Sources/LandingPatternCore/Models/Contracts.swift` | All model structs/enums mirroring `@landing/ui-types` |
| `Sources/LandingPatternCore/Engine/PatternEngine.swift` | `computePattern()` and `solveWingsuitAuto()` in Swift (~1342 lines) |
| `Sources/LandingPatternCore/Engine/Math.swift` | Vector math, wind interpolation (mirrors `packages/engine/src/math.ts`) |
| `Sources/LandingPatternCore/Data/CanopyPresets.swift` | Canopy presets (mirrors `packages/data/src/presets.ts`) |
| `Sources/LandingPatternCore/Data/WeatherService.swift` | NOAA + Open-Meteo wind fetching |
| `Tests/LandingPatternCoreTests/EngineParityTests.swift` | Fixture-based parity tests against TS engine output |
| `Tests/LandingPatternCoreTests/EngineUnitTests.swift` | Unit tests for Swift engine |
| `Tests/LandingPatternCoreTests/WeatherServiceTests.swift` | Weather service tests |
| `Tests/LandingPatternCoreTests/Fixtures/` | Copied parity fixtures from `packages/fixtures/engine/` |

### iOS configuration

| File | Description |
|------|-------------|
| `apps/ios/project.yml` | XcodeGen spec (source of truth for `.xcodeproj`) |
| `apps/ios/README.md` | iOS setup and testing instructions |
| `apps/ios/docs/map-stack-spike.md` | Map stack evaluation notes |

## Scripts

| File | Description |
|------|-------------|
| `scripts/ios_pipeline.sh` | Runs full iOS pipeline: generate project → sync fixtures → test → build |

## Where Things Live

| Concept | Web | iOS |
|---------|-----|-----|
| State management | `apps/web/src/store.ts` (Zustand) | `apps/ios/LandingPattern/State/LandingStore.swift` |
| Rendering | `apps/web/src/components/MapPanel.tsx` (MapLibre) | `apps/ios/LandingPattern/Map/MapKitLandingMapView.swift` |
| Domain logic (solver) | `packages/engine/src/index.ts` | `apps/ios/LandingPatternCore/Sources/.../Engine/PatternEngine.swift` |
| Math utilities | `packages/engine/src/math.ts` | `apps/ios/LandingPatternCore/Sources/.../Engine/Math.swift` |
| Type contracts | `packages/ui-types/src/index.ts` | `apps/ios/LandingPatternCore/Sources/.../Models/Contracts.swift` |
| Wind data | `packages/data/src/index.ts` | `apps/ios/LandingPatternCore/Sources/.../Data/WeatherService.swift` |
| Canopy presets | `packages/data/src/presets.ts` | `apps/ios/LandingPatternCore/Sources/.../Data/CanopyPresets.swift` |
| Wingsuit presets | `apps/web/src/wingsuits.ts` | `apps/ios/LandingPattern/WingsuitPresets.swift` |

## Files to Read First (New Engineer Onboarding)

1. **This document** and [Architecture Overview](architecture_overview.md)
2. `packages/ui-types/src/index.ts` — understand all type contracts
3. `packages/engine/src/index.ts` — start from `computePattern()` for basic flow, then `solveWingsuitAuto()` for auto mode
4. `packages/engine/src/math.ts` — coordinate transforms and wind interpolation
5. `apps/web/src/store.ts` — how state is managed and persisted
6. `apps/web/src/App.tsx` lines 115–210 — `buildPatternInput()` and `buildWingsuitAutoInput()` for how UI state becomes solver input
7. `apps/web/src/components/MapPanel.tsx` — how solver output becomes visual overlays
8. `packages/engine/test/engine.test.ts` — test cases document expected behavior
9. `docs/wingsuit-auto-mode.md` — detailed auto solver documentation
