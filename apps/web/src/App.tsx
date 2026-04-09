import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, InputHTMLAttributes } from "react";
import { useMutation } from "@tanstack/react-query";
import { canopyPresets, extrapolateWindProfile, fetchNoaaSurfaceWind, fetchWingsuitWindProfile } from "@landing/data";
import { computePattern } from "@landing/engine";
import type {
  CanopyProfile,
  FlightMode,
  PatternInput,
  SurfaceWind,
  WindLayer,
  WingsuitPresetId,
  WingsuitProfile,
} from "@landing/ui-types";
import { feetToMeters, knotsToMps, metersToFeet, mpsToKnots } from "./lib/units";
import { type Language, useAppStore } from "./store";
import { MapPanel } from "./components/MapPanel";
import { glideRatioForWingsuit, normalizeWingsuitProfile, wingsuitProfileForPreset, withCustomWingsuit } from "./wingsuits";

function numberFromInput(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: number;
  onValueChange: (value: number) => void;
};

function NumberInput({ value, onValueChange, onFocus, onBlur, ...rest }: NumberInputProps) {
  const [draft, setDraft] = useState(() => String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(String(value));
    }
  }, [value]);

  return (
    <input
      {...rest}
      type="number"
      value={draft}
      onFocus={(event) => {
        focusedRef.current = true;
        onFocus?.(event);
      }}
      onBlur={(event) => {
        focusedRef.current = false;
        const trimmed = draft.trim();
        if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.") {
          setDraft(String(value));
          onBlur?.(event);
          return;
        }

        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
          setDraft(String(parsed));
          onValueChange(parsed);
        } else {
          setDraft(String(value));
        }
        onBlur?.(event);
      }}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const trimmed = raw.trim();
        if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.") {
          return;
        }

        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
          onValueChange(parsed);
        }
      }}
    />
  );
}

function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function circularDistanceDeg(a: number, b: number): number {
  const delta = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return Math.min(delta, 360 - delta);
}

function toDisplayFeet(unit: "imperial" | "metric", feet: number): number {
  return unit === "imperial" ? feet : feetToMeters(feet);
}

function fromDisplayFeet(unit: "imperial" | "metric", value: number): number {
  return unit === "imperial" ? value : metersToFeet(value);
}

function toDisplayKnots(unit: "imperial" | "metric", knots: number): number {
  return unit === "imperial" ? knots : knotsToMps(knots);
}

function fromDisplayKnots(unit: "imperial" | "metric", value: number): number {
  return unit === "imperial" ? value : mpsToKnots(value);
}

const DEFAULT_AIRSPEED_MIN_KT = 8;
const DEFAULT_AIRSPEED_MAX_KT = 35;

function buildPatternInput(state: {
  mode: FlightMode;
  touchdown: { lat: number; lng: number };
  landingHeadingDeg: number;
  side: "left" | "right";
  baseLegDrift: boolean;
  canopySettings: {
    gatesFt: [number, number, number, number];
    windLayers: WindLayer[];
    canopy: CanopyProfile;
    exitWeightLb: number;
  };
  wingsuitSettings: {
    gatesFt: [number, number, number, number];
    windLayers: WindLayer[];
    wingsuit: WingsuitProfile;
  };
}): PatternInput {
  const gatesFt = state.mode === "canopy" ? state.canopySettings.gatesFt : state.wingsuitSettings.gatesFt;
  const windLayers = state.mode === "canopy" ? state.canopySettings.windLayers : state.wingsuitSettings.windLayers;
  return {
    mode: state.mode,
    touchdownLat: state.touchdown.lat,
    touchdownLng: state.touchdown.lng,
    landingHeadingDeg: state.landingHeadingDeg,
    side: state.side,
    baseLegDrift: state.baseLegDrift,
    gatesFt,
    winds: windLayers,
    canopy: state.canopySettings.canopy,
    jumper: {
      exitWeightLb: state.canopySettings.exitWeightLb,
      canopyAreaSqft: state.canopySettings.canopy.sizeSqft,
    },
    wingsuit: state.wingsuitSettings.wingsuit,
  };
}

function getRequestedWindAltitudes(mode: FlightMode, gatesFt: [number, number, number, number]): number[] {
  if (mode === "canopy") {
    return [gatesFt[0], gatesFt[1], gatesFt[2]];
  }

  const activeAltitudes: number[] = [];
  if (gatesFt[0] > gatesFt[1]) {
    activeAltitudes.push(gatesFt[0]);
  }
  if (gatesFt[1] > gatesFt[2]) {
    activeAltitudes.push(gatesFt[1]);
  }
  if (gatesFt[2] > gatesFt[3]) {
    activeAltitudes.push(gatesFt[2]);
  }
  return activeAltitudes;
}

function exportSnapshot(data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `landing-pattern-snapshot-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function readTextFromFile(file: File): Promise<string> {
  if (typeof file.text === "function") {
    return file.text();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read file."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

interface LocationSearchResult {
  lat: number;
  lng: number;
  displayName: string;
}

const translations = {
  en: {
    statusReady: "Ready.",
    title: "Flight Pattern Simulator",
    planningNote:
      "Planning aid only. Not operational guidance. Always follow DZ procedures, traffic, and instructor/coach input.",
    languageSection: "Language",
    languageEnglish: "English",
    languageChinese: "中文",
    unitsSection: "Units",
    imperial: "Imperial",
    metric: "Metric",
    touchdownSpot: "Touchdown Spot",
    useBrowserLocation: "Use Browser Location",
    loadingWind: "Loading Wind...",
    fetchNoaaWind: "Fetch NOAA Wind",
    searchPlaceholder: "Search place or address",
    searching: "Searching...",
    searchLocation: "Search Location",
    lat: "Lat",
    lng: "Lng",
    applyTouchdown: "Apply Touchdown",
    spotNamePlaceholder: "Spot name",
    saveSpot: "Save Spot",
    selectSavedSpot: "Select saved spot",
    modeSection: "Flight Mode",
    canopyMode: "Canopy",
    wingsuitMode: "Wingsuit",
    canopyAndJumper: "Canopy + Jumper",
    wingsuitSettings: "Wingsuit",
    preset: "Preset",
    canopySizeSqft: "Canopy Size (sqft)",
    exitWeightLb: "Exit Weight (lb)",
    airspeedRefAtWlRefKt: "Airspeed Ref @ WL Ref (kt)",
    wlRef: "WL Ref",
    glideRatio: "Glide Ratio",
    wlSpeedExponent: "WL Speed Exponent",
    airspeedMinKt: "Airspeed Min (kt)",
    airspeedMaxKt: "Airspeed Max (kt)",
    currentWlSummary: (wingLoading: number, modeledAirspeedKt: number) =>
      `Current WL ${wingLoading.toFixed(2)} => Modeled Airspeed ${modeledAirspeedKt.toFixed(1)} kt`,
    currentWingsuitSummary: (flightSpeedKt: number, fallRateFps: number, glideRatio: number) =>
      `Horizontal ${flightSpeedKt.toFixed(1)} kt, Vertical ${fallRateFps.toFixed(1)} ft/s, Approx GR ${glideRatio.toFixed(2)}`,
    rawModelSummary: (modeledRawAirspeedKt: number, airspeedClampLabel: string | null) =>
      `Raw model ${modeledRawAirspeedKt.toFixed(1)} kt${airspeedClampLabel ? ` (${airspeedClampLabel})` : ""}`,
    wingsuitPreset: "Wingsuit Preset",
    wingsuitPresetSwift: "SWIFT",
    wingsuitPresetAtc: "ATC",
    wingsuitPresetFreak: "FREAK",
    wingsuitPresetAura: "AURA",
    wingsuitPresetCustom: "Custom",
    wingsuitName: "Wingsuit Name",
    flightSpeedKt: "Horizontal Speed (kt)",
    fallRateFps: "Fall Rate (ft/s)",
    patternSettings: "Pattern Settings",
    side: "Side",
    left: "Left",
    right: "Right",
    allowBaseDrift: "Allow Base Drift",
    landingHeadingDeg: "Landing Heading (deg)",
    suggestHeadwindFinal: "Suggest Headwind Final",
    landingDirectionSlider: "Landing Direction Slider",
    gateLabel: (mode: FlightMode, index: number, altUnitLabel: string) =>
      mode === "canopy"
        ? `${(["Downwind", "Base", "Final", "Touchdown"][index] ?? `Gate ${index + 1}`)} (${altUnitLabel})`
        : `${(["Exit", "Turn 1", "Turn 2", "Deploy"][index] ?? `Gate ${index + 1}`)} (${altUnitLabel})`,
    shearExponent: "Shear Exponent",
    windLayers: "Wind Layers",
    altLabel: (altUnitLabel: string) => `Alt (${altUnitLabel})`,
    speedLabel: (speedUnitLabel: string) => `Speed (${speedUnitLabel})`,
    directionFromDeg: "Direction From (deg)",
    outputs: "Outputs",
    wingLoading: "Wing Loading",
    estAirspeed: "Est. Airspeed",
    estFlightSpeed: "Horizontal Speed",
    lastSurfaceWind: (
      speed: string,
      speedUnitLabel: string,
      dirFromDeg: string,
      source: string,
    ) => `Last Surface Wind: ${speed} ${speedUnitLabel} from ${dirFromDeg} deg (${source})`,
    speedModel: (airspeedRefKt: string, wlRef: string, exponent: string) =>
      `Speed Model: ref ${airspeedRefKt}kt @ WL ${wlRef}, exponent ${exponent}`,
    wingsuitModel: (name: string) => `Wingsuit setup: ${name}`,
    estSink: (estSinkFps: string) => `Est. Sink: ${estSinkFps} ft/s`,
    leg: "Leg",
    heading: "Heading",
    track: "Track",
    fwdLabel: (speedUnitLabel: string) => `Fwd (${speedUnitLabel})`,
    gsLabel: (speedUnitLabel: string) => `GS (${speedUnitLabel})`,
    timeSeconds: "Time (s)",
    distLabel: (altUnitLabel: string) => `Dist (${altUnitLabel})`,
    saferHeadings: "Safer headings (no backward leg):",
    noForwardHeading: "No fully forward heading found in current winds.",
    importExport: "Import / Export",
    exportSnapshotJson: "Export Snapshot JSON",
    importSnapshotJson: "Import Snapshot JSON",
    fetchWingsuitWind: "Fetch Upper Winds",
    statusLoadedWind: (surfaceWind: SurfaceWind, lat: number, lng: number) =>
      `Loaded ${surfaceWind.source} wind at touchdown (${lat.toFixed(4)}, ${lng.toFixed(4)}): ${surfaceWind.speedKt.toFixed(1)} kt from ${surfaceWind.dirFromDeg.toFixed(0)} deg.`,
    statusLoadedUpperWind: (count: number) => `Loaded upper-air winds for ${count} active start altitude${count === 1 ? "" : "s"}.`,
    statusLoadedUpperWindFallback: (errorText: string) =>
      `Upper-air wind fetch failed. Fell back to extrapolated surface winds. ${errorText}`,
    statusAutoWindFailed: (errorText: string, includeCoverageHint: boolean) =>
      `Auto wind failed. Use manual inputs.${includeCoverageHint ? " NOAA API is mostly US-only; this spot may be outside coverage." : ""} ${errorText}`.trim(),
    statusGeoUnavailable: "Geolocation is not available in this browser.",
    statusLocationSetFromGeolocation: "Location set from browser geolocation.",
    statusGeolocationFailed: "Geolocation failed. Enter location manually.",
    statusLocationSet: (displayName: string) => `Location set to ${displayName}.`,
    statusEnterSearch: "Enter a place or address to search.",
    statusNoSearchResults: "No location results found.",
    statusLocationSearchFailed: (errorText: string) => `Location search failed: ${errorText}`,
    statusNoWindLayer: "No wind layer available to suggest landing direction.",
    statusHeadingSuggested: "Landing heading set to headwind suggestion.",
    statusSnapshotImported: "Snapshot imported.",
    statusImportFailed: (errorText: string) => `Import failed: ${errorText}`,
    airspeedCapped: (maxKt: number) => `Airspeed capped by max ${maxKt.toFixed(1)} kt.`,
    airspeedRaised: (minKt: number) => `Airspeed raised to min ${minKt.toFixed(1)} kt.`,
    outputBlocked: "Pattern blocked by safety model.",
    outputCaution: "Pattern computed with caution warnings.",
    outputValid: "Pattern valid.",
    segmentNames: {
      downwind: "Downwind",
      base: "Base",
      final: "Final",
    },
  },
  zh: {
    statusReady: "就绪。",
    title: "飞行航线模拟器",
    planningNote: "仅用于规划参考，不构成实际运行指导。请始终遵守 DZ 程序、空中交通和教练指示。",
    languageSection: "语言",
    languageEnglish: "English",
    languageChinese: "中文",
    unitsSection: "单位",
    imperial: "英制",
    metric: "公制",
    touchdownSpot: "着陆点",
    useBrowserLocation: "使用浏览器定位",
    loadingWind: "正在加载风数据...",
    fetchNoaaWind: "获取 NOAA 风数据",
    searchPlaceholder: "搜索地点或地址",
    searching: "搜索中...",
    searchLocation: "搜索位置",
    lat: "纬度",
    lng: "经度",
    applyTouchdown: "应用着陆点",
    spotNamePlaceholder: "点位名称",
    saveSpot: "保存点位",
    selectSavedSpot: "选择已保存点位",
    modeSection: "飞行模式",
    canopyMode: "伞翼",
    wingsuitMode: "翼装",
    canopyAndJumper: "伞翼与跳伞员",
    wingsuitSettings: "翼装",
    preset: "预设",
    canopySizeSqft: "伞翼面积 (sqft)",
    exitWeightLb: "出舱重量 (lb)",
    airspeedRefAtWlRefKt: "参考翼载下参考空速 (kt)",
    wlRef: "参考翼载",
    glideRatio: "滑翔比",
    wlSpeedExponent: "翼载速度指数",
    airspeedMinKt: "最小空速 (kt)",
    airspeedMaxKt: "最大空速 (kt)",
    currentWlSummary: (wingLoading: number, modeledAirspeedKt: number) =>
      `当前翼载 ${wingLoading.toFixed(2)} => 模型空速 ${modeledAirspeedKt.toFixed(1)} kt`,
    currentWingsuitSummary: (flightSpeedKt: number, fallRateFps: number, glideRatio: number) =>
      `水平速度 ${flightSpeedKt.toFixed(1)} kt，垂直速度 ${fallRateFps.toFixed(1)} ft/s，约滑翔比 ${glideRatio.toFixed(2)}`,
    rawModelSummary: (modeledRawAirspeedKt: number, airspeedClampLabel: string | null) =>
      `原始模型 ${modeledRawAirspeedKt.toFixed(1)} kt${airspeedClampLabel ? `（${airspeedClampLabel}）` : ""}`,
    wingsuitPreset: "翼装预设",
    wingsuitPresetSwift: "SWIFT",
    wingsuitPresetAtc: "ATC",
    wingsuitPresetFreak: "FREAK",
    wingsuitPresetAura: "AURA",
    wingsuitPresetCustom: "自定义",
    wingsuitName: "翼装名称",
    flightSpeedKt: "水平速度 (kt)",
    fallRateFps: "下沉率 (ft/s)",
    patternSettings: "航线设置",
    side: "方向",
    left: "左",
    right: "右",
    allowBaseDrift: "允许第二边随风漂移",
    landingHeadingDeg: "着陆航向 (度)",
    suggestHeadwindFinal: "一键设为迎风着陆航向",
    landingDirectionSlider: "着陆方向滑块",
    gateLabel: (mode: FlightMode, index: number, altUnitLabel: string) =>
      mode === "canopy"
        ? `${(["第一边", "第二边", "第三边", "接地点"][index] ?? `阶段${index + 1}`)}高度 (${altUnitLabel})`
        : `${(["出舱", "第一转弯", "第二转弯", "开伞"][index] ?? `阶段${index + 1}`)}高度 (${altUnitLabel})`,
    shearExponent: "风切变指数",
    windLayers: "分层风",
    altLabel: (altUnitLabel: string) => `高度 (${altUnitLabel})`,
    speedLabel: (speedUnitLabel: string) => `速度 (${speedUnitLabel})`,
    directionFromDeg: "来向 (度)",
    outputs: "输出",
    wingLoading: "翼载",
    estAirspeed: "估算空速",
    estFlightSpeed: "水平速度",
    lastSurfaceWind: (
      speed: string,
      speedUnitLabel: string,
      dirFromDeg: string,
      source: string,
    ) => `最近地表风: ${speed} ${speedUnitLabel}，来自 ${dirFromDeg} 度（${source}）`,
    speedModel: (airspeedRefKt: string, wlRef: string, exponent: string) =>
      `速度模型: 参考 ${airspeedRefKt}kt @ 翼载 ${wlRef}，指数 ${exponent}`,
    wingsuitModel: (name: string) => `翼装配置：${name}`,
    estSink: (estSinkFps: string) => `估算下沉率: ${estSinkFps} ft/s`,
    leg: "航段",
    heading: "航向",
    track: "航迹",
    fwdLabel: (speedUnitLabel: string) => `前向 (${speedUnitLabel})`,
    gsLabel: (speedUnitLabel: string) => `地速 (${speedUnitLabel})`,
    timeSeconds: "时间 (s)",
    distLabel: (altUnitLabel: string) => `距离 (${altUnitLabel})`,
    saferHeadings: "更安全航向（无倒飞航段）：",
    noForwardHeading: "当前风况下未找到全程前向航向。",
    importExport: "导入 / 导出",
    exportSnapshotJson: "导出快照 JSON",
    importSnapshotJson: "导入快照 JSON",
    fetchWingsuitWind: "获取高空风",
    statusLoadedWind: (surfaceWind: SurfaceWind, lat: number, lng: number) =>
      `已加载 ${surfaceWind.source} 风数据（着陆点 ${lat.toFixed(4)}, ${lng.toFixed(4)}）：${surfaceWind.speedKt.toFixed(1)} kt，来向 ${surfaceWind.dirFromDeg.toFixed(0)} 度。`,
    statusLoadedUpperWind: (count: number) => `已加载 ${count} 个有效起始高度的高空风。`,
    statusLoadedUpperWindFallback: (errorText: string) => `高空风获取失败，已回退为地表风外推。${errorText}`,
    statusAutoWindFailed: (errorText: string, includeCoverageHint: boolean) =>
      `自动获取风数据失败，请手动输入。${includeCoverageHint ? " NOAA API 主要覆盖美国，此地点可能超出范围。" : ""} ${errorText}`.trim(),
    statusGeoUnavailable: "当前浏览器不支持定位。",
    statusLocationSetFromGeolocation: "已使用浏览器定位设置位置。",
    statusGeolocationFailed: "定位失败，请手动输入位置。",
    statusLocationSet: (displayName: string) => `已将位置设为 ${displayName}。`,
    statusEnterSearch: "请输入地点或地址进行搜索。",
    statusNoSearchResults: "未找到位置结果。",
    statusLocationSearchFailed: (errorText: string) => `位置搜索失败：${errorText}`,
    statusNoWindLayer: "当前没有可用于计算迎风航向的风层。",
    statusHeadingSuggested: "已将着陆航向设置为迎风方向。",
    statusSnapshotImported: "快照已导入。",
    statusImportFailed: (errorText: string) => `导入失败：${errorText}`,
    airspeedCapped: (maxKt: number) => `空速被最大值 ${maxKt.toFixed(1)} kt 限制。`,
    airspeedRaised: (minKt: number) => `空速已提升到最小值 ${minKt.toFixed(1)} kt。`,
    outputBlocked: "航线被安全模型拦截。",
    outputCaution: "航线已计算，但包含警告。",
    outputValid: "航线有效。",
    segmentNames: {
      downwind: "第一边",
      base: "第二边",
      final: "第三边",
    },
  },
} as const;

function formatSegmentName(language: Language, name: string): string {
  const normalized = name.trim().toLowerCase();
  const translated =
    translations[language].segmentNames[normalized as keyof (typeof translations)[Language]["segmentNames"]];
  return translated ?? name;
}

export default function App() {
  const {
    language,
    setLanguage,
    unitSystem,
    setUnitSystem,
    mode,
    setMode,
    location,
    setLocation,
    touchdown,
    setTouchdown,
    landingHeadingDeg,
    setHeading,
    side,
    setSide,
    baseLegDrift,
    setBaseLegDrift,
    shearAlpha,
    setShearAlpha,
    canopySettings,
    setCanopyGates,
    setCanopy,
    setExitWeight,
    setCanopyWindLayers,
    updateCanopyWindLayer,
    wingsuitSettings,
    setWingsuitGates,
    setWingsuit,
    setWingsuitWindLayers,
    updateWingsuitWindLayer,
    namedSpots,
    saveNamedSpot,
    selectNamedSpot,
  } = useAppStore();
  const t = translations[language];
  const canopy = canopySettings.canopy;
  const exitWeightLb = canopySettings.exitWeightLb;
  const wingsuit = wingsuitSettings.wingsuit;
  const wingsuitPresetId: WingsuitPresetId =
    wingsuit.presetId === "swift" ||
    wingsuit.presetId === "atc" ||
    wingsuit.presetId === "freak" ||
    wingsuit.presetId === "aura"
      ? wingsuit.presetId
      : "custom";
  const gatesFt = mode === "canopy" ? canopySettings.gatesFt : wingsuitSettings.gatesFt;
  const windLayers = mode === "canopy" ? canopySettings.windLayers : wingsuitSettings.windLayers;
  const wingsuitGlideRatio = useMemo(() => glideRatioForWingsuit(wingsuit), [wingsuit]);

  function setActiveGates(nextGates: [number, number, number, number]): void {
    if (mode === "canopy") {
      setCanopyGates(nextGates);
    } else {
      setWingsuitGates(nextGates);
    }
  }

  function setActiveWindLayers(nextLayers: WindLayer[]): void {
    if (mode === "canopy") {
      setCanopyWindLayers(nextLayers);
    } else {
      setWingsuitWindLayers(nextLayers);
    }
  }

  function updateActiveWindLayer(layerIndex: number, patch: Partial<WindLayer>): void {
    if (mode === "canopy") {
      updateCanopyWindLayer(layerIndex, patch);
    } else {
      updateWingsuitWindLayer(layerIndex, patch);
    }
  }

  function handleWingsuitPresetChange(presetId: WingsuitPresetId): void {
    if (presetId === "custom") {
      setWingsuit(withCustomWingsuit(wingsuit));
      return;
    }
    setWingsuit(wingsuitProfileForPreset(presetId));
  }

  const [touchdownLatInput, setTouchdownLatInput] = useState(touchdown.lat.toFixed(5));
  const [touchdownLngInput, setTouchdownLngInput] = useState(touchdown.lng.toFixed(5));
  const [locationQuery, setLocationQuery] = useState("");
  const [locationSearchResults, setLocationSearchResults] = useState<LocationSearchResult[]>([]);
  const [isSearchingLocation, setIsSearchingLocation] = useState(false);
  const [lastSurfaceWind, setLastSurfaceWind] = useState<SurfaceWind | null>(null);
  const [spotName, setSpotName] = useState("");
  const [statusMessage, setStatusMessage] = useState<string>(translations.en.statusReady);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setStatusMessage((current) =>
      current === translations.en.statusReady || current === translations.zh.statusReady ? t.statusReady : current,
    );
  }, [t.statusReady]);

  const patternInput = useMemo(
    () =>
      buildPatternInput({
        mode,
        touchdown,
        landingHeadingDeg,
        side,
        baseLegDrift,
        canopySettings,
        wingsuitSettings,
      }),
    [mode, touchdown, landingHeadingDeg, side, baseLegDrift, canopySettings, wingsuitSettings],
  );

  const patternOutput = useMemo(() => computePattern(patternInput), [patternInput]);

  const safeLandingHeadings = useMemo(() => {
    const candidates: number[] = [];
    for (let heading = 0; heading < 360; heading += 5) {
      const result = computePattern({
        ...patternInput,
        landingHeadingDeg: heading,
      });
      if (result.blocked) {
        continue;
      }
      const forwardSafe = result.segments.every((segment) => segment.alongLegSpeedKt > 0);
      if (forwardSafe) {
        candidates.push(heading);
      }
    }
    return candidates
      .sort((a, b) => circularDistanceDeg(a, landingHeadingDeg) - circularDistanceDeg(b, landingHeadingDeg))
      .slice(0, 8);
  }, [patternInput, landingHeadingDeg]);

  const windMutation = useMutation({
    mutationFn: async () => {
      const requestedAltitudes = getRequestedWindAltitudes(mode, gatesFt);
      if (mode === "wingsuit") {
        try {
          const profile = await fetchWingsuitWindProfile(touchdown.lat, touchdown.lng, requestedAltitudes);
          return {
            type: "upper-air" as const,
            profile,
          };
        } catch (error) {
          const surfaceWind = await fetchNoaaSurfaceWind(touchdown.lat, touchdown.lng);
          return {
            type: "fallback" as const,
            profile: extrapolateWindProfile(surfaceWind, requestedAltitudes, shearAlpha),
            surfaceWind,
            errorText: String(error),
          };
        }
      }

      const surfaceWind = await fetchNoaaSurfaceWind(touchdown.lat, touchdown.lng);
      return {
        type: "surface" as const,
        profile: extrapolateWindProfile(surfaceWind, requestedAltitudes, shearAlpha),
        surfaceWind,
      };
    },
    onSuccess: (result) => {
      setActiveWindLayers(result.profile);
      if (result.type === "surface") {
        setLastSurfaceWind(result.surfaceWind);
        setStatusMessage(t.statusLoadedWind(result.surfaceWind, touchdown.lat, touchdown.lng));
        return;
      }
      if (result.type === "fallback") {
        setLastSurfaceWind(result.surfaceWind);
        setStatusMessage(t.statusLoadedUpperWindFallback(result.errorText));
        return;
      }
      setLastSurfaceWind(null);
      setStatusMessage(t.statusLoadedUpperWind(result.profile.length));
    },
    onError: (error) => {
      setLastSurfaceWind(null);
      const errorText = String(error);
      const includeCoverageHint = errorText.includes("/points/") && errorText.includes("404");
      setStatusMessage(t.statusAutoWindFailed(errorText, includeCoverageHint));
    },
  });

  function handleUseGeolocation(): void {
    if (!("geolocation" in navigator)) {
      setStatusMessage(t.statusGeoUnavailable);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setLocation(lat, lng, "gps");
        setTouchdown(lat, lng);
        setTouchdownLatInput(lat.toFixed(5));
        setTouchdownLngInput(lng.toFixed(5));
        setStatusMessage(t.statusLocationSetFromGeolocation);
      },
      () => {
        setStatusMessage(t.statusGeolocationFailed);
      },
      {
        timeout: 5000,
      },
    );
  }

  function handleTouchdownChange(lat: number, lng: number): void {
    setLocation(lat, lng, "manual");
    setTouchdown(lat, lng);
    setTouchdownLatInput(lat.toFixed(5));
    setTouchdownLngInput(lng.toFixed(5));
  }

  function handleTouchdownInputApply(): void {
    const lat = numberFromInput(touchdownLatInput, touchdown.lat);
    const lng = numberFromInput(touchdownLngInput, touchdown.lng);
    handleTouchdownChange(lat, lng);
  }

  function applySearchedLocation(result: LocationSearchResult): void {
    handleTouchdownChange(result.lat, result.lng);
    setStatusMessage(t.statusLocationSet(result.displayName));
  }

  async function handleSearchLocation(): Promise<void> {
    const query = locationQuery.trim();
    if (!query) {
      setStatusMessage(t.statusEnterSearch);
      return;
    }

    setIsSearchingLocation(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`Search failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as Array<{
        lat: string;
        lon: string;
        display_name: string;
      }>;

      const results = payload
        .map((entry) => ({
          lat: Number(entry.lat),
          lng: Number(entry.lon),
          displayName: entry.display_name,
        }))
        .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lng));

      setLocationSearchResults(results);
      if (results.length === 0) {
        setStatusMessage(t.statusNoSearchResults);
        return;
      }

      const firstResult = results[0];
      if (firstResult) {
        applySearchedLocation(firstResult);
      }
    } catch (error) {
      setStatusMessage(t.statusLocationSearchFailed(String(error)));
    } finally {
      setIsSearchingLocation(false);
    }
  }

  function handleSetSuggestedHeading(): void {
    const lowLayer = [...windLayers].sort((a, b) => a.altitudeFt - b.altitudeFt)[0];
    if (!lowLayer) {
      setStatusMessage(t.statusNoWindLayer);
      return;
    }
    setHeading(lowLayer.dirFromDeg);
    setStatusMessage(t.statusHeadingSuggested);
  }

  function handlePresetChange(model: string): void {
    const preset = canopyPresets.find((item) => item.model === model);
    if (!preset) {
      return;
    }
    setCanopy({ ...preset });
  }

  function handleExport(): void {
    exportSnapshot({
      mode,
      location,
      touchdown,
      landingHeadingDeg,
      side,
      baseLegDrift,
      shearAlpha,
      canopySettings,
      wingsuitSettings,
      namedSpots,
      unitSystem,
      language,
    });
  }

  function handleImportClick(): void {
    importInputRef.current?.click();
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await readTextFromFile(file);
      const payload = JSON.parse(text) as Partial<{
        mode: FlightMode;
        location: { lat: number; lng: number; source?: "default" | "gps" | "manual" };
        touchdown: { lat: number; lng: number };
        landingHeadingDeg: number;
        side: "left" | "right";
        baseLegDrift: boolean;
        gatesFt: [number, number, number, number];
        shearAlpha: number;
        canopy: CanopyProfile;
        exitWeightLb: number;
        windLayers: WindLayer[];
        canopySettings: {
          gatesFt: [number, number, number, number];
          canopy: CanopyProfile;
          exitWeightLb: number;
          windLayers: WindLayer[];
        };
        wingsuitSettings: {
          gatesFt: [number, number, number, number];
          wingsuit: WingsuitProfile;
          windLayers: WindLayer[];
        };
        language: Language;
      }>;

      if (payload.location) {
        const source = payload.location.source === "gps" ? "gps" : "manual";
        setLocation(payload.location.lat, payload.location.lng, source);
        if (!payload.touchdown) {
          handleTouchdownChange(payload.location.lat, payload.location.lng);
        }
      }
      if (payload.touchdown) {
        handleTouchdownChange(payload.touchdown.lat, payload.touchdown.lng);
      }
      if (typeof payload.landingHeadingDeg === "number") {
        setHeading(payload.landingHeadingDeg);
      }
      if (payload.side === "left" || payload.side === "right") {
        setSide(payload.side);
      }
      if (typeof payload.baseLegDrift === "boolean") {
        setBaseLegDrift(payload.baseLegDrift);
      }
      if (typeof payload.shearAlpha === "number") {
        setShearAlpha(payload.shearAlpha);
      }
      if (payload.canopySettings) {
        if (payload.canopySettings.gatesFt?.length === 4) {
          setCanopyGates(payload.canopySettings.gatesFt);
        }
        if (payload.canopySettings.canopy) {
          setCanopy(payload.canopySettings.canopy);
        }
        if (typeof payload.canopySettings.exitWeightLb === "number") {
          setExitWeight(payload.canopySettings.exitWeightLb);
        }
        if (payload.canopySettings.windLayers?.length) {
          setCanopyWindLayers(payload.canopySettings.windLayers);
        }
      } else {
        if (payload.gatesFt && payload.gatesFt.length === 4) {
          setCanopyGates(payload.gatesFt);
        }
        if (payload.canopy) {
          setCanopy(payload.canopy);
        }
        if (typeof payload.exitWeightLb === "number") {
          setExitWeight(payload.exitWeightLb);
        }
        if (payload.windLayers && payload.windLayers.length > 0) {
          setCanopyWindLayers(payload.windLayers);
        }
      }
      if (payload.wingsuitSettings) {
        if (payload.wingsuitSettings.gatesFt?.length === 4) {
          setWingsuitGates(payload.wingsuitSettings.gatesFt);
        }
        if (payload.wingsuitSettings.wingsuit) {
          setWingsuit(normalizeWingsuitProfile(payload.wingsuitSettings.wingsuit));
        }
        if (payload.wingsuitSettings.windLayers?.length) {
          setWingsuitWindLayers(payload.wingsuitSettings.windLayers);
        }
      }
      if (payload.mode === "canopy" || payload.mode === "wingsuit") {
        setMode(payload.mode);
      } else {
        setMode("canopy");
      }
      if (payload.language === "en" || payload.language === "zh") {
        setLanguage(payload.language);
      }

      setStatusMessage(t.statusSnapshotImported);
    } catch (error) {
      setStatusMessage(t.statusImportFailed(String(error)));
    }
  }

  const speedUnitLabel = unitSystem === "imperial" ? "kt" : "m/s";
  const altUnitLabel = unitSystem === "imperial" ? "ft" : "m";
  const airspeedMinKt = canopy.airspeedMinKt ?? DEFAULT_AIRSPEED_MIN_KT;
  const airspeedMaxKt = canopy.airspeedMaxKt ?? DEFAULT_AIRSPEED_MAX_KT;
  const airspeedRange = Math.max(airspeedMaxKt - airspeedMinKt, 1);
  const wingLoading = patternOutput.metrics.wingLoading ?? 0;
  const wlRatio = wingLoading / Math.max(canopy.wlRef, 1e-6);
  const modeledRawAirspeedKt = canopy.airspeedRefKt * Math.pow(Math.max(wlRatio, 1e-6), canopy.airspeedWlExponent ?? 0.5);
  const modeledAirspeedKt = patternOutput.metrics.estAirspeedKt;
  const airspeedGaugePct = Math.min(100, Math.max(0, ((modeledAirspeedKt - airspeedMinKt) / airspeedRange) * 100));
  const clampTolerance = 0.05;
  const airspeedClampLabel =
    modeledRawAirspeedKt > airspeedMaxKt + clampTolerance
      ? t.airspeedCapped(airspeedMaxKt)
      : modeledRawAirspeedKt < airspeedMinKt - clampTolerance
        ? t.airspeedRaised(airspeedMinKt)
        : null;
  const hasCautionWarnings = patternOutput.warnings.length > 0;
  const outputStatusClass = patternOutput.blocked ? "blocked" : hasCautionWarnings ? "caution" : "ok";
  const outputStatusText = patternOutput.blocked
    ? t.outputBlocked
    : hasCautionWarnings
      ? t.outputCaution
      : t.outputValid;

  return (
    <div className="app-shell">
      <header className="banner">
        <h1>{t.title}</h1>
        <p>{t.planningNote}</p>
      </header>

      <main className="layout">
        <section className="map-column">
          <MapPanel
            language={language}
            touchdown={touchdown}
            waypoints={patternOutput.waypoints}
            blocked={patternOutput.blocked}
            hasWarnings={patternOutput.warnings.length > 0}
            landingHeadingDeg={landingHeadingDeg}
            windLayers={windLayers}
            onTouchdownChange={handleTouchdownChange}
            onHeadingChange={(headingDeg) => setHeading(headingDeg)}
          />
        </section>

        <aside className="sidebar">
          <section>
            <h2>{t.languageSection}</h2>
            <div className="row">
              <label>
                <input type="radio" checked={language === "en"} onChange={() => setLanguage("en")} />
                {t.languageEnglish}
              </label>
              <label>
                <input type="radio" checked={language === "zh"} onChange={() => setLanguage("zh")} />
                {t.languageChinese}
              </label>
            </div>
          </section>

          <section>
            <h2>{t.unitsSection}</h2>
            <div className="row">
              <label>
                <input
                  type="radio"
                  checked={unitSystem === "imperial"}
                  onChange={() => setUnitSystem("imperial")}
                />
                {t.imperial}
              </label>
              <label>
                <input type="radio" checked={unitSystem === "metric"} onChange={() => setUnitSystem("metric")} />
                {t.metric}
              </label>
            </div>
          </section>

          <section>
            <h2>{t.modeSection}</h2>
            <div className="row">
              <label>
                <input type="radio" checked={mode === "canopy"} onChange={() => setMode("canopy")} />
                {t.canopyMode}
              </label>
              <label>
                <input type="radio" checked={mode === "wingsuit"} onChange={() => setMode("wingsuit")} />
                {t.wingsuitMode}
              </label>
            </div>
          </section>

          <section>
            <h2>{t.touchdownSpot}</h2>
            <div className="row wrap">
              <button onClick={handleUseGeolocation}>{t.useBrowserLocation}</button>
              <button onClick={() => windMutation.mutate()} disabled={windMutation.isPending}>
                {windMutation.isPending ? t.loadingWind : mode === "canopy" ? t.fetchNoaaWind : t.fetchWingsuitWind}
              </button>
            </div>
            <div className="location-search">
              <input
                placeholder={t.searchPlaceholder}
                value={locationQuery}
                onChange={(event) => setLocationQuery(event.target.value)}
              />
              <button onClick={() => void handleSearchLocation()} disabled={isSearchingLocation}>
                {isSearchingLocation ? t.searching : t.searchLocation}
              </button>
            </div>
            {locationSearchResults.length > 1 ? (
              <div className="search-results">
                {locationSearchResults.slice(1, 5).map((result) => (
                  <button key={`${result.lat}-${result.lng}`} onClick={() => applySearchedLocation(result)}>
                    {result.displayName}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="grid two">
              <label>
                {t.lat}
                <input value={touchdownLatInput} onChange={(event) => setTouchdownLatInput(event.target.value)} />
              </label>
              <label>
                {t.lng}
                <input value={touchdownLngInput} onChange={(event) => setTouchdownLngInput(event.target.value)} />
              </label>
            </div>
            <button onClick={handleTouchdownInputApply}>{t.applyTouchdown}</button>
            <p className="status">{statusMessage}</p>
            <div className="grid two">
              <input
                placeholder={t.spotNamePlaceholder}
                value={spotName}
                onChange={(event) => setSpotName(event.target.value)}
              />
              <button
                onClick={() => {
                  if (!spotName.trim()) {
                    return;
                  }
                  saveNamedSpot(spotName.trim());
                  setSpotName("");
                }}
              >
                {t.saveSpot}
              </button>
            </div>
            {namedSpots.length > 0 ? (
              <select onChange={(event) => selectNamedSpot(event.target.value)} defaultValue="">
                <option value="" disabled>
                  {t.selectSavedSpot}
                </option>
                {namedSpots.map((spot) => (
                  <option key={spot.id} value={spot.id}>
                    {spot.name}
                  </option>
                ))}
              </select>
            ) : null}
          </section>

          {mode === "canopy" ? (
            <section>
              <h2>{t.canopyAndJumper}</h2>
              <label>
                {t.preset}
                <select value={canopy.model} onChange={(event) => handlePresetChange(event.target.value)}>
                  {canopyPresets.map((preset) => (
                    <option key={preset.model} value={preset.model}>
                      {preset.model}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid two">
                <label>
                  {t.canopySizeSqft}
                  <NumberInput
                    value={canopy.sizeSqft}
                    onValueChange={(nextValue) => setCanopy({ ...canopy, sizeSqft: nextValue })}
                  />
                </label>
                <label>
                  {t.exitWeightLb}
                  <NumberInput value={exitWeightLb} onValueChange={(nextValue) => setExitWeight(nextValue)} />
                </label>
                <label>
                  {t.airspeedRefAtWlRefKt}
                  <NumberInput
                    value={canopy.airspeedRefKt}
                    onValueChange={(nextValue) => setCanopy({ ...canopy, airspeedRefKt: nextValue })}
                  />
                </label>
                <label>
                  {t.wlRef}
                  <NumberInput
                    step="0.05"
                    value={canopy.wlRef}
                    onValueChange={(nextValue) => setCanopy({ ...canopy, wlRef: Math.max(0.1, nextValue) })}
                  />
                </label>
                <label>
                  {t.glideRatio}
                  <NumberInput
                    step="0.1"
                    value={canopy.glideRatio}
                    onValueChange={(nextValue) => setCanopy({ ...canopy, glideRatio: nextValue })}
                  />
                </label>
                <label>
                  {t.wlSpeedExponent}
                  <NumberInput
                    step="0.05"
                    value={canopy.airspeedWlExponent ?? 0.5}
                    onValueChange={(nextValue) => setCanopy({ ...canopy, airspeedWlExponent: nextValue })}
                  />
                </label>
                <label>
                  {t.airspeedMinKt}
                  <NumberInput
                    step="0.5"
                    value={airspeedMinKt}
                    onValueChange={(nextValue) => setCanopy({ ...canopy, airspeedMinKt: nextValue })}
                  />
                </label>
                <label>
                  {t.airspeedMaxKt}
                  <NumberInput
                    step="0.5"
                    value={airspeedMaxKt}
                    onValueChange={(nextValue) => setCanopy({ ...canopy, airspeedMaxKt: nextValue })}
                  />
                </label>
              </div>
              <p className="status">{t.currentWlSummary(wingLoading, patternOutput.metrics.estAirspeedKt)}</p>
              <div className="airspeed-meter">
                <div className="airspeed-meter-track">
                  <div className="airspeed-meter-marker" style={{ left: `calc(${airspeedGaugePct}% - 1px)` }} />
                </div>
                <div className="airspeed-meter-scale">
                  <span>{airspeedMinKt.toFixed(1)} kt</span>
                  <span>{modeledAirspeedKt.toFixed(1)} kt</span>
                  <span>{airspeedMaxKt.toFixed(1)} kt</span>
                </div>
                <p className="status">{t.rawModelSummary(modeledRawAirspeedKt, airspeedClampLabel)}</p>
              </div>
            </section>
          ) : (
            <section>
              <h2>{t.wingsuitSettings}</h2>
              <div className="grid two">
                <label>
                  {t.wingsuitPreset}
                  <select value={wingsuitPresetId} onChange={(event) => handleWingsuitPresetChange(event.target.value as WingsuitPresetId)}>
                    <option value="swift">{t.wingsuitPresetSwift}</option>
                    <option value="atc">{t.wingsuitPresetAtc}</option>
                    <option value="freak">{t.wingsuitPresetFreak}</option>
                    <option value="aura">{t.wingsuitPresetAura}</option>
                    <option value="custom">{t.wingsuitPresetCustom}</option>
                  </select>
                </label>
                <label>
                  {t.wingsuitName}
                  <input
                    value={wingsuit.name}
                    onChange={(event) => setWingsuit(withCustomWingsuit({ ...wingsuit, name: event.target.value }))}
                  />
                </label>
                <label>
                  {t.flightSpeedKt}
                  <NumberInput
                    step="0.5"
                    value={wingsuit.flightSpeedKt}
                    onValueChange={(nextValue) =>
                      setWingsuit(withCustomWingsuit({ ...wingsuit, flightSpeedKt: nextValue }))
                    }
                  />
                </label>
                <label>
                  {t.fallRateFps}
                  <NumberInput
                    step="0.1"
                    value={wingsuit.fallRateFps}
                    onValueChange={(nextValue) =>
                      setWingsuit(withCustomWingsuit({ ...wingsuit, fallRateFps: nextValue }))
                    }
                  />
                </label>
              </div>
              <p className="status">
                {t.currentWingsuitSummary(wingsuit.flightSpeedKt, wingsuit.fallRateFps, wingsuitGlideRatio)}
              </p>
            </section>
          )}

          <section>
            <h2>{t.patternSettings}</h2>
            <div className="row">
              <label>
                {t.side}
                <select value={side} onChange={(event) => setSide(event.target.value as "left" | "right")}>
                  <option value="left">{t.left}</option>
                  <option value="right">{t.right}</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={baseLegDrift}
                  onChange={(event) => setBaseLegDrift(event.target.checked)}
                />
                {t.allowBaseDrift}
              </label>
              <label>
                {t.landingHeadingDeg}
                <NumberInput value={landingHeadingDeg} onValueChange={(nextValue) => setHeading(nextValue)} />
              </label>
              <button onClick={handleSetSuggestedHeading}>{t.suggestHeadwindFinal}</button>
            </div>
            <label>
              {t.landingDirectionSlider}
              <input
                type="range"
                min={0}
                max={359}
                value={landingHeadingDeg}
                onChange={(event) => setHeading(numberFromInput(event.target.value, landingHeadingDeg))}
              />
            </label>
            <div className="grid two">
              {gatesFt.map((gate, index) => (
                <label key={index}>
                  {t.gateLabel(mode, index, altUnitLabel)}
                  <NumberInput
                    value={Math.round(toDisplayFeet(unitSystem, gate))}
                    onValueChange={(nextValue) => {
                      const next = [...gatesFt] as [number, number, number, number];
                      next[index] = fromDisplayFeet(unitSystem, nextValue);
                      setActiveGates(next);
                    }}
                  />
                </label>
              ))}
              <label>
                {t.shearExponent}
                <NumberInput step="0.01" value={shearAlpha} onValueChange={(nextValue) => setShearAlpha(nextValue)} />
              </label>
            </div>
          </section>

          <section>
            <h2>{t.windLayers}</h2>
            {windLayers.map((layer, layerIndex) => (
              <div className="grid three" key={`${layerIndex}-${layer.altitudeFt}`}>
                <label>
                  {t.altLabel(altUnitLabel)}
                  <NumberInput
                    value={Math.round(toDisplayFeet(unitSystem, layer.altitudeFt))}
                    onValueChange={(nextValue) => {
                      const value = fromDisplayFeet(unitSystem, nextValue);
                      updateActiveWindLayer(layerIndex, { altitudeFt: value });
                    }}
                  />
                </label>
                <label>
                  {t.speedLabel(speedUnitLabel)}
                  <NumberInput
                    value={Number(toDisplayKnots(unitSystem, layer.speedKt).toFixed(1))}
                    onValueChange={(nextValue) => {
                      const value = fromDisplayKnots(unitSystem, nextValue);
                      updateActiveWindLayer(layerIndex, { speedKt: value, source: "manual" });
                    }}
                  />
                </label>
                <label>
                  {t.directionFromDeg}
                  <NumberInput
                    value={Math.round(layer.dirFromDeg)}
                    onValueChange={(nextValue) =>
                      updateActiveWindLayer(layerIndex, { dirFromDeg: nextValue, source: "manual" })
                    }
                  />
                </label>
              </div>
            ))}
          </section>

          <section>
            <h2>{t.outputs}</h2>
            {mode === "canopy" ? (
              <p>
                {t.wingLoading}: {wingLoading.toFixed(2)}
              </p>
            ) : null}
            <p>
              {mode === "canopy" ? t.estAirspeed : t.estFlightSpeed}:{" "}
              {toDisplayKnots(unitSystem, patternOutput.metrics.estAirspeedKt).toFixed(1)} {speedUnitLabel}
            </p>
            {lastSurfaceWind ? (
              <p>
                {t.lastSurfaceWind(
                  toDisplayKnots(unitSystem, lastSurfaceWind.speedKt).toFixed(1),
                  speedUnitLabel,
                  lastSurfaceWind.dirFromDeg.toFixed(0),
                  lastSurfaceWind.source,
                )}
              </p>
            ) : null}
            {mode === "canopy" ? (
              <p>
                {t.speedModel(
                  canopy.airspeedRefKt.toFixed(1),
                  canopy.wlRef.toFixed(2),
                  (canopy.airspeedWlExponent ?? 0.5).toFixed(2),
                )}
              </p>
            ) : (
              <p>{t.wingsuitModel(wingsuit.name)}</p>
            )}
            <p>{t.estSink(patternOutput.metrics.estSinkFps.toFixed(2))}</p>
            <p className={outputStatusClass}>{outputStatusText}</p>
            {patternOutput.warnings.length > 0 ? (
              <ul>
                {patternOutput.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {patternOutput.segments.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>{t.leg}</th>
                    <th>{t.heading}</th>
                    <th>{t.track}</th>
                    <th>{t.fwdLabel(speedUnitLabel)}</th>
                    <th>{t.gsLabel(speedUnitLabel)}</th>
                    <th>{t.timeSeconds}</th>
                    <th>{t.distLabel(altUnitLabel)}</th>
                  </tr>
                </thead>
                <tbody>
                  {patternOutput.segments.map((segment) => (
                    <tr key={segment.name}>
                      <td>{formatSegmentName(language, segment.name)}</td>
                      <td>{segment.headingDeg.toFixed(0)}</td>
                      <td>{segment.trackHeadingDeg.toFixed(0)}</td>
                      <td>{toDisplayKnots(unitSystem, segment.alongLegSpeedKt).toFixed(1)}</td>
                      <td>{toDisplayKnots(unitSystem, segment.groundSpeedKt).toFixed(1)}</td>
                      <td>{segment.timeSec.toFixed(1)}</td>
                      <td>{toDisplayFeet(unitSystem, segment.distanceFt).toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {safeLandingHeadings.length > 0 ? (
              <div>
                <p>{t.saferHeadings}</p>
                <div className="row wrap">
                  {safeLandingHeadings.map((heading) => (
                    <button key={heading} onClick={() => setHeading(heading)}>
                      {heading}°
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p>{t.noForwardHeading}</p>
            )}
          </section>

          <section>
            <h2>{t.importExport}</h2>
            <div className="row wrap">
              <button onClick={handleExport}>{t.exportSnapshotJson}</button>
              <button onClick={handleImportClick}>{t.importSnapshotJson}</button>
            </div>
            <input ref={importInputRef} type="file" accept="application/json" hidden onChange={handleImportFile} />
          </section>
        </aside>
      </main>
    </div>
  );
}
