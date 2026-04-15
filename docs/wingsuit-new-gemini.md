


# Wingsuit Auto Solver: Diagnosis & Redesign Plan

Based on the provided specification and a deep review of real-world wingsuit flight mechanics, the current implementation is experiencing high failure rates ("over-constrained") and producing unnatural routes ("unrealistic results") because it attempts to fit a **backward-solving canopy algorithm** into a **freefall wingsuit environment**. 

Here is a deep dive into why the current model breaks down, how wingsuit flight is actually planned in real life, and a detailed specification for a highly performant **Forward-Solving Architecture** that will fix these issues.

---

## 1. Diagnosis of Current Implementation Flaws

1. **The "Backward-Solver" Fallacy**: The current solver sweeps a grid of random deploy points and works *backwards* using `computePattern` to try and hit the jump-run line. Hitting an infinitely thin jump-run line in the sky from a random starting point is mathematically over-constrained, causing the solver to frequently fail or rely on "nearest misses".
2. **Applying Canopy Logic to Freefall**: The solver forces standard canopy logic (`downwind -> base -> final`) onto wingsuit freefall. Wingsuits do not fly base and final legs to reach a deployment point; they fly aerodynamic vectors designed primarily for lateral separation.
3. **Rigid Downwind Half-Disk**: Forbidding the entire downwind hemisphere for deployment is an unrealistic parachute constraint. Wingsuiters routinely deploy crosswind or slightly downwind of the LZ as long as they have sufficient altitude and canopy glide to return. 
4. **Tolerance Chokepoint**: The `< 300 ft` jump-run exit tolerance rejects perfectly good flight plans simply because the backward math drifted by a few seconds of wind.

---

## 2. Deep Research: Real-World Wingsuit Planning Factors

In real-life skydiving operations (per USPA guidelines and standard DZ practices), a wingsuit flight path is planned **forward from the exit point**, not backward from the deploy point. The primary goal is safely clearing the aircraft and getting lateral separation from the vertical fallers (slicks).

A standard wingsuit flight is essentially a 3-leg **Dogleg / U-Pattern**:
*   **The Exit (Fixed Point)**: Wingsuits exit *last*, well past the vertical freefallers.
*   **Leg 1 (Clear the Tail)**: The jumper flies roughly parallel to the jump run for 5–15 seconds to clear the aircraft's horizontal stabilizer and burble. 
*   **Leg 2 (Lateral Offset)**: The jumper executes a hard turn (45° to 90°) away from the jump run to build horizontal separation. This ensures they do not deploy underneath falling slicks or their deploying canopies.
*   **Leg 3 (Return / Approach)**: The jumper turns back (often flying a reciprocal heading to the jump run) to approach the safe deployment zone.
*   **Deployment**: The jumper pulls at the planned altitude. The only physical requirement is that the deploy point is laterally clear of the jump run, and close enough to the DZ that their canopy can glide back.

---

## 3. The Paradigm Shift: A Forward-Parametric Solver

To eliminate over-constraints, the auto-solver must be inverted: **Start exactly at the resolved Wingsuit Exit Slot and integrate the flight path forward.** 

By mapping the UI's `turn1` and `turn2` ratios to **time/altitude splits** rather than canopy turn heights, we can quickly sweep a grid of *headings* rather than sweeping *deploy points*.

### Summary of Benefits:
*   **Zero Exit Error**: Because the path starts exactly at the resolved jump-run slot, the `exitToJumpRunErrorFt` is mathematically `0`. The hardest constraint is completely eliminated.
*   **100% Realistic Shapes**: By sweeping flight headings (e.g., Leg 2 at 90°), the generated paths look exactly like standard DZ dogleg patterns.
*   **Blazing Fast**: Forward vector integration (Airspeed + Wind) requires practically zero CPU overhead compared to iterating a backward canopy router.
*   **Better Deploy Zones**: Mathematically verifying canopy glide ratio replaces the arbitrary "Downwind Half-Disk" restriction.

---

## 4. Detailed Implementation Plan (Markdown Spec)

### 4.1. Jump Run & Exit Resolution
*Keep the existing jump-run logic mostly intact.*
1. Resolve aircraft heading based on the lowest wind layer.
2. Calculate aircraft ground speed and slick spot offsets.
3. Layout slots `G1, G2, ..., WS`. 
4. **Crucial Change**: Set the `exitPoint` **exactly** to the `WS` slot coordinates. 

### 4.2. Parametrizing the Freefall Legs
The UI's `turnRatios` (e.g., `turn1 = 0.75`, `turn2 = 0.31`) map perfectly to freefall altitude drops. 
For a total altitude drop `Span = exitHeightFt - deployHeightFt`:
*   **Leg 1 (Clearance)** drops from `exit` to `turn1Height`.
*   **Leg 2 (Offset)** drops from `turn1Height` to `turn2Height`.
*   **Leg 3 (Return)** drops from `turn2Height` to `deployHeight`.

Time duration for each leg $i$ is exactly:  
`T[i] = (startAlt - endAlt) / wingsuit.fallRateFps`

### 4.3. The Sweep Strategy (Search Space)
Instead of searching a geographic grid, we sweep a predefined set of heading deltas relative to the `jumpRunHeadingDeg`. 

For a **Left** pattern (multiply angles by $-1$ for right):
*   **Leg 1 Deltas**: `[0, -10, -20]` degrees. (Fly straight or slight crab to clear).
*   **Leg 2 Deltas**: `[-60, -90, -110]` degrees. (The dogleg offset).
*   **Leg 3 Deltas**: `[-150, -180, -210]` degrees. (Reciprocal return).

Combine these with the existing `gateCandidates` (preferred, shifted, no-base/collapsed) to generate a few hundred potential path configurations.

### 4.4. Forward Kinematic Integration
For every candidate in the sweep, calculate the exact ground track:
```text
currentPoint = exitPoint
For each leg in [Leg1, Leg2, Leg3]:
    heading = jumpRunHeading + leg.deltaHeading
    airSpeed = wingsuit.flightSpeedKt 
    airVector = unit(heading) * airSpeed

    // Sample wind at the middle of the leg's altitude drop
    windVector = windAt((leg.startAlt + leg.endAlt) / 2) 
    
    groundVector = airVector + windVector
    legDistance = groundVector * leg.T
    
    nextPoint = currentPoint + legDistance
    Save nextPoint as turn1, turn2, or deployPoint
    currentPoint = nextPoint
```

### 4.5. Realistic Constraints & Validation
Filter the generated forward paths through the following real-world safety checks:
1. **Side Verification**: `turn1`, `turn2`, and `deploy` must have a valid `signedCross()` on the selected side of the jump run.
2. **Corridor Verification**: The deployment point must be laterally separated from the jump run. `abs(signedCross(deployLocal)) >= minDeployRadiusFt` (e.g., 1000 ft minimum lateral separation).
3. **Canopy Glide Verification (Replaces Half-Disk)**:
   Instead of rigidly rejecting the downwind hemisphere, simulate a basic canopy return.
   *   `distToLZ = length(deployPoint - landingPoint)`
   *   Calculate effective headwind/crosswind on the canopy ride back.
   *   Require that the required glide ratio to return to the LZ (plus a 20% safety margin) is `<= 2.5` (a standard safe canopy glide). If it passes, the deploy point is safe.

### 4.6. Candidate Ranking
All surviving paths are perfectly valid and require zero "exit tolerance" adjustments. Rank them to find the most optimal/aesthetic pattern:
1. **Higher Canopy Safety Margin**: Favor deploy points that require lower glide ratios to return.
2. **Standard Aesthetics**: Penalize large deviations from the classic $90^\circ$ offset and $180^\circ$ reciprocal return. (e.g., a $-90^\circ$ Leg 2 ranks higher than a $-60^\circ$ Leg 2).
3. **Lateral Offset**: Favor paths that deploy further away from the jump run line, up to `maxDeployRadiusFt`.

### 4.7. Generating the "Feasible Deploy Region"
The UI currently expects a `feasibleDeployRegionPolygon` mapping viable deploy bands. 
Because the forward solver evaluates hundreds of variations of heading/time splits, it will naturally generate a massive point cloud of valid `deployPoints`. 
*   Convert every valid `deployPoint` to `(bearing, radius)` relative to the LZ.
*   Group them by $5^\circ$ bearing buckets.
*   Track the `minRadius` and `maxRadius` for each bucket.
*   Stitch these exactly as the current system does to output `deployBandsByBearing` and the corresponding polygon. 

---

## 5. Summary

By discarding the backward-canopy routing engine for wingsuits and utilizing a **Forward Freefall Parametric Sweep**, the auto-solver will mimic how actual skydiving patterns are planned. It mathematically guarantees that the wingsuiter hits the exit slot, stays clear of vertical traffic, and only suggests deployments from which a canopy can safely penetrate the wind back to the dropzone.