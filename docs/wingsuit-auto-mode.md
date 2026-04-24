# Wingsuit Auto Solver

This document describes the current web wingsuit auto solver implemented by
`solveWingsuitAuto` in `packages/engine/src/index.ts`.

This is software planning logic, not operational approval for a real jump.
Generated plans must be checked against local DZ rules, pilot instructions,
weather, airspace, terrain, outs, canopy traffic, clouds, and jumper
proficiency.

## Implementation Scope

The authoritative web path is:

- `apps/web/src/App.tsx` builds a `WingsuitAutoInput`.
- `packages/engine/src/index.ts` runs `solveWingsuitAuto`.
- `apps/web/src/components/MapPanel.tsx` renders the returned geometry.

The TypeScript web solver is forward-parametric: it starts at the resolved
wingsuit slot and integrates route candidates forward to deployment. The Swift
iOS solver is a port of this implementation and is checked against
TypeScript-generated auto fixtures, but the TypeScript path remains the source
of truth for behavior changes.

## Coordinate And Wind Model

All geometry is computed in a local flat frame centered at the landing point:

```text
northFt = (lat - refLat) * 364000
eastFt  = (lng - refLng) * 364000 * max(cos(refLat), 1e-5)
```

Headings use aviation convention:

- `0 deg` is north.
- `90 deg` is east.
- `unit(heading) = (east: sin(rad), north: cos(rad))`.

Wind layers store `dirFromDeg`. The solver converts this to a ground-vector
direction by adding 180 degrees.

The wind model sorts layers by altitude and linearly interpolates speed and the
shortest wrapped direction. Above or below the modeled range it uses the nearest
available layer and emits validation warnings.

## Inputs

`WingsuitAutoInput` contains:

- `landingPoint`
- `jumpRun`: placement mode, auto/manual heading, optional reciprocal
  constraint, distance-mode offset, and normal-mode slotting assumptions
- `side`: `left` or `right` relative to aircraft travel
- `exitHeightFt` and `deployHeightFt`
- `winds`
- `wingsuit`: horizontal speed and fall rate
- optional `turnRatios`
- optional `tuning`

Default turn ratios are:

```text
turn1 = 0.75
turn2 = 0.3125
```

For `span = exitHeightFt - deployHeightFt`:

```text
turn1HeightFt = deployHeightFt + span * turn1
turn2HeightFt = deployHeightFt + span * turn2
```

Default tuning:

| Field | Default |
| --- | ---: |
| `corridorHalfWidthFt` | `250` |
| `deployBearingStepDeg` | `5` |
| `deployRadiusStepFt` | `250` |
| `deployBearingWindowHalfDeg` | `90` |
| `maxDeployRadiusFt` | `6562` |
| `maxFirstLegTrackDeltaDeg` | `45` |
| `minDeployRadiusFt` | `500` |
| `refinementIterations` | `3` |
| `exitOnJumpRunToleranceFt` | `300` |

`exitOnJumpRunToleranceFt` is retained for contract compatibility. The current
web solver starts at the planned WS slot, so primary solutions report
`exitToJumpRunErrorFt = 0`.

## Jump-Run Resolution

The solver supports two jump-run placement modes. `normal` is the default and
keeps the historical behavior. `distance` is a web-only wingsuit-first mode for
the aircraft sequence where slick groups leave on the normal run, the aircraft
continues offsite, turns 90 degrees, and then drops the wingsuit shortly after
that turn.

Both modes first resolve a normal reference heading:

- Auto mode uses the lowest wind layer's `dirFromDeg` as the suggested headwind
  jump-run direction.
- Manual mode uses `manualHeadingDeg`.
- Reciprocal constraints snap the source heading to the closer of the configured
  runway heading or its reciprocal.

### Normal Placement

Normal placement builds a directed jump-run frame from the resolved heading:

```text
U = unit(resolvedHeadingDeg)
L = (-U.north, U.east)
along(P) = dot(P - start, U)
signedCross(P) = dot(P - start, L)
```

Positive signed cross-track is left of aircraft travel. The final slot is
labeled `WS`; earlier slots are labeled `G1`, `G2`, etc.

The jump-run line is shifted for crosswind using the existing spot table, and
prior slick groups must fit within `slickReturnRadiusFt`. If they cannot fit,
the solver returns setup geometry and blocks with a jump-run setup failure.

### Distance Placement

Distance placement does not use slick slot assumptions to place the wingsuit.
It forces the resolved slot list to a single `WS` slot.

Definitions:

```text
H = normal reference heading
S = -1 for left, +1 for right
D = distanceOffsetFt, default 4000 m = 13123 ft
P = distancePostTurnFt, default 750 ft
U = unit(H)
V = unit(H + S * 90)
```

The aircraft model is:

```text
normal slick run: heading H
continue offsite: D feet along H from the landing point
90-degree aircraft turn: heading H + S * 90
wingsuit exit: P feet after that turn on the distance run
```

The selected side is coupled to the offsite side. A left aircraft turn means the
landing point is left of the distance run; a right aircraft turn means the
landing point is right of the distance run. The pattern side is therefore not an
independent distance-mode variable.

## Forward Route Generation

The solver no longer searches deploy points and reverse-solves to a jump-run
line. Instead it starts exactly at the resolved `WS` slot.

For each candidate, it builds three freefall legs:

```text
exit -> turn1
turn1 -> turn2
turn2 -> deploy
```

The preferred altitude split comes from `turnRatios`. The solver also tries
additional altitude-drop splits so it can vary leg lengths without changing
the user's exit and deploy heights. Candidate drop fractions include shorter
and longer first legs, offset legs, and return legs, while preserving the order:

```text
drop1 > 0
drop2 > 0
drop3 >= 0.15
drop1 + drop2 + drop3 = 1
```

Heading candidates are side-aware:

```text
sideSign = left ? -1 : 1

normal placement:
first leg  = jumpRunHeading + sideSign * [0, 10, 20, 30, 40, 45]
offset leg = jumpRunHeading + sideSign * [60, 75, 90, 105, 120, 135]
return leg = near jumpRunHeading + 180, with wider fallback headings

distance placement:
first leg  = distanceRunHeading + sideSign * [0, 5, 10, 15, 20, 30, 40]
return legs = near normalReferenceHeading + 180
```

Normal placement return legs also include direct-to-landing fallback headings.
These are valid fallbacks, but the scoring now prefers reciprocal/parallel
rectangular tracks when safety margins are comparable.

Distance placement uses additional altitude-drop splits that prefer a short
first leg. It keeps longer first-leg fallbacks so the solver can still find a
safe route when the short gather shape would put deployment inside the wind
no-deploy sector. The second and third output legs are both return legs; `turn2`
is a return checkpoint so the output remains compatible with the existing map
and metrics.

Each leg is integrated forward in altitude/time steps of at most 5 seconds:

```text
airVector = wingsuit.flightSpeedKt * unit(heading)
windVector = windAt(sampleAltitude)
groundVector = airVector + windVector
point += knotsToFeetPerSecond(groundVector) * dt
```

## Hard Filters

A candidate is rejected only when it violates a hard safety or feasibility rule:

- First ground track must stay within `maxFirstLegTrackDeltaDeg` of jump run on
  the selected side.
- `turn1`, `turn2`, and deploy must be on the selected side of jump run.
- The post-departure route must stay outside the finite jump-run corridor.
- Deploy radius must be within `minDeployRadiusFt` and `maxDeployRadiusFt`.
- Deploy bearing must stay outside the wind no-deploy sector rendered on the
  map. The sector is centered on the lowest wind layer's travel direction
  (`windDirFrom + 180`) with half-width `deployBearingWindowHalfDeg`.
- A simple canopy-return check must leave nonnegative altitude margin after
  deployment loss and the configured pattern reserve.

The close-in, rectangular, and distance-shape preferences are not hard filters.
This is important: if the preferred shape is not feasible, the broader candidate
set can still produce a solution instead of increasing fail rate.

## Canopy Return Check

The first web implementation uses a conservative built-in canopy return model:

```text
canopyAirspeed = 25 kt
glideRatio = 2.5
deploymentLoss = 300 ft
patternReserve = 1000 ft
```

For a deploy point, it estimates the return direction to the landing point,
samples wind around mid-deployment altitude, computes return ground speed, and
requires:

```text
deployHeightFt - deploymentLoss - canopyAltitudeLost - patternReserve >= 0
```

This check is intentionally a feasibility floor, not the main ranking term.
Once preferred safety margin is reached, extra canopy margin is saturated so the
solver does not keep moving deployment closer to the landing point.

## Candidate Ranking

The ranking now has three goals, in this order:

1. Preserve safety margins.
2. Prefer mostly rectangular wingsuit routes.
3. Prefer a soft deploy annulus instead of close-in deployment.

The candidate score is:

```text
canopyShortfall = max(0, 750 - canopyReturnMarginFt)
corridorShortfall = max(0, 1000 - corridorMarginFt)

safetyPenalty =
  (canopyShortfall / 500)^2 +
  (corridorShortfall / 500)^2

preferredRadius = clamp(0.45 * maxDeployRadiusFt, 2500, 4500)
radiusPenalty =
  (max(0, preferredRadius - 750 - radiusFt) / 1000)^2 +
  0.25 * (max(0, radiusFt - preferredRadius - 750) / 1000)^2

score =
  1000 * safetyPenalty +
  50 * rectangularTrackPenalty +
  40 * radiusPenalty -
  saturatedSafetyReward
```

Normal placement uses a rectangular track penalty based on actual ground-track
headings rather than commanded air headings:

```text
firstTarget  = jumpRunHeading + sideSign * 15
offsetTarget = jumpRunHeading + sideSign * 90
returnTarget = jumpRunHeading + 180

rectangularTrackPenalty =
  0.5 * (delta(track1, firstTarget) / 20)^2 +
  1.5 * (delta(track2, offsetTarget) / 20)^2 +
  1.5 * (delta(track3, returnTarget) / 25)^2
```

This fixes the two observed failure modes:

- Close-in deploy points no longer dominate merely because canopy return margin
  is larger.
- Direct-to-LZ triangular returns are now fallback choices rather than the
  preferred aesthetic.

Distance placement uses a different shape penalty:

```text
firstTarget  = distanceRunHeading + sideSign * 10
returnTarget = normalReferenceHeading + 180
firstLegTargetDistance = 1800 ft

distanceShapePenalty =
  heading error for the short gather leg +
  heading error for both return legs +
  penalty for first-leg distance much longer than 1800 ft
```

This matches the desired distance-flight default: short gather leg after exit,
one 90-degree turn back toward the landing point, then a long return to
deployment. If that shape conflicts with the wind no-deploy sector, the hard
filter wins and scoring chooses the shortest safe fallback from the broader
distance candidate set.

## Output

Successful output includes:

- `landingPoint`
- `resolvedJumpRun`
- `exitPoint`
- `turnPoints`
- `deployPoint`
- `routeWaypoints`
- `routeSegments`
- landing no-deploy circle
- downwind context half-disk
- jump-run corridor polygon
- feasible deploy region polygon
- deploy bands by bearing
- diagnostics

Important diagnostics:

- resolved heading and heading source
- selected deploy bearing and radius
- `exitToJumpRunErrorFt`
- deploy radius margin
- first-leg track delta
- corridor margin
- selected turn heights
- failure reason when blocked

## Failure Behavior

Blocked outputs still include setup geometry when available. Failure reasons
prioritize:

1. validation errors
2. jump-run resolution/setup failure
3. missing wind coverage
4. first-leg bound
5. selected side
6. corridor exclusion
7. deploy radius limits
8. canopy return margin
9. integration failure

## Verification

Core verification:

```bash
npm run test --workspace @landing/engine
npm run build
```

Browser verification should exercise wingsuit auto mode with default and
non-default locations, checking that:

- the solver is not blocked
- selected deploy radius is not close-in when safer options exist
- route tracks are mostly rectangular
- map rendering still shows landing, exit, turns, deploy, corridor, and feasible
  deploy region
