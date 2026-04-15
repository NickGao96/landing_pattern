import { useEffect, useMemo, useRef, useState } from "react";
import type { GeoPoint, PatternWaypoint, ResolvedJumpRun, WindLayer, WingsuitAutoWaypoint } from "@landing/ui-types";
import { resolveMapFallbackStyle, resolveMapStyle } from "../lib/mapStyle";
import type { Language } from "../store";

type MapLibreMap = import("maplibre-gl").Map;
type MapLibreMarker = import("maplibre-gl").Marker;
type MapLibreLayer = Parameters<MapLibreMap["addLayer"]>[0];

interface ManualMapPanelProps {
  variant: "manual";
  language: Language;
  touchdown: GeoPoint;
  waypoints: PatternWaypoint[];
  blocked: boolean;
  hasWarnings: boolean;
  landingHeadingDeg: number;
  windLayers: WindLayer[];
  onTouchdownChange: (lat: number, lng: number) => void;
  onHeadingChange: (headingDeg: number) => void;
}

interface AutoMapPanelProps {
  variant: "auto";
  language: Language;
  landingPoint: GeoPoint;
  resolvedJumpRun: ResolvedJumpRun | null;
  routeWaypoints: WingsuitAutoWaypoint[];
  landingNoDeployZonePolygon: GeoPoint[];
  downwindDeployForbiddenZonePolygon: GeoPoint[];
  forbiddenZonePolygon: GeoPoint[];
  feasibleDeployRegionPolygon: GeoPoint[];
  blocked: boolean;
  hasWarnings: boolean;
  windLayers: WindLayer[];
  onLandingPointChange: (lat: number, lng: number) => void;
}

type MapPanelProps = ManualMapPanelProps | AutoMapPanelProps;

const overlaySourceId = "overlay-source";
const headingHandleDistanceMeters = 180;
const headingHandleDistancePixels = 56;
const fitPaddingPixels = 48;
const minViewportFraction = 0.2;
const earthRadiusMeters = 6_371_000;

const mapTexts: Record<
  Language,
  {
    mapDisabledHeadless: string;
    touchdown: string;
    landingPoint: string;
    mapFallbackActive: string;
    windLayers: string;
    autoOverlays: string;
    headwindNoDeployZone: string;
    jumpRunCorridor: string;
    wingsuitRoute: string;
    from: string;
  }
> = {
  en: {
    mapDisabledHeadless: "Map disabled in test/headless mode.",
    touchdown: "Touchdown",
    landingPoint: "Landing Point",
    mapFallbackActive: "Map fallback active",
    windLayers: "Wind Layers",
    autoOverlays: "Auto Overlays",
    headwindNoDeployZone: "Headwind no-deploy zone",
    jumpRunCorridor: "Jump-run corridor",
    wingsuitRoute: "Wingsuit route",
    from: "from",
  },
  zh: {
    mapDisabledHeadless: "测试/无头模式下地图已禁用。",
    touchdown: "着陆点",
    landingPoint: "着陆点",
    mapFallbackActive: "地图回退样式已启用",
    windLayers: "分层风",
    autoOverlays: "自动图层",
    headwindNoDeployZone: "迎风禁开伞半区",
    jumpRunCorridor: "航线走廊",
    wingsuitRoute: "翼装航线",
    from: "来自",
  },
};

function isHeadlessEnvironment(): boolean {
  if (typeof navigator === "undefined") {
    return true;
  }
  return /jsdom/i.test(navigator.userAgent);
}

function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

function destinationPoint(
  latDeg: number,
  lngDeg: number,
  bearingDeg: number,
  distanceMeters: number,
): GeoPoint {
  const bearing = toRadians(normalizeHeading(bearingDeg));
  const lat1 = toRadians(latDeg);
  const lng1 = toRadians(lngDeg);
  const angularDistance = distanceMeters / earthRadiusMeters;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAngular = Math.sin(angularDistance);
  const cosAngular = Math.cos(angularDistance);

  const lat2 = Math.asin(sinLat1 * cosAngular + cosLat1 * sinAngular * Math.cos(bearing));
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * sinAngular * cosLat1,
      cosAngular - sinLat1 * Math.sin(lat2),
    );

  return {
    lat: toDegrees(lat2),
    lng: toDegrees(lng2),
  };
}

function headingFromPoints(from: GeoPoint, to: GeoPoint): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const deltaLng = toRadians(to.lng - from.lng);

  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  return normalizeHeading(toDegrees(Math.atan2(y, x)));
}

function interpolatePoint(from: GeoPoint, to: GeoPoint, t: number): GeoPoint {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    lat: from.lat + (to.lat - from.lat) * clamped,
    lng: from.lng + (to.lng - from.lng) * clamped,
  };
}

function closePolygon(points: GeoPoint[]): Array<[number, number]> {
  if (points.length === 0) {
    return [];
  }

  const closed = points.map((point) => [point.lng, point.lat] as [number, number]);
  const first = closed[0];
  if (!first) {
    return closed;
  }
  closed.push(first);
  return closed;
}

function labelForAutoWaypoint(name: WingsuitAutoWaypoint["name"]): string {
  switch (name) {
    case "landing":
      return "LND";
    case "deploy":
      return "DEP";
    case "turn2":
      return "T2";
    case "turn1":
      return "T1";
    case "exit":
      return "EXIT";
    default:
      return String(name).toUpperCase();
  }
}

function buildManualOverlayFeatures(
  touchdown: GeoPoint,
  waypoints: PatternWaypoint[],
  landingHeadingDeg: number,
  headingHandle?: GeoPoint,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  if (waypoints.length >= 2) {
    features.push({
      type: "Feature",
      properties: { kind: "pattern-line" },
      geometry: {
        type: "LineString",
        coordinates: waypoints.map((waypoint) => [waypoint.lng, waypoint.lat]),
      },
    });

    for (let index = 0; index < waypoints.length - 1; index += 1) {
      const start = waypoints[index];
      const end = waypoints[index + 1];
      if (!start || !end) {
        continue;
      }
      const heading = headingFromPoints(start, end);
      const tip = interpolatePoint(start, end, 0.62);
      const shaftStart = destinationPoint(tip.lat, tip.lng, heading + 180, 38);
      const leftWing = destinationPoint(tip.lat, tip.lng, heading + 155, 20);
      const rightWing = destinationPoint(tip.lat, tip.lng, heading - 155, 20);

      features.push({
        type: "Feature",
        properties: { kind: "pattern-direction-shaft" },
        geometry: {
          type: "LineString",
          coordinates: [
            [shaftStart.lng, shaftStart.lat],
            [tip.lng, tip.lat],
          ],
        },
      });

      features.push({
        type: "Feature",
        properties: { kind: "pattern-direction-head" },
        geometry: {
          type: "LineString",
          coordinates: [
            [leftWing.lng, leftWing.lat],
            [tip.lng, tip.lat],
            [rightWing.lng, rightWing.lat],
          ],
        },
      });
    }
  }

  for (const waypoint of waypoints) {
    const isTouchdown = waypoint.name === "touchdown";
    const label = isTouchdown ? "TD" : `${Math.round(waypoint.altFt)} ft`;
    features.push({
      type: "Feature",
      properties: { kind: "manual-waypoint", label },
      geometry: {
        type: "Point",
        coordinates: [waypoint.lng, waypoint.lat],
      },
    });
  }

  const headingTip =
    headingHandle ??
    destinationPoint(
      touchdown.lat,
      touchdown.lng,
      landingHeadingDeg,
      headingHandleDistanceMeters,
    );

  features.push({
    type: "Feature",
    properties: { kind: "heading-guide" },
    geometry: {
      type: "LineString",
      coordinates: [
        [touchdown.lng, touchdown.lat],
        [headingTip.lng, headingTip.lat],
      ],
    },
  });

  const headingArrowLeft = destinationPoint(headingTip.lat, headingTip.lng, landingHeadingDeg + 155, 18);
  const headingArrowRight = destinationPoint(headingTip.lat, headingTip.lng, landingHeadingDeg - 155, 18);
  features.push({
    type: "Feature",
    properties: { kind: "heading-guide-arrow" },
    geometry: {
      type: "LineString",
      coordinates: [
        [headingArrowLeft.lng, headingArrowLeft.lat],
        [headingTip.lng, headingTip.lat],
        [headingArrowRight.lng, headingArrowRight.lat],
      ],
    },
  });

  return {
    type: "FeatureCollection",
    features,
  };
}

function buildAutoOverlayFeatures(props: AutoMapPanelProps): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  if (props.forbiddenZonePolygon.length >= 3) {
    features.push({
      type: "Feature",
      properties: { kind: "forbidden-zone" },
      geometry: {
        type: "Polygon",
        coordinates: [closePolygon(props.forbiddenZonePolygon)],
      },
    });
  }

  if (props.landingNoDeployZonePolygon.length >= 3) {
    features.push({
      type: "Feature",
      properties: { kind: "landing-no-deploy-zone" },
      geometry: {
        type: "Polygon",
        coordinates: [closePolygon(props.landingNoDeployZonePolygon)],
      },
    });
  }

  if (props.downwindDeployForbiddenZonePolygon.length >= 3) {
    features.push({
      type: "Feature",
      properties: { kind: "downwind-deploy-forbidden-zone" },
      geometry: {
        type: "Polygon",
        coordinates: [closePolygon(props.downwindDeployForbiddenZonePolygon)],
      },
    });
  }

  // Forward auto mode currently returns sparse sampled deploy bands, not a
  // reliable continuous contour. Keep that diagnostic out of the map until the
  // solver emits a proper visible envelope.

  if (props.resolvedJumpRun) {
    features.push({
      type: "Feature",
      properties: { kind: "jump-run" },
      geometry: {
        type: "LineString",
        coordinates: [
          [props.resolvedJumpRun.line.start.lng, props.resolvedJumpRun.line.start.lat],
          [props.resolvedJumpRun.line.end.lng, props.resolvedJumpRun.line.end.lat],
        ],
      },
    });

    const jumpRunHeadingDeg = headingFromPoints(props.resolvedJumpRun.line.start, props.resolvedJumpRun.line.end);
    const jumpRunArrowTip = interpolatePoint(props.resolvedJumpRun.line.start, props.resolvedJumpRun.line.end, 0.6);
    const jumpRunArrowTail = destinationPoint(
      jumpRunArrowTip.lat,
      jumpRunArrowTip.lng,
      jumpRunHeadingDeg + 180,
      60,
    );
    const jumpRunArrowLeft = destinationPoint(jumpRunArrowTip.lat, jumpRunArrowTip.lng, jumpRunHeadingDeg + 155, 32);
    const jumpRunArrowRight = destinationPoint(jumpRunArrowTip.lat, jumpRunArrowTip.lng, jumpRunHeadingDeg - 155, 32);
    features.push({
      type: "Feature",
      properties: { kind: "jump-run-arrow-shaft" },
      geometry: {
        type: "LineString",
        coordinates: [
          [jumpRunArrowTail.lng, jumpRunArrowTail.lat],
          [jumpRunArrowTip.lng, jumpRunArrowTip.lat],
        ],
      },
    });
    features.push({
      type: "Feature",
      properties: { kind: "jump-run-arrow-head" },
      geometry: {
        type: "LineString",
        coordinates: [
          [jumpRunArrowLeft.lng, jumpRunArrowLeft.lat],
          [jumpRunArrowTip.lng, jumpRunArrowTip.lat],
          [jumpRunArrowRight.lng, jumpRunArrowRight.lat],
        ],
      },
    });

    for (const slot of props.resolvedJumpRun.slots) {
      features.push({
        type: "Feature",
        properties: { kind: "jump-run-slot", label: slot.label },
        geometry: {
          type: "Point",
          coordinates: [slot.lng, slot.lat],
        },
      });
    }
  }

  if (props.routeWaypoints.length >= 2) {
    features.push({
      type: "Feature",
      properties: { kind: "route-line" },
      geometry: {
        type: "LineString",
        coordinates: props.routeWaypoints.map((waypoint) => [waypoint.lng, waypoint.lat]),
      },
    });
  }

  const deployPoint = props.routeWaypoints[props.routeWaypoints.length - 1];
  if (deployPoint) {
    features.push({
      type: "Feature",
      properties: { kind: "landing-link" },
      geometry: {
        type: "LineString",
        coordinates: [
          [deployPoint.lng, deployPoint.lat],
          [props.landingPoint.lng, props.landingPoint.lat],
        ],
      },
    });
  }

  const labeledPoints: WingsuitAutoWaypoint[] = [
    {
      name: "landing",
      lat: props.landingPoint.lat,
      lng: props.landingPoint.lng,
      altFt: 0,
    },
    ...props.routeWaypoints,
  ];

  for (const waypoint of labeledPoints) {
    features.push({
      type: "Feature",
      properties: {
        kind: "auto-waypoint",
        label: labelForAutoWaypoint(waypoint.name),
      },
      geometry: {
        type: "Point",
        coordinates: [waypoint.lng, waypoint.lat],
      },
    });
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

function headingHandlePointForView(
  map: MapLibreMap,
  touchdown: GeoPoint,
  landingHeadingDeg: number,
): GeoPoint {
  const touchdownPoint = map.project([touchdown.lng, touchdown.lat]);
  const bearingRad = toRadians(normalizeHeading(landingHeadingDeg));
  const handlePoint = {
    x: touchdownPoint.x + Math.sin(bearingRad) * headingHandleDistancePixels,
    y: touchdownPoint.y - Math.cos(bearingRad) * headingHandleDistancePixels,
  };
  const lngLat = map.unproject([handlePoint.x, handlePoint.y]);
  return { lat: lngLat.lat, lng: lngLat.lng };
}

function buildManualOverlayForCurrentView(
  map: MapLibreMap,
  touchdown: GeoPoint,
  waypoints: PatternWaypoint[],
  landingHeadingDeg: number,
): {
  headingPoint: GeoPoint;
  data: GeoJSON.FeatureCollection;
} {
  const headingPoint = headingHandlePointForView(map, touchdown, landingHeadingDeg);
  return {
    headingPoint,
    data: buildManualOverlayFeatures(touchdown, waypoints, landingHeadingDeg, headingPoint),
  };
}

function getManualFitPoints(touchdown: GeoPoint, waypoints: PatternWaypoint[]): GeoPoint[] {
  return [touchdown, ...waypoints.map((waypoint) => ({ lat: waypoint.lat, lng: waypoint.lng }))];
}

function getAutoFitPoints(props: AutoMapPanelProps): GeoPoint[] {
  return [
    props.landingPoint,
    ...(props.resolvedJumpRun ? [props.resolvedJumpRun.line.start, props.resolvedJumpRun.line.end] : []),
    ...(props.resolvedJumpRun?.slots.map((slot) => ({ lat: slot.lat, lng: slot.lng })) ?? []),
    ...props.routeWaypoints.map((waypoint) => ({ lat: waypoint.lat, lng: waypoint.lng })),
    ...props.landingNoDeployZonePolygon,
    ...props.downwindDeployForbiddenZonePolygon,
    ...props.forbiddenZonePolygon,
  ];
}

function shouldFitPointsInView(map: MapLibreMap, points: GeoPoint[]): boolean {
  if (points.length <= 1) {
    return false;
  }

  const canvas = map.getCanvas();
  const viewWidth = canvas.clientWidth;
  const viewHeight = canvas.clientHeight;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    const projected = map.project([point.lng, point.lat]);
    minX = Math.min(minX, projected.x);
    maxX = Math.max(maxX, projected.x);
    minY = Math.min(minY, projected.y);
    maxY = Math.max(maxY, projected.y);
  }

  const offscreen =
    minX < fitPaddingPixels ||
    maxX > viewWidth - fitPaddingPixels ||
    minY < fitPaddingPixels ||
    maxY > viewHeight - fitPaddingPixels;

  const underfilled =
    maxX - minX < viewWidth * minViewportFraction &&
    maxY - minY < viewHeight * minViewportFraction;

  return offscreen || underfilled;
}

function fitPointsInView(map: MapLibreMap, points: GeoPoint[], center: GeoPoint): void {
  if (points.length <= 1) {
    map.easeTo({ center: [center.lng, center.lat], zoom: 16, duration: 350 });
    return;
  }

  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minLng = Math.min(minLng, point.lng);
    maxLng = Math.max(maxLng, point.lng);
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
  }

  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    {
      padding: fitPaddingPixels,
      duration: 350,
      maxZoom: 16,
    },
  );
}

function addLayerIfMissing(map: MapLibreMap, layer: MapLibreLayer): void {
  if (!map.getLayer(layer.id)) {
    map.addLayer(layer);
  }
}

function ensureOverlayLayers(map: MapLibreMap, overlayData: GeoJSON.FeatureCollection): void {
  if (!map.getSource(overlaySourceId)) {
    map.addSource(overlaySourceId, {
      type: "geojson",
      data: overlayData,
    });
  }

  addLayerIfMissing(map, {
    id: "landing-no-deploy-zone",
    type: "fill",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "landing-no-deploy-zone"],
    paint: {
      "fill-color": "#f59e0b",
      "fill-opacity": 0.08,
    },
  });

  addLayerIfMissing(map, {
    id: "downwind-deploy-forbidden-zone",
    type: "fill",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "downwind-deploy-forbidden-zone"],
    paint: {
      "fill-color": "#f97316",
      "fill-opacity": 0.18,
    },
  });

  addLayerIfMissing(map, {
    id: "deploy-region",
    type: "fill",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "deploy-region"],
    paint: {
      "fill-color": "#16a34a",
      "fill-opacity": 0.2,
    },
  });

  addLayerIfMissing(map, {
    id: "forbidden-zone",
    type: "fill",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "forbidden-zone"],
    paint: {
      "fill-color": "#dc2626",
      "fill-opacity": 0.16,
    },
  });

  addLayerIfMissing(map, {
    id: "forbidden-zone-outline",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "forbidden-zone"],
    paint: {
      "line-color": "#ef4444",
      "line-width": 2,
      "line-dasharray": [2, 2],
    },
  });

  addLayerIfMissing(map, {
    id: "downwind-deploy-forbidden-zone-outline",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "downwind-deploy-forbidden-zone"],
    paint: {
      "line-color": "#fb923c",
      "line-width": 2.5,
      "line-opacity": 0.95,
      "line-dasharray": [3, 2],
    },
  });

  addLayerIfMissing(map, {
    id: "jump-run",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "jump-run"],
    paint: {
      "line-color": "#38bdf8",
      "line-width": 3,
      "line-dasharray": [2, 1],
    },
  });

  addLayerIfMissing(map, {
    id: "jump-run-arrow-shaft",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "jump-run-arrow-shaft"],
    paint: {
      "line-color": "#e0f2fe",
      "line-width": 2.5,
      "line-opacity": 0.95,
    },
  });

  addLayerIfMissing(map, {
    id: "jump-run-arrow-head",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "jump-run-arrow-head"],
    paint: {
      "line-color": "#e0f2fe",
      "line-width": 2.5,
      "line-opacity": 0.95,
    },
  });

  addLayerIfMissing(map, {
    id: "jump-run-slot-circle",
    type: "circle",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "jump-run-slot"],
    paint: {
      "circle-radius": 5,
      "circle-color": "#38bdf8",
      "circle-stroke-color": "#e0f2fe",
      "circle-stroke-width": 2,
    },
  });

  addLayerIfMissing(map, {
    id: "jump-run-slot-label",
    type: "symbol",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "jump-run-slot"],
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 12,
      "text-offset": [0, -1.2],
      "text-anchor": "top",
    },
    paint: {
      "text-color": "#e0f2fe",
      "text-halo-color": "#0f172a",
      "text-halo-width": 1,
    },
  });

  addLayerIfMissing(map, {
    id: "landing-link",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "landing-link"],
    paint: {
      "line-color": "#f59e0b",
      "line-width": 2,
      "line-dasharray": [1, 2],
    },
  });

  addLayerIfMissing(map, {
    id: "route-line",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "route-line"],
    paint: {
      "line-color": "#16a34a",
      "line-width": 4,
    },
  });

  addLayerIfMissing(map, {
    id: "pattern-line",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "pattern-line"],
    paint: {
      "line-color": "#16a34a",
      "line-width": 4,
    },
  });

  addLayerIfMissing(map, {
    id: "heading-guide",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "heading-guide"],
    paint: {
      "line-color": "#f59e0b",
      "line-width": 4,
      "line-dasharray": [2, 2],
    },
  });

  addLayerIfMissing(map, {
    id: "heading-guide-arrow",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "heading-guide-arrow"],
    paint: {
      "line-color": "#f59e0b",
      "line-width": 3,
    },
  });

  addLayerIfMissing(map, {
    id: "pattern-direction-shaft",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "pattern-direction-shaft"],
    paint: {
      "line-color": "#ffffff",
      "line-width": 2.5,
      "line-opacity": 0.9,
    },
  });

  addLayerIfMissing(map, {
    id: "pattern-direction-head",
    type: "line",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "pattern-direction-head"],
    paint: {
      "line-color": "#ffffff",
      "line-width": 2.5,
      "line-opacity": 0.9,
    },
  });

  addLayerIfMissing(map, {
    id: "manual-waypoint-circle",
    type: "circle",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "manual-waypoint"],
    paint: {
      "circle-radius": 5,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#111827",
      "circle-stroke-width": 2,
    },
  });

  addLayerIfMissing(map, {
    id: "manual-waypoint-label",
    type: "symbol",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "manual-waypoint"],
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 12,
      "text-offset": [0, -1.2],
      "text-anchor": "top",
    },
    paint: {
      "text-color": "#111827",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1,
    },
  });

  addLayerIfMissing(map, {
    id: "auto-waypoint-circle",
    type: "circle",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "auto-waypoint"],
    paint: {
      "circle-radius": 5,
      "circle-color": "#f8fafc",
      "circle-stroke-color": "#0f172a",
      "circle-stroke-width": 2,
    },
  });

  addLayerIfMissing(map, {
    id: "auto-waypoint-label",
    type: "symbol",
    source: overlaySourceId,
    filter: ["==", ["get", "kind"], "auto-waypoint"],
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 12,
      "text-offset": [0, -1.2],
      "text-anchor": "top",
    },
    paint: {
      "text-color": "#111827",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1,
    },
  });
}

function activeRouteColor(blocked: boolean, hasWarnings: boolean): string {
  if (blocked) {
    return "#b91c1c";
  }
  if (hasWarnings) {
    return "#d97706";
  }
  return "#16a34a";
}

export function MapPanel(props: MapPanelProps) {
  const t = mapTexts[props.language];
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mainMarkerRef = useRef<MapLibreMarker | null>(null);
  const headingMarkerRef = useRef<MapLibreMarker | null>(null);
  const fallbackStyleAppliedRef = useRef(false);
  const ignoreClickUntilMsRef = useRef(0);
  const propsRef = useRef<MapPanelProps>(props);
  const [mapError, setMapError] = useState<string | null>(null);
  propsRef.current = props;

  function getCurrentManualProps(): ManualMapPanelProps | null {
    const current = propsRef.current;
    return current.variant === "manual" ? current : null;
  }

  function getCurrentAutoProps(): AutoMapPanelProps | null {
    const current = propsRef.current;
    return current.variant === "auto" ? current : null;
  }

  const syncSignature = useMemo(
    () =>
      props.variant === "manual"
        ? JSON.stringify({
            touchdown: props.touchdown,
            waypoints: props.waypoints,
            landingHeadingDeg: props.landingHeadingDeg,
            blocked: props.blocked,
            hasWarnings: props.hasWarnings,
          })
        : JSON.stringify({
            landingPoint: props.landingPoint,
            resolvedJumpRun: props.resolvedJumpRun,
            routeWaypoints: props.routeWaypoints,
            landingNoDeployZonePolygon: props.landingNoDeployZonePolygon,
            downwindDeployForbiddenZonePolygon: props.downwindDeployForbiddenZonePolygon,
            forbiddenZonePolygon: props.forbiddenZonePolygon,
            feasibleDeployRegionPolygon: props.feasibleDeployRegionPolygon,
            blocked: props.blocked,
            hasWarnings: props.hasWarnings,
          }),
    [props],
  );

  function syncOverlay(map: MapLibreMap): void {
    if (propsRef.current.variant === "manual") {
      const overlay = buildManualOverlayForCurrentView(
        map,
        propsRef.current.touchdown,
        propsRef.current.waypoints,
        propsRef.current.landingHeadingDeg,
      );

      if (!map.getSource(overlaySourceId)) {
        ensureOverlayLayers(map, overlay.data);
      }

      const source = map.getSource(overlaySourceId) as import("maplibre-gl").GeoJSONSource | undefined;
      source?.setData(overlay.data);
      mainMarkerRef.current?.setLngLat([propsRef.current.touchdown.lng, propsRef.current.touchdown.lat]);
      headingMarkerRef.current?.setLngLat([overlay.headingPoint.lng, overlay.headingPoint.lat]);
      return;
    }

    const overlay = buildAutoOverlayFeatures(propsRef.current);
    if (!map.getSource(overlaySourceId)) {
      ensureOverlayLayers(map, overlay);
    }

    const source = map.getSource(overlaySourceId) as import("maplibre-gl").GeoJSONSource | undefined;
    source?.setData(overlay);
    mainMarkerRef.current?.setLngLat([propsRef.current.landingPoint.lng, propsRef.current.landingPoint.lat]);
  }

  useEffect(() => {
    if (!mapContainerRef.current || isHeadlessEnvironment()) {
      return;
    }

    let cancelled = false;

    async function initializeMap(): Promise<void> {
      try {
        const maplibregl = await import("maplibre-gl");
        if (cancelled || !mapContainerRef.current) {
          return;
        }

        const center: [number, number] =
          props.variant === "manual"
            ? [props.touchdown.lng, props.touchdown.lat]
            : [props.landingPoint.lng, props.landingPoint.lat];

        const map = new maplibregl.Map({
          container: mapContainerRef.current,
          style: resolveMapStyle(),
          center,
          zoom: 15,
        });

        map.on("error", (event) => {
          if (fallbackStyleAppliedRef.current) {
            return;
          }
          fallbackStyleAppliedRef.current = true;
          const reason = event.error instanceof Error ? event.error.message : "primary style load error";
          setMapError(reason);
          map.setStyle(resolveMapFallbackStyle());
        });

        map.on("load", () => {
          syncOverlay(map);
        });

        map.on("zoom", () => {
          syncOverlay(map);
        });

        map.on("click", (event) => {
          if (Date.now() < ignoreClickUntilMsRef.current) {
            return;
          }

          const currentManual = getCurrentManualProps();
          if (currentManual) {
            currentManual.onTouchdownChange(event.lngLat.lat, event.lngLat.lng);
            return;
          }

          const currentAuto = getCurrentAutoProps();
          currentAuto?.onLandingPointChange(event.lngLat.lat, event.lngLat.lng);
        });

        if (props.variant === "manual") {
          const touchdownMarker = new maplibregl.Marker({
            draggable: true,
            color: "#ef4444",
          })
            .setLngLat([props.touchdown.lng, props.touchdown.lat])
            .addTo(map);

          touchdownMarker.on("dragstart", () => {
            ignoreClickUntilMsRef.current = Date.now() + 400;
          });

          touchdownMarker.on("dragend", () => {
            ignoreClickUntilMsRef.current = Date.now() + 400;
            const lngLat = touchdownMarker.getLngLat();
            getCurrentManualProps()?.onTouchdownChange(lngLat.lat, lngLat.lng);
          });

          const headingPoint = destinationPoint(
            props.touchdown.lat,
            props.touchdown.lng,
            props.landingHeadingDeg,
            headingHandleDistanceMeters,
          );

          const headingMarker = new maplibregl.Marker({
            draggable: true,
            color: "#f59e0b",
          })
            .setLngLat([headingPoint.lng, headingPoint.lat])
            .addTo(map);

          const updateHeadingFromMarker = () => {
            ignoreClickUntilMsRef.current = Date.now() + 400;
            const current = getCurrentManualProps();
            if (!current) {
              return;
            }
            const lngLat = headingMarker.getLngLat();
            const heading = headingFromPoints(current.touchdown, {
              lat: lngLat.lat,
              lng: lngLat.lng,
            });
            current.onHeadingChange(heading);
          };

          headingMarker.on("dragstart", () => {
            ignoreClickUntilMsRef.current = Date.now() + 400;
          });
          headingMarker.on("drag", updateHeadingFromMarker);
          headingMarker.on("dragend", updateHeadingFromMarker);

          mainMarkerRef.current = touchdownMarker;
          headingMarkerRef.current = headingMarker;
        } else {
          const landingMarker = new maplibregl.Marker({
            draggable: true,
            color: "#ef4444",
          })
            .setLngLat([props.landingPoint.lng, props.landingPoint.lat])
            .addTo(map);

          landingMarker.on("dragstart", () => {
            ignoreClickUntilMsRef.current = Date.now() + 400;
          });

          landingMarker.on("dragend", () => {
            ignoreClickUntilMsRef.current = Date.now() + 400;
            const lngLat = landingMarker.getLngLat();
            getCurrentAutoProps()?.onLandingPointChange(lngLat.lat, lngLat.lng);
          });

          mainMarkerRef.current = landingMarker;
        }

        mapRef.current = map;
      } catch (error) {
        setMapError(String(error));
      }
    }

    void initializeMap();

    return () => {
      cancelled = true;
      mainMarkerRef.current?.remove();
      headingMarkerRef.current?.remove();
      mapRef.current?.remove();
      mainMarkerRef.current = null;
      headingMarkerRef.current = null;
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) {
      return;
    }

    const map = mapRef.current;
    const points =
      props.variant === "manual"
        ? getManualFitPoints(props.touchdown, props.waypoints)
        : getAutoFitPoints(props);

    if (shouldFitPointsInView(map, points)) {
      fitPointsInView(map, points, props.variant === "manual" ? props.touchdown : props.landingPoint);
    }

    syncOverlay(map);

    const color = activeRouteColor(props.blocked, props.hasWarnings);
    const routeLayerId = props.variant === "manual" ? "pattern-line" : "route-line";
    if (map.getLayer(routeLayerId)) {
      map.setPaintProperty(routeLayerId, "line-color", color);
    }
  }, [props.variant, syncSignature]);

  if (isHeadlessEnvironment()) {
    const point = props.variant === "manual" ? props.touchdown : props.landingPoint;
    const label = props.variant === "manual" ? t.touchdown : t.landingPoint;
    return (
      <div className="map-fallback" data-testid="map-fallback">
        <p>{t.mapDisabledHeadless}</p>
        <p>
          {label}: {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
        </p>
      </div>
    );
  }

  return (
    <div className="map-shell">
      {mapError ? <p className="map-warning">{t.mapFallbackActive}: {mapError}</p> : null}
      <div ref={mapContainerRef} className="map-container" />
      <div className="map-legend">
        <div className="map-legend-section">
          <h3>{t.windLayers}</h3>
        </div>
        {props.windLayers.map((layer, index) => (
          <div className="map-legend-row" key={`${index}-${layer.altitudeFt}`}>
            <span
              className="map-legend-arrow"
              style={{ transform: `rotate(${normalizeHeading(layer.dirFromDeg + 180)}deg)` }}
              aria-hidden
            >
              ↑
            </span>
            <span>{Math.round(layer.altitudeFt)} ft</span>
            <span>{layer.speedKt.toFixed(1)} kt</span>
            <span>{t.from} {Math.round(layer.dirFromDeg)}°</span>
          </div>
        ))}
        {props.variant === "auto" ? (
          <div className="map-legend-section">
            <h3>{t.autoOverlays}</h3>
            {props.downwindDeployForbiddenZonePolygon.length >= 3 ? (
              <div className="map-legend-overlay-row">
                <span className="map-legend-swatch swatch-headwind-no-deploy" aria-hidden />
                <span>{t.headwindNoDeployZone}</span>
              </div>
            ) : null}
            {props.forbiddenZonePolygon.length >= 3 ? (
              <div className="map-legend-overlay-row">
                <span className="map-legend-swatch swatch-jump-run-corridor" aria-hidden />
                <span>{t.jumpRunCorridor}</span>
              </div>
            ) : null}
            {props.routeWaypoints.length >= 2 ? (
              <div className="map-legend-overlay-row">
                <span className="map-legend-swatch swatch-wingsuit-route" aria-hidden />
                <span>{t.wingsuitRoute}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
