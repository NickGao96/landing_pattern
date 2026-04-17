# Architecture Overview

> Main entry point for engineers. Start here, then follow links to detailed docs.

## What This Product Does

Landing Pattern Simulator is a **local-first skydiving flight-path planner** for two disciplines:

1. **Canopy mode** — plan a standard downwind/base/final landing pattern, given canopy performance, jumper weight, and wind layers at 900/600/300 ft.
2. **Wingsuit mode** — plan a three-leg freefall route from exit to deployment, either manually or via the **auto solver** that resolves jump-run geometry and sweeps valid routes automatically.

The app runs on **web** (React + Vite) and **iOS** (SwiftUI). Both platforms share the same domain concepts but have **independent engine implementations** (TypeScript and Swift). The web app is the feature leader; iOS lags on wingsuit auto mode.

## User-Facing Modes and Flows

| Mode | Sub-mode | Description |
|------|----------|-------------|
| **Canopy** | — | User picks touchdown, heading, side, canopy preset, jumper weight, gates (900/600/300/0 ft), and wind layers. Engine solves the 3-leg pattern geometry. |
| **Wingsuit Manual** | — | Same as canopy but with wingsuit flight parameters (horizontal speed, fall rate) instead of canopy profile. Gates are at higher altitudes (e.g. 12000/10000/6500/4000 ft). |
| **Wingsuit Auto** | Normal placement | User picks landing point, side, wingsuit preset, and wind layers. Solver resolves headwind-based jump-run heading, places slick groups + WS slot, then sweeps forward three-leg routes. |
| **Wingsuit Auto** | Distance placement | Aircraft continues offsite from the normal run, turns 90°, and drops the wingsuit first. Short gather leg then return toward landing. |

## High-Level System Division

```
┌─────────────────────────────────────────────────────┐
│                    Monorepo Root                     │
│  package.json (workspaces: apps/*, packages/*)      │
├──────────────┬──────────────────┬────────────────────┤
│  packages/   │     apps/web/    │    apps/ios/       │
│  ui-types    │  React + Vite    │  SwiftUI + MapKit  │
│  engine      │  MapLibre-GL     │  LandingPatternCore│
│  data        │  Zustand store   │  (Swift Package)   │
│  fixtures    │                  │                    │
└──────────────┴──────────────────┴────────────────────┘
```

### Shared packages (TypeScript, web-side)

| Package | Scope (npm) | Purpose |
|---------|-------------|---------|
| `packages/ui-types` | `@landing/ui-types` | Shared TypeScript types for all contracts between packages |
| `packages/engine` | `@landing/engine` | Pattern solver (`computePattern`) and wingsuit auto solver (`solveWingsuitAuto`) |
| `packages/data` | `@landing/data` | NOAA/NWS wind fetchers, Open-Meteo upper-air wind fetcher, canopy presets, wind extrapolation |
| `packages/fixtures` | — | Generates parity test fixtures consumed by Swift tests |

### Apps

| App | Stack | Purpose |
|-----|-------|---------|
| `apps/web` | React 18 + Vite + MapLibre-GL + Zustand | Full-featured web UI; the canonical reference implementation |
| `apps/ios` | SwiftUI + MapKit + LandingPatternCore Swift package | Native iPhone app; canopy + manual wingsuit fully working, auto mode gated off |

## Main Data Flow

```
User inputs (UI controls)
        │
        ▼
  State store (Zustand / LandingStore.swift)
        │
        ├── mode = canopy ──────▶ buildPatternInput() ──▶ computePattern()
        │                                                      │
        ├── mode = wingsuit     ──▶ buildPatternInput() ──▶ computePattern()
        │   (manual)                                           │
        │                                                      │
        └── mode = wingsuit     ──▶ buildWingsuitAutoInput() ──▶ solveWingsuitAuto()
            (auto)                                              │
                                                                ▼
                                                    PatternOutput / WingsuitAutoOutput
                                                                │
                                                                ▼
                                               MapPanel renders GeoJSON overlays
```

## How Canopy and Wingsuit Paths Fit

Both modes share the same `computePattern()` entry point for the basic three-leg pattern solver. The difference:

- **Canopy**: Airspeed is derived from `canopy.airspeedRefKt`, wing loading, and WL exponent. Sink rate is `airspeed / glideRatio`. Gates are typically 900/600/300/0 ft.
- **Wingsuit**: Airspeed and fall rate are user-specified directly. Gates are at much higher altitudes. The first and/or second legs can be collapsed (equal gate values) to produce a 2-leg pattern.

**Wingsuit auto mode** bypasses `computePattern` entirely and uses `solveWingsuitAuto()`, which resolves jump-run geometry, sweeps candidate routes, and returns a rich output with zones, corridors, bands, and diagnostics.

## Where Wingsuit Auto Mode Fits

Auto mode is a **web-only** feature (iOS has the code scaffolded but gated by `iosWingsuitAutoModeEnabled = false`). It is the most complex subsystem:

1. **Jump-run resolution** — heading from wind or manual input, optional reciprocal constraint, spot/crosswind offset tables, slot placement
2. **Forward route sweep** — varies first-leg heading, offset heading, return heading, and altitude-drop fractions; integrates each candidate forward through altitude-dependent wind layers
3. **Hard filters** — first-leg track angle, selected side, corridor exclusion, deploy radius, wind no-deploy sector, canopy return margin
4. **Ranking** — safety penalty + shape penalty + radius penalty − saturated safety reward

See [Wingsuit Auto Mode](wingsuit-auto-mode.md) for full technical details.

## Current Implementation Status

| Feature | Web | iOS |
|---------|-----|-----|
| Canopy pattern solver | ✅ | ✅ |
| Wingsuit manual pattern | ✅ | ✅ |
| Wingsuit auto mode | ✅ | ❌ (gated off) |
| NOAA surface wind | ✅ | ✅ |
| Open-Meteo upper-air winds | ✅ | ✅ |
| Wind shear extrapolation | ✅ | ✅ |
| Manual wind layer override | ✅ | ✅ |
| Canopy presets | ✅ | ✅ |
| Wingsuit presets (SWIFT/ATC/FREAK/AURA/custom) | ✅ | ✅ |
| Map (satellite + overlays) | ✅ (MapLibre) | ✅ (MapKit) |
| Snapshot export/import | ✅ | ✅ |
| Named spots persistence | ✅ | ❌ |
| i18n (English + Chinese) | ✅ | ✅ |
| Unit toggle (imperial/metric) | ✅ | Partial |
| Parity test fixtures | ✅ (generates) | ✅ (consumes) |
| Distance jump-run placement | ✅ | ❌ |

See [Web / iOS Feature Status](web_ios_feature_status.md) for detailed comparison.

## Doc Index

| Document | Purpose |
|----------|---------|
| [Architecture Overview](architecture_overview.md) | This file — high-level product and system overview |
| [Component Map](component_map.md) | Repository map with key files and directories |
| [Web / iOS Feature Status](web_ios_feature_status.md) | Feature parity comparison |
| [Wingsuit Auto Mode](wingsuit-auto-mode.md) | Canonical technical doc for the auto solver |
| [Domain Model](domain_model.md) | Core domain concepts, data structures, coordinate systems |
| [Rendering Pipeline](rendering_pipeline.md) | How flight paths become visible on screen |
