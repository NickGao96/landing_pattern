# Wingsuit Auto Mode Plan

## Current Codebase Facts

- Web wingsuit mode is not a separate solver today. It reuses the generic 4-gate pattern engine in [packages/engine/src/index.ts](/Users/nickgao/Desktop/landing_pattern/packages/engine/src/index.ts) and only changes defaults from [apps/web/src/wingsuits.ts](/Users/nickgao/Desktop/landing_pattern/apps/web/src/wingsuits.ts).
- iOS mirrors the same behavior in [apps/ios/LandingPatternCore/Sources/LandingPatternCore/Engine/PatternEngine.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPatternCore/Sources/LandingPatternCore/Engine/PatternEngine.swift) with UI state in [apps/ios/LandingPattern/State/LandingStore.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPattern/State/LandingStore.swift).
- Current wingsuit mode still uses `touchdown` as the endpoint even though the gates are labeled `Exit`, `Turn 1`, `Turn 2`, `Deploy`. That semantic mismatch has to be fixed before auto mode can be correct.
- Wind fetch is currently sparse. Wingsuit wind fetch only returns layers for the requested gate altitudes, which is enough for the manual 4-gate pattern but not enough for a robust auto solver.

## Goal

Add a **wingsuit auto mode** without removing the existing manual pattern drawer.

Auto mode should let the user specify a small amount of intent, then solve:

1. A directed jump run.
2. A left/right pattern side relative to that jump run.
3. A landing point.
4. A feasible deploy region.
5. A selected deploy point.
6. A jump-run-safe exit point.
7. Wingsuit turn points between exit and deploy.

## User Input vs Auto-Derived Output

### Required user input

- `landing point`
  - Distinct from deploy point.
  - This is the canopy destination, not the wingsuit endpoint.
- `jump run`
  - Must be **directed**, not just a heading.
  - Store as two map points: `start` and `end`.
  - The direction matters for both `last out` logic and `left/right relative to jump run`.
- `pattern side relative to jump run`
  - `left` or `right` relative to the aircraft travel direction from jump-run start to end.
- `exit height AGL`
  - Default from current wingsuit setup is fine at first.
- `deploy height AGL`
  - Default from current wingsuit setup is fine at first.
- `wingsuit preset/custom performance`
  - Keep current preset/custom input.
- `winds`
  - Auto-fetched by default, still overridable manually.

### Optional advanced input

- `intermediate turn-height ratios`
  - Keep hidden at first.
  - Default from the current wingsuit gate proportions.
- `jump-run forbidden buffer width`
  - Hidden tuning, not first-class UI.
- `deploy preference window around headwind`
  - Hidden tuning, not first-class UI.

### Auto-derived

- `deploy feasibility region`
- `selected deploy point`
- `exit point on jump run`
- `turn 1 / turn 2`
- `forbidden jump-run corridor`
- `diagnostics`
  - no-solution reason
  - “deploy too close to corridor”
  - “cannot place exit on jump run”
  - “low canopy return margin”

## Scope Decision

### In scope for first auto-mode version

- Solve and render the **wingsuit route from exit to deploy**.
- Use the **landing point** only as the canopy destination and deploy-selection reference.
- Use canopy performance only to validate deploy feasibility and preference.

### Explicitly out of scope for first auto-mode version

- Full auto canopy pattern after deployment.
- Dynamic aircraft drift/off-jump-run aircraft motion model.
- Terrain/obstacle modeling.
- Multi-group separation logic beyond the single jump-run forbidden corridor.

## Shared Computation Contract

Both the TypeScript engine and the Swift core should expose a dedicated auto solver instead of overloading the current manual `computePattern` contract.

### New input model

Add a new wingsuit-auto-specific contract alongside the existing manual pattern input:

```ts
WingsuitAutoInput {
  landingPoint
  jumpRunStart
  jumpRunEnd
  sideRelativeToJumpRun
  exitHeightFt
  deployHeightFt
  turnHeightRatios
  wingsuitProfile
  canopyProfile
  jumper
  windProfile
  tuning
}
```

### New output model

```ts
WingsuitAutoOutput {
  blocked
  warnings
  landingPoint
  deployPoint
  exitPoint
  turnPoints
  routeWaypoints
  routeSegments
  forbiddenZonePolygon
  feasibleDeployRegionPolygon
  deployBandsByBearing
  diagnostics
}
```

### Important modeling rule

Do **not** reuse `touchdown` for auto wingsuit output.

For auto mode, the named points should be:

- `landing`
- `deploy`
- `turn2`
- `turn1`
- `exit`

The existing manual-mode `PatternOutput` can remain as-is.

## Computation Plan

### 1. Normalize geometry into a local flat frame

- Use the landing point as the local origin.
- Convert all map geometry into local `east/north feet`.
- Reuse the existing local-coordinate approach already used by the manual solver.
- Only convert back to lat/lng for rendering and persistence.

This keeps the math deterministic and identical between TS and Swift.

### 2. Build a continuous wind model from ground to exit altitude

The current sparse gate-only wind model is not enough for auto mode.

Use a dense AGL profile:

- Merge surface/low-level wind with upper-air wind.
- Sample at a fixed altitude step, for example `250 ft` or `500 ft`.
- Interpolate direction and speed exactly the same way the current engine already interpolates wind layers.

Required output of this stage:

- `windAt(altitudeFt)` for any altitude between ground and exit.

Implementation note:

- Web should extend [packages/data/src/index.ts](/Users/nickgao/Desktop/landing_pattern/packages/data/src/index.ts).
- iOS should extend [apps/ios/LandingPatternCore/Sources/LandingPatternCore/Data/WeatherService.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPatternCore/Sources/LandingPatternCore/Data/WeatherService.swift).

### 3. Represent the jump run as a directed line with signed cross-track distance

From `jumpRunStart -> jumpRunEnd` compute:

- `jumpRunUnit`
- `leftNormal`
- `signedCrossTrack(point)`
- `alongRun(point)`

Rules:

- `left` pattern means points must stay on the positive `leftNormal` side.
- `right` pattern means points must stay on the negative side.
- Reversing jump-run direction must flip the meaning of left/right. This is why a directed line is mandatory.

### 4. Define the forbidden zone as a buffered jump-run corridor

The first implementation should treat the forbidden zone as:

- an infinite strip in solver logic
- a clipped polygon in map rendering

Solver rule:

- reject any deploy candidate with `abs(signedCrossTrack) < corridorHalfWidthFt`
- reject any segment that enters the corridor

Rendering rule:

- clip the corridor to the active area bounding box built from landing point, deploy region, and exit point
- shade it on the map

This gives a safe computational constraint before tuning exact numeric buffers.

## 5. Compute the canopy-reachable deploy envelope around the landing point

Use the current canopy performance model already present in both codebases.

For a candidate canopy heading `theta`:

1. Compute canopy airspeed from the current canopy model.
2. Compute canopy sink from glide ratio.
3. Integrate from `deployHeightFt -> 0` in altitude steps:
   - `dt = deltaAlt / sinkFps`
   - `groundVector = airVector(theta) + windVector(alt)`
   - `displacement += groundVector * dt`

Sweeping `theta` around 360 degrees produces a deploy envelope around the landing point.

Use this envelope to get:

- `max reachable radius` by bearing from landing
- a deploy candidate is invalid if it falls outside the canopy envelope

This is better than hardcoding a simple circle because it bakes in canopy performance and wind drift.

### Headwind preference

Use the lowest available wind layer as the landing-wind reference.

Preferred deploy bearings are centered on:

- `preferredBearing = lowestLayer.dirFromDeg`

Because that is the upwind side of the landing point.

The feasible region is then the canopy envelope intersected with a headwind-preference sector.

## 6. Derive turn heights from exit/deploy heights

Auto mode should not require the user to enter 4 explicit wingsuit gates.

Use:

- `exit height`
- `deploy height`

Then derive intermediate turn heights from fixed ratios based on the current defaults.

Recommended initial rule:

- preserve the current relative fractions from `[12000, 10000, 6500, 4000]`
- scale those ratios into the new `[exit, deploy]` band

Keep those ratios in tuning, not hardcoded inside UI code.

## 7. Solve deploy candidates by searching on the upwind side of landing

Parameterize candidate deploy points by:

- bearing from landing
- radius from landing

Search strategy:

1. Sweep bearings over the preferred headwind sector.
2. For each bearing, sweep radius from near to far inside the canopy envelope.
3. Reject candidates inside the forbidden corridor or on the wrong jump-run side.

For each surviving deploy candidate, solve a wingsuit route and score it.

## 8. Reuse a factored 4-gate route solver for the wingsuit path

Do not build auto mode directly inside the current top-level `computePattern`.

Instead, factor the current manual solver into:

- a low-level “solve 4-gate route from endpoint + final heading + side + winds + performance”
- a high-level auto solver that searches for deploy candidates and calls that low-level route solver

For each deploy candidate:

1. Set `endpoint = deploy candidate`.
2. Set `final heading = bearing from landing point to deploy point`.
3. Set `side = chosen left/right side`.
4. Set `gates = [exit, turn1, turn2, deploy]` from the derived heights.
5. Run the factored route solver.

This returns:

- `exit`
- `turn1`
- `turn2`
- `deploy`

The candidate is valid only if:

- the route solver is not blocked
- the exit is on or very close to the jump run
- all waypoints and all route segments stay outside the forbidden corridor
- the route stays on the selected side of jump run

### Why this is the right first implementation

- It reuses the current segment integration logic.
- It keeps manual and auto wingsuit math consistent.
- It reduces the amount of brand-new math that must be mirrored in Swift.

## 9. Refine the chosen candidate so the exit lands exactly on jump run

The coarse grid search should only be used to find the neighborhood.

After choosing the best candidate:

1. Measure the signed exit distance to jump run.
2. Refine the candidate radius, then bearing if needed.
3. Stop when exit-to-jump-run error is within a small tolerance.

If refinement cannot land the exit on jump run within tolerance, keep the candidate but emit a warning and render the residual.

## 10. Build the feasible deploy region for rendering

For each sampled bearing, keep the radial interval that produced valid deploy candidates.

This naturally creates:

- `min feasible radius`
- `max feasible radius`

per bearing.

Render the region by stitching:

1. the outer boundary over increasing bearing
2. the inner boundary over decreasing bearing

Advantages:

- easy to compute
- easy to debug
- easy to render on both MapLibre and MapKit
- easy to compare between TS and Swift

## 11. Candidate scoring

Use deterministic ranking, not hand-tuned unstable heuristics spread across the app.

Rank candidates in this order:

1. smallest exit-to-jump-run error
2. largest minimum margin to forbidden corridor
3. smallest bearing error to headwind preference
4. largest canopy-envelope margin
5. furthest along-run “last out” position among otherwise equivalent candidates

The last-out rule should only break near-ties, not dominate safety constraints.

## 12. Failure modes

The auto solver must produce explainable failure reasons, not just `blocked = true`.

At minimum:

- no deploy point survives canopy reachability
- no deploy point survives jump-run corridor exclusion
- route candidates survive region checks but cannot place exit on jump run
- all surviving routes violate side constraint
- wind model missing required altitude coverage

## Shared Testing Plan

### Unit tests

Add deterministic synthetic tests for:

- directed jump-run left/right sign handling
- forbidden-corridor segment intersection
- canopy deploy envelope expansion/contraction under wind
- exit snapping/refinement
- deploy candidate scoring order
- no-solution cases

### Regression fixtures

Web should add new fixture generation in [packages/fixtures/engine/generate-fixtures.mjs](/Users/nickgao/Desktop/landing_pattern/packages/fixtures/engine/generate-fixtures.mjs).

iOS should continue parity verification against synced fixtures in [apps/ios/LandingPatternCore/Tests/LandingPatternCoreTests/EngineParityTests.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPatternCore/Tests/LandingPatternCoreTests/EngineParityTests.swift).

### Golden scenarios to include

- left pattern with feasible deploy band entirely left of jump run
- right pattern mirror case
- deploy region clipped by jump-run corridor
- deploy region clipped by canopy reachability
- strong upper wind shifting exit far from landing
- no valid deploy region

## Part 1: Web / TypeScript Modification Plan

This part owns all TypeScript shared packages plus the web UI.

### A. Shared TS contracts and solver

Modify:

- [packages/ui-types/src/index.ts](/Users/nickgao/Desktop/landing_pattern/packages/ui-types/src/index.ts)
- [packages/engine/src/index.ts](/Users/nickgao/Desktop/landing_pattern/packages/engine/src/index.ts)
- [packages/engine/src/math.ts](/Users/nickgao/Desktop/landing_pattern/packages/engine/src/math.ts)
- [packages/data/src/index.ts](/Users/nickgao/Desktop/landing_pattern/packages/data/src/index.ts)
- [packages/engine/test/engine.test.ts](/Users/nickgao/Desktop/landing_pattern/packages/engine/test/engine.test.ts)
- [packages/fixtures/engine/generate-fixtures.mjs](/Users/nickgao/Desktop/landing_pattern/packages/fixtures/engine/generate-fixtures.mjs)

Steps:

1. Add new wingsuit-auto input/output types.
2. Add local-geometry helpers for:
   - jump-run signed distance
   - line-buffer intersection checks
   - polar deploy-band polygon construction
3. Factor the existing manual 4-gate solver into a reusable lower-level route solver.
4. Add a new `solveWingsuitAuto(...)` entry point.
5. Extend wind fetching to support dense AGL profiles from ground to exit altitude.
6. Add unit tests and new fixtures for the auto solver.

### B. Web state and persistence

Modify:

- [apps/web/src/store.ts](/Users/nickgao/Desktop/landing_pattern/apps/web/src/store.ts)

Steps:

1. Add `wingsuitPlanningMode = manual | auto`.
2. Add persisted auto-mode settings:
   - landing point
   - jump run start/end
   - side relative to jump run
   - exit/deploy heights
   - optional advanced tuning
3. Keep current manual wingsuit settings intact.
4. Extend snapshot export/import with the new auto-mode payload.

### C. Web UI

Modify:

- [apps/web/src/App.tsx](/Users/nickgao/Desktop/landing_pattern/apps/web/src/App.tsx)

Steps:

1. Add a manual/auto sub-mode inside wingsuit mode.
2. Rename the wingsuit auto location input from “touchdown” semantics to “landing point”.
3. Add jump-run editing controls:
   - two draggable map handles is the preferred input
   - numeric fallback readout for heading
4. Keep exit/deploy height visible.
5. Hide turn-height ratios under an advanced section.
6. Show auto-solver diagnostics and selected deploy metrics.

### D. Web map rendering

Modify:

- [apps/web/src/components/MapPanel.tsx](/Users/nickgao/Desktop/landing_pattern/apps/web/src/components/MapPanel.tsx)

Steps:

1. Render a directed jump-run line.
2. Render landing, deploy, exit, and turn-point markers separately.
3. Render the forbidden corridor as a shaded polygon.
4. Render the feasible deploy region as a translucent polygon.
5. Keep the selected deploy point highlighted.
6. Add draggable jump-run handles and landing-point handle in auto mode.
7. Preserve current canopy/manual-wingsuit behavior.

### E. Web verification

Run:

- `npm run test`
- `npm run build`
- refresh fixtures used by iOS parity later

## Part 2: iOS / Swift Modification Plan

This part owns the Swift core mirror and the native iOS UI.

### A. Swift core contracts and solver

Modify:

- [apps/ios/LandingPatternCore/Sources/LandingPatternCore/Models/Contracts.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPatternCore/Sources/LandingPatternCore/Models/Contracts.swift)
- [apps/ios/LandingPatternCore/Sources/LandingPatternCore/Engine/PatternEngine.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPatternCore/Sources/LandingPatternCore/Engine/PatternEngine.swift)
- [apps/ios/LandingPatternCore/Sources/LandingPatternCore/Engine/Math.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPatternCore/Sources/LandingPatternCore/Engine/Math.swift)
- [apps/ios/LandingPatternCore/Sources/LandingPatternCore/Data/WeatherService.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPatternCore/Sources/LandingPatternCore/Data/WeatherService.swift)
- [apps/ios/LandingPatternCore/Tests/LandingPatternCoreTests/EngineUnitTests.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPatternCore/Tests/LandingPatternCoreTests/EngineUnitTests.swift)
- [apps/ios/LandingPatternCore/Tests/LandingPatternCoreTests/EngineParityTests.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPatternCore/Tests/LandingPatternCoreTests/EngineParityTests.swift)

Steps:

1. Mirror the new auto-mode contracts exactly.
2. Factor the existing manual 4-gate solver into a reusable internal route solver.
3. Implement the Swift `solveWingsuitAuto(...)` mirror of the TS solver.
4. Extend weather fetching for dense AGL wind profiles.
5. Add Swift unit tests for geometry, corridor checks, candidate scoring, and failure modes.
6. Keep parity with the TS fixtures once the TS side stabilizes.

### B. iOS app state and persistence

Modify:

- [apps/ios/LandingPattern/State/LandingStore.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPattern/State/LandingStore.swift)

Steps:

1. Add persisted auto-mode state matching the TS contract.
2. Keep manual wingsuit mode intact.
3. Extend snapshot encoding/decoding with the new auto-mode payload.
4. Update wind-fetch flows so auto mode requests dense altitude coverage.

### C. iOS UI

Modify:

- [apps/ios/LandingPattern/Views/ContentView.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPattern/Views/ContentView.swift)

Steps:

1. Add a manual/auto sub-mode inside wingsuit mode.
2. Present landing-point controls separately from deploy output.
3. Add jump-run editing controls and a heading readout.
4. Keep exit/deploy heights visible.
5. Show diagnostics and selected deploy metrics.

### D. iOS map rendering

Modify:

- [apps/ios/LandingPattern/Map/LandingMapProtocol.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPattern/Map/LandingMapProtocol.swift)
- [apps/ios/LandingPattern/Map/MapKitLandingMapView.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPattern/Map/MapKitLandingMapView.swift)

Notes:

- [apps/ios/LandingPattern/Map/MapboxLandingMapView.swift](/Users/nickgao/Desktop/landing_pattern/apps/ios/LandingPattern/Map/MapboxLandingMapView.swift) is currently only a thin wrapper over MapKit, so MapKit is the real implementation target.

Steps:

1. Render separate annotations for landing, deploy, exit, and turns.
2. Add draggable handles for landing and jump-run endpoints.
3. Render the forbidden corridor as an `MKPolygon` overlay.
4. Render the feasible deploy region as an `MKPolygon` overlay.
5. Preserve current camera-fit behavior while including the new geometry.

### E. iOS verification

Run:

- `npm run ios:fixtures:sync`
- `npm run ios:core:test`
- `npm run ios:app:build:sim`

## Parallelization Guidance

The work can be split cleanly as:

- **Web agent**: all TS shared packages + web UI
- **iOS agent**: Swift core mirror + iOS UI

### Required coordination points

Freeze these before parallel implementation:

1. exact auto-mode input/output field names
2. turn-height-ratio rule
3. deploy-band representation by bearing
4. candidate scoring order
5. failure/diagnostic strings that parity tests will assert on

### Safe parallel boundary

Once the contract above is frozen:

- the web agent can change TS packages and web UI without touching iOS files
- the iOS agent can mirror the same contract and solver behavior without touching TS files

## Final Recommendation

Implement auto mode as a **new wingsuit planning layer** on top of the existing 4-gate integrator, not as a patch inside the current manual mode.

That gives the cleanest path to:

- correct landing-vs-deploy semantics
- deploy-region rendering
- jump-run-safe exit solving
- TS/Swift parity
- keeping the current manual drawer untouched

## Domain Constants That Still Need Your Sign-Off

These should be centralized as tunables immediately, even if the first pass ships with defaults:

- jump-run corridor half-width
- preferred deploy bearing window around headwind
- minimum/maximum deploy distance bias
- turn-height ratios between exit and deploy
- exit-to-jump-run tolerance for “solved”

The structure above is stable without those exact numbers, but those numbers should be reviewed before calling the feature operational.
