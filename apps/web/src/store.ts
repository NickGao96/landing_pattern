import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CanopyProfile, FlightMode, PatternSide, WindLayer, WingsuitProfile } from "@landing/ui-types";
import { canopyPresets } from "@landing/data";
import {
  defaultWingsuitGatesFt,
  defaultWingsuitWindLayers,
  normalizeWingsuitProfile,
  wingsuitProfileForPreset,
} from "./wingsuits";

type UnitSystem = "imperial" | "metric";
export type Language = "en" | "zh";

interface NamedSpot {
  id: string;
  name: string;
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

interface AppStore {
  language: Language;
  unitSystem: UnitSystem;
  mode: FlightMode;
  location: {
    lat: number;
    lng: number;
    source: "default" | "gps" | "manual";
  };
  touchdown: {
    lat: number;
    lng: number;
  };
  landingHeadingDeg: number;
  side: PatternSide;
  baseLegDrift: boolean;
  shearAlpha: number;
  canopySettings: CanopySettings;
  wingsuitSettings: WingsuitSettings;
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
  setUnitSystem: (system: UnitSystem) => void;
  setLanguage: (language: Language) => void;
  saveNamedSpot: (name: string) => void;
  selectNamedSpot: (id: string) => void;
}

const defaultLat = 37.4419;
const defaultLng = -122.143;

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

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      language: "en",
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
      version: 2,
      migrate: (persistedState: unknown, version) => {
        const state = (persistedState ?? {}) as Partial<AppStore> & {
          gatesFt?: [number, number, number, number];
          canopy?: CanopyProfile;
          exitWeightLb?: number;
          windLayers?: WindLayer[];
        };

        if (version >= 1 && state.canopySettings && state.wingsuitSettings) {
          return {
            language: state.language ?? "en",
            unitSystem: state.unitSystem ?? "imperial",
            mode: state.mode === "wingsuit" ? "wingsuit" : "canopy",
            location: state.location ?? { lat: defaultLat, lng: defaultLng, source: "default" },
            touchdown: state.touchdown ?? { lat: defaultLat, lng: defaultLng },
            landingHeadingDeg: state.landingHeadingDeg ?? 180,
            side: state.side ?? "left",
            baseLegDrift: state.baseLegDrift ?? true,
            shearAlpha: state.shearAlpha ?? 0.14,
            canopySettings: state.canopySettings,
            wingsuitSettings: {
              ...defaultWingsuitSettings,
              ...state.wingsuitSettings,
              wingsuit: normalizeWingsuitProfile(state.wingsuitSettings.wingsuit),
            },
            namedSpots: state.namedSpots ?? [],
            selectedSpotId: state.selectedSpotId ?? null,
          };
        }

        return {
          language: state.language ?? "en",
          unitSystem: state.unitSystem ?? "imperial",
          mode: state.mode === "wingsuit" ? "wingsuit" : "canopy",
          location: state.location ?? { lat: defaultLat, lng: defaultLng, source: "default" },
          touchdown: state.touchdown ?? { lat: defaultLat, lng: defaultLng },
          landingHeadingDeg: state.landingHeadingDeg ?? 180,
          side: state.side ?? "left",
          baseLegDrift: state.baseLegDrift ?? true,
          shearAlpha: state.shearAlpha ?? 0.14,
          canopySettings: state.canopySettings ?? {
            gatesFt: state.gatesFt ?? defaultCanopySettings.gatesFt,
            canopy: state.canopy ?? defaultCanopySettings.canopy,
            exitWeightLb: state.exitWeightLb ?? defaultCanopySettings.exitWeightLb,
            windLayers: state.windLayers ?? defaultCanopySettings.windLayers,
          },
          wingsuitSettings: state.wingsuitSettings ?? defaultWingsuitSettings,
          namedSpots: state.namedSpots ?? [],
          selectedSpotId: state.selectedSpotId ?? null,
        };
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
        namedSpots: state.namedSpots,
        selectedSpotId: state.selectedSpotId,
      }),
    },
  ),
);
