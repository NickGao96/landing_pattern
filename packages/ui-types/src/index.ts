export type PatternSide = "left" | "right";

export type SegmentName = "downwind" | "base" | "final";

export interface WindLayer {
  altitudeFt: number;
  speedKt: number;
  dirFromDeg: number;
  source: "auto" | "manual";
}

export interface CanopyProfile {
  manufacturer: string;
  model: string;
  sizeSqft: number;
  wlRef: number;
  airspeedRefKt: number;
  airspeedWlExponent?: number;
  airspeedMinKt?: number;
  airspeedMaxKt?: number;
  glideRatio: number;
  sourceUrl?: string;
  confidence?: "low" | "medium" | "high";
}

export interface JumperInput {
  exitWeightLb: number;
  canopyAreaSqft: number;
}

export interface PatternInput {
  touchdownLat: number;
  touchdownLng: number;
  landingHeadingDeg: number;
  side: PatternSide;
  baseLegDrift?: boolean;
  gatesFt: [number, number, number, number];
  winds: WindLayer[];
  canopy: CanopyProfile;
  jumper: JumperInput;
}

export interface PatternWaypoint {
  name: "downwind_start" | "base_start" | "final_start" | "touchdown";
  lat: number;
  lng: number;
  altFt: number;
}

export interface SegmentOutput {
  name: SegmentName;
  headingDeg: number;
  trackHeadingDeg: number;
  alongLegSpeedKt: number;
  groundSpeedKt: number;
  timeSec: number;
  distanceFt: number;
}

export interface PatternOutput {
  waypoints: PatternWaypoint[];
  segments: SegmentOutput[];
  metrics: {
    wingLoading: number;
    estAirspeedKt: number;
    estSinkFps: number;
  };
  warnings: string[];
  blocked: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface SurfaceWind {
  speedKt: number;
  dirFromDeg: number;
  source: "observation" | "forecast" | "manual" | "open-meteo";
  observationTime?: string;
}
