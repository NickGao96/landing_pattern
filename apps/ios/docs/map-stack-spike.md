# Map Stack Spike: MapKit vs Mapbox

## Required capabilities

1. Satellite basemap.
2. Draggable touchdown marker.
3. Draggable heading handle constrained around touchdown.
4. Polyline overlays + directional arrows.
5. Turn-point labels.
6. Stable interaction at 60fps on modern iPhone.
7. No blocking token/license dependency for baseline operation.

## Result

- **MapKit**: Pass on all checklist items for baseline V1.
- **Mapbox**: iOS integration is not implemented in current app build.

## Selection rule outcome

`MapStackEvaluator.defaultChoice(mapKitReport:mapboxReport:)` selects **MapKit** by default.

## Notes

- App UI is currently MapKit-only; Mapbox is intentionally hidden until implementation is complete.
- If MapKit behavior regresses in a future release, update this document with measured findings before enabling any alternate stack.
