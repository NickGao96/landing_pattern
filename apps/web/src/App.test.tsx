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
    unitSystem: "imperial",
    location: { lat: 37.4419, lng: -122.143, source: "default" },
    touchdown: { lat: 37.4419, lng: -122.143 },
    landingHeadingDeg: 180,
    side: "left",
    baseLegDrift: true,
    gatesFt: [900, 600, 300, 0],
    shearAlpha: 0.14,
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
});
