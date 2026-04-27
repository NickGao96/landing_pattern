import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  CanopyProfile,
  FlightMode,
  PatternSide,
  WindLayer,
  WingsuitAutoJumpRunAssumptions,
  WingsuitAutoJumpRunConstraintMode,
  WingsuitAutoJumpRunDirectionMode,
  WingsuitAutoJumpRunPlacementMode,
  WingsuitProfile,
} from "@landing/ui-types";
import { canopyPresets } from "@landing/data";
import {
  defaultWingsuitGatesFt,
  defaultWingsuitWindLayers,
  normalizeWingsuitProfile,
  wingsuitProfileForPreset,
} from "./wingsuits";

type UnitSystem = "imperial" | "metric";
export type Language = "en" | "zh";
export type WingsuitPlanningMode = "manual" | "auto";

interface NamedSpot {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface GeoPoint {
  lat: number;
  lng: number;
}

export interface CanopySettings {
  gatesFt: [number, number, number, number];
  canopy: CanopyProfile;
  exitWeightLb: number;
  windLayers: WindLayer[];
}

export interface WingsuitSettings {
  gatesFt: [number, number, number, number];
  wingsuit: WingsuitProfile;
  windLayers: WindLayer[];
}

export interface WingsuitAutoSettings {
  planningMode: WingsuitPlanningMode;
  placementMode: WingsuitAutoJumpRunPlacementMode;
  directionMode: WingsuitAutoJumpRunDirectionMode;
  manualHeadingDeg: number;
  constraintMode: WingsuitAutoJumpRunConstraintMode;
  constraintHeadingDeg: number;
  distanceOffsetFt: number;
  assumptions: Required<WingsuitAutoJumpRunAssumptions>;
}

interface AppStore {
  language: Language;
  unitSystem: UnitSystem;
  mode: FlightMode;
  location: {
    lat: number;
    lng: number;
    source: "default" | "gps" | "manual";
  };
  touchdown: GeoPoint;
  landingHeadingDeg: number;
  side: PatternSide;
  baseLegDrift: boolean;
  shearAlpha: number;
  canopySettings: CanopySettings;
  wingsuitSettings: WingsuitSettings;
  wingsuitAutoSettings: WingsuitAutoSettings;
  namedSpots: NamedSpot[];
  selectedSpotId: string | null;
  setMode: (mode: FlightMode) => void;
  setLocation: (lat: number, lng: number, source: "default" | "gps" | "manual") => void;
  setTouchdown: (lat: number, lng: number) => void;
  setHeading: (headingDeg: number) => void;
  setSide: (side: PatternSide) => void;
  setBaseLegDrift: (enabled: boolean) => void;
  setShearAlpha: (alpha: number) => void;
  setCanopyGates: (gates: [number, number, number, number]) => void;
  setCanopy: (canopy: CanopyProfile) => void;
  setExitWeight: (weightLb: number) => void;
  setCanopyWindLayers: (layers: WindLayer[]) => void;
  updateCanopyWindLayer: (layerIndex: number, patch: Partial<WindLayer>) => void;
  setWingsuitGates: (gates: [number, number, number, number]) => void;
  setWingsuit: (wingsuit: WingsuitProfile) => void;
  setWingsuitWindLayers: (layers: WindLayer[]) => void;
  updateWingsuitWindLayer: (layerIndex: number, patch: Partial<WindLayer>) => void;
  setWingsuitPlanningMode: (mode: WingsuitPlanningMode) => void;
  setWingsuitAutoPlacementMode: (mode: WingsuitAutoJumpRunPlacementMode) => void;
  setWingsuitAutoDirectionMode: (mode: WingsuitAutoJumpRunDirectionMode) => void;
  setWingsuitAutoManualHeading: (headingDeg: number) => void;
  setWingsuitAutoConstraintMode: (mode: WingsuitAutoJumpRunConstraintMode) => void;
  setWingsuitAutoConstraintHeading: (headingDeg: number) => void;
  setWingsuitAutoDistanceOffset: (distanceOffsetFt: number) => void;
  setWingsuitAutoAssumptions: (patch: Partial<WingsuitAutoJumpRunAssumptions>) => void;
  setUnitSystem: (system: UnitSystem) => void;
  setLanguage: (language: Language) => void;
  saveNamedSpot: (name: string) => void;
  selectNamedSpot: (id: string) => void;
}

const defaultLat = 37.4419;
const defaultLng = -122.143;
const feetPerDegLat = 364000;
const defaultWingsuitDistanceOffsetFt = 4000 * 3.280839895;

const defaultPreset: CanopyProfile = canopyPresets[0] ?? {
  manufacturer: "Performance Designs",
  model: "Fallback 170",
  sizeSqft: 170,
  wlRef: 1,
  airspeedRefKt: 20,
  airspeedWlExponent: 0.5,
  airspeedMinKt: 12,
  airspeedMaxKt: 34,
  glideRatio: 2.7,
};

const defaultWingsuit: WingsuitProfile = {
  ...wingsuitProfileForPreset("freak"),
};

const defaultCanopySettings: CanopySettings = {
  gatesFt: [900, 600, 300, 0],
  canopy: defaultPreset,
  exitWeightLb: 170,
  windLayers: [
    { altitudeFt: 900, speedKt: 10, dirFromDeg: 180, source: "manual" },
    { altitudeFt: 600, speedKt: 9, dirFromDeg: 180, source: "manual" },
    { altitudeFt: 300, speedKt: 8, dirFromDeg: 180, source: "manual" },
  ],
};

const defaultWingsuitSettings: WingsuitSettings = {
  gatesFt: defaultWingsuitGatesFt,
  wingsuit: defaultWingsuit,
  windLayers: defaultWingsuitWindLayers,
};

const defaultWingsuitAutoAssumptions: Required<WingsuitAutoJumpRunAssumptions> = {
  planeAirspeedKt: 85,
  groupCount: 4,
  groupSeparationFt: 1500,
  slickDeployHeightFt: 3000,
  slickFallRateFps: 176,
  slickReturnRadiusFt: 5000,
};

export function resolveDefaultLanguage(): Language {
  if (typeof navigator === "undefined") {
    return "en";
  }

  const browserLanguages = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter((language): language is string => typeof language === "string");

  for (const language of browserLanguages) {
    const normalized = language.toLowerCase();
    if (normalized === "zh" || normalized.startsWith("zh-")) {
      return "zh";
    }
    if (normalized === "en" || normalized.startsWith("en-")) {
      return "en";
    }
  }

  return "en";
}

function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function latLngToLocalFeet(refLat: number, refLng: number, lat: number, lng: number): { eastFt: number; northFt: number } {
  const northFt = (lat - refLat) * feetPerDegLat;
  const feetPerDegLng = feetPerDegLat * Math.max(Math.cos((refLat * Math.PI) / 180), 1e-5);
  const eastFt = (lng - refLng) * feetPerDegLng;
  return { eastFt, northFt };
}

function headingFromCoordinates(from: GeoPoint, to: GeoPoint): number {
  const local = latLngToLocalFeet(from.lat, from.lng, to.lat, to.lng);
  if (Math.hypot(local.eastFt, local.northFt) <= 1e-6) {
    return 0;
  }
  return normalizeHeading((Math.atan2(local.eastFt, local.northFt) * 180) / Math.PI);
}

function updateWindLayerList(layers: WindLayer[], layerIndex: number, patch: Partial<WindLayer>): WindLayer[] {
  return layers.map((layer, index) =>
    index === layerIndex
      ? {
          ...layer,
          ...patch,
        }
      : layer,
  );
}

function normalizePersistedAssumptions(
  assumptions: Partial<WingsuitAutoJumpRunAssumptions> | undefined,
): Required<WingsuitAutoJumpRunAssumptions> {
  return {
    planeAirspeedKt:
      typeof assumptions?.planeAirspeedKt === "number"
        ? assumptions.planeAirspeedKt
        : defaultWingsuitAutoAssumptions.planeAirspeedKt,
    groupCount:
      typeof assumptions?.groupCount === "number"
        ? Math.max(1, Math.round(assumptions.groupCount))
        : defaultWingsuitAutoAssumptions.groupCount,
    groupSeparationFt:
      typeof assumptions?.groupSeparationFt === "number"
        ? assumptions.groupSeparationFt
        : defaultWingsuitAutoAssumptions.groupSeparationFt,
    slickDeployHeightFt:
      typeof assumptions?.slickDeployHeightFt === "number"
        ? assumptions.slickDeployHeightFt
        : defaultWingsuitAutoAssumptions.slickDeployHeightFt,
    slickFallRateFps:
      typeof assumptions?.slickFallRateFps === "number"
        ? assumptions.slickFallRateFps
        : defaultWingsuitAutoAssumptions.slickFallRateFps,
    slickReturnRadiusFt:
      typeof assumptions?.slickReturnRadiusFt === "number"
        ? assumptions.slickReturnRadiusFt
        : defaultWingsuitAutoAssumptions.slickReturnRadiusFt,
  };
}

function normalizePersistedAutoSettings(
  value: Partial<WingsuitAutoSettings> & {
    jumpRun?: { start?: GeoPoint; end?: GeoPoint };
  },
): WingsuitAutoSettings {
  const legacyHeadingDeg =
    value.jumpRun?.start && value.jumpRun?.end
      ? headingFromCoordinates(value.jumpRun.start, value.jumpRun.end)
      : 0;

  return {
    planningMode: value.planningMode === "auto" ? "auto" : "manual",
    placementMode: value.placementMode === "distance" ? "distance" : "normal",
    directionMode:
      value.directionMode === "manual" || value.directionMode === "auto"
        ? value.directionMode
        : value.jumpRun
          ? "manual"
          : "auto",
    manualHeadingDeg:
      typeof value.manualHeadingDeg === "number" ? normalizeHeading(value.manualHeadingDeg) : legacyHeadingDeg,
    constraintMode: value.constraintMode === "reciprocal" ? "reciprocal" : "none",
    constraintHeadingDeg:
      typeof value.constraintHeadingDeg === "number" ? normalizeHeading(value.constraintHeadingDeg) : 0,
    distanceOffsetFt:
      typeof value.distanceOffsetFt === "number" && Number.isFinite(value.distanceOffsetFt) && value.distanceOffsetFt > 0
        ? value.distanceOffsetFt
        : defaultWingsuitDistanceOffsetFt,
    assumptions: normalizePersistedAssumptions(value.assumptions),
  };
}

const defaultWingsuitAutoSettings: WingsuitAutoSettings = {
  planningMode: "manual",
  placementMode: "normal",
  directionMode: "auto",
  manualHeadingDeg: 0,
  constraintMode: "none",
  constraintHeadingDeg: 0,
  distanceOffsetFt: defaultWingsuitDistanceOffsetFt,
  assumptions: defaultWingsuitAutoAssumptions,
};

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      language: resolveDefaultLanguage(),
      unitSystem: "imperial",
      mode: "canopy",
      location: { lat: defaultLat, lng: defaultLng, source: "default" },
      touchdown: { lat: defaultLat, lng: defaultLng },
      landingHeadingDeg: 180,
      side: "left",
      baseLegDrift: true,
      shearAlpha: 0.14,
      canopySettings: defaultCanopySettings,
      wingsuitSettings: defaultWingsuitSettings,
      wingsuitAutoSettings: defaultWingsuitAutoSettings,
      namedSpots: [],
      selectedSpotId: null,
      setMode: (mode) =>
        set(() => ({
          mode,
        })),
      setLocation: (lat, lng, source) =>
        set(() => ({
          location: { lat, lng, source },
        })),
      setTouchdown: (lat, lng) =>
        set(() => ({
          touchdown: { lat, lng },
        })),
      setHeading: (headingDeg) =>
        set(() => ({
          landingHeadingDeg: headingDeg,
        })),
      setSide: (side) =>
        set(() => ({
          side,
        })),
      setBaseLegDrift: (enabled) =>
        set(() => ({
          baseLegDrift: enabled,
        })),
      setShearAlpha: (alpha) =>
        set(() => ({
          shearAlpha: alpha,
        })),
      setCanopyGates: (gates) =>
        set((state) => ({
          canopySettings: {
            ...state.canopySettings,
            gatesFt: gates,
          },
        })),
      setCanopy: (canopy) =>
        set((state) => ({
          canopySettings: {
            ...state.canopySettings,
            canopy,
          },
        })),
      setExitWeight: (weightLb) =>
        set((state) => ({
          canopySettings: {
            ...state.canopySettings,
            exitWeightLb: weightLb,
          },
        })),
      setCanopyWindLayers: (layers) =>
        set((state) => ({
          canopySettings: {
            ...state.canopySettings,
            windLayers: layers,
          },
        })),
      updateCanopyWindLayer: (layerIndex, patch) =>
        set((state) => ({
          canopySettings: {
            ...state.canopySettings,
            windLayers: updateWindLayerList(state.canopySettings.windLayers, layerIndex, patch),
          },
        })),
      setWingsuitGates: (gates) =>
        set((state) => ({
          wingsuitSettings: {
            ...state.wingsuitSettings,
            gatesFt: gates,
          },
        })),
      setWingsuit: (wingsuit) =>
        set((state) => ({
          wingsuitSettings: {
            ...state.wingsuitSettings,
            wingsuit,
          },
        })),
      setWingsuitWindLayers: (layers) =>
        set((state) => ({
          wingsuitSettings: {
            ...state.wingsuitSettings,
            windLayers: layers,
          },
        })),
      updateWingsuitWindLayer: (layerIndex, patch) =>
        set((state) => ({
          wingsuitSettings: {
            ...state.wingsuitSettings,
            windLayers: updateWindLayerList(state.wingsuitSettings.windLayers, layerIndex, patch),
          },
        })),
      setWingsuitPlanningMode: (planningMode) =>
        set((state) => ({
          wingsuitAutoSettings: {
            ...state.wingsuitAutoSettings,
            planningMode,
          },
        })),
      setWingsuitAutoPlacementMode: (placementMode) =>
        set((state) => ({
          wingsuitAutoSettings: {
            ...state.wingsuitAutoSettings,
            placementMode,
          },
        })),
      setWingsuitAutoDirectionMode: (directionMode) =>
        set((state) => ({
          wingsuitAutoSettings: {
            ...state.wingsuitAutoSettings,
            directionMode,
          },
        })),
      setWingsuitAutoManualHeading: (manualHeadingDeg) =>
        set((state) => ({
          wingsuitAutoSettings: {
            ...state.wingsuitAutoSettings,
            manualHeadingDeg: normalizeHeading(manualHeadingDeg),
          },
        })),
      setWingsuitAutoConstraintMode: (constraintMode) =>
        set((state) => ({
          wingsuitAutoSettings: {
            ...state.wingsuitAutoSettings,
            constraintMode,
          },
        })),
      setWingsuitAutoConstraintHeading: (constraintHeadingDeg) =>
        set((state) => ({
          wingsuitAutoSettings: {
            ...state.wingsuitAutoSettings,
            constraintHeadingDeg: normalizeHeading(constraintHeadingDeg),
          },
        })),
      setWingsuitAutoDistanceOffset: (distanceOffsetFt) =>
        set((state) => ({
          wingsuitAutoSettings: {
            ...state.wingsuitAutoSettings,
            distanceOffsetFt:
              Number.isFinite(distanceOffsetFt) && distanceOffsetFt > 0
                ? distanceOffsetFt
                : defaultWingsuitDistanceOffsetFt,
          },
        })),
      setWingsuitAutoAssumptions: (patch) =>
        set((state) => ({
          wingsuitAutoSettings: {
            ...state.wingsuitAutoSettings,
            assumptions: normalizePersistedAssumptions({
              ...state.wingsuitAutoSettings.assumptions,
              ...patch,
            }),
          },
        })),
      setUnitSystem: (system) =>
        set(() => ({
          unitSystem: system,
        })),
      setLanguage: (language) =>
        set(() => ({
          language,
        })),
      saveNamedSpot: (name) => {
        const state = get();
        const id = `${Date.now()}`;
        const spot = {
          id,
          name,
          lat: state.touchdown.lat,
          lng: state.touchdown.lng,
        };
        set({
          namedSpots: [...state.namedSpots, spot],
          selectedSpotId: id,
        });
      },
      selectNamedSpot: (id) => {
        const state = get();
        const spot = state.namedSpots.find((item) => item.id === id);
        if (!spot) {
          return;
        }
        set({
          selectedSpotId: id,
          touchdown: { lat: spot.lat, lng: spot.lng },
        });
      },
    }),
    {
      name: "landing-pattern-store-v1",
      version: 4,
      migrate: (persistedState: unknown, version) => {
        const state = (persistedState ?? {}) as Partial<AppStore> & {
          gatesFt?: [number, number, number, number];
          canopy?: CanopyProfile;
          exitWeightLb?: number;
          windLayers?: WindLayer[];
        };

        const migrated = {
          language: state.language ?? resolveDefaultLanguage(),
          unitSystem: state.unitSystem ?? "imperial",
          mode: state.mode === "wingsuit" ? "wingsuit" : "canopy",
          location: state.location ?? { lat: defaultLat, lng: defaultLng, source: "default" },
          touchdown: state.touchdown ?? { lat: defaultLat, lng: defaultLng },
          landingHeadingDeg: state.landingHeadingDeg ?? 180,
          side: state.side ?? "left",
          baseLegDrift: state.baseLegDrift ?? true,
          shearAlpha: state.shearAlpha ?? 0.14,
          canopySettings:
            version >= 1 && state.canopySettings
              ? state.canopySettings
              : {
                  gatesFt: state.gatesFt ?? defaultCanopySettings.gatesFt,
                  canopy: state.canopy ?? defaultCanopySettings.canopy,
                  exitWeightLb: state.exitWeightLb ?? defaultCanopySettings.exitWeightLb,
                  windLayers: state.windLayers ?? defaultCanopySettings.windLayers,
                },
          wingsuitSettings:
            version >= 1 && state.wingsuitSettings
              ? {
                  ...defaultWingsuitSettings,
                  ...state.wingsuitSettings,
                  wingsuit: normalizeWingsuitProfile(state.wingsuitSettings.wingsuit),
                }
              : defaultWingsuitSettings,
          wingsuitAutoSettings: normalizePersistedAutoSettings(
            (state.wingsuitAutoSettings as Partial<WingsuitAutoSettings> & {
              jumpRun?: { start?: GeoPoint; end?: GeoPoint };
            }) ?? defaultWingsuitAutoSettings,
          ),
          namedSpots: state.namedSpots ?? [],
          selectedSpotId: state.selectedSpotId ?? null,
        };

        return migrated;
      },
      partialize: (state) => ({
        language: state.language,
        unitSystem: state.unitSystem,
        mode: state.mode,
        location: state.location,
        touchdown: state.touchdown,
        landingHeadingDeg: state.landingHeadingDeg,
        side: state.side,
        baseLegDrift: state.baseLegDrift,
        shearAlpha: state.shearAlpha,
        canopySettings: state.canopySettings,
        wingsuitSettings: state.wingsuitSettings,
        wingsuitAutoSettings: state.wingsuitAutoSettings,
        namedSpots: state.namedSpots,
        selectedSpotId: state.selectedSpotId,
      }),
    },
  ),
);
