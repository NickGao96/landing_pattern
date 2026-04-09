import type {
  FlightMode,
  PatternInput,
  PatternOutput,
  SegmentName,
  ValidationResult,
  WindLayer,
} from "@landing/ui-types";
import {
  addVec,
  dot,
  getWindForAltitude,
  headingToUnitVector,
  knotsToFeetPerSecond,
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

interface LocalPoint {
  eastFt: number;
  northFt: number;
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

function computeAirspeedKt(input: PatternInput, wingLoading: number): number {
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

export { normalizeHeading, windFromToGroundVector } from "./math";
