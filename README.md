# Landing Pattern Simulator (Web V1)

Local-first skydiving landing-pattern simulator for planning downwind/base/final geometry using canopy assumptions and wind profile estimates.

## What is implemented

- Web app (`React + TypeScript + Vite`) with map + sidebar controls.
- 2D pattern solver (`packages/engine`) for 900/600/300/0 ft gates.
- Safety gating:
  - Blocks output when wing loading > 1.7.
  - Warns when final-leg wind penetration is too low.
- Wingsuit auto mode:
  - Lets the user pick a landing point, jump-run heading intent, and a left/right side.
  - Resolves normal jump runs from heading intent, wind, and jump-run assumptions.
  - Adds distance placement for a wingsuit-first run after the aircraft continues offsite and turns 90°.
  - Computes landing no-deploy, downwind deploy-forbidden, and jump-run corridor zones.
  - Solves deploy/turn/exit automatically and only returns a route when exit comes back onto the resolved `WS` slot.
- NOAA/NWS integration (`packages/data`):
  - Fetches surface wind from observations with forecast fallback.
  - Extrapolates 300/600/900 winds via configurable shear exponent.
  - Full manual wind-layer override in UI.
- Tokenless map path by default (Esri imagery attempt, OSM fallback).
- Optional Mapbox style backup via `VITE_MAPBOX_TOKEN`.
- Local persistence for user settings and saved touchdown spots.
- JSON snapshot export/import.

## Monorepo layout

- `apps/web` - web UI and map integration.
- `packages/ui-types` - shared types.
- `packages/engine` - solver + validators.
- `packages/data` - canopy presets + NOAA adapters.

## Prerequisites

- Node 24+
- npm 11+

## Install

```bash
npm install
```

## Run tests

```bash
npm run test
```

## Build

```bash
npm run build
```

## Run locally

```bash
npm run dev
```

Then open the printed local URL (default Vite URL).

## Access From Phone (LAN/Hotspot)

Use this mode when your phone and laptop are on the same network (Wi-Fi or personal hotspot):

```bash
npm run dev:lan
```

Find your laptop IP:

```bash
ipconfig getifaddr en0
```

Fallback if needed:

```bash
ifconfig | grep "inet "
```

Open this on your phone browser:

```text
http://<laptop-ip>:5173
```

Hotspot note: this works only if the hotspot allows client-to-client traffic.

### Phone check with preview build

```bash
npm run build
npm run preview:lan
```

Then open:

```text
http://<laptop-ip>:4173
```

### Troubleshooting

- Keep phone and laptop on the same network/subnet.
- Disable VPN on laptop/phone if routing looks wrong.
- Allow Node/Vite through local firewall.
- Some hotspot/network configurations block client isolation (peer access).

### Safety note

Do not router port-forward this PoC.

## Optional Mapbox backup

Set in shell before `npm run dev`:

```bash
export VITE_MAPBOX_TOKEN=<your-token>
```

Without this variable, the app stays tokenless.

## Notes

- This tool is a planning aid and intentionally does not model high-performance/swoop dynamics.
- For strict environments where browser geolocation or NOAA fetch fails, manual location/wind entry remains available.

## Wingsuit Auto Mode

Wingsuit auto mode is the guided alternative to the manual pattern drawer.

The user provides:

- landing point
- jump-run direction source
  - `auto (headwind)`
  - `manual`
- optional reciprocal runway-pair constraint
- left/right side relative to jump run
- exit and deploy heights
- wingsuit performance
- wind layers
- optional advanced jump-run assumptions
  - plane airspeed
  - group count
  - group separation
  - slick deploy height
  - slick return radius
- optional distance placement
  - offsite distance, default 4 km
  - aircraft turn side, coupled to the route turn back toward the landing point

From there, auto mode does the rest:

- resolves jump-run heading from headwind or manual compass input
- snaps that heading to a runway pair when a reciprocal constraint is enabled
- computes aircraft ground speed and spacing time from the selected plane speed and winds aloft
- in normal placement, uses a bounded spot table at slick deploy height to place the run after/before the LZ and a lighter crosswind table to offsite it
- in normal placement, fits the normal-group span inside the configured slick return radius and derives labeled slots (`G1`, `G2`, `G3`, `WS`)
- in distance placement, continues from the normal run by the configured offsite distance, turns the aircraft 90°, and resolves a single first-out `WS` slot shortly after the turn
- starts the wingsuit route exactly at the resolved `WS` slot
- sweeps forward three-leg route candidates through altitude-dependent winds
- varies exit, offset, and return headings plus intermediate leg lengths
- renders and enforces a light downwind deploy-forbidden half-space
- renders a small landing no-deploy circle
- buffers jump run with a forbidden corridor
- requires the first leg to stay within 45° of jump-run direction on the selected side
- rejects routes that cross the post-departure jump-run corridor, deploy inside the wind no-deploy sector, or cannot preserve canopy-return margin
- ranks normal valid routes by saturated safety margin, rectangular ground-track shape, and a soft deploy-distance annulus
- ranks distance valid routes by saturated safety margin, short gather leg, clean return track, and the same soft deploy-distance annulus

If no solution satisfies those constraints, auto mode blocks and shows diagnostics instead of drawing a misleading pattern.

Implementation details are documented in [docs/wingsuit-auto-mode.md](docs/wingsuit-auto-mode.md).

## Native iOS (SwiftUI V1)

Native iPhone implementation is scaffolded under:

- `apps/ios/LandingPattern/` - SwiftUI app source (views, state, map abstractions)
- `apps/ios/LandingPatternCore/` - Swift package for engine/data/models + tests
- `packages/fixtures/engine/` - TS-generated parity fixtures consumed by Swift tests

### iOS prerequisites

- Xcode 15+ with iOS 17 SDK (full Xcode, not only Command Line Tools).
- macOS with at least one iOS Simulator runtime installed in Xcode.
- XcodeGen installed (for `ios:project:generate`):

```bash
brew install xcodegen
```

### Generate iOS project

```bash
npm run ios:project:generate
```

### Refresh parity fixtures

```bash
npm run ios:fixtures:sync
```

### Run Swift core tests

```bash
npm run ios:core:test
```

### Build app for iOS Simulator

```bash
npm run ios:app:build:sim
```

### Verified local iOS pipeline

```bash
npm run ios:pipeline
```

Equivalent expanded steps:

```bash
npm run ios:project:generate
npm run ios:fixtures:sync
npm run ios:core:test
npm run ios:app:build:sim
```

### Open and run iOS app in Xcode

1. Open `apps/ios/LandingPattern.xcodeproj`.
2. Select scheme `LandingPattern`.
3. Pick an iPhone simulator and run (`Cmd+R`).
4. If no simulator is listed, install one via Xcode Settings > Components.

### Run on a physical iPhone

1. Connect iPhone to the Mac.
2. In Xcode, sign in with Apple ID (`Xcode > Settings > Accounts`).
3. In target `LandingPattern > Signing & Capabilities`, set your Team.
4. Keep bundle id unique if needed (for example `com.example.landingpattern`).
5. Select your iPhone as destination and run (`Cmd+R`).
6. If prompted, enable Developer Mode on iPhone and trust local signing.

### iOS docs

- Detailed iOS setup/testing notes: `apps/ios/README.md`

The app is designed to default to MapKit for tokenless baseline operation. Mapbox remains an optional fallback path.
