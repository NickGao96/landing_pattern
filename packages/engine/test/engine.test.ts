import { describe, expect, it } from "vitest";
import type { PatternInput, WingsuitAutoInput } from "@landing/ui-types";
import {
  computePattern,
  normalizeHeading,
  solveWingsuitAuto,
  validatePatternInput,
  validateWingsuitAutoInput,
  windFromToGroundVector,
} from "../src";
import { getWindForAltitude, knotsToFeetPerSecond } from "../src/math";

const baseInput: PatternInput = {
  mode: "canopy",
  touchdownLat: 37.0,
  touchdownLng: -122.0,
  landingHeadingDeg: 180,
  side: "left",
  gatesFt: [900, 600, 300, 0],
  canopy: {
    manufacturer: "PD",
    model: "Sabre3",
    sizeSqft: 170,
    wlRef: 1.0,
    airspeedRefKt: 20,
    glideRatio: 2.7,
  },
  jumper: {
    exitWeightLb: 170,
    canopyAreaSqft: 170,
  },
  wingsuit: {
    name: "Generic Wingsuit",
    flightSpeedKt: 60,
    fallRateFps: 12,
  },
  winds: [
    { altitudeFt: 900, speedKt: 5, dirFromDeg: 270, source: "auto" },
    { altitudeFt: 600, speedKt: 5, dirFromDeg: 270, source: "auto" },
    { altitudeFt: 300, speedKt: 5, dirFromDeg: 270, source: "auto" },
  ],
};

const wingsuitInput: PatternInput = {
  ...baseInput,
  mode: "wingsuit",
  gatesFt: [3000, 2000, 1000, 0],
  wingsuit: {
    name: "Swift",
    flightSpeedKt: 60,
    fallRateFps: 12,
  },
  winds: [
    { altitudeFt: 3000, speedKt: 22, dirFromDeg: 240, source: "auto" },
    { altitudeFt: 2000, speedKt: 18, dirFromDeg: 230, source: "auto" },
    { altitudeFt: 1000, speedKt: 14, dirFromDeg: 220, source: "auto" },
  ],
};

const autoLanding = { lat: 37.0, lng: -122.0 };

const autoInput: WingsuitAutoInput = {
  landingPoint: autoLanding,
  jumpRun: {
    directionMode: "manual",
    manualHeadingDeg: 0,
    constraintMode: "none",
    constraintHeadingDeg: 0,
    assumptions: {
      planeAirspeedKt: 85,
      groupCount: 4,
      groupSeparationFt: 1500,
      slickDeployHeightFt: 3000,
      slickFallRateFps: 176,
      slickReturnRadiusFt: 5000,
    },
  },
  side: "left",
  exitHeightFt: 10000,
  deployHeightFt: 4500,
  wingsuit: {
    name: "Squirrel FREAK",
    flightSpeedKt: 84,
    fallRateFps: 68,
  },
  winds: [
    { altitudeFt: 12000, speedKt: 20, dirFromDeg: 270, source: "manual" },
    { altitudeFt: 8000, speedKt: 16, dirFromDeg: 270, source: "manual" },
    { altitudeFt: 4000, speedKt: 12, dirFromDeg: 270, source: "manual" },
  ],
  tuning: {
    corridorHalfWidthFt: 250,
    deployBearingWindowHalfDeg: 70,
    deployRadiusStepFt: 250,
    minDeployRadiusFt: 1000,
  },
};

describe("math helpers", () => {
  it("normalizes heading", () => {
    expect(normalizeHeading(-90)).toBe(270);
    expect(normalizeHeading(450)).toBe(90);
  });

  it("converts wind-from to travel vector", () => {
    const vec = windFromToGroundVector(10, 0);
    expect(vec.north).toBeCloseTo(-10, 6);
    expect(vec.east).toBeCloseTo(0, 6);
  });

  it("interpolates wind direction across 360 wrap using shortest path", () => {
    const interpolated = getWindForAltitude(450, [
      { altitudeFt: 600, speedKt: 10, dirFromDeg: 350, source: "auto" },
      { altitudeFt: 300, speedKt: 10, dirFromDeg: 10, source: "auto" },
    ]);

    expect(interpolated).toBeDefined();
    expect(interpolated?.dirFromDeg).toBeCloseTo(0, 6);
  });
});

describe("pattern validation", () => {
  it("flags missing wind layers", () => {
    const validation = validatePatternInput({ ...baseInput, winds: [] });
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("Missing wind layer"))).toBe(true);
  });

  it("flags non-finite wind values", () => {
    const validation = validatePatternInput({
      ...baseInput,
      winds: [{ ...baseInput.winds[0], dirFromDeg: Number.NaN }, ...baseInput.winds.slice(1)],
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("Wind layer values must be finite"))).toBe(true);
  });
});

describe("computePattern", () => {
  it("computes a nominal three-leg pattern", () => {
    const output = computePattern(baseInput);
    expect(output.blocked).toBe(false);
    expect(output.segments).toHaveLength(3);
    expect(output.waypoints).toHaveLength(4);

    const final = output.segments.find((segment) => segment.name === "final");
    expect(final?.headingDeg).toBeGreaterThan(180);
    expect(final?.distanceFt ?? 0).toBeGreaterThan(0);

    const finalStart = output.waypoints.find((waypoint) => waypoint.name === "final_start");
    const touchdown = output.waypoints.find((waypoint) => waypoint.name === "touchdown");
    expect(finalStart).toBeDefined();
    expect(touchdown).toBeDefined();
    expect(finalStart?.lng ?? 0).toBeCloseTo(touchdown?.lng ?? 0, 4);
  });

  it("changes final distance when headwind increases", () => {
    const calm = computePattern({
      ...baseInput,
      winds: baseInput.winds.map((layer) => ({ ...layer, speedKt: 0 })),
    });

    const strongHeadwind = computePattern({
      ...baseInput,
      winds: baseInput.winds.map((layer) => ({ ...layer, speedKt: 15, dirFromDeg: 180 })),
    });

    const calmFinal = calm.segments.find((segment) => segment.name === "final")?.distanceFt ?? 0;
    const headwindFinal = strongHeadwind.segments.find((segment) => segment.name === "final")?.distanceFt ?? 0;

    expect(headwindFinal).toBeLessThan(calmFinal);
  });

  it("flips base heading for right pattern", () => {
    const left = computePattern({ ...baseInput, side: "left" });
    const right = computePattern({ ...baseInput, side: "right" });

    const leftBase = left.segments.find((segment) => segment.name === "base");
    const rightBase = right.segments.find((segment) => segment.name === "base");

    expect(leftBase?.headingDeg).toBe(90);
    expect(rightBase?.headingDeg).toBe(270);
  });

  it("supports turning base drift off", () => {
    const crosswindInput = {
      ...baseInput,
      winds: baseInput.winds.map((layer) => ({ ...layer, dirFromDeg: 180 })),
    };
    const drift = computePattern({ ...crosswindInput, baseLegDrift: true });
    const noDrift = computePattern({ ...crosswindInput, baseLegDrift: false });

    const driftBase = drift.segments.find((segment) => segment.name === "base");
    const noDriftBase = noDrift.segments.find((segment) => segment.name === "base");

    expect(drift.blocked).toBe(false);
    expect(noDrift.blocked).toBe(false);
    expect(driftBase?.headingDeg).toBe(90);
    expect(Math.abs((noDriftBase?.headingDeg ?? 90) - 90)).toBeGreaterThan(1);
  });

  it("keeps a computed pattern for high-wind backward scenarios with warnings", () => {
    const output = computePattern({
      ...baseInput,
      baseLegDrift: true,
      winds: baseInput.winds.map((layer) => ({ ...layer, speedKt: 35, dirFromDeg: 180 })),
    });

    expect(output.blocked).toBe(false);
    expect(output.segments).toHaveLength(3);
    const final = output.segments.find((segment) => segment.name === "final");
    expect(final?.alongLegSpeedKt ?? 1).toBeLessThan(0);
    expect(output.warnings.some((warning) => warning.includes("Final leg tracks backward"))).toBe(true);
  });

  it("blocks when wind values are non-finite", () => {
    const output = computePattern({
      ...baseInput,
      winds: [{ ...baseInput.winds[0], dirFromDeg: Number.NaN }, ...baseInput.winds.slice(1)],
    });

    expect(output.blocked).toBe(true);
    expect(output.warnings.some((warning) => warning.includes("Wind layer values must be finite"))).toBe(true);
    expect(output.segments).toHaveLength(0);
  });

  it("blocks when wing loading exceeds threshold", () => {
    const output = computePattern({
      ...baseInput,
      jumper: {
        exitWeightLb: 260,
        canopyAreaSqft: 130,
      },
    });

    expect(output.blocked).toBe(true);
    expect(output.warnings.some((warning) => warning.includes("Wing loading"))).toBe(true);
    expect(output.segments).toHaveLength(0);
  });

  it("computes a nominal wingsuit pattern without wing-loading metrics", () => {
    const output = computePattern(wingsuitInput);

    expect(output.blocked).toBe(false);
    expect(output.segments).toHaveLength(3);
    expect(output.waypoints).toHaveLength(4);
    expect(output.metrics.wingLoading).toBeNull();
    expect(output.metrics.estAirspeedKt).toBe(60);
    expect(output.metrics.estSinkFps).toBe(12);
  });

  it("supports collapsing the first wingsuit leg", () => {
    const output = computePattern({
      ...wingsuitInput,
      gatesFt: [3000, 3000, 1000, 0],
      winds: [
        { altitudeFt: 3000, speedKt: 22, dirFromDeg: 240, source: "auto" },
        { altitudeFt: 1000, speedKt: 14, dirFromDeg: 220, source: "auto" },
      ],
    });

    expect(output.blocked).toBe(false);
    expect(output.segments.map((segment) => segment.name)).toEqual(["base", "final"]);
    expect(output.waypoints.map((waypoint) => waypoint.name)).toEqual(["base_start", "final_start", "touchdown"]);
  });

  it("supports collapsing the middle wingsuit leg", () => {
    const output = computePattern({
      ...wingsuitInput,
      gatesFt: [3000, 1000, 1000, 0],
      winds: [
        { altitudeFt: 3000, speedKt: 22, dirFromDeg: 240, source: "auto" },
        { altitudeFt: 1000, speedKt: 14, dirFromDeg: 220, source: "auto" },
      ],
    });

    expect(output.blocked).toBe(false);
    expect(output.segments.map((segment) => segment.name)).toEqual(["downwind", "final"]);
    expect(output.waypoints.map((waypoint) => waypoint.name)).toEqual([
      "downwind_start",
      "final_start",
      "touchdown",
    ]);
  });

  it("blocks wingsuit inputs when both early legs collapse", () => {
    const output = computePattern({
      ...wingsuitInput,
      gatesFt: [3000, 3000, 3000, 0],
      winds: [{ altitudeFt: 3000, speedKt: 22, dirFromDeg: 240, source: "auto" }],
    });

    expect(output.blocked).toBe(true);
    expect(output.warnings.some((warning) => warning.includes("requires at least two active legs"))).toBe(true);
  });
});

describe("wingsuit auto mode", () => {
  it("requires a finite manual jump-run heading", () => {
    const validation = validateWingsuitAutoInput({
      ...autoInput,
      jumpRun: {
        ...autoInput.jumpRun,
        directionMode: "manual",
        manualHeadingDeg: Number.NaN,
      },
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("Manual jump-run direction requires a finite heading.");
  });

  it("solves a nominal auto pattern and derives default turn heights", () => {
    const output = solveWingsuitAuto(autoInput);

    expect(output.blocked).toBe(false);
    expect(output.resolvedJumpRun).not.toBeNull();
    expect(output.routeWaypoints.map((waypoint) => waypoint.name)).toEqual(["exit", "turn1", "turn2", "deploy"]);
    expect(output.turnPoints.map((waypoint) => waypoint.name)).toEqual(["turn1", "turn2"]);
    expect(output.routeSegments.length).toBeGreaterThanOrEqual(2);
    expect(output.routeSegments.length).toBeLessThanOrEqual(3);
    expect(output.deployBandsByBearing.length).toBeGreaterThan(0);
    expect(output.feasibleDeployRegionPolygon.length).toBeGreaterThan(0);
    expect(output.landingNoDeployZonePolygon.length).toBeGreaterThan(0);
    expect(output.downwindDeployForbiddenZonePolygon.length).toBeGreaterThan(0);
    expect(output.forbiddenZonePolygon).toHaveLength(4);
    expect(output.diagnostics.preferredDeployBearingDeg).toBe(270);
    expect(output.deployPoint).not.toBeNull();
    expect(output.exitPoint).not.toBeNull();
    const wingsuitSlot = output.resolvedJumpRun?.slots.find((slot) => slot.kind === "wingsuit");
    expect(wingsuitSlot).toBeDefined();
    expect(output.exitPoint?.lat ?? 0).toBeCloseTo(wingsuitSlot?.lat ?? 0, 8);
    expect(output.exitPoint?.lng ?? 0).toBeCloseTo(wingsuitSlot?.lng ?? 0, 8);
    expect(output.diagnostics.selectedDeployRadiusFt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(6562);
    expect(output.diagnostics.exitToJumpRunErrorFt).toBe(0);
    expect(output.diagnostics.deployRadiusMarginFt ?? -1).toBeGreaterThanOrEqual(0);
    expect(output.diagnostics.firstLegTrackDeltaDeg ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(45);
    expect(output.diagnostics.turnHeightsFt?.[0] ?? 0).toBeGreaterThanOrEqual(output.diagnostics.turnHeightsFt?.[1] ?? 0);
    expect(output.diagnostics.turnHeightsFt?.[1] ?? 0).toBeGreaterThan(autoInput.deployHeightFt);
    expect(output.warnings.some((warning) => warning.includes("Exit remains"))).toBe(false);
    expect(output.resolvedJumpRun?.slots).toHaveLength(4);
  });

  it("allows the wingsuit slot to exit first", () => {
    const validation = validateWingsuitAutoInput({
      ...autoInput,
      jumpRun: {
        ...autoInput.jumpRun,
        assumptions: {
          ...autoInput.jumpRun.assumptions,
          groupCount: 1,
        },
      },
    });
    expect(validation.valid).toBe(true);

    const output = solveWingsuitAuto({
      ...autoInput,
      jumpRun: {
        ...autoInput.jumpRun,
        assumptions: {
          ...autoInput.jumpRun.assumptions,
          groupCount: 1,
        },
      },
    });

    expect(output.blocked).toBe(false);
    expect(output.resolvedJumpRun?.slots).toHaveLength(1);
    expect(output.resolvedJumpRun?.lengthFt).toBe(1500);
    expect(output.resolvedJumpRun?.slots[0]?.label).toBe("WS");
    expect(output.resolvedJumpRun?.slots[0]?.kind).toBe("wingsuit");
    expect(output.diagnostics.firstSlickReturnMarginFt).toBeNull();
    expect(output.diagnostics.lastSlickReturnMarginFt).toBeNull();
    expect(output.exitPoint?.lat ?? 0).toBeCloseTo(output.resolvedJumpRun?.slots[0]?.lat ?? 0, 8);
    expect(output.exitPoint?.lng ?? 0).toBeCloseTo(output.resolvedJumpRun?.slots[0]?.lng ?? 0, 8);
  });

  it("moves the wingsuit slot to a custom exit group", () => {
    const output = solveWingsuitAuto({
      ...autoInput,
      jumpRun: {
        ...autoInput.jumpRun,
        assumptions: {
          ...autoInput.jumpRun.assumptions,
          groupCount: 5,
        },
      },
    });

    expect(output.blocked).toBe(false);
    expect(output.resolvedJumpRun?.lengthFt).toBe(7500);
    expect(output.resolvedJumpRun?.slots.map((slot) => slot.label)).toEqual(["G1", "G2", "G3", "G4", "WS"]);
    expect(output.resolvedJumpRun?.slots.map((slot) => slot.kind)).toEqual([
      "group",
      "group",
      "group",
      "group",
      "wingsuit",
    ]);
    expect(output.exitPoint?.lat ?? 0).toBeCloseTo(output.resolvedJumpRun?.slots[4]?.lat ?? 0, 8);
    expect(output.exitPoint?.lng ?? 0).toBeCloseTo(output.resolvedJumpRun?.slots[4]?.lng ?? 0, 8);
  });

  it("rejects nonpositive wingsuit exit group numbers", () => {
    const validation = validateWingsuitAutoInput({
      ...autoInput,
      jumpRun: {
        ...autoInput.jumpRun,
        assumptions: {
          ...autoInput.jumpRun.assumptions,
          groupCount: 0,
        },
      },
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("Wingsuit exit group must be an integer of at least 1.");
  });

  it("does not depend on reverse-solved exit tolerance", () => {
    const output = solveWingsuitAuto({
      ...autoInput,
      tuning: {
        ...autoInput.tuning,
        exitOnJumpRunToleranceFt: 1,
      },
    });

    expect(output.blocked).toBe(false);
    expect(output.diagnostics.exitToJumpRunErrorFt).toBe(0);
  });

  it("uses the low-wind headwind when jump-run direction is automatic", () => {
    const output = solveWingsuitAuto({
      ...autoInput,
      jumpRun: {
        ...autoInput.jumpRun,
        directionMode: "auto",
      },
    });

    expect(output.resolvedJumpRun?.headingDeg).toBe(270);
    expect(output.diagnostics.headingSource).toBe("auto-headwind");
  });

  it("snaps automatic direction to the closer reciprocal runway heading", () => {
    const output = solveWingsuitAuto({
      ...autoInput,
      jumpRun: {
        ...autoInput.jumpRun,
        directionMode: "auto",
        constraintMode: "reciprocal",
        constraintHeadingDeg: 180,
      },
    });

    expect(output.resolvedJumpRun?.headingDeg).toBe(180);
    expect(output.diagnostics.constrainedHeadingApplied).toBe(true);
  });

  it("honors manual direction when unconstrained", () => {
    const output = solveWingsuitAuto({
      ...autoInput,
      jumpRun: {
        ...autoInput.jumpRun,
        directionMode: "manual",
        manualHeadingDeg: 33,
      },
    });

    expect(output.resolvedJumpRun?.headingDeg).toBe(33);
    expect(output.diagnostics.headingSource).toBe("manual");
  });

  it("computes crosswind offsite and jump-run spacing from assumptions", () => {
    const output = solveWingsuitAuto(autoInput);
    expect(Math.abs(output.resolvedJumpRun?.crosswindOffsetFt ?? 0)).toBeGreaterThan(0);
    expect(output.resolvedJumpRun?.lengthFt).toBe(6000);
    expect(output.resolvedJumpRun?.groupSpacingFt).toBe(1500);
    expect(output.resolvedJumpRun?.groupSpacingSec ?? 0).toBeCloseTo(
      1500 / knotsToFeetPerSecond(output.resolvedJumpRun?.planeGroundSpeedKt ?? 45),
      6,
    );
  });

  it("blocks when slick groups cannot fit inside the return radius", () => {
    const output = solveWingsuitAuto({
      ...autoInput,
      jumpRun: {
        ...autoInput.jumpRun,
        assumptions: {
          ...autoInput.jumpRun.assumptions,
          slickReturnRadiusFt: 1000,
        },
      },
    });

    expect(output.blocked).toBe(true);
    expect(output.resolvedJumpRun).not.toBeNull();
    expect(output.diagnostics.failureReason).toContain("slick groups");
    expect(output.diagnostics.firstSlickReturnMarginFt ?? 0).toBeLessThan(0);
  });

  it("uses custom turn ratios", () => {
    const output = solveWingsuitAuto({
      ...autoInput,
      turnRatios: {
        turn1: 0.6,
        turn2: 0.25,
      },
    });

    expect(output.blocked).toBe(false);
    expect(output.diagnostics.turnHeightsFt?.[0] ?? 0).toBeGreaterThanOrEqual(output.diagnostics.turnHeightsFt?.[1] ?? 0);
    expect(output.diagnostics.turnHeightsFt?.[1] ?? 0).toBeGreaterThan(4000);
  });

  it("blocks when the jump-run corridor removes every deploy candidate", () => {
    const output = solveWingsuitAuto({
      ...autoInput,
      tuning: {
        ...autoInput.tuning,
        corridorHalfWidthFt: 30000,
        maxDeployRadiusFt: 1000,
      },
    });

    expect(output.blocked).toBe(true);
    expect(output.diagnostics.failureReason).toBe("No deploy point survives jump-run corridor exclusion.");
    expect(output.deployBandsByBearing).toHaveLength(0);
  });

  it("caps deploy solutions to the fixed maximum radius", () => {
    const output = solveWingsuitAuto({
      ...autoInput,
      tuning: {
        ...autoInput.tuning,
        maxDeployRadiusFt: 6400,
      },
    });

    expect(output.blocked).toBe(false);
    expect(output.diagnostics.selectedDeployRadiusFt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(6400);
    expect(
      output.deployBandsByBearing.every((band) => band.maxRadiusFt <= 6400 + 1e-6),
    ).toBe(true);
  });

  it("reports the first-leg track rule when that is the limiting factor", () => {
    const output = solveWingsuitAuto({
      ...autoInput,
      jumpRun: {
        ...autoInput.jumpRun,
        directionMode: "manual",
        manualHeadingDeg: 5,
      },
      tuning: {
        ...autoInput.tuning,
        maxFirstLegTrackDeltaDeg: 1,
      },
    });

    expect(output.blocked).toBe(true);
    expect(output.diagnostics.failureReason).toContain("first leg within 1°");
  });
});
