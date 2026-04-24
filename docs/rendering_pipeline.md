# Rendering Pipeline

> How solver output becomes pixels on screen — from data to map overlays.

## Overview

The rendering pipeline transforms solver output (waypoints, segments, zones) into interactive map overlays. Both platforms follow the same logical pipeline but use different rendering backends:

| Stage | Web | iOS |
|-------|-----|-----|
| Solve | `computePattern()` / `solveWingsuitAuto()` | Same functions (Swift port) |
| Build GeoJSON | `buildManualOverlayFeatures()` / `buildAutoOverlayFeatures()` | Direct MapKit annotation/overlay APIs |
| Map library | MapLibre-GL JS | Apple MapKit |
| Tile source | Esri ArcGIS satellite (default), optional Mapbox | MapKit satellite (default) |
| Interaction | MapLibre markers + event handlers | MapKit annotations + gesture recognizers |

## Web Rendering Pipeline

### Step 1: Solver invocation

In `App.tsx`, the solver is called as a `useMemo` computation:

```typescript
// Manual mode (canopy or wingsuit):
const patternInput = buildPatternInput(storeState);
const patternOutput = computePattern(patternInput);

// Auto mode:
const autoInput = buildWingsuitAutoInput(storeState);
const autoOutput = solveWingsuitAuto(autoInput);
```

Both are reactive — they recompute whenever any input state changes in the Zustand store.

### Step 2: MapPanel component

The parent `App.tsx` passes output to `<MapPanel>` via one of two variants:

```typescript
// Manual mode:
<MapPanel
  variant="manual"
  touchdown={touchdown}
  waypoints={patternOutput.waypoints}
  landingHeadingDeg={landingHeadingDeg}
  blocked={patternOutput.blocked}
  hasWarnings={patternOutput.warnings.length > 0}
  windLayers={windLayers}
  onTouchdownChange={...}
  onHeadingChange={...}
/>

// Auto mode:
<MapPanel
  variant="auto"
  landingPoint={autoInput.landingPoint}
  resolvedJumpRun={autoOutput.resolvedJumpRun}
  routeWaypoints={autoOutput.routeWaypoints}
  forbiddenZonePolygon={autoOutput.forbiddenZonePolygon}
  feasibleDeployRegionPolygon={autoOutput.feasibleDeployRegionPolygon}
  landingNoDeployZonePolygon={autoOutput.landingNoDeployZonePolygon}
  downwindDeployForbiddenZonePolygon={autoOutput.downwindDeployForbiddenZonePolygon}
  blocked={autoOutput.blocked}
  hasWarnings={autoOutput.warnings.length > 0}
  windLayers={winds}
  onLandingPointChange={...}
/>
```

### Step 3: GeoJSON feature construction

`MapPanel.tsx` builds a unified `GeoJSON.FeatureCollection` from solver output:

#### Manual mode features (`buildManualOverlayFeatures`)

| Feature Kind | Geometry | Visual |
|-------------|----------|--------|
| `pattern-line` | LineString through all waypoints | Green 4px solid line |
| `pattern-direction-shaft` | LineString (arrow shaft per segment) | White 2.5px line |
| `pattern-direction-head` | LineString (arrowhead per segment) | White 2.5px chevron |
| `manual-waypoint` | Point per waypoint | Label with altitude |
| `heading-guide` | LineString from touchdown to heading handle | Amber 4px dashed line |
| `heading-guide-arrow` | LineString (heading arrowhead) | Amber 3px chevron |

The heading handle position is computed in **screen space** (56px from touchdown) and projected back to geo coordinates, so it maintains a consistent visual size regardless of zoom.

Direction arrows are placed at **62% along each segment** using linear geo interpolation.

#### Auto mode features (`buildAutoOverlayFeatures`)

| Feature Kind | Geometry | Visual |
|-------------|----------|--------|
| `forbidden-zone` | Polygon (jump-run corridor) | Red fill (16% opacity) + dashed outline |
| `landing-no-deploy-zone` | Polygon (min radius circle) | Amber fill (8% opacity) |
| `downwind-deploy-forbidden-zone` | Polygon (wind half-disk) | Orange fill (18% opacity) + dashed outline |
| `jump-run` | LineString (start → end) | Sky blue 3px dashed line |
| `jump-run-arrow-shaft` / `-head` | LineString (arrow at 60%) | Light blue 2.5px |
| `jump-run-slot` | Point per slot | Sky blue circle (5px) + label |
| `route-line` | LineString through route waypoints | Green 4px solid line |
| `landing-link` | LineString (deploy → landing) | Amber 2px dotted line |
| `auto-waypoint` | Point per waypoint | Labels: LND, EXIT, T1, T2, DEP |

### Step 4: MapLibre-GL layer rendering

All features share a single GeoJSON source (`overlay-source`). Individual MapLibre layers filter by the `kind` property:

```javascript
{
  id: "forbidden-zone",
  type: "fill",
  source: "overlay-source",
  filter: ["==", ["get", "kind"], "forbidden-zone"],
  paint: { "fill-color": "#dc2626", "fill-opacity": 0.16 }
}
```

The layer stack (bottom to top):
1. Zone fills (no-deploy zones, forbidden corridor, feasible region)
2. Zone outlines
3. Jump-run line + arrows + slot markers
4. Landing link (deploy → landing dashed line)
5. Route/pattern lines
6. Heading guide + arrows
7. Direction arrows (pattern segment flow indicators)
8. Waypoint circles and labels

### Step 5: Interaction handling

**Touchdown/landing point marker:** A draggable MapLibre `Marker` element. On drag end, calls `onTouchdownChange(lat, lng)` which updates the Zustand store, triggering solver recomputation and overlay rebuild.

**Heading handle (manual mode):** A second draggable marker placed at a fixed pixel distance from touchdown. On drag, computes bearing from touchdown to handle position and calls `onHeadingChange(headingDeg)`.

**View fitting:** On initial render and when waypoints move significantly, the map auto-fits to show all relevant points with 48px padding and a maximum zoom of 16.

### Map tile resolution

```typescript
// mapStyle.ts
export function resolveMapStyle(): StyleSpecification | string {
  const token = import.meta.env.VITE_MAPBOX_TOKEN;
  if (token) return `mapbox://styles/mapbox/satellite-v9?access_token=${token}`;
  return esriSatelliteStyle();  // Tokenless default
}

export function resolveMapFallbackStyle(): StyleSpecification {
  return osmFallbackStyle();    // OpenStreetMap raster
}
```

Priority: Mapbox (if `VITE_MAPBOX_TOKEN` set) → Esri satellite (default) → OSM (error fallback).

## iOS Rendering Pipeline

### Step 1: Solver invocation

In `LandingStore.swift`, solver output is computed as `@Published` computed properties:

```swift
var patternOutput: PatternOutput {
    computePattern(patternInput)
}

var wingsuitAutoOutput: WingsuitAutoOutput {
    solveWingsuitAuto(wingsuitAutoInput)
}
```

SwiftUI observes changes to the `@Published` inputs and re-renders the map view.

### Step 2: MapKit rendering

`MapKitLandingMapView.swift` (`UIViewRepresentable`) manages:

| Element | MapKit API | Description |
|---------|-----------|-------------|
| Pattern polyline | `MKPolyline` overlay | Green line through all waypoints |
| Direction arrows | `MKPolyline` overlays | Per-segment flow indicators |
| Waypoint annotations | `MKAnnotation` subclass | Circle + altitude label |
| Touchdown marker | `MKAnnotationView` (draggable) | Drag triggers `onTouchdownChange` |
| Heading handle | Custom annotation (draggable) | Constrained circular drag around touchdown |
| Auto overlays | `MKPolygon` / `MKPolyline` | Zones, jump-run, route |

### Step 3: Overlay rendering

MapKit delegates handle visual styling via `MKMapViewDelegate.rendererForOverlay`:

- Pattern polylines: green stroke, matching web appearance
- Zone polygons: colored fills with varying opacity for feasible region, jump-run corridor, min deploy radius, and wind no-deploy half-disk
- Arrow overlays: short line segments with chevron end caps

### Step 4: Interaction handling

MapKit uses its built-in annotation dragging:
- Touchdown annotation: `isDraggable = true`, drag end updates `LandingStore`
- Heading handle: custom `UIPanGestureRecognizer` computes bearing from touchdown
- Auto mode landing point: draggable landing annotation updates `LandingStore`
- Jump-run endpoints: not draggable; the line is rendered from `resolvedJumpRun`

### Map basemap

MapKit uses `mapType: .satellite` by default. The app declares two `MapStackChoice` options:
- `.mapKit` — Apple MapKit with satellite imagery
- `.mapbox` — declared but Mapbox implementation is not yet built

## Color Scheme Reference

| Feature | Web Color | Opacity | Usage |
|---------|-----------|---------|-------|
| Pattern line | `#16a34a` (green-600) | 100% | Main flight path |
| Route line (auto) | `#16a34a` (green-600) | 100% | Wingsuit route |
| Heading guide | `#f59e0b` (amber-500) | 100% | Landing direction indicator |
| Landing link | `#f59e0b` (amber-500) | 100% | Deploy → landing dashed line |
| Jump-run line | `#38bdf8` (sky-400) | 100% | Aircraft path |
| Jump-run slot | `#38bdf8` / `#e0f2fe` | 100% | Slot circles + halos |
| Forbidden corridor | `#dc2626` (red-600) | 16% fill | Jump-run exclusion zone |
| Corridor outline | `#ef4444` (red-500) | 100% | Dashed outline |
| No-deploy circle | `#f59e0b` (amber-500) | 8% fill | Minimum deploy radius |
| Wind no-deploy zone | `#f97316` (orange-500) | 18% fill | Downwind half-disk |
| Feasible region | `#16a34a` (green-600) | 20% fill | Valid deploy area |
| Direction arrows | `#ffffff` | 90% | Segment flow indicators |
| Waypoint labels | `#e0f2fe` (sky-100) | 100% | White text with dark halo |

## Data Flow Summary

```
┌─────────────────────────────────────────────────────────┐
│ User adjusts controls (heading, wind, side, etc.)       │
│     │                                                    │
│     ▼                                                    │
│ Store update (Zustand / @Published)                      │
│     │                                                    │
│     ▼                                                    │
│ Solver recomputes (useMemo / computed property)          │
│     │                                                    │
│     ├── PatternOutput (manual) ──┐                       │
│     │                            │                       │
│     └── WingsuitAutoOutput ──────┤                       │
│                                  ▼                       │
│                      Build GeoJSON features              │
│                      (buildManualOverlayFeatures /       │
│                       buildAutoOverlayFeatures)          │
│                                  │                       │
│                                  ▼                       │
│                      Update map source data              │
│                      (setData on overlay-source)         │
│                                  │                       │
│                                  ▼                       │
│                      MapLibre / MapKit renders           │
│                      layers from feature filters         │
└─────────────────────────────────────────────────────────┘
```

All map updates are **synchronous and frame-immediate** — there is no debouncing or batching beyond what the map library provides internally. The solver is pure and stateless: same input always produces the same output, enabling trivial testing and reproducibility.
