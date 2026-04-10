import type {
  GeoPoint,
  FlightMode,
  JumpRunLine,
  PatternInput,
  PatternOutput,
  RadiusBand,
  ResolvedJumpRun,
  ResolvedJumpRunSlot,
  SegmentName,
  ValidationResult,
  WindLayer,
  WingsuitAutoInput,
  WingsuitAutoJumpRunAssumptions,
  WingsuitAutoJumpRunHeadingSource,
  WingsuitAutoOutput,
  WingsuitAutoTurnRatios,
  WingsuitAutoTuning,
  WingsuitAutoWaypoint,
  WingsuitAutoWaypointName,
} from "@landing/ui-types";
import {
  addVec,
  dot,
  getWindForAltitude,
  headingToUnitVector,
  knotsToFeetPerSecond,
  latLngToLocalFeet,
  localFeetToLatLng,
  magnitude,
  normalizeHeading,
  scaleVec,
  unitOrZero,
  windFromToGroundVector,
} from "./math";

const WL_MAX = 1.7;
const MIN_FINAL_FORWARD_GROUND_SPEED_KT = 5;
const AIRSPEED_MIN_KT = 8;
const AIRSPEED_MAX_KT = 35;
const EPSILON = 1e-6;
const AUTO_HEADING_COARSE_STEP_DEG = 5;
const AUTO_HEADING_FINE_SPAN_DEG = 4;

export const DEFAULT_WINGSUIT_AUTO_TURN_RATIOS: WingsuitAutoTurnRatios = {
  turn1: 0.75,
  turn2: 0.3125,
};

export const DEFAULT_WINGSUIT_AUTO_ASSUMPTIONS: Required<WingsuitAutoJumpRunAssumptions> = {
  planeAirspeedKt: 85,
  groupCount: 4,
  groupSeparationFt: 1500,
  slickDeployHeightFt: 3000,
  slickFallRateFps: 176,
  slickReturnRadiusFt: 5000,
};

export const DEFAULT_WINGSUIT_AUTO_TUNING: Required<WingsuitAutoTuning> = {
  corridorHalfWidthFt: 250,
  deployBearingStepDeg: 5,
  deployRadiusStepFt: 250,
  deployBearingWindowHalfDeg: 90,
  maxDeployRadiusFt: 6562,
  maxFirstLegTrackDeltaDeg: 45,
  minDeployRadiusFt: 500,
  refinementIterations: 3,
  exitOnJumpRunToleranceFt: 300,
};

const JUMP_RUN_SPOT_TABLE: Array<{ maxWindKt: number; offsetMiles: number }> = [
  { maxWindKt: 2.5, offsetMiles: 0 },
  { maxWindKt: 7.5, offsetMiles: 0.1 },
  { maxWindKt: 12.5, offsetMiles: 0.2 },
  { maxWindKt: 17.5, offsetMiles: 0.3 },
  { maxWindKt: 22.5, offsetMiles: 0.4 },
  { maxWindKt: 27.5, offsetMiles: 0.5 },
  { maxWindKt: 32.5, offsetMiles: 0.6 },
  { maxWindKt: Number.POSITIVE_INFINITY, offsetMiles: 0.7 },
];

const JUMP_RUN_CROSSWIND_TABLE: Array<{ maxWindKt: number; offsetMiles: number }> = [
  { maxWindKt: 2.5, offsetMiles: 0 },
  { maxWindKt: 7.5, offsetMiles: 0.05 },
  { maxWindKt: 12.5, offsetMiles: 0.1 },
  { maxWindKt: 17.5, offsetMiles: 0.15 },
  { maxWindKt: 22.5, offsetMiles: 0.2 },
  { maxWindKt: 27.5, offsetMiles: 0.25 },
  { maxWindKt: 32.5, offsetMiles: 0.3 },
  { maxWindKt: Number.POSITIVE_INFINITY, offsetMiles: 0.35 },
];

const AUTO_ROUTE_PLACEHOLDER_CANOPY: PatternInput["canopy"] = {
  manufacturer: "Auto Placeholder",
  model: "Auto Placeholder",
  sizeSqft: 170,
  wlRef: 1,
  airspeedRefKt: 20,
  glideRatio: 2.7,
};

const AUTO_ROUTE_PLACEHOLDER_JUMPER: PatternInput["jumper"] = {
  exitWeightLb: 170,
  canopyAreaSqft: 170,
};

interface LocalPoint {
  eastFt: number;
  northFt: number;
}

interface JumpRunFrame {
  start: LocalPoint;
  end: LocalPoint;
  unit: LocalPoint;
  leftUnit: LocalPoint;
  lengthFt: number;
}

interface CandidateEvaluation {
  landingHeadingDeg: number;
  bearingDeg: number;
  radiusFt: number;
  turnHeightsFt: [number, number];
  resolvedJumpRun: ResolvedJumpRun;
  deployPoint: WingsuitAutoWaypoint;
  exitPoint: WingsuitAutoWaypoint;
  turnPoints: WingsuitAutoWaypoint[];
  routeWaypoints: WingsuitAutoWaypoint[];
  routeSegments: PatternOutput["segments"];
  warnings: string[];
  exitToJumpRunErrorFt: number;
  firstSlickReturnMarginFt: number;
  lastSlickReturnMarginFt: number;
  corridorMarginFt: number;
  deployRadiusMarginFt: number;
  firstLegTrackDeltaDeg: number;
  exitAlongTargetErrorFt: number;
}

interface AutoGateCandidate {
  gatesFt: [number, number, number, number];
  turnHeightsFt: [number, number];
}

interface SegmentComputation {
  name: SegmentName;
  headingDeg: number;
  trackHeadingDeg: number;
  alongLegSpeedKt: number;
  groundVectorKt: { east: number; north: number };
  groundSpeedKt: number;
  timeSec: number;
  distanceFt: number;
}

interface SegmentSolveResult {
  segment: SegmentComputation | null;
  blockedReason?: string;
}

interface SegmentDefinition {
  name: SegmentName;
  headingDeg: number;
  startAltFt: number;
  endAltFt: number;
  solveKind: "drift" | "trackLocked";
}

interface ResolvedJumpRunPlan {
  resolved: ResolvedJumpRun;
  frame: JumpRunFrame;
  targetExitLocal: LocalPoint;
  jumpRunUnit: LocalPoint;
  groupSpacingFt: number;
  headingSource: WingsuitAutoJumpRunHeadingSource;
  constrainedHeadingApplied: boolean;
  headwindComponentKt: number;
  crosswindComponentKt: number;
  firstSlickReturnMarginFt: number;
  lastSlickReturnMarginFt: number;
  preferredSpotOffsetAlongFt: number;
  warnings: string[];
  blockedReason: string | null;
}

function resolveMode(input: PatternInput): FlightMode {
  return input.mode === "wingsuit" ? "wingsuit" : "canopy";
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function computeWingLoading(exitWeightLb: number, canopyAreaSqft: number): number {
  return exitWeightLb / canopyAreaSqft;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeAirspeedKt(input: Pick<PatternInput, "canopy">, wingLoading: number): number {
  const ratio = wingLoading / input.canopy.wlRef;
  const exponent = input.canopy.airspeedWlExponent ?? 0.5;
  const raw = input.canopy.airspeedRefKt * Math.pow(Math.max(ratio, 1e-6), exponent);
  const minKt = input.canopy.airspeedMinKt ?? AIRSPEED_MIN_KT;
  const maxKt = input.canopy.airspeedMaxKt ?? AIRSPEED_MAX_KT;
  return clamp(raw, minKt, maxKt);
}

function computeSinkFps(airspeedKt: number, glideRatio: number): number {
  const airspeedFps = knotsToFeetPerSecond(airspeedKt);
  return airspeedFps / glideRatio;
}

function computeLegHeading(landingHeadingDeg: number, side: "left" | "right", segment: SegmentName): number {
  if (segment === "final") {
    return normalizeHeading(landingHeadingDeg);
  }
  if (segment === "base") {
    return normalizeHeading(landingHeadingDeg + (side === "left" ? -90 : 90));
  }
  return normalizeHeading(landingHeadingDeg + 180);
}

function vectorToHeadingDeg(vector: { east: number; north: number }): number {
  return normalizeHeading((Math.atan2(vector.east, vector.north) * 180) / Math.PI);
}

function buildSegmentDefinitions(input: PatternInput): SegmentDefinition[] {
  const [downwindGate = 0, baseGate = 0, finalGate = 0, touchdownGate = 0] = input.gatesFt;
  const baseLegDrift = input.baseLegDrift !== false;

  return [
    {
      name: "downwind",
      headingDeg: computeLegHeading(input.landingHeadingDeg, input.side, "downwind"),
      startAltFt: downwindGate,
      endAltFt: baseGate,
      solveKind: "trackLocked",
    },
    {
      name: "base",
      headingDeg: computeLegHeading(input.landingHeadingDeg, input.side, "base"),
      startAltFt: baseGate,
      endAltFt: finalGate,
      solveKind: baseLegDrift ? "drift" : "trackLocked",
    },
    {
      name: "final",
      headingDeg: computeLegHeading(input.landingHeadingDeg, input.side, "final"),
      startAltFt: finalGate,
      endAltFt: touchdownGate,
      solveKind: "trackLocked",
    },
  ];
}

function getActiveSegmentDefinitions(input: PatternInput): SegmentDefinition[] {
  const mode = resolveMode(input);
  const definitions = buildSegmentDefinitions(input);

  if (mode === "canopy") {
    return definitions;
  }

  return definitions.filter((definition) => definition.startAltFt > definition.endAltFt);
}

function getRequiredWindAltitudes(input: PatternInput): number[] {
  return getActiveSegmentDefinitions(input).map((definition) => definition.startAltFt);
}

function findRequiredWinds(input: PatternInput, winds: WindLayer[]): string[] {
  const errors: string[] = [];
  for (const altitude of getRequiredWindAltitudes(input)) {
    const layer = getWindForAltitude(altitude, winds);
    if (!layer) {
      errors.push(`Missing wind layer around ${altitude} ft.`);
    }
  }
  return errors;
}

function computeDriftSegment(
  name: SegmentName,
  headingDeg: number,
  segmentStartAltFt: number,
  segmentEndAltFt: number,
  winds: WindLayer[],
  airspeedKt: number,
  sinkFps: number,
): SegmentSolveResult {
  const wind = getWindForAltitude(segmentStartAltFt, winds);
  const windVecKt = wind ? windFromToGroundVector(wind.speedKt, wind.dirFromDeg) : { east: 0, north: 0 };
  const airUnit = headingToUnitVector(headingDeg);
  const airVecKt = scaleVec(airUnit, airspeedKt);
  const groundVectorKt = addVec(airVecKt, windVecKt);

  const altitudeLoss = segmentStartAltFt - segmentEndAltFt;
  const timeSec = altitudeLoss / sinkFps;
  const groundSpeedKt = magnitude(groundVectorKt);
  if (groundSpeedKt < 0.1) {
    return {
      segment: null,
      blockedReason: `${name} leg has near-zero ground speed.`,
    };
  }
  const distanceFt = knotsToFeetPerSecond(groundSpeedKt) * timeSec;

  return {
    segment: {
      name,
      headingDeg,
      trackHeadingDeg: vectorToHeadingDeg(groundVectorKt),
      alongLegSpeedKt: dot(groundVectorKt, airUnit),
      groundVectorKt,
      groundSpeedKt,
      timeSec,
      distanceFt,
    },
  };
}

function computeTrackLockedSegment(
  name: SegmentName,
  trackHeadingDeg: number,
  segmentStartAltFt: number,
  segmentEndAltFt: number,
  winds: WindLayer[],
  airspeedKt: number,
  sinkFps: number,
): SegmentSolveResult {
  const wind = getWindForAltitude(segmentStartAltFt, winds);
  const windVecKt = wind ? windFromToGroundVector(wind.speedKt, wind.dirFromDeg) : { east: 0, north: 0 };
  const trackUnit = headingToUnitVector(trackHeadingDeg);
  const rightUnit = { east: trackUnit.north, north: -trackUnit.east };

  const windAlong = dot(windVecKt, trackUnit);
  const windCross = dot(windVecKt, rightUnit);

  if (Math.abs(windCross) >= airspeedKt) {
    return {
      segment: null,
      blockedReason: `${name} leg crosswind (${Math.abs(windCross).toFixed(1)} kt) exceeds airspeed capability.`,
    };
  }

  const airAlong = Math.sqrt(Math.max(airspeedKt * airspeedKt - windCross * windCross, 0));
  const groundAlong = airAlong + windAlong;
  if (Math.abs(groundAlong) < 0.1) {
    return {
      segment: null,
      blockedReason: `${name} leg has near-zero along-track ground speed.`,
    };
  }

  const airVecKt = addVec(scaleVec(trackUnit, airAlong), scaleVec(rightUnit, -windCross));
  const groundVectorKt = scaleVec(trackUnit, groundAlong);
  const altitudeLoss = segmentStartAltFt - segmentEndAltFt;
  const timeSec = altitudeLoss / sinkFps;
  const distanceFt = knotsToFeetPerSecond(Math.abs(groundAlong)) * timeSec;

  return {
    segment: {
      name,
      headingDeg: vectorToHeadingDeg(airVecKt),
      trackHeadingDeg,
      alongLegSpeedKt: groundAlong,
      groundVectorKt,
      groundSpeedKt: Math.abs(groundAlong),
      timeSec,
      distanceFt,
    },
  };
}

function defaultMetricsForMode(mode: FlightMode): PatternOutput["metrics"] {
  return {
    wingLoading: mode === "canopy" ? 0 : null,
    estAirspeedKt: 0,
    estSinkFps: 0,
  };
}

function getWaypointNameForSegment(name: SegmentName): "downwind_start" | "base_start" | "final_start" {
  if (name === "downwind") {
    return "downwind_start";
  }
  if (name === "base") {
    return "base_start";
  }
  return "final_start";
}

export function validatePatternInput(input: PatternInput): ValidationResult {
  const mode = resolveMode(input);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isFinite(input.touchdownLat) || !Number.isFinite(input.touchdownLng)) {
    errors.push("Touchdown location must be valid latitude/longitude values.");
  }

  if (!isFiniteNumber(input.landingHeadingDeg)) {
    errors.push("Landing heading must be a finite degree value.");
  }

  if (mode === "canopy") {
    if (
      !isFiniteNumber(input.jumper.exitWeightLb) ||
      !isFiniteNumber(input.jumper.canopyAreaSqft) ||
      input.jumper.exitWeightLb <= 0 ||
      input.jumper.canopyAreaSqft <= 0
    ) {
      errors.push("Exit weight and canopy area must be finite and positive.");
    }

    if (
      !isFiniteNumber(input.canopy.wlRef) ||
      !isFiniteNumber(input.canopy.airspeedRefKt) ||
      !isFiniteNumber(input.canopy.glideRatio) ||
      input.canopy.wlRef <= 0 ||
      input.canopy.airspeedRefKt <= 0 ||
      input.canopy.glideRatio <= 0
    ) {
      errors.push("Canopy reference values must be finite and positive.");
    }

    if (
      (input.canopy.airspeedWlExponent !== undefined && !isFiniteNumber(input.canopy.airspeedWlExponent)) ||
      (input.canopy.airspeedMinKt !== undefined && !isFiniteNumber(input.canopy.airspeedMinKt)) ||
      (input.canopy.airspeedMaxKt !== undefined && !isFiniteNumber(input.canopy.airspeedMaxKt))
    ) {
      errors.push("Canopy tuning values must be finite when provided.");
    }
  } else if (
    !isFiniteNumber(input.wingsuit?.flightSpeedKt) ||
    !isFiniteNumber(input.wingsuit?.fallRateFps) ||
    input.wingsuit.flightSpeedKt <= 0 ||
    input.wingsuit.fallRateFps <= 0
  ) {
    errors.push("Wingsuit flight speed and fall rate must be finite and positive.");
  }

  const [downwindGate, baseGate, finalGate, touchdownGate] = input.gatesFt;
  if (input.gatesFt.length !== 4) {
    errors.push("Gate altitudes must contain exactly 4 values.");
  } else if (input.gatesFt.some((gate) => !isFiniteNumber(gate))) {
    errors.push("Gate altitudes must be finite numeric values.");
  } else if (mode === "canopy") {
    if (!(downwindGate > baseGate && baseGate > finalGate && finalGate > touchdownGate)) {
      errors.push("Gate altitudes must be strictly descending, for example 900 > 600 > 300 > 0.");
    }
  } else {
    if (!(downwindGate >= baseGate && baseGate >= finalGate && finalGate > touchdownGate)) {
      errors.push("Wingsuit gate altitudes must be non-increasing with an active final leg, for example 3000 >= 2000 >= 1000 > 0.");
    }
    if (downwindGate === baseGate && baseGate === finalGate) {
      errors.push("Wingsuit mode requires at least two active legs. Only one of the first two legs may disappear.");
    }
  }

  if (touchdownGate !== 0) {
    warnings.push("Touchdown gate is expected to be 0 ft AGL in this model.");
  }

  for (const [index, wind] of input.winds.entries()) {
    if (!isFiniteNumber(wind.altitudeFt) || !isFiniteNumber(wind.speedKt) || !isFiniteNumber(wind.dirFromDeg)) {
      errors.push(`Wind layer values must be finite (index ${index}).`);
      continue;
    }
    if (wind.speedKt < 0) {
      errors.push(`Wind speed cannot be negative at ${wind.altitudeFt} ft.`);
    }
  }

  errors.push(...findRequiredWinds(input, input.winds));

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function computePattern(input: PatternInput): PatternOutput {
  const mode = resolveMode(input);
  const validation = validatePatternInput(input);
  const warnings: string[] = [...validation.warnings];

  if (!validation.valid) {
    return {
      waypoints: [
        {
          name: "touchdown",
          lat: input.touchdownLat,
          lng: input.touchdownLng,
          altFt: input.gatesFt[3] ?? input.gatesFt[input.gatesFt.length - 1] ?? 0,
        },
      ],
      segments: [],
      metrics: defaultMetricsForMode(mode),
      warnings: [...warnings, ...validation.errors],
      blocked: true,
    };
  }

  const wingLoading =
    mode === "canopy" ? computeWingLoading(input.jumper.exitWeightLb, input.jumper.canopyAreaSqft) : null;
  const airspeedKt = mode === "canopy" ? computeAirspeedKt(input, wingLoading ?? 0) : input.wingsuit.flightSpeedKt;
  const sinkFps = mode === "canopy" ? computeSinkFps(airspeedKt, input.canopy.glideRatio) : input.wingsuit.fallRateFps;

  if (mode === "canopy" && (wingLoading ?? 0) > WL_MAX) {
    warnings.push(
      `Wing loading ${(wingLoading ?? 0).toFixed(2)} exceeds model limit (${WL_MAX.toFixed(1)}). Pattern output is disabled.`,
    );
  }

  const activeDefinitions = getActiveSegmentDefinitions(input);
  const solvedSegments = activeDefinitions.map((definition) =>
    definition.solveKind === "drift"
      ? computeDriftSegment(
          definition.name,
          definition.headingDeg,
          definition.startAltFt,
          definition.endAltFt,
          input.winds,
          airspeedKt,
          sinkFps,
        )
      : computeTrackLockedSegment(
          definition.name,
          definition.headingDeg,
          definition.startAltFt,
          definition.endAltFt,
          input.winds,
          airspeedKt,
          sinkFps,
        ),
  );

  for (const result of solvedSegments) {
    if (result.blockedReason) {
      warnings.push(result.blockedReason);
    }
  }

  const activeSegments = solvedSegments
    .map((result) => result.segment)
    .filter((segment): segment is SegmentComputation => segment !== null);

  for (const segment of activeSegments) {
    if (segment.alongLegSpeedKt < 0) {
      warnings.push(`${segment.name[0]!.toUpperCase()}${segment.name.slice(1)} leg tracks backward (${segment.alongLegSpeedKt.toFixed(1)} kt).`);
    }
  }

  const finalSegment = activeSegments.find((segment) => segment.name === "final");
  const finalForwardSpeedKt = finalSegment ? finalSegment.alongLegSpeedKt : 0;
  if (finalForwardSpeedKt < MIN_FINAL_FORWARD_GROUND_SPEED_KT) {
    warnings.push(
      `Final-leg penetration is low (${finalForwardSpeedKt.toFixed(1)} kt along final). Consider a safer landing direction.`,
    );
  }

  const blocked =
    (mode === "canopy" && (wingLoading ?? 0) > WL_MAX) ||
    !Number.isFinite(sinkFps) ||
    sinkFps <= 0 ||
    activeSegments.length !== activeDefinitions.length;

  const metrics: PatternOutput["metrics"] = {
    wingLoading,
    estAirspeedKt: airspeedKt,
    estSinkFps: sinkFps,
  };

  if (blocked) {
    return {
      waypoints: [
        {
          name: "touchdown",
          lat: input.touchdownLat,
          lng: input.touchdownLng,
          altFt: input.gatesFt[3],
        },
      ],
      segments: [],
      metrics,
      warnings,
      blocked: true,
    };
  }

  const touchdown: LocalPoint = { eastFt: 0, northFt: 0 };
  const segmentStarts = new Map<SegmentName, LocalPoint>();
  let segmentEnd = touchdown;

  for (let index = activeSegments.length - 1; index >= 0; index -= 1) {
    const segment = activeSegments[index]!;
    const groundUnit = unitOrZero(segment.groundVectorKt);
    const segmentStart = {
      eastFt: segmentEnd.eastFt - groundUnit.east * segment.distanceFt,
      northFt: segmentEnd.northFt - groundUnit.north * segment.distanceFt,
    };
    segmentStarts.set(segment.name, segmentStart);
    segmentEnd = segmentStart;
  }

  const waypoints = activeDefinitions.map((definition) => {
    const start = segmentStarts.get(definition.name)!;
    const geo = localFeetToLatLng(input.touchdownLat, input.touchdownLng, start.eastFt, start.northFt);
    return {
      name: getWaypointNameForSegment(definition.name),
      lat: geo.lat,
      lng: geo.lng,
      altFt: definition.startAltFt,
    };
  });

  const touchdownGeo = localFeetToLatLng(input.touchdownLat, input.touchdownLng, touchdown.eastFt, touchdown.northFt);

  return {
    waypoints: [
      ...waypoints,
      {
        name: "touchdown",
        lat: touchdownGeo.lat,
        lng: touchdownGeo.lng,
        altFt: input.gatesFt[3],
      },
    ],
    segments: activeSegments.map((segment) => ({
      name: segment.name,
      headingDeg: segment.headingDeg,
      trackHeadingDeg: segment.trackHeadingDeg,
      alongLegSpeedKt: segment.alongLegSpeedKt,
      groundSpeedKt: segment.groundSpeedKt,
      timeSec: segment.timeSec,
      distanceFt: segment.distanceFt,
    })),
    metrics,
    warnings,
    blocked: false,
  };
}

function localPointFromGeoPoint(reference: GeoPoint, point: GeoPoint): LocalPoint {
  return latLngToLocalFeet(reference.lat, reference.lng, point.lat, point.lng);
}

function geoPointFromLocal(reference: GeoPoint, point: LocalPoint): GeoPoint {
  return localFeetToLatLng(reference.lat, reference.lng, point.eastFt, point.northFt);
}

function pointToUnitVector(headingDeg: number): LocalPoint {
  const unit = headingToUnitVector(headingDeg);
  return {
    eastFt: unit.east,
    northFt: unit.north,
  };
}

function localPointMagnitude(point: LocalPoint): number {
  return Math.hypot(point.eastFt, point.northFt);
}

function localPointDifference(a: LocalPoint, b: LocalPoint): LocalPoint {
  return {
    eastFt: a.eastFt - b.eastFt,
    northFt: a.northFt - b.northFt,
  };
}

function localPointAdd(a: LocalPoint, b: LocalPoint): LocalPoint {
  return {
    eastFt: a.eastFt + b.eastFt,
    northFt: a.northFt + b.northFt,
  };
}

function scaleLocalPoint(point: LocalPoint, scalar: number): LocalPoint {
  return {
    eastFt: point.eastFt * scalar,
    northFt: point.northFt * scalar,
  };
}

function dotLocalPoint(a: LocalPoint, b: LocalPoint): number {
  return a.eastFt * b.eastFt + a.northFt * b.northFt;
}

function normalizeLocalPoint(point: LocalPoint): LocalPoint {
  const magnitude = localPointMagnitude(point);
  if (magnitude <= EPSILON) {
    return { eastFt: 0, northFt: 0 };
  }
  return scaleLocalPoint(point, 1 / magnitude);
}

function buildJumpRunFrame(landingPoint: GeoPoint, jumpRun: JumpRunLine): JumpRunFrame | null {
  const start = localPointFromGeoPoint(landingPoint, jumpRun.start);
  const end = localPointFromGeoPoint(landingPoint, jumpRun.end);
  const raw = localPointDifference(end, start);
  const lengthFt = localPointMagnitude(raw);
  if (!Number.isFinite(lengthFt) || lengthFt <= EPSILON) {
    return null;
  }
  const unit = normalizeLocalPoint(raw);
  return {
    start,
    end,
    unit,
    leftUnit: { eastFt: -unit.northFt, northFt: unit.eastFt },
    lengthFt,
  };
}

function signedCrossTrackDistanceFt(frame: JumpRunFrame, point: LocalPoint): number {
  return dotLocalPoint(localPointDifference(point, frame.start), frame.leftUnit);
}

function alongJumpRunDistanceFt(frame: JumpRunFrame, point: LocalPoint): number {
  return dotLocalPoint(localPointDifference(point, frame.start), frame.unit);
}

function localPointToVec(point: LocalPoint): { east: number; north: number } {
  return { east: point.eastFt, north: point.northFt };
}

function interpolateLocalPoint(start: LocalPoint, end: LocalPoint, t: number): LocalPoint {
  return {
    eastFt: start.eastFt + (end.eastFt - start.eastFt) * t,
    northFt: start.northFt + (end.northFt - start.northFt) * t,
  };
}

function distanceBetweenLocalPointsFt(a: LocalPoint, b: LocalPoint): number {
  return localPointMagnitude(localPointDifference(a, b));
}

function lookupJumpRunSpotOffsetFt(componentKt: number): number {
  const absComponentKt = Math.abs(componentKt);
  const bucket = JUMP_RUN_SPOT_TABLE.find((entry) => absComponentKt <= entry.maxWindKt);
  const offsetFt = (bucket?.offsetMiles ?? 0) * 5280;
  return Math.sign(componentKt) * offsetFt;
}

function lookupJumpRunCrosswindOffsetFt(componentKt: number): number {
  const absComponentKt = Math.abs(componentKt);
  const bucket = JUMP_RUN_CROSSWIND_TABLE.find((entry) => absComponentKt <= entry.maxWindKt);
  const offsetFt = (bucket?.offsetMiles ?? 0) * 5280;
  return Math.sign(componentKt) * offsetFt;
}

function createResolvedJumpRunSlot(
  input: WingsuitAutoInput,
  point: LocalPoint,
  index: number,
  totalSlots: number,
): ResolvedJumpRunSlot {
  return {
    ...geoPointFromLocal(input.landingPoint, point),
    label: index === totalSlots - 1 ? "WS" : `G${index + 1}`,
    index,
    kind: index === totalSlots - 1 ? "wingsuit" : "group",
    altFt: input.exitHeightFt,
  };
}

function resolveJumpRunPlan(input: WingsuitAutoInput): ResolvedJumpRunPlan | null {
  const assumptions = resolveJumpRunAssumptions(input.jumpRun.assumptions);
  const headingResolution = resolveJumpRunHeading(input);
  if (!headingResolution) {
    return null;
  }

  const jumpRunUnit = pointToUnitVector(headingResolution.headingDeg);
  const leftUnit = { eastFt: -jumpRunUnit.northFt, northFt: jumpRunUnit.eastFt };
  const exitWind = getWindForAltitude(input.exitHeightFt, input.winds);
  const deployWind = getWindForAltitude(assumptions.slickDeployHeightFt, input.winds) ?? exitWind;
  const planeAirspeedVecKt = scaleVec(localPointToVec(jumpRunUnit), assumptions.planeAirspeedKt);
  const exitWindVecKt = exitWind ? windFromToGroundVector(exitWind.speedKt, exitWind.dirFromDeg) : { east: 0, north: 0 };
  const planeGroundSpeedKt = Math.max(45, dot(addVec(planeAirspeedVecKt, exitWindVecKt), localPointToVec(jumpRunUnit)));
  const deployWindVecKt = deployWind ? windFromToGroundVector(deployWind.speedKt, deployWind.dirFromDeg) : { east: 0, north: 0 };
  const headwindComponentKt = -dot(deployWindVecKt, localPointToVec(jumpRunUnit));
  const crosswindComponentKt = dot(deployWindVecKt, localPointToVec(leftUnit));
  const preferredSpotOffsetAlongFt = lookupJumpRunSpotOffsetFt(headwindComponentKt);
  const crosswindOffsetFt = -lookupJumpRunCrosswindOffsetFt(crosswindComponentKt);

  const slickGroupCount = Math.max(1, assumptions.groupCount - 1);
  const slickSpanFt = assumptions.groupSeparationFt * Math.max(0, slickGroupCount - 1);
  const lineLengthFt = assumptions.groupSeparationFt * assumptions.groupCount;
  const lineOffset = scaleLocalPoint(leftUnit, crosswindOffsetFt);
  const slickCenterAlongMinFt = -assumptions.slickReturnRadiusFt + slickSpanFt / 2;
  const slickCenterAlongMaxFt = assumptions.slickReturnRadiusFt - slickSpanFt / 2;
  const preferredSlickCenterAlongFt = preferredSpotOffsetAlongFt + assumptions.groupSeparationFt;
  const slickCenterAlongFt = clamp(preferredSlickCenterAlongFt, slickCenterAlongMinFt, slickCenterAlongMaxFt);
  const firstSlickExitAlongFt = slickCenterAlongFt - slickSpanFt / 2;
  const lastSlickExitAlongFt = slickCenterAlongFt + slickSpanFt / 2;
  const startLocal = localPointAdd(
    lineOffset,
    scaleLocalPoint(jumpRunUnit, firstSlickExitAlongFt - assumptions.groupSeparationFt),
  );
  const endLocal = localPointAdd(startLocal, scaleLocalPoint(jumpRunUnit, lineLengthFt));
  const slots = Array.from({ length: assumptions.groupCount }, (_, index) =>
    createResolvedJumpRunSlot(
      input,
      localPointAdd(startLocal, scaleLocalPoint(jumpRunUnit, assumptions.groupSeparationFt * (index + 1))),
      index,
      assumptions.groupCount,
    ),
  );
  const resolved: ResolvedJumpRun = {
    line: {
      start: geoPointFromLocal(input.landingPoint, startLocal),
      end: geoPointFromLocal(input.landingPoint, endLocal),
    },
    headingDeg: vectorToHeadingDeg(localPointToVec(jumpRunUnit)),
    lengthFt: lineLengthFt,
    crosswindOffsetFt,
    planeGroundSpeedKt,
    groupSpacingFt: assumptions.groupSeparationFt,
    groupSpacingSec: assumptions.groupSeparationFt / Math.max(knotsToFeetPerSecond(planeGroundSpeedKt), EPSILON),
    slots,
  };
  const frame = buildJumpRunFrame(input.landingPoint, resolved.line);
  if (!frame) {
    return null;
  }

  return {
    resolved,
    frame,
    targetExitLocal: localPointFromGeoPoint(input.landingPoint, slots[slots.length - 1]!),
    jumpRunUnit,
    groupSpacingFt: assumptions.groupSeparationFt,
    headingSource: headingResolution.headingSource,
    constrainedHeadingApplied: headingResolution.constrainedHeadingApplied,
    headwindComponentKt,
    crosswindComponentKt,
    firstSlickReturnMarginFt: assumptions.slickReturnRadiusFt - Math.abs(firstSlickExitAlongFt),
    lastSlickReturnMarginFt: assumptions.slickReturnRadiusFt - Math.abs(lastSlickExitAlongFt),
    preferredSpotOffsetAlongFt,
    warnings:
      planeGroundSpeedKt <= 45 + EPSILON
        ? ["Aircraft ground speed was clamped to 45 kt for exit-spacing stability."]
        : [],
    blockedReason:
      slickCenterAlongMaxFt < slickCenterAlongMinFt
        ? `Jump run cannot fit ${slickGroupCount} slick groups inside the ${assumptions.slickReturnRadiusFt.toFixed(0)} ft return radius.`
        : null,
  };
}

function resolveTurnRatios(turnRatios: WingsuitAutoInput["turnRatios"] | undefined): WingsuitAutoTurnRatios {
  return {
    turn1: turnRatios?.turn1 ?? DEFAULT_WINGSUIT_AUTO_TURN_RATIOS.turn1,
    turn2: turnRatios?.turn2 ?? DEFAULT_WINGSUIT_AUTO_TURN_RATIOS.turn2,
  };
}

function resolveWingsuitAutoTuning(tuning: WingsuitAutoInput["tuning"] | undefined): Required<WingsuitAutoTuning> {
  return {
    corridorHalfWidthFt: tuning?.corridorHalfWidthFt ?? DEFAULT_WINGSUIT_AUTO_TUNING.corridorHalfWidthFt,
    deployBearingStepDeg: tuning?.deployBearingStepDeg ?? DEFAULT_WINGSUIT_AUTO_TUNING.deployBearingStepDeg,
    deployRadiusStepFt: tuning?.deployRadiusStepFt ?? DEFAULT_WINGSUIT_AUTO_TUNING.deployRadiusStepFt,
    deployBearingWindowHalfDeg:
      tuning?.deployBearingWindowHalfDeg ?? DEFAULT_WINGSUIT_AUTO_TUNING.deployBearingWindowHalfDeg,
    maxDeployRadiusFt: tuning?.maxDeployRadiusFt ?? DEFAULT_WINGSUIT_AUTO_TUNING.maxDeployRadiusFt,
    maxFirstLegTrackDeltaDeg:
      tuning?.maxFirstLegTrackDeltaDeg ?? DEFAULT_WINGSUIT_AUTO_TUNING.maxFirstLegTrackDeltaDeg,
    minDeployRadiusFt: tuning?.minDeployRadiusFt ?? DEFAULT_WINGSUIT_AUTO_TUNING.minDeployRadiusFt,
    refinementIterations: tuning?.refinementIterations ?? DEFAULT_WINGSUIT_AUTO_TUNING.refinementIterations,
    exitOnJumpRunToleranceFt:
      tuning?.exitOnJumpRunToleranceFt ?? DEFAULT_WINGSUIT_AUTO_TUNING.exitOnJumpRunToleranceFt,
  };
}

function resolveJumpRunAssumptions(
  assumptions: WingsuitAutoInput["jumpRun"]["assumptions"] | undefined,
): Required<WingsuitAutoJumpRunAssumptions> {
  return {
    planeAirspeedKt: assumptions?.planeAirspeedKt ?? DEFAULT_WINGSUIT_AUTO_ASSUMPTIONS.planeAirspeedKt,
    groupCount: assumptions?.groupCount ?? DEFAULT_WINGSUIT_AUTO_ASSUMPTIONS.groupCount,
    groupSeparationFt: assumptions?.groupSeparationFt ?? DEFAULT_WINGSUIT_AUTO_ASSUMPTIONS.groupSeparationFt,
    slickDeployHeightFt: assumptions?.slickDeployHeightFt ?? DEFAULT_WINGSUIT_AUTO_ASSUMPTIONS.slickDeployHeightFt,
    slickFallRateFps: assumptions?.slickFallRateFps ?? DEFAULT_WINGSUIT_AUTO_ASSUMPTIONS.slickFallRateFps,
    slickReturnRadiusFt: assumptions?.slickReturnRadiusFt ?? DEFAULT_WINGSUIT_AUTO_ASSUMPTIONS.slickReturnRadiusFt,
  };
}

function deriveTurnHeightsFt(input: WingsuitAutoInput, ratios: WingsuitAutoTurnRatios): [number, number] {
  const span = input.exitHeightFt - input.deployHeightFt;
  return [
    input.deployHeightFt + span * ratios.turn1,
    input.deployHeightFt + span * ratios.turn2,
  ];
}

function buildAutoGatesFt(input: WingsuitAutoInput, ratios: WingsuitAutoTurnRatios): [number, number, number, number] {
  const [turn1Ft, turn2Ft] = deriveTurnHeightsFt(input, ratios);
  return [input.exitHeightFt, turn1Ft, turn2Ft, input.deployHeightFt];
}

function resolveJumpRunHeading(input: WingsuitAutoInput): {
  headingDeg: number;
  headingSource: WingsuitAutoJumpRunHeadingSource;
  constrainedHeadingApplied: boolean;
} | null {
  const headingSource: WingsuitAutoJumpRunHeadingSource =
    input.jumpRun.directionMode === "manual" ? "manual" : "auto-headwind";
  const lowestWindLayer = [...input.winds].sort((a, b) => a.altitudeFt - b.altitudeFt)[0];
  const sourceHeadingDeg =
    headingSource === "manual"
      ? input.jumpRun.manualHeadingDeg
      : lowestWindLayer?.dirFromDeg;

  if (!Number.isFinite(sourceHeadingDeg)) {
    return null;
  }

  const normalizedSourceHeading = normalizeHeading(sourceHeadingDeg as number);
  if (input.jumpRun.constraintMode !== "reciprocal") {
    return {
      headingDeg: normalizedSourceHeading,
      headingSource,
      constrainedHeadingApplied: false,
    };
  }

  if (!Number.isFinite(input.jumpRun.constraintHeadingDeg)) {
    return null;
  }

  const baseHeadingDeg = normalizeHeading(input.jumpRun.constraintHeadingDeg as number);
  const oppositeHeadingDeg = normalizeHeading(baseHeadingDeg + 180);
  const selectedHeadingDeg =
    absoluteHeadingDeltaDeg(normalizedSourceHeading, baseHeadingDeg) <=
    absoluteHeadingDeltaDeg(normalizedSourceHeading, oppositeHeadingDeg)
      ? baseHeadingDeg
      : oppositeHeadingDeg;

  return {
    headingDeg: selectedHeadingDeg,
    headingSource,
    constrainedHeadingApplied: absoluteHeadingDeltaDeg(normalizedSourceHeading, selectedHeadingDeg) > EPSILON,
  };
}

function createAutoGateCandidate(
  exitHeightFt: number,
  turn1HeightFt: number,
  turn2HeightFt: number,
  deployHeightFt: number,
): AutoGateCandidate {
  return {
    gatesFt: [exitHeightFt, turn1HeightFt, turn2HeightFt, deployHeightFt],
    turnHeightsFt: [turn1HeightFt, turn2HeightFt],
  };
}

function buildAutoGateCandidates(
  input: WingsuitAutoInput,
  preferredRatios: WingsuitAutoTurnRatios,
): AutoGateCandidate[] {
  const spanFt = input.exitHeightFt - input.deployHeightFt;
  const preferred = buildAutoGatesFt(input, preferredRatios);
  const candidates: AutoGateCandidate[] = [
    createAutoGateCandidate(preferred[0], preferred[1], preferred[2], preferred[3]),
  ];

  const threeLegRatios: Array<[number, number]> = [
    [Math.min(0.9, preferredRatios.turn1 + 0.08), Math.min(0.55, preferredRatios.turn2 + 0.08)],
    [Math.max(0.5, preferredRatios.turn1 - 0.1), Math.max(0.15, preferredRatios.turn2 - 0.08)],
  ];

  for (const [turn1Ratio, turn2Ratio] of threeLegRatios) {
    if (!(turn1Ratio < 1 && turn1Ratio > turn2Ratio && turn2Ratio > 0)) {
      continue;
    }
    candidates.push(
      createAutoGateCandidate(
        input.exitHeightFt,
        input.deployHeightFt + spanFt * turn1Ratio,
        input.deployHeightFt + spanFt * turn2Ratio,
        input.deployHeightFt,
      ),
    );
  }

  const noDownwindTurn2Ft = input.deployHeightFt + spanFt * preferredRatios.turn2;
  candidates.push(
    createAutoGateCandidate(
      input.exitHeightFt,
      input.exitHeightFt,
      noDownwindTurn2Ft,
      input.deployHeightFt,
    ),
  );

  const noBaseTurnFt = input.deployHeightFt + spanFt * preferredRatios.turn1;
  candidates.push(
    createAutoGateCandidate(
      input.exitHeightFt,
      noBaseTurnFt,
      noBaseTurnFt,
      input.deployHeightFt,
    ),
  );

  const deduped = new Map<string, AutoGateCandidate>();
  for (const candidate of candidates) {
    const key = candidate.gatesFt.map((value) => value.toFixed(2)).join("|");
    deduped.set(key, candidate);
  }
  return [...deduped.values()];
}

function isFiniteGeoPoint(point: GeoPoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lng >= -180 &&
    point.lng <= 180
  );
}

export function validateWingsuitAutoInput(input: WingsuitAutoInput): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tuning = resolveWingsuitAutoTuning(input.tuning);
  const ratios = resolveTurnRatios(input.turnRatios);
  const assumptions = resolveJumpRunAssumptions(input.jumpRun.assumptions);

  if (!isFiniteGeoPoint(input.landingPoint)) {
    errors.push("Landing point must be a valid latitude/longitude value.");
  }

  const directionMode = input.jumpRun.directionMode ?? "auto";
  const constraintMode = input.jumpRun.constraintMode ?? "none";
  if (directionMode === "manual" && !Number.isFinite(input.jumpRun.manualHeadingDeg)) {
    errors.push("Manual jump-run direction requires a finite heading.");
  }
  if (constraintMode === "reciprocal" && !Number.isFinite(input.jumpRun.constraintHeadingDeg)) {
    errors.push("Reciprocal jump-run constraint requires a finite runway heading.");
  }

  if (!Number.isFinite(input.exitHeightFt) || !Number.isFinite(input.deployHeightFt)) {
    errors.push("Exit and deploy heights must be finite numeric values.");
  } else if (!(input.exitHeightFt > input.deployHeightFt && input.deployHeightFt > 0)) {
    errors.push("Exit height must be above deploy height, and deploy height must be above 0 ft.");
  }

  if (
    !Number.isFinite(ratios.turn1) ||
    !Number.isFinite(ratios.turn2) ||
    !(ratios.turn1 < 1 && ratios.turn1 > ratios.turn2 && ratios.turn2 > 0)
  ) {
    errors.push("Turn ratios must satisfy 1 > turn1 > turn2 > 0.");
  }

  if (
    !Number.isFinite(input.wingsuit.flightSpeedKt) ||
    !Number.isFinite(input.wingsuit.fallRateFps) ||
    input.wingsuit.flightSpeedKt <= 0 ||
    input.wingsuit.fallRateFps <= 0
  ) {
    errors.push("Wingsuit flight speed and fall rate must be finite and positive.");
  }

  if (input.winds.length === 0) {
    errors.push("At least one wind layer is required.");
  }

  if (
    !Number.isFinite(assumptions.planeAirspeedKt) ||
    !Number.isFinite(assumptions.groupCount) ||
    !Number.isFinite(assumptions.groupSeparationFt) ||
    !Number.isFinite(assumptions.slickDeployHeightFt) ||
    !Number.isFinite(assumptions.slickFallRateFps) ||
    !Number.isFinite(assumptions.slickReturnRadiusFt)
  ) {
    errors.push("Jump-run assumptions must be finite when provided.");
  } else {
    if (assumptions.planeAirspeedKt <= 0) {
      errors.push("Plane airspeed must be positive.");
    }
    if (!Number.isInteger(assumptions.groupCount) || assumptions.groupCount < 2) {
      errors.push("Group count must be an integer of at least 2.");
    }
    if (assumptions.groupSeparationFt <= 0) {
      errors.push("Group separation must be positive.");
    }
    if (!(assumptions.slickDeployHeightFt > 0 && assumptions.slickDeployHeightFt < input.exitHeightFt)) {
      errors.push("Slick deploy height must be above 0 ft and below exit height.");
    }
    if (assumptions.slickFallRateFps <= 0) {
      errors.push("Slick fall rate must be positive.");
    }
    if (assumptions.slickReturnRadiusFt <= 0) {
      errors.push("Slick return radius must be positive.");
    }
  }

  for (const [index, wind] of input.winds.entries()) {
    if (!Number.isFinite(wind.altitudeFt) || !Number.isFinite(wind.speedKt) || !Number.isFinite(wind.dirFromDeg)) {
      errors.push(`Wind layer values must be finite (index ${index}).`);
      continue;
    }
    if (wind.speedKt < 0) {
      errors.push(`Wind speed cannot be negative at ${wind.altitudeFt} ft.`);
    }
  }

  const highestWind = input.winds.reduce((best, layer) => Math.max(best, layer.altitudeFt), Number.NEGATIVE_INFINITY);
  const lowestWind = input.winds.reduce((best, layer) => Math.min(best, layer.altitudeFt), Number.POSITIVE_INFINITY);
  if (Number.isFinite(highestWind) && highestWind < input.exitHeightFt) {
    warnings.push("Highest wind layer is below exit height; upper winds will be extrapolated.");
  }
  if (Number.isFinite(lowestWind) && lowestWind > Math.min(input.deployHeightFt, assumptions.slickDeployHeightFt)) {
    warnings.push("Lowest wind layer is above the lowest modeled altitude; low winds will be extrapolated.");
  }

  for (const value of Object.values(tuning)) {
    if (!Number.isFinite(value)) {
      errors.push("Auto-solver tuning values must be finite when provided.");
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function createAutoWaypoint(
  name: WingsuitAutoWaypointName,
  point: GeoPoint,
  altFt: number,
): WingsuitAutoWaypoint {
  return {
    name,
    lat: point.lat,
    lng: point.lng,
    altFt,
  };
}

function signedHeadingDeltaDeg(fromDeg: number, toDeg: number): number {
  return ((normalizeHeading(toDeg) - normalizeHeading(fromDeg) + 540) % 360) - 180;
}

function absoluteHeadingDeltaDeg(fromDeg: number, toDeg: number): number {
  return Math.abs(signedHeadingDeltaDeg(fromDeg, toDeg));
}

function buildBearingSweep(preferredBearingDeg: number, stepDeg: number, windowHalfDeg: number): number[] {
  const bearings: number[] = [];
  const count = Math.max(1, Math.floor((windowHalfDeg * 2) / stepDeg));
  for (let index = 0; index <= count; index += 1) {
    const offsetDeg = -windowHalfDeg + index * stepDeg;
    bearings.push(normalizeHeading(preferredBearingDeg + offsetDeg));
  }
  return Array.from(new Set(bearings.map((bearing) => Number(bearing.toFixed(6)))));
}

function buildForbiddenZonePolygon(
  landingPoint: GeoPoint,
  frame: JumpRunFrame,
  corridorHalfWidthFt: number,
  extentFt: number,
): GeoPoint[] {
  const extension = extentFt + frame.lengthFt;
  const startExtended = localPointAdd(frame.start, scaleLocalPoint(frame.unit, -extension));
  const endExtended = localPointAdd(frame.end, scaleLocalPoint(frame.unit, extension));
  const leftOffset = scaleLocalPoint(frame.leftUnit, corridorHalfWidthFt);

  return [
    geoPointFromLocal(landingPoint, localPointAdd(startExtended, leftOffset)),
    geoPointFromLocal(landingPoint, localPointAdd(endExtended, leftOffset)),
    geoPointFromLocal(landingPoint, localPointAdd(endExtended, scaleLocalPoint(leftOffset, -1))),
    geoPointFromLocal(landingPoint, localPointAdd(startExtended, scaleLocalPoint(leftOffset, -1))),
  ];
}

function buildCirclePolygon(landingPoint: GeoPoint, radiusFt: number, points = 36): GeoPoint[] {
  const polygon: GeoPoint[] = [];
  for (let index = 0; index < points; index += 1) {
    const bearingDeg = (index / points) * 360;
    polygon.push(
      geoPointFromLocal(landingPoint, scaleLocalPoint(pointToUnitVector(bearingDeg), radiusFt)),
    );
  }
  return polygon;
}

function buildHalfDiskPolygon(
  landingPoint: GeoPoint,
  centerBearingDeg: number,
  radiusFt: number,
  points = 24,
): GeoPoint[] {
  const polygon: GeoPoint[] = [landingPoint];
  for (let index = 0; index <= points; index += 1) {
    const t = index / points;
    const bearingDeg = normalizeHeading(centerBearingDeg - 90 + t * 180);
    polygon.push(
      geoPointFromLocal(landingPoint, scaleLocalPoint(pointToUnitVector(bearingDeg), radiusFt)),
    );
  }
  return polygon;
}

function buildBandsPolygon(landingPoint: GeoPoint, bands: RadiusBand[]): GeoPoint[] {
  if (bands.length === 0) {
    return [];
  }

  const outer = bands.map((band) => {
    const direction = pointToUnitVector(band.bearingDeg);
    return geoPointFromLocal(landingPoint, scaleLocalPoint(direction, band.maxRadiusFt));
  });

  const inner = [...bands]
    .reverse()
    .map((band) => {
      const direction = pointToUnitVector(band.bearingDeg);
      return geoPointFromLocal(landingPoint, scaleLocalPoint(direction, Math.max(0, band.minRadiusFt)));
    });

  return [...outer, ...inner];
}

function pointToCorridorMarginFt(frame: JumpRunFrame, point: LocalPoint, corridorHalfWidthFt: number): number {
  const alongFt = alongJumpRunDistanceFt(frame, point);
  const crossTrackFt = Math.abs(signedCrossTrackDistanceFt(frame, point));

  if (alongFt < 0) {
    if (crossTrackFt <= corridorHalfWidthFt) {
      return -alongFt;
    }
    return Math.hypot(-alongFt, crossTrackFt - corridorHalfWidthFt);
  }

  if (alongFt > frame.lengthFt) {
    if (crossTrackFt <= corridorHalfWidthFt) {
      return alongFt - frame.lengthFt;
    }
    return Math.hypot(alongFt - frame.lengthFt, crossTrackFt - corridorHalfWidthFt);
  }

  return crossTrackFt - corridorHalfWidthFt;
}

function pointIsOnSelectedSide(point: LocalPoint, frame: JumpRunFrame, side: WingsuitAutoInput["side"]): boolean {
  const crossTrackFt = signedCrossTrackDistanceFt(frame, point);
  return side === "left" ? crossTrackFt > 0 : crossTrackFt < 0;
}

function segmentOutsideFiniteCorridor(
  frame: JumpRunFrame,
  startPoint: LocalPoint,
  endPoint: LocalPoint,
  corridorHalfWidthFt: number,
  side: WingsuitAutoInput["side"],
  samples = 12,
): { valid: boolean; marginFt: number } {
  let minMarginFt = Number.POSITIVE_INFINITY;

  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const point = interpolateLocalPoint(startPoint, endPoint, t);
    if (!pointIsOnSelectedSide(point, frame, side)) {
      return { valid: false, marginFt: Number.NEGATIVE_INFINITY };
    }
    const corridorMarginFt = pointToCorridorMarginFt(frame, point, corridorHalfWidthFt);
    if (corridorMarginFt <= 0) {
      return { valid: false, marginFt: corridorMarginFt };
    }
    minMarginFt = Math.min(minMarginFt, corridorMarginFt);
  }

  return { valid: true, marginFt: minMarginFt };
}

function compareCandidatesWithPreferredBearing(
  a: CandidateEvaluation,
  b: CandidateEvaluation,
  preferredBearingDeg: number,
): number {
  if (Math.abs(a.exitToJumpRunErrorFt - b.exitToJumpRunErrorFt) > EPSILON) {
    return a.exitToJumpRunErrorFt - b.exitToJumpRunErrorFt;
  }
  if (Math.abs(a.firstLegTrackDeltaDeg - b.firstLegTrackDeltaDeg) > EPSILON) {
    return a.firstLegTrackDeltaDeg - b.firstLegTrackDeltaDeg;
  }
  const aBearingDelta = absoluteHeadingDeltaDeg(preferredBearingDeg, a.bearingDeg);
  const bBearingDelta = absoluteHeadingDeltaDeg(preferredBearingDeg, b.bearingDeg);
  if (Math.abs(aBearingDelta - bBearingDelta) > EPSILON) {
    return aBearingDelta - bBearingDelta;
  }
  if (Math.abs(a.corridorMarginFt - b.corridorMarginFt) > EPSILON) {
    return b.corridorMarginFt - a.corridorMarginFt;
  }
  if (Math.abs(a.radiusFt - b.radiusFt) > EPSILON) {
    return a.radiusFt - b.radiusFt;
  }
  return a.exitAlongTargetErrorFt - b.exitAlongTargetErrorFt;
}

function compareCandidatesForSameDeploy(a: CandidateEvaluation, b: CandidateEvaluation): number {
  if (Math.abs(a.exitToJumpRunErrorFt - b.exitToJumpRunErrorFt) > EPSILON) {
    return a.exitToJumpRunErrorFt - b.exitToJumpRunErrorFt;
  }
  if (Math.abs(a.firstLegTrackDeltaDeg - b.firstLegTrackDeltaDeg) > EPSILON) {
    return a.firstLegTrackDeltaDeg - b.firstLegTrackDeltaDeg;
  }
  if (Math.abs(a.corridorMarginFt - b.corridorMarginFt) > EPSILON) {
    return b.corridorMarginFt - a.corridorMarginFt;
  }
  if (Math.abs(a.radiusFt - b.radiusFt) > EPSILON) {
    return a.radiusFt - b.radiusFt;
  }
  return a.exitAlongTargetErrorFt - b.exitAlongTargetErrorFt;
}

function evaluateDeployCandidate(
  input: WingsuitAutoInput,
  plan: ResolvedJumpRunPlan,
  gateCandidate: AutoGateCandidate,
  corridorHalfWidthFt: number,
  _jumpRunToleranceFt: number,
  maxFirstLegTrackDeltaDeg: number,
  landingHeadingDeg: number,
  bearingDeg: number,
  radiusFt: number,
  maxRadiusFt: number,
): CandidateEvaluation | null {
  const landingPoint = input.landingPoint;
  const frame = plan.frame;
  const deployLocal = scaleLocalPoint(pointToUnitVector(bearingDeg), radiusFt);
  if (!pointIsOnSelectedSide(deployLocal, frame, input.side)) {
    return null;
  }
  if (pointToCorridorMarginFt(frame, deployLocal, corridorHalfWidthFt) <= 0) {
    return null;
  }

  const deployGeo = geoPointFromLocal(landingPoint, deployLocal);
  const routeOutput = computePattern({
    mode: "wingsuit",
    touchdownLat: deployGeo.lat,
    touchdownLng: deployGeo.lng,
    landingHeadingDeg,
    side: input.side,
    baseLegDrift: true,
    gatesFt: gateCandidate.gatesFt,
    winds: input.winds,
    canopy: AUTO_ROUTE_PLACEHOLDER_CANOPY,
    jumper: AUTO_ROUTE_PLACEHOLDER_JUMPER,
    wingsuit: input.wingsuit,
  });

  if (
    routeOutput.blocked ||
    routeOutput.waypoints.length < 3 ||
    routeOutput.waypoints.length > 4 ||
    routeOutput.segments.length < 2 ||
    routeOutput.segments.length > 3
  ) {
    return null;
  }

  if (routeOutput.segments.some((segment) => segment.alongLegSpeedKt <= 0)) {
    return null;
  }

  const firstSegment = routeOutput.segments[0];
  if (!firstSegment) {
    return null;
  }
  const jumpRunHeadingDeg = vectorToHeadingDeg({ east: frame.unit.eastFt, north: frame.unit.northFt });
  const firstLegTrackDeltaDeg = signedHeadingDeltaDeg(jumpRunHeadingDeg, firstSegment.trackHeadingDeg);
  const firstLegWithinBound =
    input.side === "left"
      ? firstLegTrackDeltaDeg >= -maxFirstLegTrackDeltaDeg && firstLegTrackDeltaDeg <= 0
      : firstLegTrackDeltaDeg >= 0 && firstLegTrackDeltaDeg <= maxFirstLegTrackDeltaDeg;
  if (!firstLegWithinBound) {
    return null;
  }

  const routeWarnings = routeOutput.warnings.filter(
    (warning) => warning !== "Touchdown gate is expected to be 0 ft AGL in this model.",
  );

  const segmentKey = routeOutput.segments.map((segment) => segment.name).join("|");
  let routeWaypoints: WingsuitAutoWaypoint[] | null = null;
  if (segmentKey === "downwind|base|final" && routeOutput.waypoints.length === 4) {
    routeWaypoints = [
      createAutoWaypoint("exit", routeOutput.waypoints[0]!, gateCandidate.gatesFt[0]),
      createAutoWaypoint("turn1", routeOutput.waypoints[1]!, gateCandidate.gatesFt[1]),
      createAutoWaypoint("turn2", routeOutput.waypoints[2]!, gateCandidate.gatesFt[2]),
      createAutoWaypoint("deploy", routeOutput.waypoints[3]!, gateCandidate.gatesFt[3]),
    ];
  } else if (segmentKey === "base|final" && routeOutput.waypoints.length === 3) {
    routeWaypoints = [
      createAutoWaypoint("exit", routeOutput.waypoints[0]!, gateCandidate.gatesFt[0]),
      createAutoWaypoint("turn1", routeOutput.waypoints[0]!, gateCandidate.gatesFt[1]),
      createAutoWaypoint("turn2", routeOutput.waypoints[1]!, gateCandidate.gatesFt[2]),
      createAutoWaypoint("deploy", routeOutput.waypoints[2]!, gateCandidate.gatesFt[3]),
    ];
  } else if (segmentKey === "downwind|final" && routeOutput.waypoints.length === 3) {
    routeWaypoints = [
      createAutoWaypoint("exit", routeOutput.waypoints[0]!, gateCandidate.gatesFt[0]),
      createAutoWaypoint("turn1", routeOutput.waypoints[1]!, gateCandidate.gatesFt[1]),
      createAutoWaypoint("turn2", routeOutput.waypoints[1]!, gateCandidate.gatesFt[2]),
      createAutoWaypoint("deploy", routeOutput.waypoints[2]!, gateCandidate.gatesFt[3]),
    ];
  }
  if (!routeWaypoints) {
    return null;
  }

  const routeLocals = routeWaypoints.map((waypoint) => localPointFromGeoPoint(landingPoint, waypoint));
  const exitPoint = routeWaypoints[0]!;
  const turn1Point = routeWaypoints[1]!;
  const turn2Point = routeWaypoints[2]!;
  const exitLocal = routeLocals[0]!;
  const turn1Local = routeLocals[1]!;
  const turn2Local = routeLocals[2]!;

  const activeTurnAndDeployLocals =
    segmentKey === "base|final"
      ? [turn2Local, deployLocal]
      : segmentKey === "downwind|final"
        ? [turn1Local, deployLocal]
        : [turn1Local, turn2Local, deployLocal];
  const sideOkay = activeTurnAndDeployLocals.every((point) => pointIsOnSelectedSide(point, frame, input.side));
  if (!sideOkay) {
    return null;
  }

  const segmentMarginPairs: Array<[LocalPoint, LocalPoint]> =
    segmentKey === "base|final"
      ? [[turn2Local, deployLocal]]
      : segmentKey === "downwind|final"
        ? [[turn1Local, deployLocal]]
        : [[turn1Local, turn2Local], [turn2Local, deployLocal]];
  const segmentMargins = segmentMarginPairs.map(([startPoint, endPoint]) =>
    segmentOutsideFiniteCorridor(frame, startPoint, endPoint, corridorHalfWidthFt, input.side),
  );

  if (segmentMargins.some((margin) => !margin.valid)) {
    return null;
  }

  const pointMargins = activeTurnAndDeployLocals.map(
    (point) => pointToCorridorMarginFt(frame, point, corridorHalfWidthFt),
  );
  const corridorMarginFt = Math.min(...pointMargins, ...segmentMargins.map((margin) => margin.marginFt));
  const resolvedJumpRun = plan.resolved;
  const exitToJumpRunErrorFt = distanceBetweenLocalPointsFt(exitLocal, plan.targetExitLocal);
  const deployRadiusMarginFt = maxRadiusFt - radiusFt;
  const exitAlongTargetErrorFt = exitToJumpRunErrorFt;

  return {
    landingHeadingDeg,
    bearingDeg,
    radiusFt,
    turnHeightsFt: gateCandidate.turnHeightsFt,
    resolvedJumpRun,
    deployPoint: routeWaypoints[3]!,
    exitPoint,
    turnPoints: [turn1Point, turn2Point],
    routeWaypoints,
    routeSegments: routeOutput.segments,
    warnings: routeWarnings,
    exitToJumpRunErrorFt,
    firstSlickReturnMarginFt: plan.firstSlickReturnMarginFt,
    lastSlickReturnMarginFt: plan.lastSlickReturnMarginFt,
    corridorMarginFt,
    deployRadiusMarginFt,
    firstLegTrackDeltaDeg: Math.abs(firstLegTrackDeltaDeg),
    exitAlongTargetErrorFt,
  };
}

function findBestHeadingForDeployCandidate(
  input: WingsuitAutoInput,
  plan: ResolvedJumpRunPlan,
  gateCandidate: AutoGateCandidate,
  corridorHalfWidthFt: number,
  jumpRunToleranceFt: number,
  maxFirstLegTrackDeltaDeg: number,
  bearingDeg: number,
  radiusFt: number,
  maxRadiusFt: number,
): CandidateEvaluation | null {
  let best: CandidateEvaluation | null = null;

  for (let landingHeadingDeg = 0; landingHeadingDeg < 360; landingHeadingDeg += AUTO_HEADING_COARSE_STEP_DEG) {
    const candidate = evaluateDeployCandidate(
      input,
      plan,
      gateCandidate,
      corridorHalfWidthFt,
      jumpRunToleranceFt,
      maxFirstLegTrackDeltaDeg,
      landingHeadingDeg,
      bearingDeg,
      radiusFt,
      maxRadiusFt,
    );
    if (!candidate) {
      continue;
    }
    if (!best || compareCandidatesForSameDeploy(candidate, best) < 0) {
      best = candidate;
    }
  }

  if (!best) {
    return null;
  }

  for (
    let deltaDeg = -AUTO_HEADING_FINE_SPAN_DEG;
    deltaDeg <= AUTO_HEADING_FINE_SPAN_DEG;
    deltaDeg += 1
  ) {
    const landingHeadingDeg = normalizeHeading(best.landingHeadingDeg + deltaDeg);
    const candidate = evaluateDeployCandidate(
      input,
      plan,
      gateCandidate,
      corridorHalfWidthFt,
      jumpRunToleranceFt,
      maxFirstLegTrackDeltaDeg,
      landingHeadingDeg,
      bearingDeg,
      radiusFt,
      maxRadiusFt,
    );
    if (!candidate) {
      continue;
    }
    if (compareCandidatesForSameDeploy(candidate, best) < 0) {
      best = candidate;
    }
  }

  return best;
}

function findBestRouteForDeployCandidate(
  input: WingsuitAutoInput,
  plan: ResolvedJumpRunPlan,
  gateCandidates: AutoGateCandidate[],
  corridorHalfWidthFt: number,
  jumpRunToleranceFt: number,
  maxFirstLegTrackDeltaDeg: number,
  bearingDeg: number,
  radiusFt: number,
  maxRadiusFt: number,
): CandidateEvaluation | null {
  let best: CandidateEvaluation | null = null;

  for (const gateCandidate of gateCandidates) {
    const candidate = findBestHeadingForDeployCandidate(
      input,
      plan,
      gateCandidate,
      corridorHalfWidthFt,
      jumpRunToleranceFt,
      maxFirstLegTrackDeltaDeg,
      bearingDeg,
      radiusFt,
      maxRadiusFt,
    );
    if (!candidate) {
      continue;
    }
    if (!best || compareCandidatesForSameDeploy(candidate, best) < 0) {
      best = candidate;
    }
    if (candidate.exitToJumpRunErrorFt <= jumpRunToleranceFt) {
      return best;
    }
  }

  return best;
}

function refineCandidate(
  input: WingsuitAutoInput,
  plan: ResolvedJumpRunPlan,
  gateCandidates: AutoGateCandidate[],
  tuning: Required<WingsuitAutoTuning>,
  preferredBearingDeg: number,
  bestCandidate: CandidateEvaluation,
): CandidateEvaluation {
  let current = bestCandidate;
  let bearingStepDeg = tuning.deployBearingStepDeg / 2;
  let radiusStepFt = tuning.deployRadiusStepFt / 2;

  for (let iteration = 0; iteration < tuning.refinementIterations; iteration += 1) {
    let improved = current;

    for (const bearingDelta of [-bearingStepDeg, 0, bearingStepDeg]) {
      const nextBearingDeg = normalizeHeading(current.bearingDeg + bearingDelta);
      const maxRadiusFt = tuning.maxDeployRadiusFt;

      for (const radiusDelta of [-radiusStepFt, 0, radiusStepFt]) {
        const nextRadiusFt = clamp(current.radiusFt + radiusDelta, tuning.minDeployRadiusFt, maxRadiusFt);
        const bestRouteCandidate = findBestRouteForDeployCandidate(
          input,
          plan,
          gateCandidates,
          tuning.corridorHalfWidthFt,
          tuning.exitOnJumpRunToleranceFt,
          tuning.maxFirstLegTrackDeltaDeg,
          nextBearingDeg,
          nextRadiusFt,
          maxRadiusFt,
        );
        if (!bestRouteCandidate) {
          continue;
        }
        if (compareCandidatesWithPreferredBearing(bestRouteCandidate, improved, preferredBearingDeg) < 0) {
          improved = bestRouteCandidate;
        }
      }
    }

    current = improved;
    bearingStepDeg /= 2;
    radiusStepFt /= 2;
  }

  return current;
}

function emptyAutoOutput(
  landingPoint: WingsuitAutoWaypoint,
  resolvedJumpRun: ResolvedJumpRun | null,
  landingNoDeployZonePolygon: GeoPoint[],
  downwindDeployForbiddenZonePolygon: GeoPoint[],
  forbiddenZonePolygon: GeoPoint[],
  diagnostics: WingsuitAutoOutput["diagnostics"],
  warnings: string[],
): WingsuitAutoOutput {
  return {
    blocked: true,
    warnings,
    landingPoint,
    resolvedJumpRun,
    deployPoint: null,
    exitPoint: null,
    turnPoints: [],
    routeWaypoints: [],
    routeSegments: [],
    landingNoDeployZonePolygon,
    downwindDeployForbiddenZonePolygon,
    forbiddenZonePolygon,
    feasibleDeployRegionPolygon: [],
    deployBandsByBearing: [],
    diagnostics,
  };
}

export function solveWingsuitAuto(input: WingsuitAutoInput): WingsuitAutoOutput {
  const validation = validateWingsuitAutoInput(input);
  const turnRatios = resolveTurnRatios(input.turnRatios);
  const tuning = resolveWingsuitAutoTuning(input.tuning);
  const landingPoint = createAutoWaypoint("landing", input.landingPoint, 0);
  const turnHeightsFt = deriveTurnHeightsFt(input, turnRatios);
  const gateCandidates = buildAutoGateCandidates(input, turnRatios);
  const baseDiagnostics: WingsuitAutoOutput["diagnostics"] = {
    headingSource: null,
    constrainedHeadingApplied: false,
    resolvedHeadingDeg: null,
    headwindComponentKt: null,
    crosswindComponentKt: null,
    crosswindOffsetFt: null,
    firstSlickReturnMarginFt: null,
    lastSlickReturnMarginFt: null,
    preferredDeployBearingDeg: null,
    selectedDeployBearingDeg: null,
    selectedDeployRadiusFt: null,
    exitToJumpRunErrorFt: null,
    deployRadiusMarginFt: null,
    firstLegTrackDeltaDeg: null,
    corridorMarginFt: null,
    turnHeightsFt,
    failureReason: null,
  };

  if (!validation.valid) {
    const failureReason = validation.errors[0] ?? "Wingsuit auto input is invalid.";
    return emptyAutoOutput(
      landingPoint,
      null,
      [],
      [],
      [],
      {
        ...baseDiagnostics,
        failureReason,
      },
      [...validation.warnings, ...validation.errors],
    );
  }

  const resolvedPlan = resolveJumpRunPlan(input);
  if (!resolvedPlan) {
    const failureReason = "Jump run could not be resolved from the current settings.";
    return emptyAutoOutput(
      landingPoint,
      null,
      [],
      [],
      [],
      {
        ...baseDiagnostics,
        failureReason,
      },
      [...validation.warnings, failureReason],
    );
  }

  const jumpRunFrame = resolvedPlan.frame;
  const forbiddenZonePolygon = buildForbiddenZonePolygon(
    input.landingPoint,
    jumpRunFrame,
    tuning.corridorHalfWidthFt,
    Math.max(tuning.maxDeployRadiusFt, jumpRunFrame.lengthFt),
  );
  const landingNoDeployZonePolygon = buildCirclePolygon(input.landingPoint, tuning.minDeployRadiusFt);
  const downwindShadeRadiusFt = Math.max(
    tuning.maxDeployRadiusFt,
    jumpRunFrame.lengthFt,
    tuning.minDeployRadiusFt * 2,
  );

  const lowestWindLayer = [...input.winds].sort((a, b) => a.altitudeFt - b.altitudeFt)[0];
  const preferredBearingDeg = lowestWindLayer ? normalizeHeading(lowestWindLayer.dirFromDeg) : null;
  const downwindDeployForbiddenZonePolygon =
    preferredBearingDeg == null
      ? []
      : buildHalfDiskPolygon(
          input.landingPoint,
          normalizeHeading(preferredBearingDeg + 180),
          downwindShadeRadiusFt,
        );

  const setupDiagnostics: WingsuitAutoOutput["diagnostics"] = {
    ...baseDiagnostics,
    headingSource: resolvedPlan.headingSource,
    constrainedHeadingApplied: resolvedPlan.constrainedHeadingApplied,
    resolvedHeadingDeg: resolvedPlan.resolved.headingDeg,
    headwindComponentKt: resolvedPlan.headwindComponentKt,
    crosswindComponentKt: resolvedPlan.crosswindComponentKt,
    crosswindOffsetFt: resolvedPlan.resolved.crosswindOffsetFt,
    firstSlickReturnMarginFt: resolvedPlan.firstSlickReturnMarginFt,
    lastSlickReturnMarginFt: resolvedPlan.lastSlickReturnMarginFt,
  };

  if (resolvedPlan.blockedReason) {
    return emptyAutoOutput(
      landingPoint,
      resolvedPlan.resolved,
      landingNoDeployZonePolygon,
      downwindDeployForbiddenZonePolygon,
      forbiddenZonePolygon,
      {
        ...setupDiagnostics,
        preferredDeployBearingDeg: preferredBearingDeg,
        failureReason: resolvedPlan.blockedReason,
      },
      [...validation.warnings, ...resolvedPlan.warnings, resolvedPlan.blockedReason],
    );
  }

  if (preferredBearingDeg === null) {
    return emptyAutoOutput(
      landingPoint,
      resolvedPlan.resolved,
      landingNoDeployZonePolygon,
      downwindDeployForbiddenZonePolygon,
      forbiddenZonePolygon,
      {
        ...setupDiagnostics,
        failureReason: "Wind model missing required altitude coverage.",
      },
      [...validation.warnings, ...resolvedPlan.warnings, "Wind model missing required altitude coverage."],
    );
  }

  const searchBearings = buildBearingSweep(
    preferredBearingDeg,
    tuning.deployBearingStepDeg,
    tuning.deployBearingWindowHalfDeg,
  );
  const validCandidates: CandidateEvaluation[] = [];
  let nearestMissCandidate: CandidateEvaluation | null = null;
  const bandsByBearing = new Map<number, RadiusBand>();
  let anyOnSelectedSide = false;
  let anyOutsideCorridor = false;
  let anyRouteWithoutFirstLegBound = false;

  for (const bearingDeg of searchBearings) {
    const maxRadiusFt = tuning.maxDeployRadiusFt;
    const startRadiusFt = Math.min(maxRadiusFt, Math.max(tuning.minDeployRadiusFt, tuning.deployRadiusStepFt));
    for (let radiusFt = startRadiusFt; radiusFt <= maxRadiusFt + EPSILON; radiusFt += tuning.deployRadiusStepFt) {
      const deployLocal = scaleLocalPoint(pointToUnitVector(bearingDeg), radiusFt);
      if (!pointIsOnSelectedSide(deployLocal, jumpRunFrame, input.side)) {
        continue;
      }
      anyOnSelectedSide = true;

      if (pointToCorridorMarginFt(jumpRunFrame, deployLocal, tuning.corridorHalfWidthFt) <= 0) {
        continue;
      }
      anyOutsideCorridor = true;

      const bestRouteCandidate = findBestRouteForDeployCandidate(
        input,
        resolvedPlan,
        gateCandidates,
        tuning.corridorHalfWidthFt,
        tuning.exitOnJumpRunToleranceFt,
        tuning.maxFirstLegTrackDeltaDeg,
        bearingDeg,
        radiusFt,
        maxRadiusFt,
      );
      if (!bestRouteCandidate) {
        const relaxedFirstLegCandidate = findBestRouteForDeployCandidate(
          input,
          resolvedPlan,
          gateCandidates,
          tuning.corridorHalfWidthFt,
          tuning.exitOnJumpRunToleranceFt,
          180,
          bearingDeg,
          radiusFt,
          maxRadiusFt,
        );
        if (relaxedFirstLegCandidate) {
          anyRouteWithoutFirstLegBound = true;
        }
      }
      if (!bestRouteCandidate) {
        continue;
      }

      if (
        !nearestMissCandidate ||
        compareCandidatesWithPreferredBearing(bestRouteCandidate, nearestMissCandidate, preferredBearingDeg) < 0
      ) {
        nearestMissCandidate = bestRouteCandidate;
      }

      if (bestRouteCandidate.exitToJumpRunErrorFt <= tuning.exitOnJumpRunToleranceFt) {
        validCandidates.push(bestRouteCandidate);
        const key = Number(normalizeHeading(bearingDeg).toFixed(6));
        const existing = bandsByBearing.get(key);
        if (!existing) {
          bandsByBearing.set(key, {
            bearingDeg: key,
            minRadiusFt: radiusFt,
            maxRadiusFt: radiusFt,
          });
        } else {
          existing.minRadiusFt = Math.min(existing.minRadiusFt, radiusFt);
          existing.maxRadiusFt = Math.max(existing.maxRadiusFt, radiusFt);
        }
      }
    }
  }

  if (validCandidates.length === 0 && nearestMissCandidate) {
    const refinedNearestMiss = refineCandidate(
      input,
      resolvedPlan,
      gateCandidates,
      tuning,
      preferredBearingDeg,
      nearestMissCandidate,
    );
    nearestMissCandidate =
      compareCandidatesWithPreferredBearing(refinedNearestMiss, nearestMissCandidate, preferredBearingDeg) < 0
        ? refinedNearestMiss
        : nearestMissCandidate;

    if (nearestMissCandidate.exitToJumpRunErrorFt <= tuning.exitOnJumpRunToleranceFt) {
      validCandidates.push(nearestMissCandidate);
      bandsByBearing.set(Number(normalizeHeading(nearestMissCandidate.bearingDeg).toFixed(6)), {
        bearingDeg: Number(normalizeHeading(nearestMissCandidate.bearingDeg).toFixed(6)),
        minRadiusFt: nearestMissCandidate.radiusFt,
        maxRadiusFt: nearestMissCandidate.radiusFt,
      });
    }
  }

  if (validCandidates.length === 0) {
    let failureReason = "No deploy point survives route solving on the selected side.";
    if (!anyOnSelectedSide) {
      failureReason = "No deploy point survives the selected side of jump run.";
    } else if (!anyOutsideCorridor) {
      failureReason = "No deploy point survives jump-run corridor exclusion.";
    } else if (anyRouteWithoutFirstLegBound && !nearestMissCandidate) {
      failureReason = `No deploy point keeps the first leg within ${tuning.maxFirstLegTrackDeltaDeg.toFixed(0)}° of jump run.`;
    } else if (nearestMissCandidate) {
      failureReason = `No deploy point returns exit to the resolved jump run; closest miss is ${nearestMissCandidate.exitToJumpRunErrorFt.toFixed(0)} ft.`;
    }

    return emptyAutoOutput(
      landingPoint,
      nearestMissCandidate?.resolvedJumpRun ?? resolvedPlan.resolved,
      landingNoDeployZonePolygon,
      downwindDeployForbiddenZonePolygon,
      forbiddenZonePolygon,
      {
        ...setupDiagnostics,
        crosswindOffsetFt: nearestMissCandidate?.resolvedJumpRun.crosswindOffsetFt ?? setupDiagnostics.crosswindOffsetFt,
        firstSlickReturnMarginFt:
          nearestMissCandidate?.firstSlickReturnMarginFt ?? setupDiagnostics.firstSlickReturnMarginFt,
        lastSlickReturnMarginFt:
          nearestMissCandidate?.lastSlickReturnMarginFt ?? setupDiagnostics.lastSlickReturnMarginFt,
        preferredDeployBearingDeg: preferredBearingDeg,
        selectedDeployBearingDeg: nearestMissCandidate?.bearingDeg ?? null,
        selectedDeployRadiusFt: nearestMissCandidate?.radiusFt ?? null,
        exitToJumpRunErrorFt: nearestMissCandidate?.exitToJumpRunErrorFt ?? null,
        deployRadiusMarginFt: nearestMissCandidate?.deployRadiusMarginFt ?? null,
        firstLegTrackDeltaDeg: nearestMissCandidate?.firstLegTrackDeltaDeg ?? null,
        corridorMarginFt: nearestMissCandidate?.corridorMarginFt ?? null,
        turnHeightsFt: nearestMissCandidate?.turnHeightsFt ?? turnHeightsFt,
        failureReason,
      },
      [...validation.warnings, ...resolvedPlan.warnings, failureReason],
    );
  }

  let bestCandidate = validCandidates.reduce((best, candidate) =>
    compareCandidatesWithPreferredBearing(candidate, best, preferredBearingDeg) < 0 ? candidate : best,
  );

  bestCandidate = refineCandidate(
    input,
    resolvedPlan,
    gateCandidates,
    tuning,
    preferredBearingDeg,
    bestCandidate,
  );

  const deployBandsByBearing = [...bandsByBearing.values()].sort((a, b) => a.bearingDeg - b.bearingDeg);
  const feasibleDeployRegionPolygon = buildBandsPolygon(input.landingPoint, deployBandsByBearing);
  const warnings = [...validation.warnings, ...resolvedPlan.warnings, ...bestCandidate.warnings];

  return {
    blocked: false,
    warnings,
    landingPoint,
    resolvedJumpRun: bestCandidate.resolvedJumpRun,
    deployPoint: bestCandidate.deployPoint,
    exitPoint: bestCandidate.exitPoint,
    turnPoints: bestCandidate.turnPoints,
    routeWaypoints: bestCandidate.routeWaypoints,
    routeSegments: bestCandidate.routeSegments,
    landingNoDeployZonePolygon,
    downwindDeployForbiddenZonePolygon,
    forbiddenZonePolygon,
    feasibleDeployRegionPolygon,
    deployBandsByBearing,
    diagnostics: {
      ...setupDiagnostics,
      crosswindOffsetFt: bestCandidate.resolvedJumpRun.crosswindOffsetFt,
      firstSlickReturnMarginFt: bestCandidate.firstSlickReturnMarginFt,
      lastSlickReturnMarginFt: bestCandidate.lastSlickReturnMarginFt,
      preferredDeployBearingDeg: preferredBearingDeg,
      selectedDeployBearingDeg: bestCandidate.bearingDeg,
      selectedDeployRadiusFt: bestCandidate.radiusFt,
      exitToJumpRunErrorFt: bestCandidate.exitToJumpRunErrorFt,
      deployRadiusMarginFt: bestCandidate.deployRadiusMarginFt,
      firstLegTrackDeltaDeg: bestCandidate.firstLegTrackDeltaDeg,
      corridorMarginFt: bestCandidate.corridorMarginFt,
      turnHeightsFt: bestCandidate.turnHeightsFt,
      failureReason: null,
    },
  };
}

export { latLngToLocalFeet, normalizeHeading, windFromToGroundVector } from "./math";
