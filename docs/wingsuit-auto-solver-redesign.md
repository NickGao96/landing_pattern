# Wingsuit Auto Solver Redesign Plan

This document proposes a replacement design for the current wingsuit auto solver
described in [wingsuit-auto-mode.md](wingsuit-auto-mode.md). It also
cross-references Gemini's proposal in
[wingsuit-new-gemini.md](wingsuit-new-gemini.md).

This is a software design document, not operational approval for a real jump.
Every generated plan must remain advisory and must be checked against local DZ
rules, pilot instructions, S&TA or equivalent authority, weather, airspace,
clouds, terrain, outs, and actual jumper proficiency.

## Executive Summary

The current solver is unrealistic because it solves the wrong problem backward.
It enumerates deploy points around the landing zone, calls the shared wingsuit
pattern solver backward from each deploy point, then accepts candidates whose
computed exit happens to land close to the resolved jump-run line. That makes
the most important operational point, the wingsuit exit slot, a byproduct of
the math instead of an input.

The replacement should be a forward, operational planner:

1. Resolve the load, jump run, and intended wingsuit exit slot.
2. Build a deployment safety envelope from real constraints: jump-run
   separation, other groups, canopy return, holding area, pattern entry,
   terrain, outs, clouds, and DZ policy.
3. Generate wingsuit route candidates forward from the planned exit.
4. Integrate the wingsuit trajectory through altitude-dependent winds.
5. Keep only candidates whose full path and deploy point satisfy the safety
   envelope.
6. Rank candidates by safety margin first, then pattern simplicity and
   aesthetics.

This keeps the parts of the current system that are useful, especially local
coordinates, wind interpolation, jump-run rendering, and diagnostics, but
removes the backward deploy-point search as the primary solver.

## Research Basis

The sources reviewed consistently frame wingsuit planning as a pre-planned
navigation and traffic-deconfliction exercise:

- USPA SIM 5-8 says wingsuit pilots need situational awareness around aircraft
  location, jump-run direction, exit order, exit separation, deployment,
  canopy flight, and the landing pattern. It also says wingsuiters can travel
  miles, should determine winds aloft before jumping, should avoid crossing
  jump run, and should consider canopy traffic, especially tandem and AFF
  students. Source: [USPA SIM 5-8, Wingsuit Flying](https://www.uspa.org/sim/5-8).
- USPA's wingsuit pre-flight checklist asks for jump run, forecast winds at
  exit, flight, deployment, landing pattern, current ground conditions, exit
  order, other wingsuit or movement groups, coordinated deployment areas,
  terrain, holding area, and whether the path interferes with jump run.
  Source: [USPA SIM 5-8 checklist](https://www.uspa.org/sim/5-8).
- USPA movement-jump guidance generalizes the same navigation problem: plan to
  move off the aircraft line of flight, avoid other groups in freefall and
  under canopy, open where predetermined, account for terrain, and have a
  landing-out backup. Source: [USPA SIM 5-10, Movement Jumps](https://www.uspa.org/sim/5).
- USPA exit-separation training computes spacing from aircraft ground speed
  and recommends more spacing as upper winds and group size increase. Source:
  [USPA Category F, Exit Separation](https://www.uspa.org/skydiveschool/F).
- USPA spotting training calculates opening points from winds aloft and canopy
  drift, then ties those opening points to a pattern-entry point rather than
  only to the center of the landing area. Source:
  [USPA Category E, Determining Opening Point](https://www.uspa.org/skydiveschool/e).
- USPA canopy training treats the landing pattern as a planned route through a
  holding area and pattern-entry checkpoints, usually downwind, base, and final.
  Source: [USPA Category A, Landing Pattern](https://www.uspa.org/skydiveschool/a).
- British Skydiving's first-flight manual describes wingsuits as generally
  exiting last, using an aerial photo to brief jump run, spot, landmarks,
  hazards, and outs, and using a 90-degree box pattern as the common first
  training pattern. It specifically emphasizes staying clear of the line of
  flight and not flying near tandem or student canopies. Source:
  [British Skydiving Wing Suit Training Manual, 2019](https://britishskydiving.org/wp-content/uploads/2019/05/Wing-Suit-Training-Manual-2019.pdf).
- FAA 14 CFR 105.17 prohibits parachute operations into or through clouds and
  specifies visibility and cloud-clearance minima. Source:
  [14 CFR 105.17](https://www.law.cornell.edu/cfr/text/14/105.17).

The practical implication is that "auto mode" must not look for a mathematically
nice path in isolation. It must model the operational constraints that determine
where a wingsuiter may exit, fly, and deploy.

## Diagnosis Of The Current Solver

### 1. Exit Is Treated As An Error Term

The current implementation resolves a nominal wingsuit slot, but then it solves
routes backward from sampled deploy points and checks whether the computed exit
is close enough to the jump-run line. This creates the `exitToJumpRunErrorFt`
chokepoint.

Operationally, the exit is not a solver residual. It is a planned event on a
specific pass after previous groups have left. The solver should start there.
If the route cannot reach a safe deployment area from that exit, the correct
answer is "no valid plan under these assumptions", plus suggested changes such
as a different reciprocal jump run, side, deploy altitude, or spot.

### 2. Freefall Is Forced Into A Canopy Pattern Grammar

Auto mode reuses `computePattern` with a route endpoint at deploy altitude and
segment labels that were designed around downwind, base, and final. For wingsuit
freefall, that grammar is too restrictive. A real wingsuit route is usually
planned around line-of-flight clearance, lateral movement away from jump run,
deployment-area coordination, and return or parallel flight near the DZ. It may
look like a 90-degree box, an out-and-back, a racetrack, or a DZ-specific
variation.

### 3. The Upwind Half-Disk Is A False Constraint

The current search centers deploy candidates on the lowest-layer wind direction
and defaults to the upwind half-plane. Real deployment safety is not simply
"upwind is safe, downwind is unsafe". A deploy point is acceptable only if it is
clear of traffic and the canopy can reach a suitable holding area, pattern-entry
point, main landing area, or alternate with altitude margin. In some wind
profiles a crosswind or even mildly downwind deploy point may be better than an
upwind point that conflicts with jump run, clouds, or canopy traffic.

### 4. Slick Spotting Is Oversimplified

The current jump-run setup uses spot tables for slick groups and validates
`slickFallRateFps` without using it. Real spotting uses winds aloft, freefall
drift, canopy drift, aircraft ground speed, and opening or pattern-entry points.
The current table can be kept as a fallback, but the target model should
integrate drift for each group class.

### 5. The Fixed 2 km Deploy Radius Is Not A Physical Limit

The default `maxDeployRadiusFt` is about 2 km. That may be a reasonable UI or
DZ-policy limit for some contexts, but wingsuits can cover far more distance
than that. The max distance should be a policy input and a safety-envelope
result, not a hidden physical constant.

### 6. Feasible Deploy Bands Are A Search Artifact

The current `deployBandsByBearing` are derived from coarse LZ-relative deploy
samples that happen to reverse-solve. That region can look authoritative while
only reflecting the backward solver's search grid and constraints. The new
region should represent the intersection of:

- deploy points reachable by a forward wingsuit route from the planned exit
- deploy points safe for canopy return and traffic deconfliction
- deploy points permitted by DZ, terrain, weather, cloud, and airspace policy

## Real-World Planning Factors To Model

### Jump Run

Inputs:

- aircraft heading options or runway reciprocal constraint
- aircraft true or indicated airspeed and expected ground speed on jump run
- wind layers at exit altitude
- aircraft type and tail-clearance notes
- pilot or DZ-imposed pass constraints
- current clouds and visibility, if available
- airspace or runway restrictions, if available

Solver behavior:

- Keep the existing local-frame and heading conventions.
- Resolve a default headwind jump run only as a suggestion. If runway or pilot
  constraints are provided, snap to an allowed reciprocal.
- Compute aircraft ground speed along the selected heading for spacing.
- Report group spacing in seconds and feet.
- If wind or aircraft speed produces unrealistic spacing, block or warn rather
  than silently relying on a floor.

### Load And Exit Order

Inputs:

- group list, not only `groupCount`
- each group type: belly, freefly, tandem, student, tracking, wingsuit,
  high-pull, hop-and-pop, etc.
- approximate group size, deploy altitude, fall-rate class, and canopy return
  assumptions
- DZ policy for exit order and movement groups

Solver behavior:

- Default to "wingsuit last" when no load details are provided, matching common
  first-flight teaching, but do not hardcode it as universal.
- Use group spacing based on aircraft ground speed and DZ policy.
- For each non-wingsuit group, estimate opening point from freefall drift and
  canopy drift. This replaces the current slick table over time.
- Track high-pull, tandem, student, and other movement-group deployment areas
  as traffic constraints for the wingsuit route and deployment envelope.

### Wingsuit Exit Point

Inputs:

- resolved wingsuit slot from the load model
- optional exit-window tolerance along jump run, if the pilot or spot allows a
  short window rather than one point
- minimum separation after the previous group
- tail-clearance policy for the aircraft

Solver behavior:

- Start the route exactly at the planned wingsuit exit slot for the primary
  solution.
- Optionally evaluate a small along-run exit window as alternate plans, but
  label them as alternate door cues. Do not move the exit silently to make the
  route nicer.
- Include a short tail-clear phase with reduced or constrained wingsuit
  performance before normal flight. The duration and performance scale should
  be aircraft/profile configuration, later calibrated from real tracks.

### Wingsuit Flight Pattern

Inputs:

- selected side: left or right of jump run
- suit/profile performance: horizontal speed, fall rate, and eventually a polar
  or mode table
- exit height, deploy height, and optional turn-ratio preferences
- DZ pattern templates allowed for wingsuit operations
- wind layers through the full freefall altitude band

Solver behavior:

- Generate route candidates forward from exit.
- Treat existing `turnRatios` as initial altitude/time splits, not as mandatory
  canopy-pattern gates.
- Sweep a small family of operational pattern templates:
  - `box90`: exit/line-of-flight phase, 90-deg move off jump run, second
    90-deg turn to fly parallel or back toward the DZ side of jump run
  - `dogleg`: short line-of-flight phase, one main offset leg, one return leg
  - `racetrack`: offset leg plus longer parallel return
  - `directed-return`: offset leg then a heading chosen to approach the best
    safe deployment envelope center without crossing jump run
- Use side-aware heading deltas:
  - `sideSign = left ? -1 : 1`
  - offset headings usually use `jumpRunHeading + sideSign * 60..110 deg`
  - return headings usually sit near `jumpRunHeading + 180 deg`, adjusted for
    winds, DZ geometry, and the deploy envelope
- Integrate with altitude-dependent winds over small altitude or time steps.
  Do not rely only on a single wind sample at segment start.

Forward integration sketch:

```text
state = {
  point: plannedExitLocal,
  altFt: exitHeightFt,
  timeSec: 0
}

for phase in candidate.phases:
  while state.altFt > phase.endAltFt:
    sinkFps = performanceSink(phase, state.altFt)
    airspeedKt = performanceSpeed(phase, state.altFt)
    dt = chooseStep(state.altFt, phase.endAltFt, sinkFps)
    sampleAltFt = state.altFt - 0.5 * sinkFps * dt
    windKt = windAt(sampleAltFt)
    airKt = airspeedKt * unit(phase.headingDeg)
    groundKt = airKt + windKt

    state.point += knotsToFeetPerSecond(groundKt) * dt
    state.altFt -= sinkFps * dt
    state.timeSec += dt
```

The first implementation can use the current single `flightSpeedKt` and
`fallRateFps`. The target implementation should support a small performance
mode table, such as `tailClear`, `normal`, `maxGlide`, `steep`, and `flare`,
calibrated from real FlySight or GPS tracks.

### Deployment Point

A deploy point should be accepted by an envelope, not by bearing preference.

Hard filters:

- outside the jump-run corridor and on the selected side after the first
  line-of-flight clearance phase
- route does not cross jump run after leaving it
- outside configured freefall and canopy traffic zones
- outside clouds and legal cloud-clearance buffers, if weather geometry is
  available
- not over prohibited terrain, water, obstacles, or airspace, if such layers
  are available
- deployment altitude is at or above policy for the selected pilot skill and
  suit profile
- enough altitude after deployment for canopy inflation, housekeeping, unzip,
  traffic scan, and steering before requiring strong navigation decisions

Canopy return filters:

- evaluate reachability from deploy point to the configured holding area or
  pattern-entry point, not only to the LZ center
- use the actual canopy profile when available: airspeed, glide ratio, descent
  rate, and wind penetration
- include wind layers from deploy height through the landing pattern
- require margin at pattern entry, for example `patternEntryAltMarginFt >=
  configuredReserve`
- fail if the canopy cannot penetrate the projected wind to the holding or
  pattern-entry area
- if the main landing area is not reachable with margin, check configured
  alternate landing areas and report that the solution requires an alternate

This replaces the current "downwind deploy forbidden" half-disk. The UI can
still render downwind context, but it should not be a hard half-plane rejection.

### Canopy Return Model

Add a dedicated `canopyReturn` model to auto mode. It can reuse parts of the
canopy engine, but it should answer a different question:

> From this deployment point and altitude, can a canopy reach a safe holding or
> pattern-entry state with enough altitude and wind penetration margin?

Recommended input additions:

```ts
interface WingsuitAutoCanopyReturnInput {
  canopyAirspeedKt: number;
  canopyGlideRatio: number;
  canopySinkFps?: number;
  controllabilityDelaySec?: number;
  deploymentAltitudeLossFt?: number;
  holdingArea?: GeoPoint;
  patternEntryPoint?: GeoPoint;
  patternEntryAltFt?: number; // default 900 or 1000 based on DZ policy
  patternEntryReserveFt?: number;
  alternates?: Array<{ name: string; point: GeoPoint; radiusFt: number }>;
}
```

Current app state already has canopy settings for manual canopy mode. Auto mode
should pass either that canopy profile or an explicit wingsuit-canopy-return
profile into `solveWingsuitAuto`.

### Terrain, Outs, And Policy Layers

The first implementation may not have map layers for hazards. The design should
still make room for them:

```ts
interface WingsuitAutoDzPolicy {
  maxDistanceFromLandingFt?: number;
  jumpRunCorridorHalfWidthFt: number;
  landingTrafficExclusionRadiusFt: number;
  deploymentExclusionPolygons?: GeoPoint[][];
  freefallExclusionPolygons?: GeoPoint[][];
  cloudExclusionPolygons?: GeoPoint[][];
  allowedPatternSides?: Array<"left" | "right">;
  minDeployHeightByExperience?: Record<string, number>;
}
```

The British manual's 1.5-mile note is an example of a policy limit, not a
universal physics limit. USPA guidance also makes DZ terrain and outs explicit.
Therefore distance limits should be configurable by DZ policy and surfaced in
diagnostics.

## Proposed Solver Architecture

### Stage 1: Normalize Inputs

- Validate landing point, wind layers, exit and deploy heights, suit profile,
  side, jump-run inputs, and canopy-return inputs.
- Normalize all geometry in the existing local flat frame centered at the
  landing point.
- Sort and interpolate wind layers with the existing shortest-direction method.
- Warn when extrapolating outside the wind table.
- Convert all policy distances into local feet.

### Stage 2: Resolve Operational Jump Run

- Resolve heading from auto/manual/reciprocal modes.
- Compute aircraft ground speed and group spacing.
- Estimate each prior group's exit point and opening/deployment region.
- Set the primary wingsuit exit to the resolved WS slot.
- Build jump-run corridor geometry for both visualization and hard filtering.

Outputs:

- `resolvedJumpRun`
- `plannedExitPoint`
- `groupDeploymentZones`
- `jumpRunCorridorPolygon`
- diagnostics for aircraft ground speed, spacing, spot offset, and group
  margins

### Stage 3: Build Deployment Safety Envelope

Evaluate an LZ-relative polar grid, or a set of candidate points, against:

- landing traffic exclusion
- jump-run corridor and side rules
- group deployment zones
- terrain, outs, water, clouds, and airspace, when available
- canopy return to holding or pattern entry

The result is `safeDeployEnvelope`. It should exist independently from the
wingsuit reachability search so the UI can show where deployment would be safe
even before selecting the final route.

### Stage 4: Generate Forward Wingsuit Candidates

Candidate dimensions:

- template: `box90`, `dogleg`, `racetrack`, `directed-return`
- first normal-flight turn altitude or ratio
- second turn altitude or ratio
- side-aware offset heading delta
- return heading delta or target point
- performance mode per phase
- optional small along-run exit-window alternate

The first implementation can keep the search compact:

```text
turn1Ratio in [preferred - 0.10, preferred, preferred + 0.08]
turn2Ratio in [preferred - 0.08, preferred, preferred + 0.08]
offsetDelta in sideSign * [60, 75, 90, 105, 120]
returnDelta in [150, 165, 180, 195, 210] around jump-run heading
templates in [box90, dogleg, racetrack]
```

Then add a local refinement pass around the best candidates.

### Stage 5: Integrate And Filter Candidate Paths

For each candidate:

- start at the planned exit
- simulate all phases forward to deploy altitude
- record sampled points, altitudes, times, headings, winds, and ground speeds
- reject candidates that cross jump run after line-of-flight clearance
- reject candidates that enter forbidden polygons or traffic zones
- reject candidates whose deploy endpoint is outside `safeDeployEnvelope`
- reject candidates that violate canopy-return margins

The key invariant is:

```text
routeWaypoints[0] == planned wingsuit exit slot
diagnostics.exitToJumpRunErrorFt == 0 for the primary solution
```

If alternate exit-window plans are enabled, diagnostics must report the actual
along-run exit shift separately from route quality.

### Stage 6: Rank Candidates

Rank only after hard constraints pass.

Primary safety terms:

1. canopy pattern-entry altitude margin
2. minimum jump-run corridor margin along the route after departure
3. minimum distance from other deployment and canopy traffic zones
4. terrain, water, cloud, and airspace margins
5. deployment altitude margin above policy minimum

Operational quality terms:

6. simple, brief line-of-flight departure before moving away
7. route shape close to an allowed DZ template
8. smooth turn timing and no late aggressive navigation
9. final freefall segment leaves the jumper close enough to expected canopy
   holding or pattern-entry flow
10. conservative wingsuit performance, preferring normal mode over max-glide
    mode when both work

Aesthetic terms:

11. offset leg near 90 deg for first-flight style plans
12. return leg close to parallel or reciprocal to jump run when that matches
    DZ policy
13. shorter total distance only when safety margins are otherwise comparable

Suggested score structure:

```text
if hardConstraintFails:
  reject

score =
  safetyWeight * safetyPenalty(candidate) +
  operationsWeight * operationsPenalty(candidate) +
  shapeWeight * templateDeviation(candidate) +
  performanceWeight * maxPerformancePenalty(candidate)
```

Do not include exit cross-track error as a score term for the primary solution,
because the route starts at the exit slot.

### Stage 7: Produce Output

Keep current output fields during migration:

- `resolvedJumpRun`
- `deployPoint`
- `exitPoint`
- `turnPoints`
- `routeWaypoints`
- `routeSegments`
- `landingNoDeployZonePolygon`
- `forbiddenZonePolygon`
- `feasibleDeployRegionPolygon`
- `deployBandsByBearing`
- `diagnostics`

Change semantics:

- `exitPoint` is the planned WS slot, not a reverse-solved route start.
- `routeSegments` should eventually allow wingsuit segment names such as
  `tail_clear`, `line_of_flight`, `offset`, `return`, and `approach`. During a
  compatibility phase, legacy segment names can be mapped for rendering, but
  the docs should not pretend they are canopy downwind/base/final legs.
- `downwindDeployForbiddenZonePolygon` should be deprecated. Render it only as
  optional wind context or leave it empty. The actual safe region is
  `feasibleDeployRegionPolygon`.

Add diagnostics:

```ts
interface WingsuitAutoForwardDiagnostics {
  plannedExitAlongFt: number;
  actualExitAlongShiftFt: number;
  canopyPatternEntryAltMarginFt: number | null;
  canopyReturnGroundSpeedMinKt: number | null;
  minJumpRunCorridorMarginFt: number | null;
  minTrafficMarginFt: number | null;
  selectedTemplate: string | null;
  selectedCandidateScore: number | null;
  rejectedCandidateCountsByReason: Record<string, number>;
}
```

## Feasible Deploy Region

The deploy region should be built from two point clouds:

1. `canopySafeDeployPoints`: points that pass canopy return, traffic, terrain,
   cloud, and policy checks.
2. `wingsuitReachableDeployPoints`: endpoints reached by forward wingsuit
   candidate routes from the planned exit.

The rendered region is the sampled intersection. For the first implementation,
reuse current bearing buckets:

```text
for each accepted endpoint:
  bearing = bearingFromLanding(endpoint)
  radius = distanceFromLanding(endpoint)
  bucket = roundToStep(bearing, deployBearingStepDeg)
  band[bucket].minRadius = min(...)
  band[bucket].maxRadius = max(...)
```

Later, replace the polar-band polygon with an alpha shape or contour when point
density is high enough. The diagnostics should state that the polygon is a
sampled approximation.

## Cross-Reference With Gemini's Proposal

| Gemini idea | Keep | Adjustment |
| --- | --- | --- |
| Invert the solver and integrate forward from exit | Yes | This is the central architectural change. |
| Set exit exactly to the WS slot | Yes | Make it the primary invariant. Optional exit-window alternates must be explicit and diagnosed. |
| Use `turnRatios` as altitude/time splits | Yes | Treat them as preferred seeds, then sweep around them. Do not make them the only possible timing. |
| Sweep headings instead of deploy points | Mostly | Sweep operational pattern templates and controls; also build a separate canopy-safe deploy envelope. |
| Use a dogleg or U-pattern | Yes, as one family | Include box90, racetrack, and DZ-specific templates. A single fixed dogleg is too narrow. |
| Replace the downwind half-disk | Yes | Replace it with canopy-return and traffic-envelope checks, not a fixed glide-ratio shortcut. |
| Check canopy glide with a 2.5 ratio and 20 percent margin | No | Use the actual canopy profile, wind layers, holding area, pattern-entry altitude, controllability delay, and policy reserve. |
| Generate feasible deploy bands from valid forward endpoints | Yes | Bands should represent the intersection of forward reachability and independent deployment safety, not just route endpoints. |
| Claim zero exit error and realistic shapes | Partly | Zero exit error is true for the primary solution; realism depends on calibrated performance, local policy, and sufficient route templates. |

Gemini's strongest point is the paradigm shift away from backward solving. Its
weakest point is that it under-models the deployment decision. In real planning,
deployment is not only "far enough from jump run and close enough to glide back";
it is a coordinated airspace, canopy, terrain, weather, and policy decision.

## Implementation Plan

### Phase 1: Forward Route Simulator Behind Existing Types

- Add a new internal `solveWingsuitAutoForward` path without deleting the old
  solver.
- Start each candidate at `resolvedPlan.targetExitLocal`.
- Implement stepped wind integration using current `flightSpeedKt` and
  `fallRateFps`.
- Implement `box90`, `dogleg`, and `racetrack` templates.
- Keep existing output shape by mapping selected route waypoints to `exit`,
  `turn1`, `turn2`, and `deploy`.
- Keep the old solver available behind a feature flag for comparison.

### Phase 2: Canopy Return Envelope

- Extend `WingsuitAutoInput` with a `canopyReturn` object.
- Pass current canopy settings from the web app when auto mode is active.
- Implement reachability to holding or pattern-entry point.
- Replace hard upwind-half search with envelope filtering.
- Keep `downwindDeployForbiddenZonePolygon` for compatibility but stop using it
  as a hard constraint.

### Phase 3: Load Model And Better Spotting

- Replace `groupCount` with an optional group list while preserving
  `groupCount` as a shorthand.
- Use fall-rate and deploy-altitude classes to estimate prior groups'
  freefall drift and opening zones.
- Use canopy-return modeling for slick group spot feasibility instead of
  `slickReturnRadiusFt` alone.
- Keep spot tables as fallback when group details are missing.

### Phase 4: Diagnostics And UI

- Add candidate rejection counts by reason.
- Render:
  - jump-run corridor
  - prior group opening zones
  - canopy-safe deploy envelope
  - selected forward route
  - sampled feasible deploy region
- Rename UI copy away from "downwind forbidden" toward "deploy safety
  envelope".
- Show no-go reasons as operational levers: jump run, side, deploy altitude,
  canopy return, traffic conflict, weather, or policy.

### Phase 5: Calibration And Validation

- Add track import support for FlySight/GPX/CSV logs.
- Fit simple profile modes from real jumps: normal speed/fall rate, max glide,
  steep, and deployment preparation.
- Compare predicted deploy endpoints against actual tracks under known winds.
- Inflate safety buffers by observed prediction error percentiles.

## Test Plan

Unit tests:

- Primary route starts exactly at the WS slot.
- Mirroring `side` mirrors the local route around jump run.
- Rotating all headings and winds rotates the solution without changing
  distances.
- No-wind box90 produces expected heading geometry.
- Strong crosswind changes ground track but does not allow post-departure
  jump-run crossing.
- Canopy-return failure blocks even when the wingsuit can physically reach the
  point.
- Traffic-zone failure blocks even when canopy return is possible.
- `deployBandsByBearing` is empty when no forward endpoint intersects the
  safety envelope.

Integration tests:

- Existing `autoInput` fixture succeeds with the forward solver.
- A case that currently fails from exit-line tolerance succeeds when the forward
  path is operationally safe.
- A case that currently succeeds only by reverse-solving an early/late exit is
  rejected or reported as requiring an alternate exit cue.
- High wind at canopy altitudes blocks unreachable downwind deployment points
  while allowing reachable crosswind points.
- Reciprocal jump-run constraint selects the safer of the allowed headings when
  both are feasible, or reports why the chosen heading is invalid.

Regression metrics:

- candidate count
- rejection counts by reason
- selected template
- deploy distance and bearing
- canopy pattern-entry altitude margin
- minimum jump-run corridor margin
- route compute time

## Open Questions

- Should auto mode choose the pattern side automatically, or should it only
  evaluate the side selected by the user? Real operations often decide side
  from DZ policy, traffic, terrain, and other movement groups.
- What should the first production default be for `canopyReturn` when no canopy
  profile is provided? A conservative placeholder is safer than the current
  fixed glide shortcut, but the UI should strongly encourage explicit canopy
  input.
- How should cloud and terrain geometry enter the app? The solver can accept
  polygons now, but the product still needs data sources and UX for them.
- Should the route display include uncertainty tubes around the predicted track?
  Given wind and performance error, this is probably more honest than a single
  thin line.
- Should the route optimizer ever suggest "no jump on this pass; request a
  go-around or different jump run"? From a safety standpoint, yes. The UI needs
  a clear way to present that without pretending it is a minor warning.

## Recommended Default Direction

Implement the forward solver in parallel with the current solver, but make the
new invariant non-negotiable: the primary route starts at the planned WS slot.
Then add canopy-return reachability before expanding load modeling. This order
removes the biggest mathematical over-constraint first while also preventing
the new solver from accepting attractive but unsafe deploy points.

