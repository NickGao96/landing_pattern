# Landing Pattern Simulator (Web V1)

Local-first skydiving landing-pattern simulator for planning downwind/base/final geometry using canopy assumptions and wind profile estimates.

## What is implemented

- Web app (`React + TypeScript + Vite`) with map + sidebar controls.
- 2D pattern solver (`packages/engine`) for 900/600/300/0 ft gates.
- Safety gating:
  - Blocks output when wing loading > 1.7.
  - Blocks output when final-leg wind penetration is too low.
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

## Optional Mapbox backup

Set in shell before `npm run dev`:

```bash
export VITE_MAPBOX_TOKEN=<your-token>
```

Without this variable, the app stays tokenless.

## Notes

- This tool is a planning aid and intentionally does not model high-performance/swoop dynamics.
- For strict environments where browser geolocation or NOAA fetch fails, manual location/wind entry remains available.
