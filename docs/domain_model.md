# Domain Model

> Core domain concepts, data structures, coordinate systems, and unit conventions.

## Coordinate System

All solver geometry uses a **local flat-earth frame** centered at the landing/touchdown point:

```text
northFt = (lat - refLat) × 364000
eastFt  = (lng - refLng) × 364000 × max(cos(refLat), 1e-5)
```

- **Origin:** landing point (auto mode) or touchdown (manual mode)
- **+North:** increasing latitude
- **+East:** increasing longitude
- **Units:** feet (internal); meters available via UI toggle

### Heading Convention

Aviation convention throughout:

| Heading | Direction |
|---------|-----------|
| `0°` | North |
| `90°` | East |
| `180°` | South |
| `270°` | West |

Unit vector for a heading:

```text
east  = sin(heading_rad)
north = cos(heading_rad)
```

### Wind Direction

Wind layers store `dirFromDeg` — the compass heading the wind blows **from** (meteorological convention). The solver converts to a ground-travel vector:

```text
travelDir = dirFromDeg + 180°
windVec = speedKt × unit(travelDir)
```

### Coordinate Conversion Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `latLngToLocalFeet(refLat, refLng, lat, lng)` | `engine/src/math.ts` | Geo → local feet |
| `localFeetToLatLng(refLat, refLng, eastFt, northFt)` | `engine/src/math.ts` | Local feet → geo |
| `geoPointFromLocal(reference, localPoint)` | `engine/src/index.ts` | Shorthand for inverse transform |

## Core Data Structures

### Flight Modes

```typescript
type FlightMode = "canopy" | "wingsuit";
```

Determines which solver parameters and gates are used.

### Pattern Side

```typescript
type PatternSide = "left" | "right";
```

- **Left:** pattern turns left relative to the landing heading (standard traffic direction)
- **Right:** pattern turns right

In auto mode, this also determines which side of the jump run the wingsuit route flies on.

### Wind Layer

```typescript
interface WindLayer {
  altitudeFt: number;    // above ground level
  speedKt: number;       // wind speed in knots
  dirFromDeg: number;    // cardinal direction wind blows FROM
  source: "auto" | "manual";
}
```

The wind model sorts layers by altitude and **linearly interpolates** speed and direction (using shortest-arc wrapping for the 360°/0° boundary). Above or below the provided range, it clamps to the nearest available layer and emits a validation warning.

### Canopy Profile

```typescript
interface CanopyProfile {
  manufacturer: string;
  model: string;
  sizeSqft: number;         // canopy square footage
  wlRef: number;            // reference wing loading for airspeed model
  airspeedRefKt: number;    // airspeed at reference WL
  airspeedWlExponent?: number;  // WL→airspeed exponent (default 0.5)
  airspeedMinKt?: number;   // floor clamp (default 8 kt)
  airspeedMaxKt?: number;   // ceiling clamp (default 35 kt)
  glideRatio: number;       // L/D ratio
  sourceUrl?: string;
  confidence?: "low" | "medium" | "high";
}
```

**Airspeed model:**

```text
wl = exitWeightLb / canopyAreaSqft
airspeed = clamp(airspeedRefKt × (wl / wlRef)^exponent, min, max)
sinkFps  = knotsToFps(airspeed) / glideRatio
```

**Safety block:** If `wl > 1.7`, the pattern is blocked.

### Wingsuit Profile

```typescript
interface WingsuitProfile {
  presetId?: "swift" | "atc" | "freak" | "aura" | "custom";
  name: string;
  flightSpeedKt: number;   // horizontal airspeed
  fallRateFps: number;      // vertical descent rate
}
```

No computed airspeed model — both values are user-specified directly.

**Stock presets:**

| Preset | Flight Speed (kt) | Fall Rate (ft/s) |
|--------|------------------:|------------------:|
| SWIFT  | 60 | 12 |
| ATC    | 72 | 70 |
| FREAK  | 84 | 68 |
| AURA   | 90 | 65 |

### Jumper Input

```typescript
interface JumperInput {
  exitWeightLb: number;
  canopyAreaSqft: number;
}
```

Used by canopy mode for wing loading computation. Also passed to auto mode for the canopy-return-margin check.

### Gate Altitudes

Both modes use a 4-element array `[gate0, gate1, gate2, gate3]`:

| Mode | Gate 0 | Gate 1 | Gate 2 | Gate 3 |
|------|--------|--------|--------|--------|
| Canopy | Downwind start | Base start | Final start | Touchdown (0) |
| Wingsuit manual | Downwind start | Base start | Final start | Touchdown (0) |
| Wingsuit auto | Exit height | Turn 1 height | Turn 2 height | Deploy height |

**Canopy:** strictly descending (`gate0 > gate1 > gate2 > gate3`)
**Wingsuit:** non-increasing with active final (`gate0 ≥ gate1 ≥ gate2 > gate3`). First or second leg may be collapsed (equal gate values).

### GeoPoint

```typescript
interface GeoPoint {
  lat: number;   // WGS84 latitude
  lng: number;   // WGS84 longitude
}
```

## Solver Input / Output Contracts

### Pattern (Manual) Mode

**Input:** `PatternInput`

```text
mode + touchdown + heading + side + baseLegDrift + gates + winds + canopy + jumper + wingsuit
```

**Output:** `PatternOutput`

```text
waypoints[]      — geo coords for each waypoint (downwind_start, base_start, final_start, touchdown)
segments[]       — per-leg metrics (heading, track, speed, time, distance)
metrics          — wingLoading, estAirspeedKt, estSinkFps
warnings[]       — any cautions
blocked          — true if pattern cannot be computed safely
```

### Auto Mode

**Input:** `WingsuitAutoInput`

```text
landingPoint + jumpRun config + side + exitHeightFt + deployHeightFt + winds + wingsuit
  + optional turnRatios + optional tuning
```

**Output:** `WingsuitAutoOutput`

```text
blocked                          — true if no valid route found
resolvedJumpRun                  — full jump-run line, slots, heading, spacing
exitPoint                        — WS slot geo position
turnPoints[]                     — [turn1, turn2] geo positions
deployPoint                      — deploy geo position
routeWaypoints[]                 — [exit, turn1, turn2, deploy]
routeSegments[]                  — per-leg metrics
landingNoDeployZonePolygon       — min radius exclusion circle
downwindDeployForbiddenZonePolygon — wind-based half-disk
forbiddenZonePolygon             — jump-run corridor rectangle
feasibleDeployRegionPolygon      — aggregated feasible region
deployBandsByBearing[]           — min/max radius per bearing step
diagnostics                      — 16-field diagnostics struct
warnings[]                       — any cautions or failure messages
```

### Resolved Jump Run

```typescript
interface ResolvedJumpRun {
  headingDeg: number;
  line: JumpRunLine;        // start and end geo points
  lengthFt: number;
  groupSpacingFt: number;
  groupSpacingSec: number;
  planeGroundSpeedKt: number;
  crosswindOffsetFt: number;
  slots: ResolvedJumpRunSlot[];
}

interface ResolvedJumpRunSlot {
  lat: number;
  lng: number;
  label: string;            // "G1", "G2", ..., "WS"
  kind: "group" | "wingsuit";
}
```

## Auto Solver Tuning Parameters

| Parameter | Default | Description |
|-----------|--------:|-------------|
| `corridorHalfWidthFt` | 250 | Half-width of jump-run exclusion corridor |
| `deployBearingStepDeg` | 5 | Bearing resolution for candidate sweep |
| `deployRadiusStepFt` | 250 | Radius resolution (legacy; now embedded in gate candidates) |
| `deployBearingWindowHalfDeg` | 90 | Half-width of wind no-deploy sector |
| `maxDeployRadiusFt` | 6562 | Maximum allowed deploy distance from landing |
| `maxFirstLegTrackDeltaDeg` | 45 | Max angle first leg track can deviate from run heading |
| `minDeployRadiusFt` | 500 | Minimum allowed deploy distance from landing |
| `refinementIterations` | 3 | Legacy field; retained for contract compatibility |
| `exitOnJumpRunToleranceFt` | 300 | Legacy field; forward solver always starts at WS slot |

## Auto Solver Assumptions (Jump-Run)

| Parameter | Default | Description |
|-----------|--------:|-------------|
| `planeAirspeedKt` | 85 | Aircraft indicated airspeed |
| `groupCount` | 4 | Wingsuit exit group number (WS slot index) |
| `groupSeparationFt` | 1500 | Vertical separation between exit groups |
| `slickDeployHeightFt` | 3000 | Assumed deploy height for slick jumpers |
| `slickFallRateFps` | 176 | Assumed freefall rate for slick jumpers |
| `slickReturnRadiusFt` | 5000 | Max acceptable canopy return distance for slick groups |

## State Persistence

### Web (Zustand + localStorage)

Store key: `landing-pattern-store-v1`

The web store persists the entire settings object (mode, touchdown, heading, side, canopy & wingsuit settings, auto settings including jump-run config, named spots, language, unit system) as JSON in `localStorage`.

### iOS (@AppStorage)

Store key: `landing-pattern-settings`

The iOS store serializes a `Snapshot` struct to `Data` in `@AppStorage`. It includes legacy migration support for older snapshot formats (flat `gatesFt`/`canopy`/`windLayers` fields vs. nested `canopySettings`/`wingsuitSettings` objects).

## Unit System

All internal computation uses **imperial units** (feet, knots, ft/s). The UI offers a toggle between:

| System | Altitude | Speed |
|--------|----------|-------|
| Imperial | feet (ft) | knots (kt) |
| Metric | meters (m) | m/s |

Conversion is applied only at the UI boundary:
- `feetToMeters(ft) = ft × 0.3048`
- `knotsToMps(kt) = kt × 0.514444`
