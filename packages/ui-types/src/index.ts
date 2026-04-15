export type PatternSide = "left" | "right";
export type FlightMode = "canopy" | "wingsuit";
export type WingsuitPresetId = "swift" | "atc" | "freak" | "aura" | "custom";

export type SegmentName = "downwind" | "base" | "final";
export type WingsuitAutoWaypointName = "landing" | "deploy" | "turn2" | "turn1" | "exit";

export interface WindLayer {
  altitudeFt: number;
  speedKt: number;
  dirFromDeg: number;
  source: "auto" | "manual";
}

export interface GeoPoint {
  lat: number;
  lng: number;
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

export interface WingsuitProfile {
  presetId?: WingsuitPresetId;
  name: string;
  flightSpeedKt: number;
  fallRateFps: number;
}

export interface PatternInput {
  mode: FlightMode;
  touchdownLat: number;
  touchdownLng: number;
  landingHeadingDeg: number;
  side: PatternSide;
  baseLegDrift?: boolean;
  gatesFt: [number, number, number, number];
  winds: WindLayer[];
  canopy: CanopyProfile;
  jumper: JumperInput;
  wingsuit: WingsuitProfile;
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
    wingLoading: number | null;
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

export interface JumpRunLine {
  start: GeoPoint;
  end: GeoPoint;
}

export type WingsuitAutoJumpRunDirectionMode = "auto" | "manual";
export type WingsuitAutoJumpRunConstraintMode = "none" | "reciprocal";
export type WingsuitAutoJumpRunHeadingSource = "auto-headwind" | "manual";

export interface WingsuitAutoJumpRunAssumptions {
  planeAirspeedKt?: number;
  /**
   * One-based wingsuit exit group number. The historical field name is kept for
   * persisted settings; a value of 4 means the wingsuit slot exits fourth.
   */
  groupCount?: number;
  groupSeparationFt?: number;
  slickDeployHeightFt?: number;
  slickFallRateFps?: number;
  slickReturnRadiusFt?: number;
}

export interface WingsuitAutoJumpRunConfig {
  directionMode?: WingsuitAutoJumpRunDirectionMode;
  manualHeadingDeg?: number;
  constraintMode?: WingsuitAutoJumpRunConstraintMode;
  constraintHeadingDeg?: number;
  assumptions?: WingsuitAutoJumpRunAssumptions;
}

export interface WingsuitAutoTurnRatios {
  turn1: number;
  turn2: number;
}

export interface WingsuitAutoTuning {
  corridorHalfWidthFt?: number;
  deployBearingStepDeg?: number;
  deployRadiusStepFt?: number;
  deployBearingWindowHalfDeg?: number;
  maxDeployRadiusFt?: number;
  maxFirstLegTrackDeltaDeg?: number;
  minDeployRadiusFt?: number;
  refinementIterations?: number;
  exitOnJumpRunToleranceFt?: number;
}

export interface WingsuitAutoInput {
  landingPoint: GeoPoint;
  jumpRun: WingsuitAutoJumpRunConfig;
  side: PatternSide;
  exitHeightFt: number;
  deployHeightFt: number;
  winds: WindLayer[];
  wingsuit: WingsuitProfile;
  turnRatios?: WingsuitAutoTurnRatios;
  tuning?: WingsuitAutoTuning;
}

export interface WingsuitAutoWaypoint extends GeoPoint {
  name: WingsuitAutoWaypointName;
  altFt: number;
}

export interface ResolvedJumpRunSlot extends GeoPoint {
  label: string;
  index: number;
  kind: "group" | "wingsuit";
  altFt: number;
}

export interface ResolvedJumpRun {
  line: JumpRunLine;
  headingDeg: number;
  lengthFt: number;
  crosswindOffsetFt: number;
  planeGroundSpeedKt: number;
  groupSpacingFt: number;
  groupSpacingSec: number;
  slots: ResolvedJumpRunSlot[];
}

export interface RadiusBand {
  bearingDeg: number;
  minRadiusFt: number;
  maxRadiusFt: number;
}

export interface WingsuitAutoDiagnostics {
  headingSource: WingsuitAutoJumpRunHeadingSource | null;
  constrainedHeadingApplied: boolean;
  resolvedHeadingDeg: number | null;
  headwindComponentKt: number | null;
  crosswindComponentKt: number | null;
  crosswindOffsetFt: number | null;
  firstSlickReturnMarginFt: number | null;
  lastSlickReturnMarginFt: number | null;
  preferredDeployBearingDeg: number | null;
  selectedDeployBearingDeg: number | null;
  selectedDeployRadiusFt: number | null;
  exitToJumpRunErrorFt: number | null;
  deployRadiusMarginFt: number | null;
  firstLegTrackDeltaDeg: number | null;
  corridorMarginFt: number | null;
  turnHeightsFt: [number, number] | null;
  failureReason: string | null;
}

export interface WingsuitAutoOutput {
  blocked: boolean;
  warnings: string[];
  landingPoint: WingsuitAutoWaypoint;
  resolvedJumpRun: ResolvedJumpRun | null;
  deployPoint: WingsuitAutoWaypoint | null;
  exitPoint: WingsuitAutoWaypoint | null;
  turnPoints: WingsuitAutoWaypoint[];
  routeWaypoints: WingsuitAutoWaypoint[];
  routeSegments: SegmentOutput[];
  landingNoDeployZonePolygon: GeoPoint[];
  downwindDeployForbiddenZonePolygon: GeoPoint[];
  forbiddenZonePolygon: GeoPoint[];
  feasibleDeployRegionPolygon: GeoPoint[];
  deployBandsByBearing: RadiusBand[];
  diagnostics: WingsuitAutoDiagnostics;
}
