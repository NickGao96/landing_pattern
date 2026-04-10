import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { useAppStore } from "./store";

function renderApp() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  useAppStore.setState({
    language: "en",
    unitSystem: "imperial",
    mode: "canopy",
    location: { lat: 37.4419, lng: -122.143, source: "default" },
    touchdown: { lat: 37.4419, lng: -122.143 },
    landingHeadingDeg: 180,
    side: "left",
    baseLegDrift: true,
    shearAlpha: 0.14,
    canopySettings: {
      gatesFt: [900, 600, 300, 0],
      canopy: {
        manufacturer: "Performance Designs",
        model: "Sabre3 170",
        sizeSqft: 170,
        wlRef: 1,
        airspeedRefKt: 20,
        glideRatio: 2.7,
      },
      exitWeightLb: 170,
      windLayers: [
        { altitudeFt: 900, speedKt: 10, dirFromDeg: 180, source: "manual" },
        { altitudeFt: 600, speedKt: 9, dirFromDeg: 180, source: "manual" },
        { altitudeFt: 300, speedKt: 8, dirFromDeg: 180, source: "manual" },
      ],
    },
    wingsuitSettings: {
      gatesFt: [12000, 10000, 6500, 4000],
      wingsuit: {
        presetId: "freak",
        name: "Squirrel FREAK",
        flightSpeedKt: 84,
        fallRateFps: 68,
      },
      windLayers: [
        { altitudeFt: 12000, speedKt: 28, dirFromDeg: 240, source: "manual" },
        { altitudeFt: 10000, speedKt: 24, dirFromDeg: 230, source: "manual" },
        { altitudeFt: 6500, speedKt: 18, dirFromDeg: 220, source: "manual" },
      ],
    },
    wingsuitAutoSettings: {
      planningMode: "manual",
      directionMode: "auto",
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
    namedSpots: [],
    selectedSpotId: null,
  });

  await useAppStore.persist.rehydrate();
});

describe("App", () => {
  it("recomputes and blocks when wing loading exceeds threshold", async () => {
    renderApp();

    const exitWeightInput = screen.getByLabelText("Exit Weight (lb)");
    fireEvent.change(exitWeightInput, { target: { value: "320" } });

    await waitFor(() => {
      expect(screen.getByText("Pattern blocked by safety model.")).toBeInTheDocument();
    });

    expect(screen.getByText(/Wing Loading:/)).toHaveTextContent("1.88");
  });

  it("allows manual wind overrides", () => {
    renderApp();

    const speedInputs = screen.getAllByLabelText("Speed (kt)");
    expect(speedInputs.length).toBeGreaterThan(0);
    const firstSpeedInput = speedInputs[0] as HTMLInputElement;
    fireEvent.change(firstSpeedInput, { target: { value: "22.5" } });

    expect(firstSpeedInput.value).toBe("22.5");
  });

  it("restores persisted state", async () => {
    localStorage.setItem(
      "landing-pattern-store-v1",
      JSON.stringify({
        state: {
          landingHeadingDeg: 145,
          exitWeightLb: 200,
        },
        version: 0,
      }),
    );

    await useAppStore.persist.rehydrate();
    renderApp();

    expect(screen.getByLabelText("Landing Heading (deg)")).toHaveValue(145);
    expect(screen.getByLabelText("Exit Weight (lb)")).toHaveValue(200);
  });

  it("supports toggling base drift mode", () => {
    renderApp();
    const toggle = screen.getByLabelText("Allow Base Drift") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
  });

  it("restores location from imported snapshot", async () => {
    const { container } = renderApp();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    const snapshot = new File(
      [
        JSON.stringify({
          mode: "canopy",
          location: { lat: 47.12345, lng: -122.98765, source: "manual" },
        }),
      ],
      "snapshot.json",
      { type: "application/json" },
    );

    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [snapshot] },
    });

    await waitFor(() => {
      expect(screen.getByText("Snapshot imported.")).toBeInTheDocument();
    });

    const latInputs = screen.getAllByLabelText("Lat") as HTMLInputElement[];
    const lngInputs = screen.getAllByLabelText("Lng") as HTMLInputElement[];
    expect(latInputs[0]?.value).toBe("47.12345");
    expect(lngInputs[0]?.value).toBe("-122.98765");
  });

  it("preserves separate canopy and wingsuit state when switching modes", async () => {
    renderApp();

    fireEvent.click(screen.getByLabelText("Wingsuit"));
    fireEvent.change(screen.getByLabelText("Horizontal Speed (kt)"), { target: { value: "72" } });
    fireEvent.click(screen.getByLabelText("Canopy"));

    expect(screen.getByLabelText("Exit Weight (lb)")).toHaveValue(170);

    fireEvent.click(screen.getByLabelText("Wingsuit"));
    expect(screen.getByLabelText("Horizontal Speed (kt)")).toHaveValue(72);
  });

  it("fills realistic values when wingsuit presets change", () => {
    renderApp();

    fireEvent.click(screen.getByLabelText("Wingsuit"));
    fireEvent.change(screen.getByLabelText("Wingsuit Preset"), { target: { value: "atc" } });

    expect(screen.getByLabelText("Horizontal Speed (kt)")).toHaveValue(68);
    expect(screen.getByLabelText("Fall Rate (ft/s)")).toHaveValue(72);
    expect(screen.getByLabelText("Wingsuit Name")).toHaveValue("Squirrel ATC");

    fireEvent.change(screen.getByLabelText("Wingsuit Preset"), { target: { value: "aura" } });

    expect(screen.getByLabelText("Horizontal Speed (kt)")).toHaveValue(80);
    expect(screen.getByLabelText("Fall Rate (ft/s)")).toHaveValue(60);
    expect(screen.getByLabelText("Wingsuit Name")).toHaveValue("Squirrel AURA");

    fireEvent.change(screen.getByLabelText("Wingsuit Preset"), { target: { value: "swift" } });

    expect(screen.getByLabelText("Horizontal Speed (kt)")).toHaveValue(60);
    expect(screen.getByLabelText("Fall Rate (ft/s)")).toHaveValue(84);
    expect(screen.getByLabelText("Wingsuit Name")).toHaveValue("Squirrel SWIFT");
  });

  it("shows wingsuit auto controls and diagnostics", () => {
    renderApp();

    fireEvent.click(screen.getByLabelText("Wingsuit"));
    fireEvent.click(screen.getByLabelText("Auto Mode"));

    expect(screen.getByText("Landing Point")).toBeInTheDocument();
    expect(screen.getByLabelText("Exit Height (ft)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Jump Run Start Lat")).not.toBeInTheDocument();
    expect(screen.getByText("Direction Source")).toBeInTheDocument();
    expect(screen.getByLabelText("Auto (Headwind)")).toBeInTheDocument();
    expect(screen.getByText("Airport Constraint")).toBeInTheDocument();
    expect(screen.getByText("Advanced Jump-Run Assumptions")).toBeInTheDocument();
    expect(screen.queryByLabelText("Jump Run Direction (deg)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Manual"));
    expect(screen.getByLabelText("Jump Run Direction (deg)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Runway Heading (deg)")).not.toBeInTheDocument();
    expect(screen.getByText(/Preferred Deploy Bearing/)).toBeInTheDocument();
    expect(screen.getByText(/Deploy Radius Margin/)).toBeInTheDocument();
    expect(screen.getByText(/First Leg Track Delta/)).toBeInTheDocument();
    expect(screen.getByText(/crosswind offsite, group spacing, run length/i)).toBeInTheDocument();
  });

  it("keeps language and units in one display section", () => {
    renderApp();

    expect(screen.getByRole("heading", { name: "Display" })).toBeInTheDocument();
    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(screen.getByText("Units")).toBeInTheDocument();
  });

  it("stores jump-run intent and assumptions independently of landing moves", () => {
    const state = useAppStore.getState();
    state.setWingsuitAutoDirectionMode("manual");
    state.setWingsuitAutoManualHeading(33);
    state.setWingsuitAutoConstraintMode("reciprocal");
    state.setWingsuitAutoConstraintHeading(180);
    state.setWingsuitAutoAssumptions({ groupCount: 5, groupSeparationFt: 1800 });
    state.setTouchdown(37.6, -122.143);

    const nextState = useAppStore.getState();
    expect(nextState.wingsuitAutoSettings.directionMode).toBe("manual");
    expect(nextState.wingsuitAutoSettings.manualHeadingDeg).toBe(33);
    expect(nextState.wingsuitAutoSettings.constraintMode).toBe("reciprocal");
    expect(nextState.wingsuitAutoSettings.constraintHeadingDeg).toBe(180);
    expect(nextState.wingsuitAutoSettings.assumptions.groupCount).toBe(5);
    expect(nextState.wingsuitAutoSettings.assumptions.groupSeparationFt).toBe(1800);
  });

  it("imports legacy canopy snapshots into canopy mode", async () => {
    const { container } = renderApp();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    const snapshot = new File(
      [
        JSON.stringify({
          gatesFt: [1200, 800, 400, 0],
          canopy: {
            manufacturer: "Performance Designs",
            model: "Sabre3 170",
            sizeSqft: 170,
            wlRef: 1,
            airspeedRefKt: 20,
            glideRatio: 2.7,
          },
          exitWeightLb: 190,
          windLayers: [
            { altitudeFt: 1200, speedKt: 11, dirFromDeg: 180, source: "manual" },
            { altitudeFt: 800, speedKt: 10, dirFromDeg: 180, source: "manual" },
            { altitudeFt: 400, speedKt: 9, dirFromDeg: 180, source: "manual" },
          ],
        }),
      ],
      "legacy.json",
      { type: "application/json" },
    );

    fireEvent.change(fileInput, { target: { files: [snapshot] } });

    await waitFor(() => {
      expect(screen.getByText("Snapshot imported.")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Canopy")).toBeChecked();
    expect(screen.getByLabelText("Exit Weight (lb)")).toHaveValue(190);
  });

  it("updates only the targeted wind row when altitudes duplicate", () => {
    renderApp();

    const altitudeInputs = screen.getAllByLabelText("Alt (ft)") as HTMLInputElement[];
    const speedInputs = screen.getAllByLabelText("Speed (kt)") as HTMLInputElement[];

    fireEvent.change(altitudeInputs[0], { target: { value: "600" } });
    fireEvent.change(speedInputs[0], { target: { value: "21.0" } });

    expect(Number(speedInputs[0]?.value)).toBeCloseTo(21.0, 6);
    expect(Number(speedInputs[1]?.value)).toBeCloseTo(9.0, 6);
  });

  it("renders test fallback map in jsdom", () => {
    renderApp();
    expect(screen.getByTestId("map-fallback")).toBeInTheDocument();
  });

  it("switches labels to Chinese", () => {
    renderApp();

    fireEvent.click(screen.getByLabelText("中文"));

    expect(screen.getByText("语言")).toBeInTheDocument();
    expect(screen.getByLabelText("出舱重量 (lb)")).toBeInTheDocument();
    expect(screen.getByText("飞行航线模拟器")).toBeInTheDocument();
  });
});
