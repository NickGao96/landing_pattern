import type { WingsuitPresetId, WingsuitProfile } from "@landing/ui-types";
import { knotsToMps } from "./lib/units";

type StockPresetId = Exclude<WingsuitPresetId, "custom">;

const presetToleranceKt = 0.5;
const presetToleranceFps = 1;

const presetProfiles: Record<StockPresetId, WingsuitProfile> = {
  // Swift is kept intentionally steeper/slower to reflect a first-suit / lower-performance profile.
  swift: {
    presetId: "swift",
    name: "Squirrel SWIFT",
    flightSpeedKt: 60,
    fallRateFps: 84,
  },
  // ATC is derated well below competition numbers and meant as a conservative everyday transition preset.
  atc: {
    presetId: "atc",
    name: "Squirrel ATC",
    flightSpeedKt: 68,
    fallRateFps: 72,
  },
  // Freak numbers are anchored to a FlySight sample shared by the user:
  // ~153.4 km/h horizontal, ~76.6 km/h vertical, GR ~2.0.
  freak: {
    presetId: "freak",
    name: "Squirrel FREAK",
    flightSpeedKt: 84,
    fallRateFps: 68,
  },
  // Aura is kept as a conservative advanced/high-glide preset, not a comp-speed target.
  aura: {
    presetId: "aura",
    name: "Squirrel AURA",
    flightSpeedKt: 80,
    fallRateFps: 60,
  },
};

export const defaultWingsuitGatesFt: [number, number, number, number] = [12000, 10000, 6500, 4000];

export const defaultWingsuitWindLayers = [
  { altitudeFt: 12000, speedKt: 28, dirFromDeg: 240, source: "manual" as const },
  { altitudeFt: 10000, speedKt: 24, dirFromDeg: 230, source: "manual" as const },
  { altitudeFt: 6500, speedKt: 18, dirFromDeg: 220, source: "manual" as const },
];

export function wingsuitProfileForPreset(presetId: StockPresetId): WingsuitProfile {
  return { ...presetProfiles[presetId] };
}

export function glideRatioForWingsuit(profile: WingsuitProfile): number {
  const horizontalSpeedFps = knotsToMps(profile.flightSpeedKt) * 3.28084;
  return horizontalSpeedFps / Math.max(profile.fallRateFps, 0.1);
}

function closeToPreset(profile: Partial<WingsuitProfile>, preset: WingsuitProfile): boolean {
  return (
    typeof profile.flightSpeedKt === "number" &&
    typeof profile.fallRateFps === "number" &&
    Math.abs(profile.flightSpeedKt - preset.flightSpeedKt) <= presetToleranceKt &&
    Math.abs(profile.fallRateFps - preset.fallRateFps) <= presetToleranceFps
  );
}

export function inferWingsuitPresetId(profile: Partial<WingsuitProfile> | null | undefined): WingsuitPresetId {
  if (!profile) {
    return "freak";
  }
  if (
    profile.presetId === "swift" ||
    profile.presetId === "atc" ||
    profile.presetId === "freak" ||
    profile.presetId === "aura" ||
    profile.presetId === "custom"
  ) {
    return profile.presetId;
  }

  const normalizedName = profile.name?.trim().toLowerCase() ?? "";
  if (normalizedName.includes("swift")) {
    return "swift";
  }
  if (normalizedName.includes("atc")) {
    return "atc";
  }
  if (normalizedName.includes("freak")) {
    return "freak";
  }
  if (normalizedName.includes("aura")) {
    return "aura";
  }
  if (closeToPreset(profile, presetProfiles.swift)) {
    return "swift";
  }
  if (closeToPreset(profile, presetProfiles.atc)) {
    return "atc";
  }
  if (closeToPreset(profile, presetProfiles.freak)) {
    return "freak";
  }
  if (closeToPreset(profile, presetProfiles.aura)) {
    return "aura";
  }
  return "custom";
}

export function normalizeWingsuitProfile(profile: Partial<WingsuitProfile> | null | undefined): WingsuitProfile {
  const presetId = inferWingsuitPresetId(profile);
  if (presetId !== "custom") {
    return {
      ...wingsuitProfileForPreset(presetId),
      name: profile?.name?.trim() ? profile.name : presetProfiles[presetId].name,
    };
  }

  return {
    presetId: "custom",
    name: profile?.name?.trim() ? profile.name : "Custom Wingsuit",
    flightSpeedKt: profile?.flightSpeedKt ?? presetProfiles.freak.flightSpeedKt,
    fallRateFps: profile?.fallRateFps ?? presetProfiles.freak.fallRateFps,
  };
}

export function withCustomWingsuit(profile: WingsuitProfile): WingsuitProfile {
  return {
    ...profile,
    presetId: "custom",
  };
}
