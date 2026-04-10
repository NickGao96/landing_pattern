import type { WindLayer } from "@landing/ui-types";

const FEET_PER_NAUTICAL_MILE = 6076.12;
const FEET_PER_DEG_LAT = 364000;

export interface Vec2 {
  east: number;
  north: number;
}

export function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function headingToUnitVector(headingDeg: number): Vec2 {
  const rad = (normalizeHeading(headingDeg) * Math.PI) / 180;
  return {
    east: Math.sin(rad),
    north: Math.cos(rad),
  };
}

export function windFromToGroundVector(speedKt: number, dirFromDeg: number): Vec2 {
  const toDeg = normalizeHeading(dirFromDeg + 180);
  const unit = headingToUnitVector(toDeg);
  return {
    east: unit.east * speedKt,
    north: unit.north * speedKt,
  };
}

export function magnitude(vec: Vec2): number {
  return Math.hypot(vec.east, vec.north);
}

export function addVec(a: Vec2, b: Vec2): Vec2 {
  return {
    east: a.east + b.east,
    north: a.north + b.north,
  };
}

export function scaleVec(vec: Vec2, scalar: number): Vec2 {
  return {
    east: vec.east * scalar,
    north: vec.north * scalar,
  };
}

export function unitOrZero(vec: Vec2): Vec2 {
  const mag = magnitude(vec);
  if (mag <= 1e-9) {
    return { east: 0, north: 0 };
  }
  return scaleVec(vec, 1 / mag);
}

export function knotsToFeetPerSecond(knots: number): number {
  return (knots * FEET_PER_NAUTICAL_MILE) / 3600;
}

export function feetPerSecondToKnots(fps: number): number {
  return (fps * 3600) / FEET_PER_NAUTICAL_MILE;
}

export function dot(a: Vec2, b: Vec2): number {
  return a.east * b.east + a.north * b.north;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpAngleDeg(a: number, b: number, t: number): number {
  const start = normalizeHeading(a);
  const end = normalizeHeading(b);
  const delta = ((end - start + 540) % 360) - 180;
  return normalizeHeading(start + delta * t);
}

export function getWindForAltitude(altitudeFt: number, winds: WindLayer[]): WindLayer | undefined {
  if (winds.length === 0) {
    return undefined;
  }

  const sorted = [...winds].sort((a, b) => b.altitudeFt - a.altitudeFt);
  const highest = sorted[0];
  const lowest = sorted[sorted.length - 1];
  if (!highest || !lowest) {
    return undefined;
  }

  for (const layer of sorted) {
    if (Math.abs(layer.altitudeFt - altitudeFt) < 1e-3) {
      return layer;
    }
  }

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const high = sorted[i];
    const low = sorted[i + 1];
    if (!high || !low) {
      continue;
    }
    if (altitudeFt <= high.altitudeFt && altitudeFt >= low.altitudeFt) {
      const span = high.altitudeFt - low.altitudeFt;
      if (span <= 0) {
        return high;
      }
      const t = (high.altitudeFt - altitudeFt) / span;
      return {
        altitudeFt,
        speedKt: lerp(high.speedKt, low.speedKt, t),
        dirFromDeg: lerpAngleDeg(high.dirFromDeg, low.dirFromDeg, t),
        source: "auto",
      };
    }
  }

  return altitudeFt > highest.altitudeFt ? highest : lowest;
}

export function localFeetToLatLng(
  refLat: number,
  refLng: number,
  eastFt: number,
  northFt: number,
): { lat: number; lng: number } {
  const lat = refLat + northFt / FEET_PER_DEG_LAT;
  const cosLat = Math.cos((refLat * Math.PI) / 180);
  const feetPerDegLng = FEET_PER_DEG_LAT * Math.max(cosLat, 1e-5);
  const lng = refLng + eastFt / feetPerDegLng;
  return { lat, lng };
}

export function latLngToLocalFeet(
  refLat: number,
  refLng: number,
  lat: number,
  lng: number,
): { eastFt: number; northFt: number } {
  const northFt = (lat - refLat) * FEET_PER_DEG_LAT;
  const cosLat = Math.cos((refLat * Math.PI) / 180);
  const feetPerDegLng = FEET_PER_DEG_LAT * Math.max(cosLat, 1e-5);
  const eastFt = (lng - refLng) * feetPerDegLng;
  return { eastFt, northFt };
}
