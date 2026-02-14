import type {
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

function findRequiredWinds(gatesFt: [number, number, number, number], winds: WindLayer[]): string[] {
  const required = [gatesFt[0], gatesFt[1], gatesFt[2]];
  const errors: string[] = [];
  for (const altitude of required) {
    const layer = getWindForAltitude(altitude, winds);
    if (!layer) {
      errors.push(`Missing wind layer around ${altitude} ft.`);
    }
  }
  return errors;
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
      blockedReason: `${name} leg crosswind (${Math.abs(windCross).toFixed(1)} kt) exceeds canopy airspeed capability.`,
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

export function validatePatternInput(input: PatternInput): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isFinite(input.touchdownLat) || !Number.isFinite(input.touchdownLng)) {
    errors.push("Touchdown location must be valid latitude/longitude values.");
  }

  if (input.jumper.exitWeightLb <= 0 || input.jumper.canopyAreaSqft <= 0) {
    errors.push("Exit weight and canopy area must be positive.");
  }

  if (input.canopy.wlRef <= 0 || input.canopy.airspeedRefKt <= 0 || input.canopy.glideRatio <= 0) {
    errors.push("Canopy reference values must be positive.");
  }

  const [downwindGate, baseGate, finalGate, touchdownGate] = input.gatesFt;
  if (!(downwindGate > baseGate && baseGate > finalGate && finalGate > touchdownGate)) {
    errors.push("Gate altitudes must be strictly descending, for example 900 > 600 > 300 > 0.");
  }

  if (touchdownGate !== 0) {
    warnings.push("Touchdown gate is expected to be 0 ft AGL in this model.");
  }

  for (const wind of input.winds) {
    if (wind.speedKt < 0) {
      errors.push(`Wind speed cannot be negative at ${wind.altitudeFt} ft.`);
    }
  }

  errors.push(...findRequiredWinds(input.gatesFt, input.winds));

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function computePattern(input: PatternInput): PatternOutput {
  const validation = validatePatternInput(input);
  const warnings: string[] = [...validation.warnings];

  if (!validation.valid) {
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
      metrics: {
        wingLoading: 0,
        estAirspeedKt: 0,
        estSinkFps: 0,
      },
      warnings: [...warnings, ...validation.errors],
      blocked: true,
    };
  }

  const wingLoading = computeWingLoading(input.jumper.exitWeightLb, input.jumper.canopyAreaSqft);
  const airspeedKt = computeAirspeedKt(input, wingLoading);
  const sinkFps = computeSinkFps(airspeedKt, input.canopy.glideRatio);

  if (wingLoading > WL_MAX) {
    warnings.push(
      `Wing loading ${wingLoading.toFixed(2)} exceeds model limit (${WL_MAX.toFixed(1)}). Pattern output is disabled.`,
    );
  }

  const downwindHeading = computeLegHeading(input.landingHeadingDeg, input.side, "downwind");
  const baseHeading = computeLegHeading(input.landingHeadingDeg, input.side, "base");
  const finalHeading = computeLegHeading(input.landingHeadingDeg, input.side, "final");
  const baseLegDrift = input.baseLegDrift !== false;

  const downwindResult = computeTrackLockedSegment(
    "downwind",
    downwindHeading,
    input.gatesFt[0],
    input.gatesFt[1],
    input.winds,
    airspeedKt,
    sinkFps,
  );
  const baseResult = baseLegDrift
    ? computeDriftSegment(
        "base",
        baseHeading,
        input.gatesFt[1],
        input.gatesFt[2],
        input.winds,
        airspeedKt,
        sinkFps,
      )
    : computeTrackLockedSegment(
        "base",
        baseHeading,
        input.gatesFt[1],
        input.gatesFt[2],
        input.winds,
        airspeedKt,
        sinkFps,
      );
  const finalResult = computeTrackLockedSegment(
    "final",
    finalHeading,
    input.gatesFt[2],
    input.gatesFt[3],
    input.winds,
    airspeedKt,
    sinkFps,
  );

  if (downwindResult.blockedReason) {
    warnings.push(downwindResult.blockedReason);
  }
  if (baseResult.blockedReason) {
    warnings.push(baseResult.blockedReason);
  }
  if (finalResult.blockedReason) {
    warnings.push(finalResult.blockedReason);
  }

  const downwind = downwindResult.segment;
  const base = baseResult.segment;
  const final = finalResult.segment;
  if (downwind && downwind.alongLegSpeedKt < 0) {
    warnings.push(`Downwind leg tracks backward (${downwind.alongLegSpeedKt.toFixed(1)} kt).`);
  }
  if (base && base.alongLegSpeedKt < 0) {
    warnings.push(`Base leg tracks backward (${base.alongLegSpeedKt.toFixed(1)} kt).`);
  }
  if (final && final.alongLegSpeedKt < 0) {
    warnings.push(`Final leg tracks backward (${final.alongLegSpeedKt.toFixed(1)} kt).`);
  }
  const finalForwardSpeedKt = final ? final.alongLegSpeedKt : 0;
  if (finalForwardSpeedKt < MIN_FINAL_FORWARD_GROUND_SPEED_KT) {
    warnings.push(
      `Final-leg penetration is low (${finalForwardSpeedKt.toFixed(1)} kt along final). Consider a safer landing direction.`,
    );
  }

  const blocked =
    wingLoading > WL_MAX ||
    !Number.isFinite(sinkFps) ||
    sinkFps <= 0 ||
    !downwind ||
    !base ||
    !final;

  const touchdown: LocalPoint = { eastFt: 0, northFt: 0 };
  const finalGroundUnit = unitOrZero(final?.groundVectorKt ?? { east: 0, north: 0 });
  const downwindGroundUnit = unitOrZero(downwind?.groundVectorKt ?? { east: 0, north: 0 });

  const finalDistance = final?.distanceFt ?? 0;
  const finalStart: LocalPoint = {
    eastFt: touchdown.eastFt - finalGroundUnit.east * finalDistance,
    northFt: touchdown.northFt - finalGroundUnit.north * finalDistance,
  };

  const baseGroundUnit = unitOrZero(base?.groundVectorKt ?? { east: 0, north: 0 });
  const baseDistance = base?.distanceFt ?? 0;
  const baseStart: LocalPoint = {
    eastFt: finalStart.eastFt - baseGroundUnit.east * baseDistance,
    northFt: finalStart.northFt - baseGroundUnit.north * baseDistance,
  };

  const downwindDistance = downwind?.distanceFt ?? 0;
  const downwindStart: LocalPoint = {
    eastFt: baseStart.eastFt - downwindGroundUnit.east * downwindDistance,
    northFt: baseStart.northFt - downwindGroundUnit.north * downwindDistance,
  };

  const touchdownGeo = localFeetToLatLng(input.touchdownLat, input.touchdownLng, touchdown.eastFt, touchdown.northFt);
  const finalStartGeo = localFeetToLatLng(input.touchdownLat, input.touchdownLng, finalStart.eastFt, finalStart.northFt);
  const baseStartGeo = localFeetToLatLng(input.touchdownLat, input.touchdownLng, baseStart.eastFt, baseStart.northFt);
  const downwindStartGeo = localFeetToLatLng(
    input.touchdownLat,
    input.touchdownLng,
    downwindStart.eastFt,
    downwindStart.northFt,
  );

  return {
    waypoints: blocked
      ? [
          {
            name: "touchdown",
            lat: input.touchdownLat,
            lng: input.touchdownLng,
            altFt: input.gatesFt[3],
          },
        ]
      : [
          {
            name: "downwind_start",
            lat: downwindStartGeo.lat,
            lng: downwindStartGeo.lng,
            altFt: input.gatesFt[0],
          },
          {
            name: "base_start",
            lat: baseStartGeo.lat,
            lng: baseStartGeo.lng,
            altFt: input.gatesFt[1],
          },
          {
            name: "final_start",
            lat: finalStartGeo.lat,
            lng: finalStartGeo.lng,
            altFt: input.gatesFt[2],
          },
          {
            name: "touchdown",
            lat: touchdownGeo.lat,
            lng: touchdownGeo.lng,
            altFt: input.gatesFt[3],
          },
        ],
    segments: blocked
      ? []
      : [downwind, base, final].map((segment) => ({
          name: segment!.name,
          headingDeg: segment!.headingDeg,
          trackHeadingDeg: segment!.trackHeadingDeg,
          alongLegSpeedKt: segment!.alongLegSpeedKt,
          groundSpeedKt: segment!.groundSpeedKt,
          timeSec: segment!.timeSec,
          distanceFt: segment!.distanceFt,
        })),
    metrics: {
      wingLoading,
      estAirspeedKt: airspeedKt,
      estSinkFps: sinkFps,
    },
    warnings,
    blocked,
  };
}

export { normalizeHeading, windFromToGroundVector } from "./math";
