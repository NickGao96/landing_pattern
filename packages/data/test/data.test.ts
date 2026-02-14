import { describe, expect, it } from "vitest";
import { extrapolateWindProfile, fetchNoaaSurfaceWind } from "../src";

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

describe("extrapolateWindProfile", () => {
  it("creates profile at requested altitudes", () => {
    const profile = extrapolateWindProfile(
      {
        speedKt: 10,
        dirFromDeg: 270,
        source: "manual",
      },
      [900, 600, 300],
      0.14,
    );

    expect(profile).toHaveLength(3);
    expect(profile[0].altitudeFt).toBe(900);
    expect(profile[0].speedKt).toBeGreaterThan(profile[2].speedKt);
    expect(profile.every((layer) => layer.dirFromDeg === 270)).toBe(true);
  });
});

describe("fetchNoaaSurfaceWind", () => {
  it("uses observations when available", async () => {
    let call = 0;
    const fetcher = async () => {
      call += 1;
      if (call === 1) {
        return mockResponse({
          properties: {
            forecastHourly: "https://example.org/hourly",
            observationStations: "https://example.org/stations",
          },
        });
      }
      if (call === 2) {
        return mockResponse({
          features: [{ properties: { stationIdentifier: "KPAO" } }],
        });
      }
      return mockResponse({
        properties: {
          timestamp: "2026-02-13T00:00:00Z",
          windSpeed: { value: 5 },
          windDirection: { value: 210 },
        },
      });
    };

    const wind = await fetchNoaaSurfaceWind(37, -122, fetcher as unknown as typeof fetch);
    expect(wind.source).toBe("observation");
    expect(wind.speedKt).toBeCloseTo(9.72, 1);
    expect(wind.dirFromDeg).toBe(210);
  });

  it("respects observation wind speed unit code", async () => {
    let call = 0;
    const fetcher = async () => {
      call += 1;
      if (call === 1) {
        return mockResponse({
          properties: {
            forecastHourly: "https://example.org/hourly",
            observationStations: "https://example.org/stations",
          },
        });
      }
      if (call === 2) {
        return mockResponse({
          features: [{ properties: { stationIdentifier: "KPAO" } }],
        });
      }
      return mockResponse({
        properties: {
          timestamp: "2026-02-13T00:00:00Z",
          windSpeed: { value: 18, unitCode: "wmoUnit:kn" },
          windDirection: { value: 300 },
        },
      });
    };

    const wind = await fetchNoaaSurfaceWind(37, -122, fetcher as unknown as typeof fetch);
    expect(wind.source).toBe("observation");
    expect(wind.speedKt).toBeCloseTo(18, 6);
    expect(wind.dirFromDeg).toBe(300);
  });

  it("falls back to forecast when observations are unusable", async () => {
    let call = 0;
    const fetcher = async (url: string) => {
      call += 1;
      if (url.includes("/points/")) {
        return mockResponse({
          properties: {
            forecastHourly: "https://example.org/hourly",
            observationStations: "https://example.org/stations",
          },
        });
      }
      if (url.includes("stations") && !url.includes("observations")) {
        return mockResponse({
          features: [{ properties: { stationIdentifier: "KPAO" } }],
        });
      }
      if (url.includes("observations/latest")) {
        return mockResponse({
          properties: {
            windSpeed: { value: null },
            windDirection: { value: null },
          },
        });
      }
      return mockResponse({
        properties: {
          periods: [
            {
              windSpeed: "10 to 14 mph",
              windDirection: "NW",
            },
          ],
        },
      });
    };

    const wind = await fetchNoaaSurfaceWind(37, -122, fetcher as unknown as typeof fetch);
    expect(wind.source).toBe("forecast");
    expect(wind.dirFromDeg).toBe(315);
    expect(wind.speedKt).toBeCloseTo(10.4, 1);
    expect(call).toBeGreaterThanOrEqual(4);
  });

  it("falls back to Open-Meteo when NOAA points are unavailable", async () => {
    const fetcher = async (url: string) => {
      if (url.includes("api.weather.gov/points/")) {
        return mockResponse({ title: "Not Found" }, 404);
      }
      if (url.includes("api.open-meteo.com")) {
        return mockResponse({
          current: {
            time: "2026-02-14T00:00",
            wind_speed_10m: 14.2,
            wind_direction_10m: 305,
          },
        });
      }
      return mockResponse({}, 404);
    };

    const wind = await fetchNoaaSurfaceWind(19.6542, 109.1796, fetcher as unknown as typeof fetch);
    expect(wind.source).toBe("open-meteo");
    expect(wind.speedKt).toBeCloseTo(14.2, 6);
    expect(wind.dirFromDeg).toBe(305);
  });

  it("throws when neither source is parseable", async () => {
    const fetcher = async (url: string) => {
      if (url.includes("/points/")) {
        return mockResponse({
          properties: {
            forecastHourly: "https://example.org/hourly",
            observationStations: "https://example.org/stations",
          },
        });
      }
      if (url.includes("stations") && !url.includes("observations")) {
        return mockResponse({
          features: [{ properties: { stationIdentifier: "KPAO" } }],
        });
      }
      if (url.includes("observations/latest")) {
        return mockResponse({
          properties: {
            windSpeed: { value: null },
            windDirection: { value: null },
          },
        });
      }
      if (url.includes("api.open-meteo.com")) {
        return mockResponse({
          current: {
            wind_speed_10m: null,
            wind_direction_10m: null,
          },
        });
      }
      return mockResponse({
        properties: {
          periods: [
            {
              windSpeed: "calm",
              windDirection: "variable",
            },
          ],
        },
      });
    };

    await expect(fetchNoaaSurfaceWind(37, -122, fetcher as unknown as typeof fetch)).rejects.toThrow(
      "Unable to determine surface wind from NOAA/NWS or Open-Meteo",
    );
  });
});
