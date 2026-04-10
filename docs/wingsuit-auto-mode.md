# Wingsuit Auto Mode

This document describes the current shared TypeScript implementation of wingsuit auto mode and the web UI that drives it.

It answers two questions:

1. How the app automatically computes the jump run, deploy constraints, and setup.
2. How the solver turns that setup into a wingsuit route.

## User Inputs

Wingsuit auto mode currently takes these user-controlled inputs:

- `landing point`
- `jump-run direction source`
  - `auto (headwind)`
  - `manual`
- `manual jump-run heading` when manual mode is selected
- `airport constraint`
  - `none`
  - `reciprocal pair`
- `runway heading` when reciprocal-pair mode is selected
- `pattern side` relative to aircraft travel (`left` or `right`)
- `exit height`
- `deploy height`
- `wingsuit performance`
- `wind layers`
- advanced jump-run assumptions
  - `plane airspeed`
  - `group count`
  - `group separation`
  - `slick deploy height`
  - `slick fall rate`
  - `slick return radius`

The user no longer drags jump-run start/end markers in auto mode. The engine resolves the jump run from heading intent plus the assumptions above.

## Automatic Setup Computation

### 1. Resolve jump-run heading

The solver resolves one aircraft heading before it searches any deploy points.

- `auto + no constraint`
  - use the lowest wind layer `dirFromDeg`
- `manual + no constraint`
  - use the manual compass heading
- `auto + reciprocal pair`
  - choose the runway heading or its reciprocal, whichever is closer to the low-wind headwind
- `manual + reciprocal pair`
  - snap the manual heading to the nearer allowed reciprocal

That resolved heading is the aircraft travel direction.

### 2. Resolve jump-run ground speed

Jump-run length is based on **ground separation**, so the solver computes aircraft ground speed along the resolved run.

- build an aircraft airspeed vector along jump run
- add the exit-altitude wind vector
- project the result back onto jump-run direction
- clamp to `45 kt` minimum for numerical stability

The output exposes:

- resolved heading
- aircraft ground speed
- spacing seconds implied by the selected spacing distance

### 3. Resolve jump-run spot from a wind table

The current implementation uses a bounded spotting table instead of integrating a full slick freefall drift model.

At the slick deploy height, the solver projects wind onto:

- jump-run direction
- jump-run crosswind axis

Those components are converted into table-based offsets:

- near calm: `0.0 mi`
- then `0.1 mi` steps for each `5 kt` bucket
- capped at `0.7 mi`

This is used in two ways:

- along-run spot:
  - headwind gives a positive “after the LZ” offset
  - tailwind gives a negative “before the LZ” offset
- crosswind offsite:
  - a lighter crosswind table shifts the whole jump run opposite the crosswind drift side
  - this uses smaller `0.05 mi` buckets and caps at `0.35 mi`

This keeps the resolved jump run near the landing area instead of throwing the entire run far away.

### 4. Fit the normal-group span inside the return radius

The current v1 model treats the first `groupCount - 1` slots as “slick” groups and the final slot as wingsuit.

Definitions:

- `slickSpanFt = groupSeparationFt * (groupCount - 2)`
- `lineLengthFt = groupSeparationFt * groupCount`

The solver places the first slick slot on the spot-table target, then keeps one extra group spacing ahead of that first exit so the resolved jump-run line represents the actual aircraft run rather than only the exit span.

That centered normal span is clamped so:

- the first slick slot
- the last non-wingsuit slick slot

both remain inside the configured slick return radius.

If that span does not fit, auto mode blocks immediately with a setup failure.

### 5. Build the resolved jump run

From that fitted span, the solver builds:

- resolved jump-run line
- resolved run length
- group spacing distance
- group spacing time
- crosswind offsite
- slot markers
  - `G1`
  - `G2`
  - `G3`
  - `WS`

The web map renders that resolved jump run and those slot markers directly from engine output.

### 6. Build the no-deploy zones

Auto mode currently returns three setup constraints:

#### Landing no-deploy circle

Prevents nonsensical deploys extremely close to the landing point.

- radius = `minDeployRadiusFt`
- default = `500 ft`

#### Downwind deploy forbidden half-space

Uses the lowest wind layer as the landing-wind reference.

- preferred deploy bearing = `lowestWind.dirFromDeg`
- the opposite half of the compass is shaded as deploy-forbidden

This is intentionally a relaxed rule:

- upwind half is acceptable
- downwind half is not

#### Jump-run corridor

The wingsuit route must stay outside a buffered jump-run corridor on the selected side.

- rendered as a rectangle around the resolved jump run
- default half-width = `1500 ft`

## Deploy Search

The solver searches deploy points inside a fixed-radius region.

- `maxDeployRadiusFt = 6562 ft` (`2 km`)
- search bearings: `preferredDeployBearing ± 90°`
- default bearing step: `5°`
- default radius step: `250 ft`

A deploy candidate survives setup filtering only if:

- it is on the selected side of jump run
- it is outside the jump-run corridor
- it is outside the landing no-deploy circle
- it is not in the downwind half-space

Candidates that pass setup filtering move on to route solving.

## Pattern Computation

### 1. Derive turn heights

Turn heights are derived from exit/deploy heights using ratios.

Defaults:

- `turn1 = 0.75`
- `turn2 = 0.3125`

### 2. Expand route layouts

The solver does not force every route to keep all three wingsuit legs.

It evaluates:

- full `downwind/base/final`
- shifted three-leg variants
- collapsed-leg variants
  - no-downwind
  - no-base

### 3. Solve route geometry

For each deploy candidate and gate layout, the solver reuses the shared wingsuit route solver and searches landing headings.

It rejects candidates when:

- the reused route solver blocks
- a segment has non-positive forward penetration
- the first active leg leaves jump run by more than `45°`
- turn/deploy points enter the corridor
- the route crosses onto the wrong side of jump run

The “first active leg” is:

- `downwind` if present
- otherwise `base`

The `45°` check uses **ground-track heading**, not air heading.

### 4. Return exit to the resolved jump run

Current hard requirement:

- exit must come back onto the resolved `WS` slot within tolerance

The error metric is:

- direct distance from the solved exit point to the resolved `WS` slot

Default tolerance:

- `300 ft`

### 5. Rank and refine candidates

Valid candidates are ranked by:

- smaller jump-run error
- smaller first-leg track delta
- smaller angular offset from preferred deploy bearing
- larger corridor margin
- smaller deploy radius
- smaller distance from the nominal wingsuit slot along the run

The best candidate is then refined locally around its bearing/radius neighborhood.

## Rendered Auto-Mode Layers

The web map currently renders:

- landing marker
- resolved jump-run line
- jump-run direction arrow
- resolved group slot markers
- selected route waypoints
- jump-run corridor
- landing no-deploy circle
- downwind deploy forbidden half-space
- feasible deploy region

## Failure Behavior

Auto mode returns `blocked = true` when it cannot satisfy the full constraint set.

Typical failure reasons are:

- slick groups cannot fit inside the configured return radius
- no deploy point survives the selected side
- the jump-run corridor removes every deploy candidate
- no candidate keeps the first leg within the allowed jump-run delta
- no candidate returns exit to the resolved jump run

In that blocked state, the engine still returns:

- the resolved jump run
- the setup polygons
- diagnostics explaining the closest miss

That lets the UI explain what failed without drawing a misleading auto route.
