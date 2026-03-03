import { useEffect, useMemo, useRef, useState } from "react";
import type { PatternWaypoint, WindLayer } from "@landing/ui-types";
import { resolveMapFallbackStyle, resolveMapStyle } from "../lib/mapStyle";
import type { Language } from "../store";

interface MapPanelProps {
  language: Language;
  touchdown: { lat: number; lng: number };
  waypoints: PatternWaypoint[];
  blocked: boolean;
  hasWarnings: boolean;
  landingHeadingDeg: number;
  windLayers: WindLayer[];
  onTouchdownChange: (lat: number, lng: number) => void;
  onHeadingChange: (headingDeg: number) => void;
}

const overlaySourceId = "overlay-source";
const headingHandleDistanceMeters = 180;
const earthRadiusMeters = 6_371_000;
const mapTexts: Record<
  Language,
  {
    mapDisabledHeadless: string;
    touchdown: string;
    mapFallbackActive: string;
    windLayers: string;
    from: string;
  }
> = {
  en: {
    mapDisabledHeadless: "Map disabled in test/headless mode.",
    touchdown: "Touchdown",
    mapFallbackActive: "Map fallback active",
    windLayers: "Wind Layers",
    from: "from",
  },
  zh: {
    mapDisabledHeadless: "测试/无头模式下地图已禁用。",
    touchdown: "着陆点",
    mapFallbackActive: "地图回退样式已启用",
    windLayers: "分层风",
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
): { lat: number; lng: number } {
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

function headingFromPoints(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const deltaLng = toRadians(to.lng - from.lng);

  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  return normalizeHeading(toDegrees(Math.atan2(y, x)));
}

function interpolatePoint(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  t: number,
): { lat: number; lng: number } {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    lat: from.lat + (to.lat - from.lat) * clamped,
    lng: from.lng + (to.lng - from.lng) * clamped,
  };
}

function buildOverlayFeatures(
  touchdown: { lat: number; lng: number },
  waypoints: PatternWaypoint[],
  landingHeadingDeg: number,
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
      properties: { kind: "turn-point", label },
      geometry: {
        type: "Point",
        coordinates: [waypoint.lng, waypoint.lat],
      },
    });
  }

  const headingTip = destinationPoint(
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

function ensureOverlayLayers(map: import("maplibre-gl").Map, overlayData: GeoJSON.FeatureCollection): void {
  if (!map.getSource(overlaySourceId)) {
    map.addSource(overlaySourceId, {
      type: "geojson",
      data: overlayData,
    });
  }

  if (!map.getLayer("pattern-line")) {
    map.addLayer({
      id: "pattern-line",
      type: "line",
      source: overlaySourceId,
      filter: ["==", "kind", "pattern-line"],
      paint: {
        "line-color": "#16a34a",
        "line-width": 4,
      },
    });
  }

  if (!map.getLayer("heading-guide")) {
    map.addLayer({
      id: "heading-guide",
      type: "line",
      source: overlaySourceId,
      filter: ["==", "kind", "heading-guide"],
      paint: {
        "line-color": "#f59e0b",
        "line-width": 4,
        "line-dasharray": [2, 2],
      },
    });
  }

  if (!map.getLayer("heading-guide-arrow")) {
    map.addLayer({
      id: "heading-guide-arrow",
      type: "line",
      source: overlaySourceId,
      filter: ["==", "kind", "heading-guide-arrow"],
      paint: {
        "line-color": "#f59e0b",
        "line-width": 3,
      },
    });
  }

  if (!map.getLayer("pattern-direction-shaft")) {
    map.addLayer({
      id: "pattern-direction-shaft",
      type: "line",
      source: overlaySourceId,
      filter: ["==", "kind", "pattern-direction-shaft"],
      paint: {
        "line-color": "#ffffff",
        "line-width": 2.5,
        "line-opacity": 0.9,
      },
    });
  }

  if (!map.getLayer("pattern-direction-head")) {
    map.addLayer({
      id: "pattern-direction-head",
      type: "line",
      source: overlaySourceId,
      filter: ["==", "kind", "pattern-direction-head"],
      paint: {
        "line-color": "#ffffff",
        "line-width": 2.5,
        "line-opacity": 0.9,
      },
    });
  }

  if (!map.getLayer("turn-point-circle")) {
    map.addLayer({
      id: "turn-point-circle",
      type: "circle",
      source: overlaySourceId,
      filter: ["==", "kind", "turn-point"],
      paint: {
        "circle-radius": 5,
        "circle-color": "#ffffff",
        "circle-stroke-color": "#111827",
        "circle-stroke-width": 2,
      },
    });
  }

  if (!map.getLayer("turn-point-label")) {
    map.addLayer({
      id: "turn-point-label",
      type: "symbol",
      source: overlaySourceId,
      filter: ["==", "kind", "turn-point"],
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

}

export function MapPanel({
  language,
  touchdown,
  waypoints,
  blocked,
  hasWarnings,
  landingHeadingDeg,
  windLayers,
  onTouchdownChange,
  onHeadingChange,
}: MapPanelProps) {
  const t = mapTexts[language];
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import("maplibre-gl").Map | null>(null);
  const markerRef = useRef<import("maplibre-gl").Marker | null>(null);
  const headingMarkerRef = useRef<import("maplibre-gl").Marker | null>(null);
  const fallbackStyleAppliedRef = useRef(false);
  const touchdownRef = useRef(touchdown);
  const ignoreClickUntilMsRef = useRef(0);
  const [mapError, setMapError] = useState<string | null>(null);

  const overlayGeoJson = useMemo(
    () => buildOverlayFeatures(touchdown, waypoints, landingHeadingDeg),
    [touchdown, waypoints, landingHeadingDeg],
  );
  const overlayGeoJsonRef = useRef(overlayGeoJson);

  useEffect(() => {
    touchdownRef.current = touchdown;
  }, [touchdown]);

  useEffect(() => {
    overlayGeoJsonRef.current = overlayGeoJson;
  }, [overlayGeoJson]);

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

        const map = new maplibregl.Map({
          container: mapContainerRef.current,
          style: resolveMapStyle(),
          center: [touchdown.lng, touchdown.lat],
          zoom: 16,
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
          ensureOverlayLayers(map, overlayGeoJsonRef.current);
        });

        map.on("click", (event) => {
          if (Date.now() < ignoreClickUntilMsRef.current) {
            return;
          }
          onTouchdownChange(event.lngLat.lat, event.lngLat.lng);
        });

        const touchdownMarker = new maplibregl.Marker({
          draggable: true,
          color: "#ef4444",
        })
          .setLngLat([touchdown.lng, touchdown.lat])
          .addTo(map);

        touchdownMarker.on("dragstart", () => {
          ignoreClickUntilMsRef.current = Date.now() + 400;
        });

        touchdownMarker.on("dragend", () => {
          ignoreClickUntilMsRef.current = Date.now() + 400;
          const lngLat = touchdownMarker.getLngLat();
          onTouchdownChange(lngLat.lat, lngLat.lng);
        });

        const headingPoint = destinationPoint(
          touchdown.lat,
          touchdown.lng,
          landingHeadingDeg,
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
          const lngLat = headingMarker.getLngLat();
          const heading = headingFromPoints(touchdownRef.current, { lat: lngLat.lat, lng: lngLat.lng });
          onHeadingChange(heading);
        };

        headingMarker.on("dragstart", () => {
          ignoreClickUntilMsRef.current = Date.now() + 400;
        });
        headingMarker.on("drag", updateHeadingFromMarker);
        headingMarker.on("dragend", updateHeadingFromMarker);

        mapRef.current = map;
        markerRef.current = touchdownMarker;
        headingMarkerRef.current = headingMarker;
      } catch (error) {
        setMapError(String(error));
      }
    }

    void initializeMap();

    return () => {
      cancelled = true;
      markerRef.current?.remove();
      headingMarkerRef.current?.remove();
      mapRef.current?.remove();
      markerRef.current = null;
      headingMarkerRef.current = null;
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) {
      return;
    }

    const map = mapRef.current;
    markerRef.current?.setLngLat([touchdown.lng, touchdown.lat]);
    const headingPoint = destinationPoint(
      touchdown.lat,
      touchdown.lng,
      landingHeadingDeg,
      headingHandleDistanceMeters,
    );
    headingMarkerRef.current?.setLngLat([headingPoint.lng, headingPoint.lat]);

    map.easeTo({ center: [touchdown.lng, touchdown.lat], duration: 350 });

    const source = map.getSource(overlaySourceId) as import("maplibre-gl").GeoJSONSource | undefined;
    if (source) {
      source.setData(overlayGeoJson);
    }

    if (map.getLayer("pattern-line")) {
      map.setPaintProperty(
        "pattern-line",
        "line-color",
        blocked ? "#b91c1c" : hasWarnings ? "#d97706" : "#16a34a",
      );
    }
  }, [touchdown.lat, touchdown.lng, landingHeadingDeg, overlayGeoJson, blocked, hasWarnings]);

  if (isHeadlessEnvironment()) {
    return (
      <div className="map-fallback" data-testid="map-fallback">
        <p>{t.mapDisabledHeadless}</p>
        <p>
          {t.touchdown}: {touchdown.lat.toFixed(5)}, {touchdown.lng.toFixed(5)}
        </p>
      </div>
    );
  }

  return (
    <div className="map-shell">
      {mapError ? <p className="map-warning">{t.mapFallbackActive}: {mapError}</p> : null}
      <div ref={mapContainerRef} className="map-container" />
      <div className="map-legend">
        <h3>{t.windLayers}</h3>
        {windLayers.map((layer, index) => (
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
      </div>
    </div>
  );
}
