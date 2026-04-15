# Wingsuit Auto Mode

This document is the self-contained specification for the current web wingsuit
auto solver implemented by `solveWingsuitAuto` in the TypeScript engine.

The solver computes, from a landing point and planning constraints:

- a resolved jump run and group slot string
- deploy exclusion geometry
- a deploy point
- a wingsuit route from exit to deploy
- diagnostics and feasible deploy bands

The implementation does not use a separate black-box router. It resolves setup,
enumerates deploy candidates, calls the shared wingsuit pattern solver for each
candidate, and ranks/refines the surviving candidates.

## Implementation Scope

The authoritative auto-mode path for the web app is:

- `apps/web/src/App.tsx` builds a `WingsuitAutoInput`
- `packages/engine/src/index.ts` runs `solveWingsuitAuto`
- `apps/web/src/components/MapPanel.tsx` renders the returned geometry

The auto-mode solver described here is the TypeScript web solver. The iOS core
contains an older wingsuit-auto implementation with a different contract; it is
not the solver used by the web auto route described below.

## Units And Conventions

All solver geometry is performed in a local flat frame centered at the landing
point:

```text
northFt = (lat - refLat) * 364000
eastFt  = (lng - refLng) * 364000 * max(cos(refLat), 1e-5)

lat = refLat + northFt / 364000
lng = refLng + eastFt / (364000 * max(cos(refLat), 1e-5))
```

Headings use aviation convention:

- `0 deg` points north
- `90 deg` points east
- headings are normalized with `((deg % 360) + 360) % 360`

The unit vector for a heading is:

```text
unit(headingDeg) = (east: sin(rad), north: cos(rad))
```

Wind layers store `dirFromDeg`. The solver converts that to the ground-vector
direction by adding 180 degrees:

```text
windVector(speedKt, dirFromDeg) = speedKt * unit(dirFromDeg + 180)
```

The solver uses:

```text
feetPerSecond(knots) = knots * 6076.12 / 3600
dot(a, b) = a.east * b.east + a.north * b.north
```

Small floating point tolerances use `EPSILON = 1e-6`.

## Wind Model

For a requested altitude, the solver sorts wind layers by altitude descending.

It returns:

- the exact layer if `abs(layer.altitudeFt - altitudeFt) < 1e-3`
- a linear interpolation between surrounding layers if the altitude is bracketed
- the highest layer when above the highest provided layer
- the lowest layer when below the lowest provided layer

Speed interpolation is linear. Direction interpolation follows the shortest path
around the 0/360 wrap:

```text
delta = ((end - start + 540) % 360) - 180
dir = normalize(start + delta * t)
```

Interpolated layers have source `"auto"`.

## Inputs

Auto mode consumes a `WingsuitAutoInput`:

```ts
{
  landingPoint: { lat, lng },
  jumpRun: {
    directionMode?: "auto" | "manual",
    manualHeadingDeg?: number,
    constraintMode?: "none" | "reciprocal",
    constraintHeadingDeg?: number,
    assumptions?: WingsuitAutoJumpRunAssumptions
  },
  side: "left" | "right",
  exitHeightFt: number,
  deployHeightFt: number,
  winds: WindLayer[],
  wingsuit: { flightSpeedKt, fallRateFps, ... },
  turnRatios?: { turn1, turn2 },
  tuning?: WingsuitAutoTuning
}
```

The web UI uses the current wingsuit gate settings for `exitHeightFt`,
`deployHeightFt`, and optional turn ratios. In auto mode, the user no longer
drags jump-run start/end points; the engine resolves the jump run from heading
intent, winds, and jump-run assumptions.

### Default Jump-Run Assumptions

| Field | Default | Current use |
| --- | ---: | --- |
| `planeAirspeedKt` | `85` | aircraft airspeed along jump run |
| `groupCount` | `4` | one-based wingsuit exit group number; `1` means wingsuit exits first |
| `groupSeparationFt` | `1500` | ground spacing between slots |
| `slickDeployHeightFt` | `3000` | altitude used to sample slick spotting wind |
| `slickFallRateFps` | `176` | validated but not used by the current table-based spotter |
| `slickReturnRadiusFt` | `5000` | maximum along-run distance for slick groups |

The current solver uses a bounded spot table, not a full slick freefall drift
integration, so `slickFallRateFps` does not affect the output.

### Default Turn Ratios

```text
turn1 = 0.75
turn2 = 0.3125
```

For `span = exitHeightFt - deployHeightFt`:

```text
turn1HeightFt = deployHeightFt + span * turn1
turn2HeightFt = deployHeightFt + span * turn2
```

### Default Solver Tuning

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

`maxDeployRadiusFt = 6562 ft` is approximately 2 km.

## Validation

The solver blocks before setup when required values are invalid:

- landing point latitude/longitude must be finite and in range
- manual jump-run mode requires a finite manual heading
- reciprocal constraint mode requires a finite constraint heading
- `exitHeightFt > deployHeightFt > 0`
- `1 > turn1 > turn2 > 0`
- wingsuit horizontal speed and fall rate must be finite and positive
- at least one wind layer is required
- wind altitude, speed, and direction must be finite; speed cannot be negative
- jump-run assumptions must be finite
- plane airspeed, group separation, slick fall rate, and slick return radius must
  be positive
- wingsuit exit group must be an integer of at least 1
- slick deploy height must be above 0 and below exit height
- tuning values must be finite when provided

The solver warns, but does not block, when the wind table is extrapolated above
the highest layer or below the lowest modeled altitude.

## Jump-Run Resolution

### 1. Resolve Aircraft Heading

The solver first resolves one aircraft travel heading.

For `directionMode = "auto"`, the source heading is the lowest wind layer's
`dirFromDeg`. Since that is the direction the wind comes from, it is the desired
headwind jump-run direction.

For `directionMode = "manual"`, the source heading is `manualHeadingDeg`.

If `constraintMode != "reciprocal"`, the resolved heading is the normalized
source heading.

If `constraintMode = "reciprocal"`, the allowed headings are:

```text
base = normalize(constraintHeadingDeg)
opposite = normalize(base + 180)
```

The solver chooses whichever allowed heading has the smaller absolute heading
delta from the source heading. `constrainedHeadingApplied` is true when the
chosen constrained heading differs from the source by more than `EPSILON`.

### 2. Build The Jump-Run Frame

Let:

```text
U = unit(resolvedHeadingDeg)
L = (-U.north, U.east)       // left normal
```

For any point `P` and resolved run start `S`:

```text
along(P) = dot(P - S, U)
signedCross(P) = dot(P - S, L)
```

Positive `signedCross` is left of the aircraft travel direction; negative is
right.

### 3. Compute Aircraft Ground Speed

Sample wind at `exitHeightFt`:

```text
W_exit = windAt(exitHeightFt)
planeAir = planeAirspeedKt * U
groundAlongKt = dot(planeAir + W_exit, U)
planeGroundSpeedKt = max(45, groundAlongKt)
```

The 45 kt floor prevents unstable spacing-time output.

Group spacing time is:

```text
groupSpacingSec = groupSeparationFt / feetPerSecond(planeGroundSpeedKt)
```

### 4. Compute Spot-Table Offsets

Sample the slick deployment wind:

```text
W_slick = windAt(slickDeployHeightFt) ?? W_exit
```

Project it into the jump-run frame:

```text
headwindComponentKt = -dot(W_slick, U)
crosswindComponentKt = dot(W_slick, L)
```

Positive `headwindComponentKt` means the slick wind opposes the aircraft travel
direction. Positive `crosswindComponentKt` means the slick wind pushes toward
the left side of jump run.

The along-run spot table is:

| Absolute wind kt | Offset miles |
| ---: | ---: |
| `<= 2.5` | `0.0` |
| `<= 7.5` | `0.1` |
| `<= 12.5` | `0.2` |
| `<= 17.5` | `0.3` |
| `<= 22.5` | `0.4` |
| `<= 27.5` | `0.5` |
| `<= 32.5` | `0.6` |
| `> 32.5` | `0.7` |

The signed along-run offset is:

```text
preferredSpotOffsetAlongFt = sign(headwindComponentKt) * tableMiles * 5280
```

The crosswind table uses the same wind buckets but half-size offsets:

| Absolute wind kt | Offset miles |
| ---: | ---: |
| `<= 2.5` | `0.00` |
| `<= 7.5` | `0.05` |
| `<= 12.5` | `0.10` |
| `<= 17.5` | `0.15` |
| `<= 22.5` | `0.20` |
| `<= 27.5` | `0.25` |
| `<= 32.5` | `0.30` |
| `> 32.5` | `0.35` |

The jump-run line is shifted opposite the crosswind drift:

```text
crosswindOffsetFt = -sign(crosswindComponentKt) * crosswindTableMiles * 5280
lineOffset = crosswindOffsetFt * L
```

### 5. Fit Slick Slots Inside Return Radius

The `groupCount` field is kept for persisted-settings compatibility, but it now
means the one-based wingsuit exit group number. The default remains group 4.
All prior slots are slick groups; if `groupCount = 1`, there are no prior slick
groups and the single rendered slot is `WS`.

```text
priorSlickGroupCount = max(0, groupCount - 1)
slickSpanFt = groupSeparationFt * max(0, priorSlickGroupCount - 1)
lineLengthFt = groupSeparationFt * groupCount
```

The allowed center of the slick slot span is:

```text
centerMin = -slickReturnRadiusFt + slickSpanFt / 2
centerMax =  slickReturnRadiusFt - slickSpanFt / 2
```

The preferred slick center is one group spacing after the spot-table offset:

```text
preferredCenter = preferredSpotOffsetAlongFt + groupSeparationFt
slickCenter = clamp(preferredCenter, centerMin, centerMax)
```

Then:

```text
firstSlickAlong = slickCenter - slickSpanFt / 2
lastSlickAlong  = slickCenter + slickSpanFt / 2
```

When prior slick groups exist, the resolved run starts one group spacing before
the first slick exit:

```text
startLocal = lineOffset + U * (firstSlickAlong - groupSeparationFt)
endLocal = startLocal + U * lineLengthFt
slot[i] = startLocal + U * groupSeparationFt * (i + 1)
```

When `groupCount = 1`, there is no slick span. The solver anchors the single
`WS` slot at the spot-table along-run offset and starts the rendered run one
group spacing before that slot.

`slot[groupCount - 1]` is labeled `WS`; all earlier slots are labeled
`G1`, `G2`, etc.

Diagnostics include:

```text
firstSlickReturnMarginFt = slickReturnRadiusFt - abs(firstSlickAlong)
lastSlickReturnMarginFt  = slickReturnRadiusFt - abs(lastSlickAlong)
```

These slick-return margins are `null` when the wingsuit exits first because no
prior slick group is being spotted.

If `centerMax < centerMin`, the slick span cannot fit inside the return radius.
The solver still returns the resolved jump run and setup geometry, but blocks
with a jump-run setup failure.

## Setup Polygons

The solver emits three setup polygons before route search.

### Landing No-Deploy Circle

`landingNoDeployZonePolygon` is a 36-point circle around the landing point with
radius `minDeployRadiusFt`.

Candidate enumeration also starts no closer than:

```text
startRadiusFt = min(maxDeployRadiusFt, max(minDeployRadiusFt, deployRadiusStepFt))
```

### Downwind Deploy Forbidden Half-Disk

The preferred deploy bearing is the lowest wind layer's `dirFromDeg`.

The shaded downwind half-disk is centered on:

```text
normalize(preferredDeployBearingDeg + 180)
```

It is rendered with radius:

```text
max(maxDeployRadiusFt, jumpRunLengthFt, minDeployRadiusFt * 2)
```

Search bearings are centered on the preferred deploy bearing. With the default
`deployBearingWindowHalfDeg = 90`, this means the search covers only the upwind
half-plane. If a caller provides a larger window, the implementation does not
apply any additional downwind half-space rejection.

### Jump-Run Corridor Polygon

The returned `forbiddenZonePolygon` is a visual rectangle around the resolved
jump run. Its half-width is `corridorHalfWidthFt`.

For rendering, the rectangle is extended far beyond the resolved line:

```text
extent = max(maxDeployRadiusFt, jumpRunLengthFt)
extension = extent + jumpRunLengthFt
startExtended = start - U * extension
endExtended = end + U * extension
polygon = [startExtended + L*h, endExtended + L*h,
           endExtended - L*h, startExtended - L*h]
```

where `h = corridorHalfWidthFt`.

The route solver's corridor test is finite and is defined separately below. The
rendered polygon is therefore a conservative visual aid outside the actual
resolved run segment.

## Shared Wingsuit Route Solver

Auto mode reuses the normal `computePattern` wingsuit solver. For auto mode,
the route endpoint passed to `computePattern` is the deploy point, not the
landing point.

### Segment Headings

Given a route final heading `H` and side:

```text
final heading = H
base heading = H - 90   for left patterns
base heading = H + 90   for right patterns
downwind heading = H + 180
```

Headings are normalized.

For wingsuit mode, zero-height legs collapse. Active segments are those where
`startAltFt > endAltFt`. The solver requires at least two active legs; both
early legs may not collapse at the same time.

Auto mode always calls the route solver with `baseLegDrift = true`.

### Track-Locked Segments

Downwind and final are track-locked. Base is also track-locked only when
`baseLegDrift = false`, which auto mode does not use.

For a track-locked segment:

```text
T = unit(trackHeadingDeg)
R = (T.north, -T.east)       // right normal
W = windAt(segmentStartAltFt)
windAlong = dot(W, T)
windCross = dot(W, R)
```

If `abs(windCross) >= airspeedKt`, the segment is blocked.

Otherwise:

```text
airAlong = sqrt(airspeedKt^2 - windCross^2)
groundAlong = airAlong + windAlong
```

If `abs(groundAlong) < 0.1 kt`, the segment is blocked.

The air vector and ground vector are:

```text
airVector = airAlong * T - windCross * R
groundVector = groundAlong * T
```

With:

```text
timeSec = (startAltFt - endAltFt) / fallRateFps
distanceFt = feetPerSecond(abs(groundAlong)) * timeSec
alongLegSpeedKt = groundAlong
groundSpeedKt = abs(groundAlong)
headingDeg = heading(airVector)
trackHeadingDeg = trackHeadingDeg
```

Auto mode later rejects any candidate segment with `alongLegSpeedKt <= 0`.

### Drift Segments

The base segment drifts in auto mode:

```text
A = airspeedKt * unit(baseHeadingDeg)
W = windAt(segmentStartAltFt)
G = A + W
```

If `|G| < 0.1 kt`, the segment is blocked.

Then:

```text
timeSec = (startAltFt - endAltFt) / fallRateFps
distanceFt = feetPerSecond(|G|) * timeSec
alongLegSpeedKt = dot(G, unit(baseHeadingDeg))
groundSpeedKt = |G|
headingDeg = baseHeadingDeg
trackHeadingDeg = heading(G)
```

### Waypoint Construction

The route solver constructs waypoints backwards from the endpoint. Starting at
the deploy point, it walks active segments in reverse order:

```text
segmentStart = segmentEnd - unit(groundVector) * distanceFt
segmentEnd = segmentStart
```

The resulting starts are returned as:

- `downwind_start`
- `base_start`
- `final_start`
- endpoint

Auto mode remaps those route waypoints to `exit`, `turn1`, `turn2`, and
`deploy`.

## Auto Gate Candidates

For each deploy point, auto mode tries several gate layouts.

The preferred layout is:

```text
[exitHeight, turn1Height, turn2Height, deployHeight]
```

It also tries two shifted three-leg layouts:

```text
turn1 = min(0.9, preferredTurn1 + 0.08)
turn2 = min(0.55, preferredTurn2 + 0.08)

turn1 = max(0.5, preferredTurn1 - 0.10)
turn2 = max(0.15, preferredTurn2 - 0.08)
```

Each shifted layout is kept only if `turn1 < 1`, `turn1 > turn2`, and
`turn2 > 0`.

It also tries collapsed layouts:

```text
no-downwind = [exitHeight, exitHeight, turn2Height, deployHeight]
no-base     = [exitHeight, turn1Height, turn1Height, deployHeight]
```

Gate candidates are de-duplicated by formatting each gate altitude to two
decimal places and joining them with `|`.

For a fixed deploy point, gate candidates are evaluated in this order. If a
gate candidate yields a route whose exit error is within
`exitOnJumpRunToleranceFt`, the solver stops trying later gate layouts for that
deploy point and returns the best candidate found so far for that deploy point.

## Deploy Search

### Bearing Sweep

Search bearings are centered on the lowest-wind headwind direction:

```text
preferredBearingDeg = normalize(lowestWindLayer.dirFromDeg)
```

The sweep is:

```text
count = max(1, floor((2 * deployBearingWindowHalfDeg) / deployBearingStepDeg))
for i = 0..count:
  bearing = normalize(preferredBearingDeg - windowHalf + i * step)
```

Bearings are rounded to 6 decimal places and de-duplicated.

### Radius Sweep

For each bearing:

```text
maxRadiusFt = tuning.maxDeployRadiusFt
startRadiusFt = min(maxRadiusFt, max(minDeployRadiusFt, deployRadiusStepFt))
for radiusFt = startRadiusFt; radiusFt <= maxRadiusFt + EPSILON; radiusFt += deployRadiusStepFt
```

A deploy candidate's local position is:

```text
deployLocal = radiusFt * unit(bearingDeg)
```

### Initial Candidate Filters

A deploy candidate must be on the selected side:

```text
left pattern:  signedCross(deployLocal) > 0
right pattern: signedCross(deployLocal) < 0
```

It must also be outside the finite jump-run corridor.

For any point `P`, corridor margin is:

```text
a = along(P)
c = abs(signedCross(P))
h = corridorHalfWidthFt

if a < 0:
  margin = c <= h ? -a : hypot(-a, c - h)
else if a > jumpRunLengthFt:
  margin = c <= h ? a - jumpRunLengthFt : hypot(a - jumpRunLengthFt, c - h)
else:
  margin = c - h
```

The point is accepted only when `margin > 0`.

This is a finite rectangle test around the resolved jump-run segment. Points
before the start or after the end are not rejected merely because they lie
within the infinite strip extension.

## Candidate Route Evaluation

For every deploy candidate and gate candidate, auto mode searches route final
headings.

### Heading Search

The coarse search tries:

```text
landingHeadingDeg = 0, 5, 10, ..., 355
```

The best coarse route is refined by trying integer deltas from `-4` through
`+4` degrees around the current best heading. The implementation updates the
best candidate inside that loop, so later fine trials are based on the latest
best heading.

For each heading trial, the solver calls `computePattern` with:

```ts
{
  mode: "wingsuit",
  touchdownLat: deployGeo.lat,
  touchdownLng: deployGeo.lng,
  landingHeadingDeg,
  side,
  baseLegDrift: true,
  gatesFt: gateCandidate.gatesFt,
  winds,
  wingsuit
}
```

The canopy and jumper fields are filled with placeholders because wingsuit mode
uses `wingsuit.flightSpeedKt` and `wingsuit.fallRateFps`.

The reused route solver may warn that touchdown altitude is expected to be
0 ft. Auto mode filters that specific warning because its route endpoint is
deploy altitude, not ground touchdown.

### Route Solver Rejections

A route is rejected when:

- `computePattern` blocks
- the route has fewer than 2 or more than 3 active segments
- the route waypoint count is outside 3 through 4
- any active segment has `alongLegSpeedKt <= 0`
- the active segment sequence is not one of:
  - `downwind|base|final`
  - `base|final`
  - `downwind|final`

### First-Leg Track Rule

The first active segment is:

- `downwind` for `downwind|base|final`
- `base` for `base|final`
- `downwind` for `downwind|final`

The solver compares that segment's ground-track heading to the resolved jump-run
heading:

```text
delta = signedHeadingDelta(jumpRunHeadingDeg, firstSegment.trackHeadingDeg)
```

For left patterns:

```text
-maxFirstLegTrackDeltaDeg <= delta <= 0
```

For right patterns:

```text
0 <= delta <= maxFirstLegTrackDeltaDeg
```

The default maximum is `45 deg`.

### Waypoint Remapping

The route waypoints are mapped into auto names as follows.

For `downwind|base|final`:

```text
exit   = downwind_start
turn1  = base_start
turn2  = final_start
deploy = endpoint
```

For `base|final`:

```text
exit   = base_start
turn1  = base_start    // same coordinates as exit, turn1 altitude
turn2  = final_start
deploy = endpoint
```

For `downwind|final`:

```text
exit   = downwind_start
turn1  = final_start
turn2  = final_start   // same coordinates, turn2 altitude
deploy = endpoint
```

### Side And Corridor Checks

The exit is allowed to lie on the jump-run line. Active turn and deploy points
must be strictly on the selected side.

The checked active points are:

```text
base|final:          [turn2, deploy]
downwind|final:      [turn1, deploy]
downwind|base|final: [turn1, turn2, deploy]
```

The solver then checks sampled post-first-leg segments:

```text
base|final:          turn2 -> deploy
downwind|final:      turn1 -> deploy
downwind|base|final: turn1 -> turn2, turn2 -> deploy
```

Each segment is sampled at 13 points (`t = 0/12, 1/12, ..., 12/12`). Every
sample must stay on the selected side and must have finite-corridor margin
greater than zero.

The first active leg from exit to the first turn is not corridor-sampled because
it intentionally departs from the jump-run line; it is constrained by the
first-leg track rule above.

The candidate's `corridorMarginFt` is the minimum margin across the checked
active points and sampled post-first-leg segments.

### Exit Constraint And Along-Run Penalty

The hard exit requirement is cross-track distance to the resolved jump-run line:

```text
exitToJumpRunErrorFt = abs(signedCross(exitLocal))
```

The candidate is valid for final selection only if:

```text
exitToJumpRunErrorFt <= exitOnJumpRunToleranceFt
```

The current default tolerance is `300 ft`.

The exit does not have to hit the nominal `WS` slot by direct distance. Any
point on the resolved jump-run line satisfies the hard geometric requirement.

The nominal `WS` slot is still used as a soft along-run ranking target:

```text
exitAlong = along(exitLocal)
targetAlong = along(WS slot)
earlyExcess = max(0, targetAlong - exitAlong)
lateExcess = max(0, exitAlong - targetAlong)
exitAlongTargetErrorFt = earlyExcess * 10 + lateExcess
```

This strongly penalizes exits before the nominal wingsuit slot and mildly
penalizes exits after it.

## Candidate Ranking

For candidates with the same deploy point, the solver sorts by:

1. smaller `exitToJumpRunErrorFt`
2. smaller `firstLegTrackDeltaDeg`
3. larger `corridorMarginFt`
4. smaller `radiusFt`
5. smaller `exitAlongTargetErrorFt`

For global candidate selection, it sorts by:

1. smaller `exitToJumpRunErrorFt`
2. smaller `firstLegTrackDeltaDeg`
3. smaller angular distance from `preferredDeployBearingDeg`
4. larger `corridorMarginFt`
5. smaller `radiusFt`
6. smaller `exitAlongTargetErrorFt`

The first two ranking terms dominate: getting the exit onto the jump-run line
and keeping the first leg close to jump-run direction are preferred before
bearing aesthetics or radius.

## Candidate Refinement

After coarse search, the solver refines the current best candidate locally.

Initial refinement steps:

```text
bearingStep = deployBearingStepDeg / 2
radiusStep = deployRadiusStepFt / 2
```

For each refinement iteration:

```text
improved = current
for bearingDelta in [-bearingStep, 0, bearingStep]:
  nextBearing = normalize(current.bearing + bearingDelta)
  for radiusDelta in [-radiusStep, 0, radiusStep]:
    nextRadius = clamp(current.radius + radiusDelta,
                       minDeployRadiusFt,
                       maxDeployRadiusFt)
    evaluate best route at (nextBearing, nextRadius)
    if globally better than improved:
      improved = candidate
current = improved
bearingStep /= 2
radiusStep /= 2
```

The default uses three iterations.

If no coarse candidate satisfies the exit tolerance but a nearest miss exists,
the solver refines that nearest miss. If refinement brings it within tolerance,
it becomes a valid candidate.

## Feasible Deploy Region

During the coarse search, every bearing/radius pair that yields a valid
candidate contributes to a `RadiusBand`:

```text
{
  bearingDeg,
  minRadiusFt,
  maxRadiusFt
}
```

Bands are keyed by bearing rounded to 6 decimal places. `minRadiusFt` and
`maxRadiusFt` expand to include all valid coarse radii for that bearing.

`feasibleDeployRegionPolygon` is built by stitching:

1. outer points for each band in increasing bearing order
2. inner points for each band in reverse order

The final refined selected deploy point is not necessarily used to expand the
coarse feasible bands, except in the nearest-miss fallback case where no coarse
valid candidates existed.

## Output

A successful `WingsuitAutoOutput` contains:

- `blocked = false`
- `landingPoint`
- `resolvedJumpRun`
- `deployPoint`
- `exitPoint`
- two `turnPoints`
- full `routeWaypoints`
- `routeSegments`
- `landingNoDeployZonePolygon`
- `downwindDeployForbiddenZonePolygon`
- `forbiddenZonePolygon`
- `feasibleDeployRegionPolygon`
- `deployBandsByBearing`
- diagnostics:
  - heading source and resolved heading
  - wind components and crosswind offsite
  - slick return margins
  - preferred and selected deploy bearing/radius
  - exit cross-track error to jump run
  - deploy radius margin
  - first-leg track delta
  - corridor margin
  - selected turn heights

Warnings include validation warnings, jump-run warnings, and route warnings from
the selected candidate.

## Failure Behavior

Auto mode returns `blocked = true` when it cannot satisfy the constraint set.

The output still includes whatever setup geometry was successfully resolved. For
example, if jump-run resolution succeeds but no deploy route succeeds, the
blocked output still includes the resolved jump run and setup polygons.

Failure reasons are selected in this order:

1. first validation error
2. jump run could not be resolved from current settings
3. slick groups cannot fit inside the return radius
4. wind model missing required altitude coverage
5. no deploy candidate lies on the selected side of jump run
6. no deploy candidate survives jump-run corridor exclusion
7. route candidates exist only when the first-leg bound is relaxed
8. nearest route cannot return the exit to the resolved jump-run line within
   tolerance
9. generic route-solving failure on the selected side

When a nearest miss exists, diagnostics include that miss's selected bearing,
radius, exit error, corridor margin, first-leg delta, deploy radius margin, and
turn heights.

## Reproduction Pseudocode

This pseudocode captures the solver flow without relying on repository helper
names:

```text
solveWingsuitAuto(input):
  validate input
  if invalid:
    return blocked output with validation reason

  ratios = defaults merged with input.turnRatios
  tuning = defaults merged with input.tuning
  gateCandidates = build preferred, shifted, no-downwind, and no-base gates

  plan = resolveJumpRunPlan(input)
  if plan missing:
    return blocked output

  build landing circle, downwind half-disk, and rendered jump-run corridor
  if plan.blockedReason:
    return blocked output with resolved jump run

  preferredBearing = lowestWind.dirFromDeg
  bearings = sweep(preferredBearing, tuning.window, tuning.bearingStep)

  valid = []
  nearestMiss = null
  bands = empty map
  flags = { anyOnSide: false, anyOutsideCorridor: false,
            anyRouteWithoutFirstLegBound: false }

  for bearing in bearings:
    for radius in radiusSweep(tuning.minDeployRadius,
                              tuning.deployRadiusStep,
                              tuning.maxDeployRadius):
      deploy = radius * unit(bearing)
      if deploy not on selected side:
        continue
      flags.anyOnSide = true

      if finiteCorridorMargin(deploy) <= 0:
        continue
      flags.anyOutsideCorridor = true

      candidate = bestRouteForDeploy(deploy, gateCandidates,
                                     firstLegLimit=tuning.maxFirstLegTrackDelta)
      if no candidate:
        relaxed = bestRouteForDeploy(deploy, gateCandidates,
                                     firstLegLimit=180)
        if relaxed:
          flags.anyRouteWithoutFirstLegBound = true
        continue

      nearestMiss = better(candidate, nearestMiss)

      if candidate.exitToJumpRunError <= tuning.exitOnJumpRunTolerance:
        valid.append(candidate)
        expand radius band for this bearing

  if valid empty and nearestMiss exists:
    nearestMiss = refine(nearestMiss)
    if nearestMiss.exitToJumpRunError <= tolerance:
      valid.append(nearestMiss)
      create a radius band for nearestMiss

  if valid empty:
    return blocked output with the best available diagnostics

  best = globally best candidate in valid
  best = refine(best)

  return successful output from best, setup polygons, and deploy bands
```

The subroutine `bestRouteForDeploy` tries each gate candidate; for each gate it
searches route final headings in 5-degree coarse increments and then 1-degree
fine increments around the current best heading. It evaluates each route with
the shared wingsuit route solver and applies the side, corridor, first-leg, and
exit-line constraints described above.
