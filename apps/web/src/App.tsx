import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, InputHTMLAttributes } from "react";
import { useMutation } from "@tanstack/react-query";
import { canopyPresets, extrapolateWindProfile, fetchNoaaSurfaceWind } from "@landing/data";
import { computePattern } from "@landing/engine";
import type { CanopyProfile, PatternInput, SurfaceWind, WindLayer } from "@landing/ui-types";
import { feetToMeters, knotsToMps, metersToFeet, mpsToKnots } from "./lib/units";
import { useAppStore } from "./store";
import { MapPanel } from "./components/MapPanel";

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
  touchdown: { lat: number; lng: number };
  landingHeadingDeg: number;
  side: "left" | "right";
  baseLegDrift: boolean;
  gatesFt: [number, number, number, number];
  windLayers: WindLayer[];
  canopy: CanopyProfile;
  exitWeightLb: number;
}): PatternInput {
  return {
    touchdownLat: state.touchdown.lat,
    touchdownLng: state.touchdown.lng,
    landingHeadingDeg: state.landingHeadingDeg,
    side: state.side,
    baseLegDrift: state.baseLegDrift,
    gatesFt: state.gatesFt,
    winds: state.windLayers,
    canopy: state.canopy,
    jumper: {
      exitWeightLb: state.exitWeightLb,
      canopyAreaSqft: state.canopy.sizeSqft,
    },
  };
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

export default function App() {
  const {
    unitSystem,
    setUnitSystem,
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
    gatesFt,
    setGates,
    shearAlpha,
    setShearAlpha,
    canopy,
    setCanopy,
    exitWeightLb,
    setExitWeight,
    windLayers,
    setWindLayers,
    updateWindLayer,
    namedSpots,
    saveNamedSpot,
    selectNamedSpot,
  } = useAppStore();

  const [touchdownLatInput, setTouchdownLatInput] = useState(touchdown.lat.toFixed(5));
  const [touchdownLngInput, setTouchdownLngInput] = useState(touchdown.lng.toFixed(5));
  const [locationQuery, setLocationQuery] = useState("");
  const [locationSearchResults, setLocationSearchResults] = useState<LocationSearchResult[]>([]);
  const [isSearchingLocation, setIsSearchingLocation] = useState(false);
  const [lastSurfaceWind, setLastSurfaceWind] = useState<SurfaceWind | null>(null);
  const [spotName, setSpotName] = useState("");
  const [statusMessage, setStatusMessage] = useState("Ready.");
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const patternInput = useMemo(
    () =>
      buildPatternInput({
        touchdown,
        landingHeadingDeg,
        side,
        baseLegDrift,
        gatesFt,
        windLayers,
        canopy,
        exitWeightLb,
      }),
    [touchdown, landingHeadingDeg, side, baseLegDrift, gatesFt, windLayers, canopy, exitWeightLb],
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
    mutationFn: async () => fetchNoaaSurfaceWind(touchdown.lat, touchdown.lng),
    onSuccess: (surfaceWind) => {
      const profile = extrapolateWindProfile(surfaceWind, [900, 600, 300], shearAlpha);
      setWindLayers(profile);
      setLastSurfaceWind(surfaceWind);
      setStatusMessage(
        `Loaded ${surfaceWind.source} wind at touchdown (${touchdown.lat.toFixed(4)}, ${touchdown.lng.toFixed(4)}): ${surfaceWind.speedKt.toFixed(1)} kt from ${surfaceWind.dirFromDeg.toFixed(0)} deg.`,
      );
    },
    onError: (error) => {
      setLastSurfaceWind(null);
      const errorText = String(error);
      const coverageHint =
        errorText.includes("/points/") && errorText.includes("404")
          ? " NOAA API is mostly US-only; this spot may be outside coverage."
          : "";
      setStatusMessage(`Auto wind failed. Use manual inputs.${coverageHint} ${errorText}`);
    },
  });

  function handleUseGeolocation(): void {
    if (!("geolocation" in navigator)) {
      setStatusMessage("Geolocation is not available in this browser.");
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
        setStatusMessage("Location set from browser geolocation.");
      },
      () => {
        setStatusMessage("Geolocation failed. Enter location manually.");
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
    setStatusMessage(`Location set to ${result.displayName}.`);
  }

  async function handleSearchLocation(): Promise<void> {
    const query = locationQuery.trim();
    if (!query) {
      setStatusMessage("Enter a place or address to search.");
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
        setStatusMessage("No location results found.");
        return;
      }

      const firstResult = results[0];
      if (firstResult) {
        applySearchedLocation(firstResult);
      }
    } catch (error) {
      setStatusMessage(`Location search failed: ${String(error)}`);
    } finally {
      setIsSearchingLocation(false);
    }
  }

  function handleSetSuggestedHeading(): void {
    const lowLayer = windLayers.find((layer) => layer.altitudeFt === 300) ?? windLayers[windLayers.length - 1];
    if (!lowLayer) {
      setStatusMessage("No wind layer available to suggest landing direction.");
      return;
    }
    setHeading(lowLayer.dirFromDeg);
    setStatusMessage("Landing heading set to headwind suggestion.");
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
      location,
      touchdown,
      landingHeadingDeg,
      side,
      baseLegDrift,
      gatesFt,
      shearAlpha,
      canopy,
      exitWeightLb,
      windLayers,
      namedSpots,
      unitSystem,
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
      if (payload.gatesFt && payload.gatesFt.length === 4) {
        setGates(payload.gatesFt);
      }
      if (typeof payload.shearAlpha === "number") {
        setShearAlpha(payload.shearAlpha);
      }
      if (payload.canopy) {
        setCanopy(payload.canopy);
      }
      if (typeof payload.exitWeightLb === "number") {
        setExitWeight(payload.exitWeightLb);
      }
      if (payload.windLayers && payload.windLayers.length > 0) {
        setWindLayers(payload.windLayers);
      }

      setStatusMessage("Snapshot imported.");
    } catch (error) {
      setStatusMessage(`Import failed: ${String(error)}`);
    }
  }

  const speedUnitLabel = unitSystem === "imperial" ? "kt" : "m/s";
  const altUnitLabel = unitSystem === "imperial" ? "ft" : "m";
  const airspeedMinKt = canopy.airspeedMinKt ?? DEFAULT_AIRSPEED_MIN_KT;
  const airspeedMaxKt = canopy.airspeedMaxKt ?? DEFAULT_AIRSPEED_MAX_KT;
  const airspeedRange = Math.max(airspeedMaxKt - airspeedMinKt, 1);
  const wingLoading = patternOutput.metrics.wingLoading;
  const wlRatio = wingLoading / Math.max(canopy.wlRef, 1e-6);
  const modeledRawAirspeedKt = canopy.airspeedRefKt * Math.pow(Math.max(wlRatio, 1e-6), canopy.airspeedWlExponent ?? 0.5);
  const modeledAirspeedKt = patternOutput.metrics.estAirspeedKt;
  const airspeedGaugePct = Math.min(100, Math.max(0, ((modeledAirspeedKt - airspeedMinKt) / airspeedRange) * 100));
  const clampTolerance = 0.05;
  const airspeedClampLabel =
    modeledRawAirspeedKt > airspeedMaxKt + clampTolerance
      ? `Airspeed capped by max ${airspeedMaxKt.toFixed(1)} kt.`
      : modeledRawAirspeedKt < airspeedMinKt - clampTolerance
        ? `Airspeed raised to min ${airspeedMinKt.toFixed(1)} kt.`
        : null;
  const hasCautionWarnings = patternOutput.warnings.length > 0;
  const outputStatusClass = patternOutput.blocked ? "blocked" : hasCautionWarnings ? "caution" : "ok";
  const outputStatusText = patternOutput.blocked
    ? "Pattern blocked by safety model."
    : hasCautionWarnings
      ? "Pattern computed with caution warnings."
      : "Pattern valid.";

  return (
    <div className="app-shell">
      <header className="banner">
        <h1>Landing Pattern Simulator</h1>
        <p>
          Planning aid only. Not operational guidance. Always follow DZ procedures, traffic, and instructor/coach input.
        </p>
      </header>

      <main className="layout">
        <section className="map-column">
          <MapPanel
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
            <h2>Units</h2>
            <div className="row">
              <label>
                <input
                  type="radio"
                  checked={unitSystem === "imperial"}
                  onChange={() => setUnitSystem("imperial")}
                />
                Imperial
              </label>
              <label>
                <input type="radio" checked={unitSystem === "metric"} onChange={() => setUnitSystem("metric")} />
                Metric
              </label>
            </div>
          </section>

          <section>
            <h2>Touchdown Spot</h2>
            <div className="row wrap">
              <button onClick={handleUseGeolocation}>Use Browser Location</button>
              <button onClick={() => windMutation.mutate()} disabled={windMutation.isPending}>
                {windMutation.isPending ? "Loading Wind..." : "Fetch NOAA Wind"}
              </button>
            </div>
            <div className="location-search">
              <input
                placeholder="Search place or address"
                value={locationQuery}
                onChange={(event) => setLocationQuery(event.target.value)}
              />
              <button onClick={() => void handleSearchLocation()} disabled={isSearchingLocation}>
                {isSearchingLocation ? "Searching..." : "Search Location"}
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
                Lat
                <input value={touchdownLatInput} onChange={(event) => setTouchdownLatInput(event.target.value)} />
              </label>
              <label>
                Lng
                <input value={touchdownLngInput} onChange={(event) => setTouchdownLngInput(event.target.value)} />
              </label>
            </div>
            <button onClick={handleTouchdownInputApply}>Apply Touchdown</button>
            <p className="status">{statusMessage}</p>
            <div className="grid two">
              <input placeholder="Spot name" value={spotName} onChange={(event) => setSpotName(event.target.value)} />
              <button
                onClick={() => {
                  if (!spotName.trim()) {
                    return;
                  }
                  saveNamedSpot(spotName.trim());
                  setSpotName("");
                }}
              >
                Save Spot
              </button>
            </div>
            {namedSpots.length > 0 ? (
              <select onChange={(event) => selectNamedSpot(event.target.value)} defaultValue="">
                <option value="" disabled>
                  Select saved spot
                </option>
                {namedSpots.map((spot) => (
                  <option key={spot.id} value={spot.id}>
                    {spot.name}
                  </option>
                ))}
              </select>
            ) : null}
          </section>

          <section>
            <h2>Canopy + Jumper</h2>
            <label>
              Preset
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
                Canopy Size (sqft)
                <NumberInput
                  value={canopy.sizeSqft}
                  onValueChange={(nextValue) => setCanopy({ ...canopy, sizeSqft: nextValue })}
                />
              </label>
              <label>
                Exit Weight (lb)
                <NumberInput value={exitWeightLb} onValueChange={(nextValue) => setExitWeight(nextValue)} />
              </label>
              <label>
                Airspeed Ref @ WL Ref (kt)
                <NumberInput
                  value={canopy.airspeedRefKt}
                  onValueChange={(nextValue) => setCanopy({ ...canopy, airspeedRefKt: nextValue })}
                />
              </label>
              <label>
                WL Ref
                <NumberInput
                  step="0.05"
                  value={canopy.wlRef}
                  onValueChange={(nextValue) => setCanopy({ ...canopy, wlRef: Math.max(0.1, nextValue) })}
                />
              </label>
              <label>
                Glide Ratio
                <NumberInput
                  step="0.1"
                  value={canopy.glideRatio}
                  onValueChange={(nextValue) => setCanopy({ ...canopy, glideRatio: nextValue })}
                />
              </label>
              <label>
                WL Speed Exponent
                <NumberInput
                  step="0.05"
                  value={canopy.airspeedWlExponent ?? 0.5}
                  onValueChange={(nextValue) => setCanopy({ ...canopy, airspeedWlExponent: nextValue })}
                />
              </label>
              <label>
                Airspeed Min (kt)
                <NumberInput
                  step="0.5"
                  value={airspeedMinKt}
                  onValueChange={(nextValue) => setCanopy({ ...canopy, airspeedMinKt: nextValue })}
                />
              </label>
              <label>
                Airspeed Max (kt)
                <NumberInput
                  step="0.5"
                  value={airspeedMaxKt}
                  onValueChange={(nextValue) => setCanopy({ ...canopy, airspeedMaxKt: nextValue })}
                />
              </label>
            </div>
            <p className="status">
              Current WL {patternOutput.metrics.wingLoading.toFixed(2)} =&gt; Modeled Airspeed {patternOutput.metrics.estAirspeedKt.toFixed(1)} kt
            </p>
            <div className="airspeed-meter">
              <div className="airspeed-meter-track">
                <div className="airspeed-meter-marker" style={{ left: `calc(${airspeedGaugePct}% - 1px)` }} />
              </div>
              <div className="airspeed-meter-scale">
                <span>{airspeedMinKt.toFixed(1)} kt</span>
                <span>{modeledAirspeedKt.toFixed(1)} kt</span>
                <span>{airspeedMaxKt.toFixed(1)} kt</span>
              </div>
              <p className="status">
                Raw model {modeledRawAirspeedKt.toFixed(1)} kt {airspeedClampLabel ? `(${airspeedClampLabel})` : ""}
              </p>
            </div>
          </section>

          <section>
            <h2>Pattern Settings</h2>
            <div className="row">
              <label>
                Side
                <select value={side} onChange={(event) => setSide(event.target.value as "left" | "right")}>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={baseLegDrift}
                  onChange={(event) => setBaseLegDrift(event.target.checked)}
                />
                Allow Base Drift
              </label>
              <label>
                Landing Heading (deg)
                <NumberInput value={landingHeadingDeg} onValueChange={(nextValue) => setHeading(nextValue)} />
              </label>
              <button onClick={handleSetSuggestedHeading}>Suggest Headwind Final</button>
            </div>
            <label>
              Landing Direction Slider
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
                  Gate {index + 1} ({altUnitLabel})
                  <NumberInput
                    value={Math.round(toDisplayFeet(unitSystem, gate))}
                    onValueChange={(nextValue) => {
                      const next = [...gatesFt] as [number, number, number, number];
                      next[index] = fromDisplayFeet(unitSystem, nextValue);
                      setGates(next);
                    }}
                  />
                </label>
              ))}
              <label>
                Shear Exponent
                <NumberInput step="0.01" value={shearAlpha} onValueChange={(nextValue) => setShearAlpha(nextValue)} />
              </label>
            </div>
          </section>

          <section>
            <h2>Wind Layers</h2>
            {windLayers.map((layer, layerIndex) => (
              <div className="grid three" key={`${layerIndex}-${layer.altitudeFt}`}>
                <label>
                  Alt ({altUnitLabel})
                  <NumberInput
                    value={Math.round(toDisplayFeet(unitSystem, layer.altitudeFt))}
                    onValueChange={(nextValue) => {
                      const value = fromDisplayFeet(unitSystem, nextValue);
                      updateWindLayer(layerIndex, { altitudeFt: value });
                    }}
                  />
                </label>
                <label>
                  Speed ({speedUnitLabel})
                  <NumberInput
                    value={Number(toDisplayKnots(unitSystem, layer.speedKt).toFixed(1))}
                    onValueChange={(nextValue) => {
                      const value = fromDisplayKnots(unitSystem, nextValue);
                      updateWindLayer(layerIndex, { speedKt: value, source: "manual" });
                    }}
                  />
                </label>
                <label>
                  Direction From (deg)
                  <NumberInput
                    value={Math.round(layer.dirFromDeg)}
                    onValueChange={(nextValue) =>
                      updateWindLayer(layerIndex, { dirFromDeg: nextValue, source: "manual" })
                    }
                  />
                </label>
              </div>
            ))}
          </section>

          <section>
            <h2>Outputs</h2>
            <p>Wing Loading: {patternOutput.metrics.wingLoading.toFixed(2)}</p>
            <p>
              Est. Airspeed: {toDisplayKnots(unitSystem, patternOutput.metrics.estAirspeedKt).toFixed(1)} {speedUnitLabel}
            </p>
            {lastSurfaceWind ? (
              <p>
                Last Surface Wind: {toDisplayKnots(unitSystem, lastSurfaceWind.speedKt).toFixed(1)} {speedUnitLabel} from{" "}
                {lastSurfaceWind.dirFromDeg.toFixed(0)} deg ({lastSurfaceWind.source})
              </p>
            ) : null}
            <p>
              Speed Model: ref {canopy.airspeedRefKt.toFixed(1)}kt @ WL {canopy.wlRef.toFixed(2)}, exponent {(canopy.airspeedWlExponent ?? 0.5).toFixed(2)}
            </p>
            <p>Est. Sink: {patternOutput.metrics.estSinkFps.toFixed(2)} ft/s</p>
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
                    <th>Leg</th>
                    <th>Heading</th>
                    <th>Track</th>
                    <th>Fwd ({speedUnitLabel})</th>
                    <th>GS ({speedUnitLabel})</th>
                    <th>Time (s)</th>
                    <th>Dist ({altUnitLabel})</th>
                  </tr>
                </thead>
                <tbody>
                  {patternOutput.segments.map((segment) => (
                    <tr key={segment.name}>
                      <td>{segment.name}</td>
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
                <p>Safer headings (no backward leg):</p>
                <div className="row wrap">
                  {safeLandingHeadings.map((heading) => (
                    <button key={heading} onClick={() => setHeading(heading)}>
                      {heading}°
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p>No fully forward heading found in current winds.</p>
            )}
          </section>

          <section>
            <h2>Import / Export</h2>
            <div className="row wrap">
              <button onClick={handleExport}>Export Snapshot JSON</button>
              <button onClick={handleImportClick}>Import Snapshot JSON</button>
            </div>
            <input ref={importInputRef} type="file" accept="application/json" hidden onChange={handleImportFile} />
          </section>
        </aside>
      </main>
    </div>
  );
}
