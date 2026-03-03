import { describe, expect, it } from "vitest";
import type { PatternInput } from "@landing/ui-types";
import { computePattern, normalizeHeading, validatePatternInput, windFromToGroundVector } from "../src";
import { getWindForAltitude } from "../src/math";

const baseInput: PatternInput = {
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
  winds: [
    { altitudeFt: 900, speedKt: 5, dirFromDeg: 270, source: "auto" },
    { altitudeFt: 600, speedKt: 5, dirFromDeg: 270, source: "auto" },
    { altitudeFt: 300, speedKt: 5, dirFromDeg: 270, source: "auto" },
  ],
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
});
