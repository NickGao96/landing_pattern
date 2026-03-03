import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CanopyProfile, PatternSide, WindLayer } from "@landing/ui-types";
import { canopyPresets } from "@landing/data";

type UnitSystem = "imperial" | "metric";
export type Language = "en" | "zh";

interface NamedSpot {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface AppStore {
  language: Language;
  unitSystem: UnitSystem;
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
  gatesFt: [number, number, number, number];
  shearAlpha: number;
  canopy: CanopyProfile;
  exitWeightLb: number;
  windLayers: WindLayer[];
  namedSpots: NamedSpot[];
  selectedSpotId: string | null;
  setLocation: (lat: number, lng: number, source: "default" | "gps" | "manual") => void;
  setTouchdown: (lat: number, lng: number) => void;
  setHeading: (headingDeg: number) => void;
  setSide: (side: PatternSide) => void;
  setBaseLegDrift: (enabled: boolean) => void;
  setGates: (gates: [number, number, number, number]) => void;
  setShearAlpha: (alpha: number) => void;
  setCanopy: (canopy: CanopyProfile) => void;
  setExitWeight: (weightLb: number) => void;
  setWindLayers: (layers: WindLayer[]) => void;
  updateWindLayer: (layerIndex: number, patch: Partial<WindLayer>) => void;
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

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      language: "en",
      unitSystem: "imperial",
      location: { lat: defaultLat, lng: defaultLng, source: "default" },
      touchdown: { lat: defaultLat, lng: defaultLng },
      landingHeadingDeg: 180,
      side: "left",
      baseLegDrift: true,
      gatesFt: [900, 600, 300, 0],
      shearAlpha: 0.14,
      canopy: defaultPreset,
      exitWeightLb: 170,
      windLayers: [
        { altitudeFt: 900, speedKt: 10, dirFromDeg: 180, source: "manual" },
        { altitudeFt: 600, speedKt: 9, dirFromDeg: 180, source: "manual" },
        { altitudeFt: 300, speedKt: 8, dirFromDeg: 180, source: "manual" },
      ],
      namedSpots: [],
      selectedSpotId: null,
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
      setGates: (gates) =>
        set(() => ({
          gatesFt: gates,
        })),
      setShearAlpha: (alpha) =>
        set(() => ({
          shearAlpha: alpha,
        })),
      setCanopy: (canopy) =>
        set(() => ({
          canopy,
        })),
      setExitWeight: (weightLb) =>
        set(() => ({
          exitWeightLb: weightLb,
        })),
      setWindLayers: (layers) =>
        set(() => ({
          windLayers: layers,
        })),
      updateWindLayer: (layerIndex, patch) =>
        set((state) => ({
          windLayers: state.windLayers.map((layer, index) =>
            index === layerIndex
              ? {
                  ...layer,
                  ...patch,
                }
              : layer,
          ),
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
      partialize: (state) => ({
        language: state.language,
        unitSystem: state.unitSystem,
        location: state.location,
        touchdown: state.touchdown,
        landingHeadingDeg: state.landingHeadingDeg,
        side: state.side,
        baseLegDrift: state.baseLegDrift,
        gatesFt: state.gatesFt,
        shearAlpha: state.shearAlpha,
        canopy: state.canopy,
        exitWeightLb: state.exitWeightLb,
        windLayers: state.windLayers,
        namedSpots: state.namedSpots,
        selectedSpotId: state.selectedSpotId,
      }),
    },
  ),
);
