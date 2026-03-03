# Landing Pattern Simulator (Web V1)

Local-first skydiving landing-pattern simulator for planning downwind/base/final geometry using canopy assumptions and wind profile estimates.

## What is implemented

- Web app (`React + TypeScript + Vite`) with map + sidebar controls.
- 2D pattern solver (`packages/engine`) for 900/600/300/0 ft gates.
- Safety gating:
  - Blocks output when wing loading > 1.7.
  - Warns when final-leg wind penetration is too low.
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

## Native iOS (SwiftUI V1)

Native iPhone implementation is scaffolded under:

- `apps/ios/LandingPattern/` - SwiftUI app source (views, state, map abstractions)
- `apps/ios/LandingPatternCore/` - Swift package for engine/data/models + tests
- `packages/fixtures/engine/` - TS-generated parity fixtures consumed by Swift tests

### iOS prerequisites

- Xcode 15+ with iOS 17 SDK (full Xcode, not only Command Line Tools).
- macOS with at least one iOS Simulator runtime installed in Xcode.

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
