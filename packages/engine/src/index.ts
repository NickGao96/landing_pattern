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
const FORWARD_INTEGRATION_MAX_STEP_SEC = 5;
const FORWARD_CANOPY_AIRSPEED_KT = 25;
const FORWARD_CANOPY_GLIDE_RATIO = 2.5;
const FORWARD_CANOPY_DEPLOYMENT_LOSS_FT = 300;
const FORWARD_CANOPY_PATTERN_RESERVE_FT = 1000;
const FORWARD_CANOPY_PREFERRED_MARGIN_FT = 750;
const FORWARD_CORRIDOR_PREFERRED_MARGIN_FT = 1000;
const FORWARD_DEPLOY_PREFERRED_RADIUS_FRACTION = 0.45;
const FORWARD_DEPLOY_PREFERRED_RADIUS_MIN_FT = 2500;
const FORWARD_DEPLOY_PREFERRED_RADIUS_MAX_FT = 4500;
const FORWARD_DEPLOY_PREFERRED_RADIUS_BAND_FT = 750;
const WINGSUIT_DISTANCE_DEFAULT_OFFSET_FT = 4000 * 3.280839895;
const WINGSUIT_DISTANCE_DEFAULT_POST_TURN_FT = 750;
const WINGSUIT_DISTANCE_FIRST_LEG_TARGET_FT = 1800;

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
  firstSlickReturnMarginFt: number | null;
  lastSlickReturnMarginFt: number | null;
  corridorMarginFt: number;
  deployRadiusMarginFt: number;
  firstLegTrackDeltaDeg: number;
  exitAlongTargetErrorFt: number;
  canopyReturnMarginFt: number;
  shapePenalty: number;
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

interface ForwardRouteLeg {
  name: SegmentName;
  headingDeg: number;
  startAltFt: number;
  endAltFt: number;
}

interface ForwardRouteLegResult {
  segment: SegmentComputation;
  start: LocalPoint;
  end: LocalPoint;
}

interface ForwardRouteLegSolveResult {
  leg: ForwardRouteLegResult | null;
  blockedReason?: string;
}

interface ForwardRouteEvaluation {
  candidate: CandidateEvaluation | null;
  rejectionReason: string | null;
}

interface ResolvedJumpRunPlan {
  resolved: ResolvedJumpRun;
  frame: JumpRunFrame;
  targetExitLocal: LocalPoint;
  jumpRunUnit: LocalPoint;
  groupSpacingFt: number;
  placementMode: "normal" | "distance";
  headingSource: WingsuitAutoJumpRunHeadingSource;
  constrainedHeadingApplied: boolean;
  normalJumpRunHeadingDeg: number | null;
  distanceOffsiteFt: number | null;
  headwindComponentKt: number;
  crosswindComponentKt: number;
  firstSlickReturnMarginFt: number | null;
  lastSlickReturnMarginFt: number | null;
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

function positivePart(value: number): number {
  return Math.max(0, value);
}

function square(value: number): number {
  return value * value;
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

function resolveJumpRunPlacementMode(mode: WingsuitAutoInput["jumpRun"]["placementMode"] | undefined): "normal" | "distance" {
  return mode === "distance" ? "distance" : "normal";
}

function resolveDistanceOffsetFt(input: WingsuitAutoInput): number {
  return input.jumpRun.distanceOffsetFt ?? WINGSUIT_DISTANCE_DEFAULT_OFFSET_FT;
}

function resolveDistancePostTurnFt(input: WingsuitAutoInput): number {
  return input.jumpRun.distancePostTurnFt ?? WINGSUIT_DISTANCE_DEFAULT_POST_TURN_FT;
}

function resolveJumpRunPlan(input: WingsuitAutoInput): ResolvedJumpRunPlan | null {
  if (resolveJumpRunPlacementMode(input.jumpRun.placementMode) === "distance") {
    return resolveDistanceJumpRunPlan(input);
  }

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

  const priorSlickGroupCount = Math.max(0, assumptions.groupCount - 1);
  const slickSpanFt = assumptions.groupSeparationFt * Math.max(0, priorSlickGroupCount - 1);
  const lineLengthFt = assumptions.groupSeparationFt * assumptions.groupCount;
  const lineOffset = scaleLocalPoint(leftUnit, crosswindOffsetFt);
  const slickCenterAlongMinFt = -assumptions.slickReturnRadiusFt + slickSpanFt / 2;
  const slickCenterAlongMaxFt = assumptions.slickReturnRadiusFt - slickSpanFt / 2;
  const preferredSlickCenterAlongFt = preferredSpotOffsetAlongFt + assumptions.groupSeparationFt;
  const slickCenterAlongFt = clamp(preferredSlickCenterAlongFt, slickCenterAlongMinFt, slickCenterAlongMaxFt);
  const firstSlickExitAlongFt =
    priorSlickGroupCount > 0 ? slickCenterAlongFt - slickSpanFt / 2 : null;
  const lastSlickExitAlongFt =
    priorSlickGroupCount > 0 ? slickCenterAlongFt + slickSpanFt / 2 : null;
  const firstSlotAlongFt = firstSlickExitAlongFt ?? preferredSpotOffsetAlongFt;
  const startLocal = localPointAdd(
    lineOffset,
    scaleLocalPoint(jumpRunUnit, firstSlotAlongFt - assumptions.groupSeparationFt),
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
    placementMode: "normal",
    headingSource: headingResolution.headingSource,
    constrainedHeadingApplied: headingResolution.constrainedHeadingApplied,
    normalJumpRunHeadingDeg: resolved.headingDeg,
    distanceOffsiteFt: null,
    headwindComponentKt,
    crosswindComponentKt,
    firstSlickReturnMarginFt:
      firstSlickExitAlongFt == null ? null : assumptions.slickReturnRadiusFt - Math.abs(firstSlickExitAlongFt),
    lastSlickReturnMarginFt:
      lastSlickExitAlongFt == null ? null : assumptions.slickReturnRadiusFt - Math.abs(lastSlickExitAlongFt),
    preferredSpotOffsetAlongFt,
    warnings:
      planeGroundSpeedKt <= 45 + EPSILON
        ? ["Aircraft ground speed was clamped to 45 kt for exit-spacing stability."]
        : [],
    blockedReason:
      priorSlickGroupCount > 0 && slickCenterAlongMaxFt < slickCenterAlongMinFt
        ? `Jump run cannot fit ${priorSlickGroupCount} slick groups inside the ${assumptions.slickReturnRadiusFt.toFixed(0)} ft return radius.`
        : null,
  };
}

function resolveDistanceJumpRunPlan(input: WingsuitAutoInput): ResolvedJumpRunPlan | null {
  const assumptions = resolveJumpRunAssumptions(input.jumpRun.assumptions);
  const headingResolution = resolveJumpRunHeading(input);
  if (!headingResolution) {
    return null;
  }

  const normalHeadingDeg = headingResolution.headingDeg;
  const sideSign = input.side === "left" ? -1 : 1;
  const distanceRunHeadingDeg = normalizeHeading(normalHeadingDeg + sideSign * 90);
  const normalJumpRunUnit = pointToUnitVector(normalHeadingDeg);
  const distanceRunUnit = pointToUnitVector(distanceRunHeadingDeg);
  const distanceOffsetFt = resolveDistanceOffsetFt(input);
  const postTurnFt = resolveDistancePostTurnFt(input);
  const turnAnchorLocal = scaleLocalPoint(normalJumpRunUnit, distanceOffsetFt);
  const targetExitLocal = localPointAdd(turnAnchorLocal, scaleLocalPoint(distanceRunUnit, postTurnFt));
  const linePaddingFt = Math.max(assumptions.groupSeparationFt, postTurnFt + 750, 1500);
  const startLocal = localPointAdd(targetExitLocal, scaleLocalPoint(distanceRunUnit, -linePaddingFt));
  const endLocal = localPointAdd(targetExitLocal, scaleLocalPoint(distanceRunUnit, linePaddingFt));
  const lineLengthFt = 2 * linePaddingFt;

  const exitWind = getWindForAltitude(input.exitHeightFt, input.winds);
  const deployWind = getWindForAltitude(input.deployHeightFt, input.winds) ?? exitWind;
  const planeAirspeedVecKt = scaleVec(localPointToVec(distanceRunUnit), assumptions.planeAirspeedKt);
  const exitWindVecKt = exitWind ? windFromToGroundVector(exitWind.speedKt, exitWind.dirFromDeg) : { east: 0, north: 0 };
  const planeGroundSpeedKt = Math.max(45, dot(addVec(planeAirspeedVecKt, exitWindVecKt), localPointToVec(distanceRunUnit)));
  const deployWindVecKt = deployWind ? windFromToGroundVector(deployWind.speedKt, deployWind.dirFromDeg) : { east: 0, north: 0 };
  const leftUnit = { eastFt: -distanceRunUnit.northFt, northFt: distanceRunUnit.eastFt };
  const headwindComponentKt = -dot(deployWindVecKt, localPointToVec(distanceRunUnit));
  const crosswindComponentKt = dot(deployWindVecKt, localPointToVec(leftUnit));
  const slot = createResolvedJumpRunSlot(input, targetExitLocal, 0, 1);
  const resolved: ResolvedJumpRun = {
    line: {
      start: geoPointFromLocal(input.landingPoint, startLocal),
      end: geoPointFromLocal(input.landingPoint, endLocal),
    },
    headingDeg: vectorToHeadingDeg(localPointToVec(distanceRunUnit)),
    lengthFt: lineLengthFt,
    crosswindOffsetFt: 0,
    planeGroundSpeedKt,
    groupSpacingFt: assumptions.groupSeparationFt,
    groupSpacingSec: assumptions.groupSeparationFt / Math.max(knotsToFeetPerSecond(planeGroundSpeedKt), EPSILON),
    slots: [slot],
  };
  const frame = buildJumpRunFrame(input.landingPoint, resolved.line);
  if (!frame) {
    return null;
  }

  return {
    resolved,
    frame,
    targetExitLocal,
    jumpRunUnit: distanceRunUnit,
    groupSpacingFt: assumptions.groupSeparationFt,
    placementMode: "distance",
    headingSource: headingResolution.headingSource,
    constrainedHeadingApplied: headingResolution.constrainedHeadingApplied,
    normalJumpRunHeadingDeg: normalHeadingDeg,
    distanceOffsiteFt: distanceOffsetFt,
    headwindComponentKt,
    crosswindComponentKt,
    firstSlickReturnMarginFt: null,
    lastSlickReturnMarginFt: null,
    preferredSpotOffsetAlongFt: distanceOffsetFt,
    warnings:
      planeGroundSpeedKt <= 45 + EPSILON
        ? ["Aircraft ground speed was clamped to 45 kt for exit-spacing stability."]
        : [],
    blockedReason: null,
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

  const preferredDrop1 = 1 - preferredRatios.turn1;
  const preferredDrop2 = preferredRatios.turn1 - preferredRatios.turn2;
  const legDropFractions: Array<[number, number]> = [
    [preferredDrop1 - 0.07, preferredDrop2 + 0.08],
    [preferredDrop1 + 0.07, preferredDrop2 - 0.08],
    [0.18, 0.35],
    [0.18, 0.44],
    [0.25, 0.44],
    [0.25, 0.52],
    [0.32, 0.35],
    [0.32, 0.44],
  ];

  for (const [rawDrop1, rawDrop2] of legDropFractions) {
    const drop1 = clamp(rawDrop1, 0.1, 0.6);
    const drop2 = clamp(rawDrop2, 0.2, 0.7);
    const drop3 = 1 - drop1 - drop2;
    if (!(drop1 > 0 && drop2 > 0 && drop3 >= 0.15)) {
      continue;
    }
    const turn1Ratio = 1 - drop1;
    const turn2Ratio = drop3;
    candidates.push(
      createAutoGateCandidate(
        input.exitHeightFt,
        input.deployHeightFt + spanFt * turn1Ratio,
        input.deployHeightFt + spanFt * turn2Ratio,
        input.deployHeightFt,
      ),
    );
  }

  const deduped = new Map<string, AutoGateCandidate>();
  for (const candidate of candidates) {
    const key = candidate.gatesFt.map((value) => value.toFixed(2)).join("|");
    deduped.set(key, candidate);
  }
  return [...deduped.values()];
}

function buildDistanceAutoGateCandidates(
  input: WingsuitAutoInput,
  _preferredRatios: WingsuitAutoTurnRatios,
): AutoGateCandidate[] {
  const spanFt = input.exitHeightFt - input.deployHeightFt;
  const candidates: AutoGateCandidate[] = [];

  const legDropFractions: Array<[number, number]> = [
    [0.06, 0.47],
    [0.08, 0.46],
    [0.1, 0.45],
    [0.12, 0.44],
    [0.15, 0.42],
    [0.18, 0.4],
    [0.22, 0.38],
    [0.28, 0.34],
    [0.34, 0.3],
    [0.45, 0.25],
    [0.55, 0.2],
  ];

  for (const [drop1, drop2] of legDropFractions) {
    const drop3 = 1 - drop1 - drop2;
    if (!(drop1 > 0 && drop2 > 0 && drop3 >= 0.25)) {
      continue;
    }
    const turn1Ratio = 1 - drop1;
    const turn2Ratio = drop3;
    candidates.push(
      createAutoGateCandidate(
        input.exitHeightFt,
        input.deployHeightFt + spanFt * turn1Ratio,
        input.deployHeightFt + spanFt * turn2Ratio,
        input.deployHeightFt,
      ),
    );
  }

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
  const placementMode = resolveJumpRunPlacementMode(input.jumpRun.placementMode);
  if (directionMode === "manual" && !Number.isFinite(input.jumpRun.manualHeadingDeg)) {
    errors.push("Manual jump-run direction requires a finite heading.");
  }
  if (constraintMode === "reciprocal" && !Number.isFinite(input.jumpRun.constraintHeadingDeg)) {
    errors.push("Reciprocal jump-run constraint requires a finite runway heading.");
  }
  if (placementMode === "distance") {
    const distanceOffsetFt = resolveDistanceOffsetFt(input);
    const postTurnFt = resolveDistancePostTurnFt(input);
    if (!Number.isFinite(distanceOffsetFt) || distanceOffsetFt <= 0) {
      errors.push("Distance-mode offsite distance must be finite and positive.");
    }
    if (!Number.isFinite(postTurnFt) || postTurnFt < 0) {
      errors.push("Distance-mode post-turn offset must be finite and nonnegative.");
    }
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
    if (!Number.isInteger(assumptions.groupCount) || assumptions.groupCount < 1) {
      errors.push("Wingsuit exit group must be an integer of at least 1.");
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

function isStrictThreeLegGate(candidate: AutoGateCandidate): boolean {
  const [exitHeightFt, turn1HeightFt, turn2HeightFt, deployHeightFt] = candidate.gatesFt;
  return exitHeightFt > turn1HeightFt && turn1HeightFt > turn2HeightFt && turn2HeightFt > deployHeightFt;
}

function uniqueNormalizedHeadings(headings: number[]): number[] {
  return Array.from(new Set(headings.map((heading) => Number(normalizeHeading(heading).toFixed(6)))));
}

function buildFirstLegHeadingCandidates(
  jumpRunHeadingDeg: number,
  side: WingsuitAutoInput["side"],
  maxFirstLegTrackDeltaDeg: number,
): number[] {
  const sideSign = side === "left" ? -1 : 1;
  const positiveDeltas = [0, 10, 20, 30, 40, 45]
    .filter((delta) => delta <= maxFirstLegTrackDeltaDeg + EPSILON);
  if (maxFirstLegTrackDeltaDeg >= 0 && !positiveDeltas.some((delta) => Math.abs(delta - maxFirstLegTrackDeltaDeg) < EPSILON)) {
    positiveDeltas.push(maxFirstLegTrackDeltaDeg);
  }
  const nonNegativeDeltas = positiveDeltas.filter((delta) => delta >= 0).sort((a, b) => a - b);
  return uniqueNormalizedHeadings(nonNegativeDeltas.map((delta) => jumpRunHeadingDeg + sideSign * delta));
}

function buildOffsetHeadingCandidates(
  jumpRunHeadingDeg: number,
  side: WingsuitAutoInput["side"],
): number[] {
  const sideSign = side === "left" ? -1 : 1;
  return uniqueNormalizedHeadings([60, 75, 90, 105, 120, 135].map((delta) => jumpRunHeadingDeg + sideSign * delta));
}

function buildReturnHeadingCandidates(
  jumpRunHeadingDeg: number,
  side: WingsuitAutoInput["side"],
  turn2Local: LocalPoint | null,
): number[] {
  const returnSign = side === "left" ? 1 : -1;
  const headings = [120, 135, 150, 165, 180, 195, 210].map(
    (delta) => jumpRunHeadingDeg + returnSign * delta,
  );

  if (turn2Local && localPointMagnitude(turn2Local) > EPSILON) {
    const directToLandingDeg = vectorToHeadingDeg({
      east: -turn2Local.eastFt,
      north: -turn2Local.northFt,
    });
    headings.push(directToLandingDeg, directToLandingDeg - 15, directToLandingDeg + 15);
  }

  return uniqueNormalizedHeadings(headings);
}

function buildDistanceFirstLegHeadingCandidates(
  distanceRunHeadingDeg: number,
  side: WingsuitAutoInput["side"],
  maxFirstLegTrackDeltaDeg: number,
): number[] {
  const sideSign = side === "left" ? -1 : 1;
  const positiveDeltas = [0, 5, 10, 15, 20, 30, 40]
    .filter((delta) => delta <= maxFirstLegTrackDeltaDeg + EPSILON);
  return uniqueNormalizedHeadings(positiveDeltas.map((delta) => distanceRunHeadingDeg + sideSign * delta));
}

function buildDistanceReturnHeadingCandidates(
  normalJumpRunHeadingDeg: number | null,
  _previewLocal: LocalPoint | null,
): number[] {
  const returnHeadingDeg = normalizeHeading((normalJumpRunHeadingDeg ?? 0) + 180);
  return uniqueNormalizedHeadings([-35, -25, -15, -5, 0, 5, 15, 25, 35].map((delta) => returnHeadingDeg + delta));
}

function segmentToOutput(segment: SegmentComputation): PatternOutput["segments"][number] {
  return {
    name: segment.name,
    headingDeg: segment.headingDeg,
    trackHeadingDeg: segment.trackHeadingDeg,
    alongLegSpeedKt: segment.alongLegSpeedKt,
    groundSpeedKt: segment.groundSpeedKt,
    timeSec: segment.timeSec,
    distanceFt: segment.distanceFt,
  };
}

function computeForwardDriftLeg(
  leg: ForwardRouteLeg,
  startPoint: LocalPoint,
  winds: WindLayer[],
  airspeedKt: number,
  fallRateFps: number,
): ForwardRouteLegSolveResult {
  const altitudeLossFt = leg.startAltFt - leg.endAltFt;
  if (!(altitudeLossFt > 0) || !(fallRateFps > 0)) {
    return {
      leg: null,
      blockedReason: `${leg.name} leg has invalid altitude or fall-rate inputs.`,
    };
  }

  const totalTimeSec = altitudeLossFt / fallRateFps;
  const stepCount = Math.max(1, Math.ceil(totalTimeSec / FORWARD_INTEGRATION_MAX_STEP_SEC));
  const stepAltitudeLossFt = altitudeLossFt / stepCount;
  const airUnit = headingToUnitVector(leg.headingDeg);
  const airVectorKt = scaleVec(airUnit, airspeedKt);
  let currentPoint = startPoint;
  let distanceFt = 0;

  for (let index = 0; index < stepCount; index += 1) {
    const stepStartAltFt = leg.startAltFt - stepAltitudeLossFt * index;
    const sampleAltFt = stepStartAltFt - stepAltitudeLossFt / 2;
    const wind = getWindForAltitude(sampleAltFt, winds);
    const windVectorKt = wind ? windFromToGroundVector(wind.speedKt, wind.dirFromDeg) : { east: 0, north: 0 };
    const groundVectorKt = addVec(airVectorKt, windVectorKt);
    const stepTimeSec = stepAltitudeLossFt / fallRateFps;
    const stepDisplacement = scaleLocalPoint(
      { eastFt: groundVectorKt.east, northFt: groundVectorKt.north },
      knotsToFeetPerSecond(1) * stepTimeSec,
    );
    currentPoint = localPointAdd(currentPoint, stepDisplacement);
    distanceFt += localPointMagnitude(stepDisplacement);
  }

  const totalDisplacement = localPointDifference(currentPoint, startPoint);
  const averageGroundVectorKt = {
    east: totalDisplacement.eastFt / Math.max(knotsToFeetPerSecond(1) * totalTimeSec, EPSILON),
    north: totalDisplacement.northFt / Math.max(knotsToFeetPerSecond(1) * totalTimeSec, EPSILON),
  };
  const groundSpeedKt = magnitude(averageGroundVectorKt);
  if (groundSpeedKt < 0.1) {
    return {
      leg: null,
      blockedReason: `${leg.name} leg has near-zero ground speed.`,
    };
  }

  return {
    leg: {
      start: startPoint,
      end: currentPoint,
      segment: {
        name: leg.name,
        headingDeg: leg.headingDeg,
        trackHeadingDeg: vectorToHeadingDeg(averageGroundVectorKt),
        alongLegSpeedKt: dot(averageGroundVectorKt, airUnit),
        groundVectorKt: averageGroundVectorKt,
        groundSpeedKt,
        timeSec: totalTimeSec,
        distanceFt,
      },
    },
  };
}

function simulateForwardRoute(
  legs: ForwardRouteLeg[],
  startPoint: LocalPoint,
  input: WingsuitAutoInput,
): { legs: ForwardRouteLegResult[]; blockedReason: string | null } {
  const results: ForwardRouteLegResult[] = [];
  let currentPoint = startPoint;

  for (const leg of legs) {
    const solved = computeForwardDriftLeg(
      leg,
      currentPoint,
      input.winds,
      input.wingsuit.flightSpeedKt,
      input.wingsuit.fallRateFps,
    );
    if (!solved.leg) {
      return { legs: results, blockedReason: solved.blockedReason ?? `${leg.name} leg could not be solved.` };
    }
    results.push(solved.leg);
    currentPoint = solved.leg.end;
  }

  return { legs: results, blockedReason: null };
}

function previewTurn2Local(
  input: WingsuitAutoInput,
  plan: ResolvedJumpRunPlan,
  gateCandidate: AutoGateCandidate,
  firstLegHeadingDeg: number,
  offsetHeadingDeg: number,
): LocalPoint | null {
  const preview = simulateForwardRoute(
    [
      {
        name: "downwind",
        headingDeg: firstLegHeadingDeg,
        startAltFt: gateCandidate.gatesFt[0],
        endAltFt: gateCandidate.gatesFt[1],
      },
      {
        name: "base",
        headingDeg: offsetHeadingDeg,
        startAltFt: gateCandidate.gatesFt[1],
        endAltFt: gateCandidate.gatesFt[2],
      },
    ],
    plan.targetExitLocal,
    input,
  );
  return preview.blockedReason || preview.legs.length < 2 ? null : preview.legs[1]!.end;
}

function computeCanopyReturnMarginFt(input: WingsuitAutoInput, deployLocal: LocalPoint): number {
  const distanceFt = localPointMagnitude(deployLocal);
  if (distanceFt <= EPSILON) {
    return input.deployHeightFt - FORWARD_CANOPY_DEPLOYMENT_LOSS_FT - FORWARD_CANOPY_PATTERN_RESERVE_FT;
  }

  const returnUnit = normalizeLocalPoint(scaleLocalPoint(deployLocal, -1));
  const sampleAltFt = Math.max(0, input.deployHeightFt / 2);
  const wind = getWindForAltitude(sampleAltFt, input.winds);
  const windVectorKt = wind ? windFromToGroundVector(wind.speedKt, wind.dirFromDeg) : { east: 0, north: 0 };
  const windAlongKt = dot(windVectorKt, localPointToVec(returnUnit));
  const groundSpeedKt = FORWARD_CANOPY_AIRSPEED_KT + windAlongKt;
  if (groundSpeedKt <= 5) {
    return Number.NEGATIVE_INFINITY;
  }

  const canopySinkFps = knotsToFeetPerSecond(FORWARD_CANOPY_AIRSPEED_KT) / FORWARD_CANOPY_GLIDE_RATIO;
  const returnTimeSec = distanceFt / knotsToFeetPerSecond(groundSpeedKt);
  const altitudeLostFt = FORWARD_CANOPY_DEPLOYMENT_LOSS_FT + canopySinkFps * returnTimeSec;
  return input.deployHeightFt - FORWARD_CANOPY_PATTERN_RESERVE_FT - altitudeLostFt;
}

function computeForwardShapePenalty(
  input: WingsuitAutoInput,
  jumpRunHeadingDeg: number,
  firstTrackHeadingDeg: number,
  offsetTrackHeadingDeg: number,
  returnTrackHeadingDeg: number,
): number {
  const sideSign = input.side === "left" ? -1 : 1;
  const firstTargetHeadingDeg = normalizeHeading(jumpRunHeadingDeg + sideSign * 15);
  const offsetTargetHeadingDeg = normalizeHeading(jumpRunHeadingDeg + sideSign * 90);
  const returnTargetHeadingDeg = normalizeHeading(jumpRunHeadingDeg + 180);

  return (
    0.5 * square(absoluteHeadingDeltaDeg(firstTrackHeadingDeg, firstTargetHeadingDeg) / 20) +
    1.5 * square(absoluteHeadingDeltaDeg(offsetTrackHeadingDeg, offsetTargetHeadingDeg) / 20) +
    1.5 * square(absoluteHeadingDeltaDeg(returnTrackHeadingDeg, returnTargetHeadingDeg) / 25)
  );
}

function computeDistanceShapePenalty(
  input: WingsuitAutoInput,
  distanceRunHeadingDeg: number,
  normalJumpRunHeadingDeg: number | null,
  firstTrackHeadingDeg: number,
  offsetTrackHeadingDeg: number,
  returnTrackHeadingDeg: number,
  firstLegDistanceFt: number,
): number {
  const sideSign = input.side === "left" ? -1 : 1;
  const firstTargetHeadingDeg = normalizeHeading(distanceRunHeadingDeg + sideSign * 10);
  const returnTargetHeadingDeg = normalizeHeading((normalJumpRunHeadingDeg ?? distanceRunHeadingDeg) + 180);
  const shortFirstLegPenalty =
    4 * square(positivePart(firstLegDistanceFt - WINGSUIT_DISTANCE_FIRST_LEG_TARGET_FT) / 700) +
    0.35 * square(positivePart(900 - firstLegDistanceFt) / 900);

  return (
    square(absoluteHeadingDeltaDeg(firstTrackHeadingDeg, firstTargetHeadingDeg) / 15) +
    3 * square(absoluteHeadingDeltaDeg(offsetTrackHeadingDeg, returnTargetHeadingDeg) / 14) +
    3 * square(absoluteHeadingDeltaDeg(returnTrackHeadingDeg, returnTargetHeadingDeg) / 14) +
    1.6 * shortFirstLegPenalty
  );
}

function evaluateForwardRouteCandidate(
  input: WingsuitAutoInput,
  plan: ResolvedJumpRunPlan,
  gateCandidate: AutoGateCandidate,
  tuning: Required<WingsuitAutoTuning>,
  forbiddenDeployBearingDeg: number | null,
  firstLegHeadingDeg: number,
  offsetHeadingDeg: number,
  returnHeadingDeg: number,
): ForwardRouteEvaluation {
  if (!isStrictThreeLegGate(gateCandidate)) {
    return { candidate: null, rejectionReason: "inactive-leg" };
  }

  const legs: ForwardRouteLeg[] = [
    {
      name: "downwind",
      headingDeg: firstLegHeadingDeg,
      startAltFt: gateCandidate.gatesFt[0],
      endAltFt: gateCandidate.gatesFt[1],
    },
    {
      name: "base",
      headingDeg: offsetHeadingDeg,
      startAltFt: gateCandidate.gatesFt[1],
      endAltFt: gateCandidate.gatesFt[2],
    },
    {
      name: "final",
      headingDeg: returnHeadingDeg,
      startAltFt: gateCandidate.gatesFt[2],
      endAltFt: gateCandidate.gatesFt[3],
    },
  ];
  const simulation = simulateForwardRoute(legs, plan.targetExitLocal, input);
  if (simulation.blockedReason || simulation.legs.length !== 3) {
    return { candidate: null, rejectionReason: "nonpositive-ground-speed" };
  }

  const firstSegment = simulation.legs[0]!.segment;
  const jumpRunHeadingDeg = plan.resolved.headingDeg;
  const firstLegTrackDeltaDeg = signedHeadingDeltaDeg(jumpRunHeadingDeg, firstSegment.trackHeadingDeg);
  const firstLegWithinBound =
    input.side === "left"
      ? firstLegTrackDeltaDeg >= -tuning.maxFirstLegTrackDeltaDeg && firstLegTrackDeltaDeg <= 0
      : firstLegTrackDeltaDeg >= 0 && firstLegTrackDeltaDeg <= tuning.maxFirstLegTrackDeltaDeg;
  if (!firstLegWithinBound) {
    return { candidate: null, rejectionReason: "first-leg-track" };
  }

  const turn1Local = simulation.legs[0]!.end;
  const turn2Local = simulation.legs[1]!.end;
  const deployLocal = simulation.legs[2]!.end;
  const checkedPoints = [turn1Local, turn2Local, deployLocal];
  if (!checkedPoints.every((point) => pointIsOnSelectedSide(point, plan.frame, input.side))) {
    return { candidate: null, rejectionReason: "selected-side" };
  }

  const pointMargins = checkedPoints.map((point) =>
    pointToCorridorMarginFt(plan.frame, point, tuning.corridorHalfWidthFt),
  );
  const routeMargins = [
    segmentOutsideFiniteCorridor(plan.frame, turn1Local, turn2Local, tuning.corridorHalfWidthFt, input.side, 16),
    segmentOutsideFiniteCorridor(plan.frame, turn2Local, deployLocal, tuning.corridorHalfWidthFt, input.side, 16),
  ];
  if (pointMargins.some((margin) => margin <= 0) || routeMargins.some((margin) => !margin.valid)) {
    return { candidate: null, rejectionReason: "corridor" };
  }

  const radiusFt = localPointMagnitude(deployLocal);
  if (radiusFt < tuning.minDeployRadiusFt || radiusFt > tuning.maxDeployRadiusFt) {
    return { candidate: null, rejectionReason: "deploy-radius" };
  }
  const bearingDeg = vectorToHeadingDeg(localPointToVec(deployLocal));
  if (
    forbiddenDeployBearingDeg != null &&
    absoluteHeadingDeltaDeg(bearingDeg, forbiddenDeployBearingDeg) <= tuning.deployBearingWindowHalfDeg
  ) {
    return { candidate: null, rejectionReason: "wind-no-deploy-zone" };
  }

  const canopyReturnMarginFt = computeCanopyReturnMarginFt(input, deployLocal);
  if (canopyReturnMarginFt < 0) {
    return { candidate: null, rejectionReason: "canopy-return" };
  }

  const exitGeo = geoPointFromLocal(input.landingPoint, plan.targetExitLocal);
  const turn1Geo = geoPointFromLocal(input.landingPoint, turn1Local);
  const turn2Geo = geoPointFromLocal(input.landingPoint, turn2Local);
  const deployGeo = geoPointFromLocal(input.landingPoint, deployLocal);
  const routeWaypoints: WingsuitAutoWaypoint[] = [
    createAutoWaypoint("exit", exitGeo, gateCandidate.gatesFt[0]),
    createAutoWaypoint("turn1", turn1Geo, gateCandidate.gatesFt[1]),
    createAutoWaypoint("turn2", turn2Geo, gateCandidate.gatesFt[2]),
    createAutoWaypoint("deploy", deployGeo, gateCandidate.gatesFt[3]),
  ];
  const corridorMarginFt = Math.min(...pointMargins, ...routeMargins.map((margin) => margin.marginFt));
  const shapePenalty = computeForwardShapePenalty(
    input,
    jumpRunHeadingDeg,
    simulation.legs[0]!.segment.trackHeadingDeg,
    simulation.legs[1]!.segment.trackHeadingDeg,
    simulation.legs[2]!.segment.trackHeadingDeg,
  );
  const distanceShapePenalty = computeDistanceShapePenalty(
    input,
    jumpRunHeadingDeg,
    plan.normalJumpRunHeadingDeg,
    simulation.legs[0]!.segment.trackHeadingDeg,
    simulation.legs[1]!.segment.trackHeadingDeg,
    simulation.legs[2]!.segment.trackHeadingDeg,
    simulation.legs[0]!.segment.distanceFt,
  );

  return {
    candidate: {
      landingHeadingDeg: returnHeadingDeg,
      bearingDeg,
      radiusFt,
      turnHeightsFt: gateCandidate.turnHeightsFt,
      resolvedJumpRun: plan.resolved,
      deployPoint: routeWaypoints[3]!,
      exitPoint: routeWaypoints[0]!,
      turnPoints: [routeWaypoints[1]!, routeWaypoints[2]!],
      routeWaypoints,
      routeSegments: simulation.legs.map((leg) => segmentToOutput(leg.segment)),
      warnings: [],
      exitToJumpRunErrorFt: 0,
      firstSlickReturnMarginFt: plan.firstSlickReturnMarginFt,
      lastSlickReturnMarginFt: plan.lastSlickReturnMarginFt,
      corridorMarginFt,
      deployRadiusMarginFt: tuning.maxDeployRadiusFt - radiusFt,
      firstLegTrackDeltaDeg: Math.abs(firstLegTrackDeltaDeg),
      exitAlongTargetErrorFt: 0,
      canopyReturnMarginFt,
      shapePenalty: plan.placementMode === "distance" ? distanceShapePenalty : shapePenalty,
    },
    rejectionReason: null,
  };
}

function compareForwardCandidates(a: CandidateEvaluation, b: CandidateEvaluation): number {
  return computeForwardCandidateScore(a) - computeForwardCandidateScore(b);
}

function computeForwardCandidateScore(candidate: CandidateEvaluation): number {
  const canopyShortfallFt = positivePart(FORWARD_CANOPY_PREFERRED_MARGIN_FT - candidate.canopyReturnMarginFt);
  const corridorShortfallFt = positivePart(FORWARD_CORRIDOR_PREFERRED_MARGIN_FT - candidate.corridorMarginFt);
  const safetyPenalty =
    square(canopyShortfallFt / 500) +
    square(corridorShortfallFt / 500);
  const preferredRadiusFt = clamp(
    (candidate.radiusFt + candidate.deployRadiusMarginFt) * FORWARD_DEPLOY_PREFERRED_RADIUS_FRACTION,
    FORWARD_DEPLOY_PREFERRED_RADIUS_MIN_FT,
    FORWARD_DEPLOY_PREFERRED_RADIUS_MAX_FT,
  );
  const radiusShortfallFt = positivePart(
    preferredRadiusFt - FORWARD_DEPLOY_PREFERRED_RADIUS_BAND_FT - candidate.radiusFt,
  );
  const radiusExcessFt = positivePart(
    candidate.radiusFt - preferredRadiusFt - FORWARD_DEPLOY_PREFERRED_RADIUS_BAND_FT,
  );
  const radiusPenalty =
    square(radiusShortfallFt / 1000) +
    0.25 * square(radiusExcessFt / 1000);
  const saturatedSafetyReward =
    0.01 * Math.min(candidate.canopyReturnMarginFt, 1000) +
    0.01 * Math.min(candidate.corridorMarginFt, 1000);

  return (
    1000 * safetyPenalty +
    50 * candidate.shapePenalty +
    40 * radiusPenalty -
    saturatedSafetyReward
  );
}

function addCandidateToBands(
  bandsByBearing: Map<number, RadiusBand>,
  candidate: CandidateEvaluation,
  bearingStepDeg: number,
  forbiddenDeployBearingDeg: number | null,
  forbiddenDeployBearingHalfWidthDeg: number,
): void {
  const safeStepDeg = Math.max(1, bearingStepDeg);
  const roundedKey = Number(
    normalizeHeading(Math.round(candidate.bearingDeg / safeStepDeg) * safeStepDeg).toFixed(6),
  );
  const key =
    forbiddenDeployBearingDeg != null &&
    absoluteHeadingDeltaDeg(roundedKey, forbiddenDeployBearingDeg) <= forbiddenDeployBearingHalfWidthDeg
      ? normalizeHeading(candidate.bearingDeg)
      : roundedKey;
  const existing = bandsByBearing.get(key);
  if (!existing) {
    bandsByBearing.set(key, {
      bearingDeg: key,
      minRadiusFt: candidate.radiusFt,
      maxRadiusFt: candidate.radiusFt,
    });
    return;
  }
  existing.minRadiusFt = Math.min(existing.minRadiusFt, candidate.radiusFt);
  existing.maxRadiusFt = Math.max(existing.maxRadiusFt, candidate.radiusFt);
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
  const placementMode = resolveJumpRunPlacementMode(input.jumpRun.placementMode);
  const baseTuning = resolveWingsuitAutoTuning(input.tuning);
  const tuning =
    placementMode === "distance"
      ? {
          ...baseTuning,
          maxDeployRadiusFt: Math.max(baseTuning.maxDeployRadiusFt, resolveDistanceOffsetFt(input)),
        }
      : baseTuning;
  const landingPoint = createAutoWaypoint("landing", input.landingPoint, 0);
  const turnHeightsFt = deriveTurnHeightsFt(input, turnRatios);
  const gateCandidates = buildAutoGateCandidates(input, turnRatios);
  const baseDiagnostics: WingsuitAutoOutput["diagnostics"] = {
    headingSource: null,
    placementMode,
    constrainedHeadingApplied: false,
    resolvedHeadingDeg: null,
    normalJumpRunHeadingDeg: null,
    distanceOffsiteFt: null,
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
  const forbiddenDeployBearingDeg =
    preferredBearingDeg == null ? null : normalizeHeading(preferredBearingDeg + 180);
  const downwindDeployForbiddenZonePolygon =
    preferredBearingDeg == null
      ? []
      : buildHalfDiskPolygon(
          input.landingPoint,
          forbiddenDeployBearingDeg ?? 0,
          downwindShadeRadiusFt,
        );

  const setupDiagnostics: WingsuitAutoOutput["diagnostics"] = {
    ...baseDiagnostics,
    headingSource: resolvedPlan.headingSource,
    placementMode: resolvedPlan.placementMode,
    constrainedHeadingApplied: resolvedPlan.constrainedHeadingApplied,
    resolvedHeadingDeg: resolvedPlan.resolved.headingDeg,
    normalJumpRunHeadingDeg: resolvedPlan.normalJumpRunHeadingDeg,
    distanceOffsiteFt: resolvedPlan.distanceOffsiteFt,
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

  const validCandidates: CandidateEvaluation[] = [];
  const bandsByBearing = new Map<number, RadiusBand>();
  const rejectionCounts = new Map<string, number>();
  const recordRejection = (reason: string | null): void => {
    if (!reason) {
      return;
    }
    rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
  };
  const forwardGateCandidates = (placementMode === "distance"
    ? buildDistanceAutoGateCandidates(input, turnRatios)
    : gateCandidates
  ).filter(isStrictThreeLegGate);

  for (const gateCandidate of forwardGateCandidates) {
    const firstLegHeadings =
      placementMode === "distance"
        ? buildDistanceFirstLegHeadingCandidates(
            resolvedPlan.resolved.headingDeg,
            input.side,
            tuning.maxFirstLegTrackDeltaDeg,
          )
        : buildFirstLegHeadingCandidates(
            resolvedPlan.resolved.headingDeg,
            input.side,
            tuning.maxFirstLegTrackDeltaDeg,
          );
    const offsetHeadings =
      placementMode === "distance"
        ? buildDistanceReturnHeadingCandidates(resolvedPlan.normalJumpRunHeadingDeg, null)
        : buildOffsetHeadingCandidates(resolvedPlan.resolved.headingDeg, input.side);

    for (const firstLegHeadingDeg of firstLegHeadings) {
      for (const offsetHeadingDeg of offsetHeadings) {
        const turn2Preview = previewTurn2Local(
          input,
          resolvedPlan,
          gateCandidate,
          firstLegHeadingDeg,
          offsetHeadingDeg,
        );
        const returnHeadings =
          placementMode === "distance"
            ? buildDistanceReturnHeadingCandidates(resolvedPlan.normalJumpRunHeadingDeg, turn2Preview)
            : buildReturnHeadingCandidates(
                resolvedPlan.resolved.headingDeg,
                input.side,
                turn2Preview,
              );

        for (const returnHeadingDeg of returnHeadings) {
          const result = evaluateForwardRouteCandidate(
            input,
            resolvedPlan,
            gateCandidate,
            tuning,
            forbiddenDeployBearingDeg,
            firstLegHeadingDeg,
            offsetHeadingDeg,
            returnHeadingDeg,
          );
          if (!result.candidate) {
            recordRejection(result.rejectionReason);
            continue;
          }
          validCandidates.push(result.candidate);
          addCandidateToBands(
            bandsByBearing,
            result.candidate,
            tuning.deployBearingStepDeg,
            forbiddenDeployBearingDeg,
            tuning.deployBearingWindowHalfDeg,
          );
        }
      }
    }
  }

  if (validCandidates.length === 0) {
    let failureReason = "No forward wingsuit route reaches a safe deployment point.";
    const rejectionEntries = [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1]);
    const dominantReason = rejectionEntries[0]?.[0] ?? null;
    if (forwardGateCandidates.length === 0) {
      failureReason = "No three-leg wingsuit gate layout is available.";
    } else if (dominantReason === "first-leg-track") {
      failureReason = `No forward route keeps the first leg within ${tuning.maxFirstLegTrackDeltaDeg.toFixed(0)}° of jump run.`;
    } else if (dominantReason === "selected-side") {
      failureReason = "No deploy point survives the selected side of jump run.";
    } else if (dominantReason === "corridor") {
      failureReason = "No deploy point survives jump-run corridor exclusion.";
    } else if (dominantReason === "deploy-radius") {
      failureReason = "No forward route reaches deployment inside the configured radius limits.";
    } else if (dominantReason === "wind-no-deploy-zone") {
      failureReason = "No deploy point survives the wind no-deploy zone.";
    } else if (dominantReason === "canopy-return") {
      failureReason = "No forward route leaves enough canopy-return margin from deployment.";
    } else if (dominantReason === "nonpositive-ground-speed") {
      failureReason = "No forward route can be integrated through the current wind and wingsuit profile.";
    }

    return emptyAutoOutput(
      landingPoint,
      resolvedPlan.resolved,
      landingNoDeployZonePolygon,
      downwindDeployForbiddenZonePolygon,
      forbiddenZonePolygon,
      {
        ...setupDiagnostics,
        crosswindOffsetFt: resolvedPlan.resolved.crosswindOffsetFt,
        firstSlickReturnMarginFt: resolvedPlan.firstSlickReturnMarginFt,
        lastSlickReturnMarginFt: resolvedPlan.lastSlickReturnMarginFt,
        preferredDeployBearingDeg: preferredBearingDeg,
        selectedDeployBearingDeg: null,
        selectedDeployRadiusFt: null,
        exitToJumpRunErrorFt: null,
        deployRadiusMarginFt: null,
        firstLegTrackDeltaDeg: null,
        corridorMarginFt: null,
        turnHeightsFt,
        failureReason,
      },
      [...validation.warnings, ...resolvedPlan.warnings, failureReason],
    );
  }

  const bestCandidate = validCandidates.reduce((best, candidate) =>
    compareForwardCandidates(candidate, best) < 0 ? candidate : best,
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
