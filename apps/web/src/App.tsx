import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, InputHTMLAttributes } from "react";
import { useMutation } from "@tanstack/react-query";
import { canopyPresets, extrapolateWindProfile, fetchNoaaSurfaceWind, fetchWingsuitWindProfile } from "@landing/data";
import { computePattern, solveWingsuitAuto } from "@landing/engine";
import type {
  CanopyProfile,
  FlightMode,
  PatternInput,
  SurfaceWind,
  WindLayer,
  WingsuitAutoInput,
  WingsuitAutoOutput,
  WingsuitAutoJumpRunAssumptions,
  WingsuitPresetId,
  WingsuitProfile,
} from "@landing/ui-types";
import { feetToMeters, knotsToMps, metersToFeet, mpsToKnots } from "./lib/units";
import { type Language, type WingsuitPlanningMode, useAppStore } from "./store";
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

function deriveWingsuitAutoTurnRatios(gatesFt: [number, number, number, number]):
  | { turn1: number; turn2: number }
  | undefined {
  const [exitFt, turn1Ft, turn2Ft, deployFt] = gatesFt;
  const spanFt = exitFt - deployFt;
  if (!Number.isFinite(spanFt) || spanFt <= 0) {
    return undefined;
  }

  const turn1 = (turn1Ft - deployFt) / spanFt;
  const turn2 = (turn2Ft - deployFt) / spanFt;
  if (!(turn1 < 1 && turn1 > turn2 && turn2 > 0)) {
    return undefined;
  }

  return { turn1, turn2 };
}

function buildWingsuitAutoInput(state: {
  landingPoint: { lat: number; lng: number };
  jumpRun: {
    directionMode: "auto" | "manual";
    manualHeadingDeg: number;
    constraintMode: "none" | "reciprocal";
    constraintHeadingDeg: number;
    assumptions: Required<WingsuitAutoJumpRunAssumptions>;
  };
  side: "left" | "right";
  wingsuitSettings: {
    gatesFt: [number, number, number, number];
    windLayers: WindLayer[];
    wingsuit: WingsuitProfile;
  };
}): WingsuitAutoInput {
  return {
    landingPoint: state.landingPoint,
    jumpRun: state.jumpRun,
    side: state.side,
    exitHeightFt: state.wingsuitSettings.gatesFt[0],
    deployHeightFt: state.wingsuitSettings.gatesFt[3],
    winds: state.wingsuitSettings.windLayers,
    wingsuit: state.wingsuitSettings.wingsuit,
    turnRatios: deriveWingsuitAutoTurnRatios(state.wingsuitSettings.gatesFt),
  };
}

function getRequestedWingsuitAutoWindAltitudes(exitHeightFt: number, deployHeightFt: number): number[] {
  const lowFt = Math.max(0, Math.min(exitHeightFt, deployHeightFt));
  const highFt = Math.max(exitHeightFt, deployHeightFt);
  const values = new Set<number>([0, lowFt, highFt]);
  for (let altitudeFt = 2000; altitudeFt < highFt; altitudeFt += 2000) {
    values.add(altitudeFt);
  }
  return [...values].sort((a, b) => b - a);
}

function getRequestedWindAltitudes(
  mode: FlightMode,
  gatesFt: [number, number, number, number],
  wingsuitPlanningMode: WingsuitPlanningMode,
): number[] {
  if (mode === "canopy") {
    return [gatesFt[0], gatesFt[1], gatesFt[2]];
  }

  if (wingsuitPlanningMode === "auto") {
    return getRequestedWingsuitAutoWindAltitudes(gatesFt[0], gatesFt[3]);
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

function headingFromCoordinates(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const deltaLng = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
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
    displaySection: "Display",
    languageSection: "Language",
    languageEnglish: "English",
    languageChinese: "中文",
    unitsSection: "Units",
    imperial: "Imperial",
    metric: "Metric",
    yes: "Yes",
    no: "No",
    touchdownSpot: "Touchdown Spot",
    landingPoint: "Landing Point",
    useBrowserLocation: "Use Browser Location",
    loadingWind: "Loading Wind...",
    fetchNoaaWind: "Fetch NOAA Wind",
    searchPlaceholder: "Search place or address",
    searching: "Searching...",
    searchLocation: "Search Location",
    lat: "Lat",
    lng: "Lng",
    applyTouchdown: "Apply Touchdown",
    applyLandingPoint: "Apply Landing Point",
    spotNamePlaceholder: "Spot name",
    saveSpot: "Save Spot",
    selectSavedSpot: "Select saved spot",
    modeSection: "Flight Mode",
    canopyMode: "Canopy",
    wingsuitMode: "Wingsuit",
    wingsuitPlanningMode: "Wingsuit Planning",
    manualPatternMode: "Manual Drawer",
    autoPlannerMode: "Auto Mode",
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
    jumpRunSettings: "Jump Run",
    side: "Side",
    left: "Left",
    right: "Right",
    allowBaseDrift: "Allow Base Drift",
    landingHeadingDeg: "Landing Heading (deg)",
    exitHeight: "Exit Height",
    deployHeight: "Deploy Height",
    turn1Height: "Turn 1 Height",
    turn2Height: "Turn 2 Height",
    jumpRunStart: "Jump Run Start",
    jumpRunEnd: "Jump Run End",
    jumpRunDirection: "Jump Run Direction (deg)",
    jumpRunHeading: "Jump Run Heading",
    jumpRunLength: "Jump Run Length",
    jumpRunSpacing: "Group Spacing",
    jumpRunSpacingSeconds: "Spacing Time",
    directionSource: "Direction Source",
    autoHeadwindDirection: "Auto (Headwind)",
    manualDirection: "Manual",
    airportConstraint: "Airport Constraint",
    noConstraint: "None",
    reciprocalPairConstraint: "Reciprocal Pair",
    runwayHeading: "Runway Heading (deg)",
    advancedAssumptions: "Advanced Jump-Run Assumptions",
    planeAirspeed: "Plane Airspeed (kt)",
    groupCount: "Wingsuit Exit Group",
    groupSeparation: "Group Separation",
    slickDeployHeight: "Slick Deploy Height",
    slickFallRate: "Slick Fall Rate",
    slickReturnRadius: "Slick Return Radius",
    jumpRunHelp:
      "Jump run is resolved automatically from direction intent, winds aloft, and spacing assumptions. The wingsuit slot defaults to group 4, and can be set to group 1 when wingsuit exits first. Choose auto to use headwind, or manual to set a compass heading. An optional reciprocal runway pair can constrain the heading. The solver then starts at the resolved WS slot, sweeps forward wingsuit routes through the wind layers, and keeps deployments that clear the jump-run corridor, stay on the selected side, fit the configured radius, and preserve canopy-return margin.",
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
    autoDiagnostics: "Auto Diagnostics",
    wingLoading: "Wing Loading",
    estAirspeed: "Est. Airspeed",
    estFlightSpeed: "Horizontal Speed",
    preferredDeployBearing: "Preferred Deploy Bearing",
    selectedDeployBearing: "Selected Deploy Bearing",
    selectedDeployRadius: "Selected Deploy Radius",
    exitToJumpRunError: "Exit to WS Slot Error",
    corridorMargin: "Corridor Margin",
    deployRadiusMargin: "Deploy Radius Margin",
    firstLegTrackDelta: "First Leg Track Delta",
    headingSource: "Heading Source",
    headingConstraint: "Constraint Applied",
    headwindComponent: "Headwind Component",
    crosswindComponent: "Crosswind Component",
    crosswindOffsite: "Crosswind Offsite",
    firstSlickReturnMargin: "First Slick Return Margin",
    lastSlickReturnMargin: "Last Slick Return Margin",
    feasibleDeployBands: "Feasible Deploy Bearings",
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
    displaySection: "显示",
    languageSection: "语言",
    languageEnglish: "English",
    languageChinese: "中文",
    unitsSection: "单位",
    imperial: "英制",
    metric: "公制",
    yes: "是",
    no: "否",
    touchdownSpot: "着陆点",
    useBrowserLocation: "使用浏览器定位",
    loadingWind: "正在加载风数据...",
    fetchNoaaWind: "获取 NOAA 风数据",
    searchPlaceholder: "搜索地点或地址",
    searching: "搜索中...",
    searchLocation: "搜索位置",
    lat: "纬度",
    lng: "经度",
    landingPoint: "着陆点",
    applyTouchdown: "应用着陆点",
    applyLandingPoint: "应用着陆点",
    spotNamePlaceholder: "点位名称",
    saveSpot: "保存点位",
    selectSavedSpot: "选择已保存点位",
    modeSection: "飞行模式",
    canopyMode: "伞翼",
    wingsuitMode: "翼装",
    wingsuitPlanningMode: "翼装规划方式",
    manualPatternMode: "手动画线",
    autoPlannerMode: "自动规划",
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
    jumpRunSettings: "航线基准",
    side: "方向",
    left: "左",
    right: "右",
    allowBaseDrift: "允许第二边随风漂移",
    landingHeadingDeg: "着陆航向 (度)",
    exitHeight: "出舱高度",
    deployHeight: "开伞高度",
    turn1Height: "第一转弯高度",
    turn2Height: "第二转弯高度",
    jumpRunStart: "航线起点",
    jumpRunEnd: "航线终点",
    jumpRunDirection: "航线方向 (度)",
    jumpRunHeading: "航线方向",
    jumpRunLength: "航线长度",
    jumpRunSpacing: "组间距",
    jumpRunSpacingSeconds: "间隔时间",
    directionSource: "方向来源",
    autoHeadwindDirection: "自动（迎风）",
    manualDirection: "手动",
    airportConstraint: "机场约束",
    noConstraint: "无",
    reciprocalPairConstraint: "往返一对",
    runwayHeading: "跑道航向 (度)",
    advancedAssumptions: "高级航线假设",
    planeAirspeed: "飞机空速 (kt)",
    groupCount: "翼装出舱组号",
    groupSeparation: "组间距",
    slickDeployHeight: "普通跳伞员开伞高度",
    slickFallRate: "普通跳伞员下沉率",
    slickReturnRadius: "普通跳伞员返场半径",
    jumpRunHelp: "自动模式会根据方向意图、高空风和编组间距假设自动解析航线。翼装出舱位默认是第 4 组；如果翼装先出舱，可以设为第 1 组。可选择自动迎风方向，也可手动输入罗盘方向；还可以用一对往返跑道方向进行约束。求解器随后会从解析出的翼装出舱位开始，按分层风向前模拟多组翼装航线，并保留能避开航线走廊、保持在所选侧、满足距离限制且保留伞降返场余量的开伞方案。",
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
    autoDiagnostics: "自动规划诊断",
    wingLoading: "翼载",
    estAirspeed: "估算空速",
    estFlightSpeed: "水平速度",
    preferredDeployBearing: "优选开伞方位",
    selectedDeployBearing: "已选开伞方位",
    selectedDeployRadius: "已选开伞距离",
    exitToJumpRunError: "出舱点到翼装出舱位误差",
    corridorMargin: "禁飞带余量",
    deployRadiusMargin: "开伞距离余量",
    firstLegTrackDelta: "第一段航迹偏角",
    headingSource: "航向来源",
    headingConstraint: "是否施加约束",
    headwindComponent: "迎风分量",
    crosswindComponent: "侧风分量",
    crosswindOffsite: "侧风偏置",
    firstSlickReturnMargin: "第一组返场余量",
    lastSlickReturnMargin: "最后普通组返场余量",
    feasibleDeployBands: "可行开伞方位数",
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
    wingsuitAutoSettings,
    setWingsuitPlanningMode,
    setWingsuitAutoDirectionMode,
    setWingsuitAutoManualHeading,
    setWingsuitAutoConstraintMode,
    setWingsuitAutoConstraintHeading,
    setWingsuitAutoAssumptions,
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
  const wingsuitPlanningMode = wingsuitAutoSettings.planningMode;
  const isWingsuitAuto = mode === "wingsuit" && wingsuitPlanningMode === "auto";
  const jumpRunSettings = wingsuitAutoSettings;
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

  function setWingsuitAutoHeight(exitHeightFt: number, deployHeightFt: number): void {
    const safeDeployFt = Math.max(100, Math.min(exitHeightFt - 100, deployHeightFt));
    const safeExitFt = Math.max(safeDeployFt + 100, exitHeightFt);
    const ratios = deriveWingsuitAutoTurnRatios(wingsuitSettings.gatesFt) ?? { turn1: 0.75, turn2: 0.3125 };
    const spanFt = safeExitFt - safeDeployFt;
    setWingsuitGates([
      safeExitFt,
      safeDeployFt + spanFt * ratios.turn1,
      safeDeployFt + spanFt * ratios.turn2,
      safeDeployFt,
    ]);
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

  useEffect(() => {
    setTouchdownLatInput(touchdown.lat.toFixed(5));
    setTouchdownLngInput(touchdown.lng.toFixed(5));
  }, [touchdown.lat, touchdown.lng]);

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
  const autoPatternInput = useMemo(
    () =>
      buildWingsuitAutoInput({
        landingPoint: touchdown,
        jumpRun: jumpRunSettings,
        side,
        wingsuitSettings,
      }),
    [touchdown, jumpRunSettings, side, wingsuitSettings],
  );
  const autoPatternOutput = useMemo<WingsuitAutoOutput | null>(
    () => (isWingsuitAuto ? solveWingsuitAuto(autoPatternInput) : null),
    [isWingsuitAuto, autoPatternInput],
  );
  const resolvedJumpRun = autoPatternOutput?.resolvedJumpRun ?? null;
  const jumpRunHeading = resolvedJumpRun?.headingDeg ?? null;
  const jumpRunLength = resolvedJumpRun?.lengthFt ?? null;

  const safeLandingHeadings = useMemo(() => {
    if (isWingsuitAuto) {
      return [];
    }
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
  }, [isWingsuitAuto, patternInput, landingHeadingDeg]);

  const windMutation = useMutation({
    mutationFn: async () => {
      const requestedAltitudes = getRequestedWindAltitudes(mode, gatesFt, wingsuitPlanningMode);
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
      wingsuitAutoSettings,
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
        wingsuitAutoSettings: {
          planningMode: WingsuitPlanningMode;
          directionMode?: "auto" | "manual";
          manualHeadingDeg?: number;
          constraintMode?: "none" | "reciprocal";
          constraintHeadingDeg?: number;
          assumptions?: Partial<WingsuitAutoJumpRunAssumptions>;
          jumpRun?: {
            start?: { lat: number; lng: number };
            end?: { lat: number; lng: number };
          };
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
      if (payload.wingsuitAutoSettings) {
        if (
          payload.wingsuitAutoSettings.planningMode === "manual" ||
          payload.wingsuitAutoSettings.planningMode === "auto"
        ) {
          setWingsuitPlanningMode(payload.wingsuitAutoSettings.planningMode);
        }
        if (
          payload.wingsuitAutoSettings.directionMode === "auto" ||
          payload.wingsuitAutoSettings.directionMode === "manual"
        ) {
          setWingsuitAutoDirectionMode(payload.wingsuitAutoSettings.directionMode);
        } else if (payload.wingsuitAutoSettings.jumpRun?.start && payload.wingsuitAutoSettings.jumpRun?.end) {
          setWingsuitAutoDirectionMode("manual");
          setWingsuitAutoManualHeading(
            headingFromCoordinates(
              payload.wingsuitAutoSettings.jumpRun.start,
              payload.wingsuitAutoSettings.jumpRun.end,
            ),
          );
        }
        if (typeof payload.wingsuitAutoSettings.manualHeadingDeg === "number") {
          setWingsuitAutoManualHeading(payload.wingsuitAutoSettings.manualHeadingDeg);
        }
        if (
          payload.wingsuitAutoSettings.constraintMode === "none" ||
          payload.wingsuitAutoSettings.constraintMode === "reciprocal"
        ) {
          setWingsuitAutoConstraintMode(payload.wingsuitAutoSettings.constraintMode);
        }
        if (typeof payload.wingsuitAutoSettings.constraintHeadingDeg === "number") {
          setWingsuitAutoConstraintHeading(payload.wingsuitAutoSettings.constraintHeadingDeg);
        }
        if (payload.wingsuitAutoSettings.assumptions) {
          setWingsuitAutoAssumptions(payload.wingsuitAutoSettings.assumptions);
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
  const activeWarnings = isWingsuitAuto ? autoPatternOutput?.warnings ?? [] : patternOutput.warnings;
  const activeBlocked = isWingsuitAuto ? autoPatternOutput?.blocked ?? true : patternOutput.blocked;
  const activeSegments = isWingsuitAuto ? autoPatternOutput?.routeSegments ?? [] : patternOutput.segments;
  const activeEstSinkFps = isWingsuitAuto ? wingsuit.fallRateFps : patternOutput.metrics.estSinkFps;
  const activeSpeedKt = isWingsuitAuto ? wingsuit.flightSpeedKt : patternOutput.metrics.estAirspeedKt;
  const locationSectionTitle = isWingsuitAuto ? t.landingPoint : t.touchdownSpot;
  const applyLocationLabel = isWingsuitAuto ? t.applyLandingPoint : t.applyTouchdown;
  const hasCautionWarnings = activeWarnings.length > 0;
  const outputStatusClass = activeBlocked ? "blocked" : hasCautionWarnings ? "caution" : "ok";
  const outputStatusText = activeBlocked
    ? t.outputBlocked
    : hasCautionWarnings
      ? t.outputCaution
      : t.outputValid;
  const autoDiagnostics = autoPatternOutput?.diagnostics;

  function formatOptionalDegrees(value: number | null | undefined): string {
    return value == null ? "--" : `${value.toFixed(0)}°`;
  }

  function formatOptionalDistance(valueFt: number | null | undefined): string {
    return valueFt == null ? "--" : `${toDisplayFeet(unitSystem, valueFt).toFixed(0)} ${altUnitLabel}`;
  }

  function formatOptionalSpeed(valueKt: number | null | undefined): string {
    return valueKt == null ? "--" : `${toDisplayKnots(unitSystem, valueKt).toFixed(1)} ${speedUnitLabel}`;
  }

  function formatHeadingSource(value: WingsuitAutoOutput["diagnostics"]["headingSource"]): string {
    if (value === "auto-headwind") {
      return t.autoHeadwindDirection;
    }
    if (value === "manual") {
      return t.manualDirection;
    }
    return "--";
  }

  return (
    <div className="app-shell">
      <header className="banner">
        <h1>{t.title}</h1>
        <p>{t.planningNote}</p>
      </header>

      <main className="layout">
        <section className="map-column">
          {isWingsuitAuto ? (
            <MapPanel
              key="auto"
              variant="auto"
              language={language}
              landingPoint={touchdown}
              resolvedJumpRun={resolvedJumpRun}
              routeWaypoints={autoPatternOutput?.routeWaypoints ?? []}
              landingNoDeployZonePolygon={autoPatternOutput?.landingNoDeployZonePolygon ?? []}
              downwindDeployForbiddenZonePolygon={autoPatternOutput?.downwindDeployForbiddenZonePolygon ?? []}
              forbiddenZonePolygon={autoPatternOutput?.forbiddenZonePolygon ?? []}
              feasibleDeployRegionPolygon={autoPatternOutput?.feasibleDeployRegionPolygon ?? []}
              blocked={activeBlocked}
              hasWarnings={hasCautionWarnings}
              windLayers={windLayers}
              onLandingPointChange={handleTouchdownChange}
            />
          ) : (
            <MapPanel
              key="manual"
              variant="manual"
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
          )}
        </section>

        <aside className="sidebar">
          <section>
            <h2>{t.displaySection}</h2>
            <div className="grid two compact-grid">
              <div className="control-cell">
                <p className="control-title">{t.languageSection}</p>
                <div className="row wrap compact-options">
                  <label className="option-chip">
                    <input type="radio" checked={language === "en"} onChange={() => setLanguage("en")} />
                    {t.languageEnglish}
                  </label>
                  <label className="option-chip">
                    <input type="radio" checked={language === "zh"} onChange={() => setLanguage("zh")} />
                    {t.languageChinese}
                  </label>
                </div>
              </div>
              <div className="control-cell">
                <p className="control-title">{t.unitsSection}</p>
                <div className="row wrap compact-options">
                  <label className="option-chip">
                    <input
                      type="radio"
                      checked={unitSystem === "imperial"}
                      onChange={() => setUnitSystem("imperial")}
                    />
                    {t.imperial}
                  </label>
                  <label className="option-chip">
                    <input type="radio" checked={unitSystem === "metric"} onChange={() => setUnitSystem("metric")} />
                    {t.metric}
                  </label>
                </div>
              </div>
            </div>
          </section>

          <section>
            <h2>{t.modeSection}</h2>
            <div className="grid compact-grid">
              <div className="control-cell">
                <p className="control-title">{t.modeSection}</p>
                <div className="row wrap compact-options">
                  <label className="option-chip">
                    <input type="radio" checked={mode === "canopy"} onChange={() => setMode("canopy")} />
                    {t.canopyMode}
                  </label>
                  <label className="option-chip">
                    <input type="radio" checked={mode === "wingsuit"} onChange={() => setMode("wingsuit")} />
                    {t.wingsuitMode}
                  </label>
                </div>
              </div>

              {mode === "wingsuit" ? (
                <div className="control-cell">
                  <p className="control-title">{t.wingsuitPlanningMode}</p>
                  <div className="row wrap compact-options">
                    <label className="option-chip">
                      <input
                        type="radio"
                        checked={wingsuitPlanningMode === "manual"}
                        onChange={() => setWingsuitPlanningMode("manual")}
                      />
                      {t.manualPatternMode}
                    </label>
                    <label className="option-chip">
                      <input
                        type="radio"
                        checked={wingsuitPlanningMode === "auto"}
                        onChange={() => setWingsuitPlanningMode("auto")}
                      />
                      {t.autoPlannerMode}
                    </label>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <section>
            <h2>{locationSectionTitle}</h2>
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
            <button onClick={handleTouchdownInputApply}>{applyLocationLabel}</button>
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
                  <select
                    value={wingsuitPresetId}
                    onChange={(event) => handleWingsuitPresetChange(event.target.value as WingsuitPresetId)}
                  >
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
            {isWingsuitAuto ? (
              <>
                <div className="grid two">
                  <label>
                    {t.side}
                    <select value={side} onChange={(event) => setSide(event.target.value as "left" | "right")}>
                      <option value="left">{t.left}</option>
                      <option value="right">{t.right}</option>
                    </select>
                  </label>
                  <label>
                    {t.shearExponent}
                    <NumberInput
                      step="0.01"
                      value={shearAlpha}
                      onValueChange={(nextValue) => setShearAlpha(nextValue)}
                    />
                  </label>
                  <label>
                    {t.exitHeight} ({altUnitLabel})
                    <NumberInput
                      value={Math.round(toDisplayFeet(unitSystem, wingsuitSettings.gatesFt[0]))}
                      onValueChange={(nextValue) =>
                        setWingsuitAutoHeight(
                          fromDisplayFeet(unitSystem, nextValue),
                          wingsuitSettings.gatesFt[3],
                        )
                      }
                    />
                  </label>
                  <label>
                    {t.deployHeight} ({altUnitLabel})
                    <NumberInput
                      value={Math.round(toDisplayFeet(unitSystem, wingsuitSettings.gatesFt[3]))}
                      onValueChange={(nextValue) =>
                        setWingsuitAutoHeight(
                          wingsuitSettings.gatesFt[0],
                          fromDisplayFeet(unitSystem, nextValue),
                        )
                      }
                    />
                  </label>
                </div>
              </>
            ) : (
              <>
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
                    <NumberInput
                      step="0.01"
                      value={shearAlpha}
                      onValueChange={(nextValue) => setShearAlpha(nextValue)}
                    />
                  </label>
                </div>
              </>
            )}
          </section>

          {isWingsuitAuto ? (
            <section>
              <h2>{t.jumpRunSettings}</h2>
              <p className="status">
                {t.jumpRunHeading}: {jumpRunHeading == null ? "--" : `${jumpRunHeading.toFixed(0)}°`} ·{" "}
                {t.jumpRunLength}:{" "}
                {jumpRunLength == null ? "--" : `${toDisplayFeet(unitSystem, jumpRunLength).toFixed(0)} ${altUnitLabel}`}
                {resolvedJumpRun
                  ? ` · ${t.jumpRunSpacing}: ${toDisplayFeet(unitSystem, resolvedJumpRun.groupSpacingFt).toFixed(0)} ${altUnitLabel} · ${t.jumpRunSpacingSeconds}: ${resolvedJumpRun.groupSpacingSec.toFixed(1)} s`
                  : ""}
              </p>
              <p className="status">{t.jumpRunHelp}</p>
              <div className="grid two compact-grid">
                <div className="control-cell">
                  <p className="control-title">{t.directionSource}</p>
                  <div className="row wrap compact-options">
                    <label className="option-chip">
                      <input
                        type="radio"
                        checked={jumpRunSettings.directionMode === "auto"}
                        onChange={() => setWingsuitAutoDirectionMode("auto")}
                      />
                      {t.autoHeadwindDirection}
                    </label>
                    <label className="option-chip">
                      <input
                        type="radio"
                        checked={jumpRunSettings.directionMode === "manual"}
                        onChange={() => setWingsuitAutoDirectionMode("manual")}
                      />
                      {t.manualDirection}
                    </label>
                  </div>
                </div>
                <div className="control-cell">
                  <p className="control-title">{t.airportConstraint}</p>
                  <div className="row wrap compact-options">
                    <label className="option-chip">
                      <input
                        type="radio"
                        checked={jumpRunSettings.constraintMode === "none"}
                        onChange={() => setWingsuitAutoConstraintMode("none")}
                      />
                      {t.noConstraint}
                    </label>
                    <label className="option-chip">
                      <input
                        type="radio"
                        checked={jumpRunSettings.constraintMode === "reciprocal"}
                        onChange={() => setWingsuitAutoConstraintMode("reciprocal")}
                      />
                      {t.reciprocalPairConstraint}
                    </label>
                  </div>
                </div>
              </div>
              <div className="grid two">
                {jumpRunSettings.directionMode === "manual" ? (
                  <label>
                    {t.jumpRunDirection}
                    <NumberInput
                      step="1"
                      value={Number(jumpRunSettings.manualHeadingDeg.toFixed(0))}
                      onValueChange={(nextValue) => setWingsuitAutoManualHeading(nextValue)}
                    />
                  </label>
                ) : null}
                {jumpRunSettings.constraintMode === "reciprocal" ? (
                  <label>
                    {t.runwayHeading}
                    <NumberInput
                      step="1"
                      value={Number(jumpRunSettings.constraintHeadingDeg.toFixed(0))}
                      onValueChange={(nextValue) => setWingsuitAutoConstraintHeading(nextValue)}
                    />
                  </label>
                ) : null}
              </div>
              <details>
                <summary>{t.advancedAssumptions}</summary>
                <label>
                  {t.planeAirspeed} ({speedUnitLabel})
                  <NumberInput
                    step="0.5"
                    value={Number(toDisplayKnots(unitSystem, jumpRunSettings.assumptions.planeAirspeedKt).toFixed(1))}
                    onValueChange={(nextValue) =>
                      setWingsuitAutoAssumptions({ planeAirspeedKt: fromDisplayKnots(unitSystem, nextValue) })
                    }
                  />
                </label>
                <div className="grid two">
                  <label>
                    {t.groupCount}
                    <NumberInput
                      min="1"
                      step="1"
                      value={jumpRunSettings.assumptions.groupCount}
                      onValueChange={(nextValue) => setWingsuitAutoAssumptions({ groupCount: Math.round(nextValue) })}
                    />
                  </label>
                  <label>
                    {t.groupSeparation} ({altUnitLabel})
                    <NumberInput
                      value={Math.round(toDisplayFeet(unitSystem, jumpRunSettings.assumptions.groupSeparationFt))}
                      onValueChange={(nextValue) =>
                        setWingsuitAutoAssumptions({ groupSeparationFt: fromDisplayFeet(unitSystem, nextValue) })
                      }
                    />
                  </label>
                  <label>
                    {t.slickDeployHeight} ({altUnitLabel})
                    <NumberInput
                      value={Math.round(toDisplayFeet(unitSystem, jumpRunSettings.assumptions.slickDeployHeightFt))}
                      onValueChange={(nextValue) =>
                        setWingsuitAutoAssumptions({ slickDeployHeightFt: fromDisplayFeet(unitSystem, nextValue) })
                      }
                    />
                  </label>
                  <label>
                    {t.slickReturnRadius} ({altUnitLabel})
                    <NumberInput
                      value={Math.round(toDisplayFeet(unitSystem, jumpRunSettings.assumptions.slickReturnRadiusFt))}
                      onValueChange={(nextValue) =>
                        setWingsuitAutoAssumptions({ slickReturnRadiusFt: fromDisplayFeet(unitSystem, nextValue) })
                      }
                    />
                  </label>
                  <label>
                    {t.slickFallRate}
                    <NumberInput
                      step="1"
                      value={Number(jumpRunSettings.assumptions.slickFallRateFps.toFixed(0))}
                      onValueChange={(nextValue) => setWingsuitAutoAssumptions({ slickFallRateFps: nextValue })}
                    />
                  </label>
                </div>
              </details>
            </section>
          ) : null}

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
              {toDisplayKnots(unitSystem, activeSpeedKt).toFixed(1)} {speedUnitLabel}
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
            <p>{t.estSink(activeEstSinkFps.toFixed(2))}</p>
            <p className={outputStatusClass}>{outputStatusText}</p>
            {isWingsuitAuto ? (
              <>
                <h3>{t.autoDiagnostics}</h3>
                <div className="metrics-grid">
                  <p className="metric-card">
                    {t.headingSource}: {formatHeadingSource(autoDiagnostics?.headingSource ?? null)}
                  </p>
                  <p className="metric-card">
                    {t.headingConstraint}: {autoDiagnostics == null ? "--" : autoDiagnostics.constrainedHeadingApplied ? t.yes : t.no}
                  </p>
                  <p className="metric-card">
                    {t.headwindComponent}: {formatOptionalSpeed(autoDiagnostics?.headwindComponentKt)}
                  </p>
                  <p className="metric-card">
                    {t.crosswindComponent}: {formatOptionalSpeed(autoDiagnostics?.crosswindComponentKt)}
                  </p>
                  <p className="metric-card">
                    {t.crosswindOffsite}: {formatOptionalDistance(autoDiagnostics?.crosswindOffsetFt)}
                  </p>
                  <p className="metric-card">
                    {t.firstSlickReturnMargin}: {formatOptionalDistance(autoDiagnostics?.firstSlickReturnMarginFt)}
                  </p>
                  <p className="metric-card">
                    {t.lastSlickReturnMargin}: {formatOptionalDistance(autoDiagnostics?.lastSlickReturnMarginFt)}
                  </p>
                  <p className="metric-card">
                    {t.preferredDeployBearing}: {formatOptionalDegrees(autoDiagnostics?.preferredDeployBearingDeg)}
                  </p>
                  <p className="metric-card">
                    {t.selectedDeployBearing}: {formatOptionalDegrees(autoDiagnostics?.selectedDeployBearingDeg)}
                  </p>
                  <p className="metric-card">
                    {t.selectedDeployRadius}: {formatOptionalDistance(autoDiagnostics?.selectedDeployRadiusFt)}
                  </p>
                  <p className="metric-card">
                    {t.exitToJumpRunError}: {formatOptionalDistance(autoDiagnostics?.exitToJumpRunErrorFt)}
                  </p>
                  <p className="metric-card">
                    {t.corridorMargin}: {formatOptionalDistance(autoDiagnostics?.corridorMarginFt)}
                  </p>
                  <p className="metric-card">
                    {t.deployRadiusMargin}: {formatOptionalDistance(autoDiagnostics?.deployRadiusMarginFt)}
                  </p>
                  <p className="metric-card">
                    {t.firstLegTrackDelta}: {formatOptionalDegrees(autoDiagnostics?.firstLegTrackDeltaDeg)}
                  </p>
                  <p className="metric-card">
                    {t.turn1Height}: {formatOptionalDistance(autoDiagnostics?.turnHeightsFt?.[0])}
                  </p>
                  <p className="metric-card">
                    {t.turn2Height}: {formatOptionalDistance(autoDiagnostics?.turnHeightsFt?.[1])}
                  </p>
                  <p className="metric-card">
                    {t.feasibleDeployBands}: {autoPatternOutput?.deployBandsByBearing.length ?? 0}
                  </p>
                  <p className="metric-card">
                    {t.jumpRunHeading}: {jumpRunHeading == null ? "--" : `${jumpRunHeading.toFixed(0)}°`}
                  </p>
                </div>
              </>
            ) : null}
            {autoDiagnostics?.failureReason ? <p className="blocked">{autoDiagnostics.failureReason}</p> : null}
            {activeWarnings.length > 0 ? (
              <ul>
                {activeWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {activeSegments.length > 0 ? (
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
                  {activeSegments.map((segment) => (
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
            {!isWingsuitAuto && safeLandingHeadings.length > 0 ? (
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
            ) : !isWingsuitAuto ? (
              <p>{t.noForwardHeading}</p>
            ) : null}
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
