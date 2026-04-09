import type { SurfaceWind, WindLayer } from "@landing/ui-types";
import { z } from "zod";

const pointsSchema = z.object({
  properties: z.object({
    forecastHourly: z.string().min(1),
    observationStations: z.string().min(1),
  }),
});

const stationsSchema = z.object({
  features: z.array(
    z.object({
      id: z.string().optional(),
      properties: z
        .object({
          stationIdentifier: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

const latestObservationSchema = z.object({
  properties: z.object({
    timestamp: z.string().optional(),
    windSpeed: z
      .object({
        value: z.number().nullable().optional(),
        unitCode: z.string().optional(),
      })
      .optional(),
    windDirection: z.object({ value: z.number().nullable().optional() }).optional(),
  }),
});

const hourlyForecastSchema = z.object({
  properties: z.object({
    periods: z.array(
      z.object({
        windSpeed: z.string(),
        windDirection: z.string(),
      }),
    ),
  }),
});

const openMeteoSchema = z.object({
  current: z
    .object({
      time: z.string().optional(),
      wind_speed_10m: z.number().nullable().optional(),
      wind_direction_10m: z.number().nullable().optional(),
    })
    .optional(),
  current_weather: z
    .object({
      time: z.string().optional(),
      windspeed: z.number().optional(),
      winddirection: z.number().optional(),
    })
    .optional(),
});

const openMeteoUpperAirSchema = z.object({
  elevation: z.number().optional(),
  current: z
    .object({
      wind_speed_10m: z.number().nullable().optional(),
      wind_direction_10m: z.number().nullable().optional(),
    })
    .optional(),
  hourly: z.record(z.string(), z.array(z.union([z.number(), z.string(), z.null()]))).optional(),
});

const PRESSURE_LEVELS = [
  "1000hPa",
  "975hPa",
  "950hPa",
  "925hPa",
  "900hPa",
  "850hPa",
  "800hPa",
  "700hPa",
  "600hPa",
] as const;

function knotsFromMetersPerSecond(valueMps: number): number {
  return valueMps * 1.94384449;
}

function knotsFromMilesPerHour(valueMph: number): number {
  return valueMph * 0.868976;
}

function knotsFromKilometersPerHour(valueKmh: number): number {
  return valueKmh * 0.539957;
}

function feetFromMeters(valueMeters: number): number {
  return valueMeters * 3.280839895;
}

function normalizeUnitCode(unitCode?: string): string {
  return String(unitCode ?? "")
    .trim()
    .toLowerCase();
}

function observationSpeedToKnots(value: number, unitCode?: string): number {
  const normalized = normalizeUnitCode(unitCode);
  if (normalized.includes("m_s-1")) {
    return knotsFromMetersPerSecond(value);
  }
  if (normalized.includes("km_h-1") || normalized.includes("km/h")) {
    return knotsFromKilometersPerHour(value);
  }
  if (normalized.includes("mi_h-1") || normalized.includes("mph")) {
    return knotsFromMilesPerHour(value);
  }
  if (normalized.includes(":kt") || normalized.includes(":kn") || normalized.includes("kn")) {
    return value;
  }

  return knotsFromMetersPerSecond(value);
}

function parseCardinalDirection(direction: string): number | undefined {
  const normalized = direction.trim().toUpperCase();
  const map: Record<string, number> = {
    N: 0,
    NNE: 22.5,
    NE: 45,
    ENE: 67.5,
    E: 90,
    ESE: 112.5,
    SE: 135,
    SSE: 157.5,
    S: 180,
    SSW: 202.5,
    SW: 225,
    WSW: 247.5,
    W: 270,
    WNW: 292.5,
    NW: 315,
    NNW: 337.5,
  };

  return map[normalized];
}

function parseSpeedStringToKnots(speedText: string): number | undefined {
  const normalized = speedText.trim().toLowerCase();
  const matches = normalized.match(/\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) {
    return undefined;
  }

  const values = matches.map((value) => Number(value));
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;

  if (normalized.includes("mph")) {
    return mean * 0.868976;
  }
  if (normalized.includes("km") || normalized.includes("kph")) {
    return mean * 0.539957;
  }

  return mean;
}

async function fetchJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, {
    headers: {
      Accept: "application/geo+json, application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.json();
}

function stationIdFromFeature(feature: z.infer<typeof stationsSchema>["features"][number]): string | undefined {
  if (feature.properties?.stationIdentifier) {
    return feature.properties.stationIdentifier;
  }
  if (feature.id) {
    const pieces = feature.id.split("/");
    return pieces[pieces.length - 1];
  }
  return undefined;
}

async function fetchOpenMeteoSurfaceWind(
  lat: number,
  lng: number,
  fetcher: typeof fetch,
): Promise<SurfaceWind> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}` +
    `&longitude=${lng.toFixed(4)}` +
    "&current=wind_speed_10m,wind_direction_10m" +
    "&wind_speed_unit=kn" +
    "&timezone=UTC";
  const payload = await fetchJson(url, fetcher);
  const parsed = openMeteoSchema.parse(payload);

  const currentSpeed = parsed.current?.wind_speed_10m;
  const currentDir = parsed.current?.wind_direction_10m;
  if (typeof currentSpeed === "number" && typeof currentDir === "number") {
    return {
      speedKt: currentSpeed,
      dirFromDeg: currentDir,
      source: "open-meteo",
      observationTime: parsed.current?.time,
    };
  }

  const legacySpeed = parsed.current_weather?.windspeed;
  const legacyDir = parsed.current_weather?.winddirection;
  if (typeof legacySpeed === "number" && typeof legacyDir === "number") {
    return {
      speedKt: legacySpeed,
      dirFromDeg: legacyDir,
      source: "open-meteo",
      observationTime: parsed.current_weather?.time,
    };
  }

  throw new Error("Open-Meteo response missing wind speed/direction.");
}

function getHourlyNumberAtIndex(
  hourly: Record<string, Array<number | string | null>> | undefined,
  key: string,
  index: number,
): number | undefined {
  const value = hourly?.[key]?.[index];
  return typeof value === "number" ? value : undefined;
}

export async function fetchWingsuitWindProfile(
  lat: number,
  lng: number,
  altitudesFt: number[],
  fetcher: typeof fetch = fetch,
): Promise<WindLayer[]> {
  if (altitudesFt.length === 0) {
    return [];
  }

  const hourlyFields = PRESSURE_LEVELS.flatMap((level) => [
    `wind_speed_${level}`,
    `wind_direction_${level}`,
    `geopotential_height_${level}`,
  ]);

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}` +
    `&longitude=${lng.toFixed(4)}` +
    `&current=wind_speed_10m,wind_direction_10m` +
    `&hourly=${hourlyFields.join(",")}` +
    "&forecast_hours=1" +
    "&wind_speed_unit=kn" +
    "&timezone=UTC";

  const payload = await fetchJson(url, fetcher);
  const parsed = openMeteoUpperAirSchema.parse(payload);
  const elevationFt = feetFromMeters(parsed.elevation ?? 0);

  const candidates: Array<{ altitudeMslFt: number; speedKt: number; dirFromDeg: number }> = [];

  const currentSpeed = parsed.current?.wind_speed_10m;
  const currentDirection = parsed.current?.wind_direction_10m;
  if (typeof currentSpeed === "number" && typeof currentDirection === "number") {
    candidates.push({
      altitudeMslFt: elevationFt + feetFromMeters(10),
      speedKt: currentSpeed,
      dirFromDeg: currentDirection,
    });
  }

  for (const level of PRESSURE_LEVELS) {
    const speedKt = getHourlyNumberAtIndex(parsed.hourly, `wind_speed_${level}`, 0);
    const dirFromDeg = getHourlyNumberAtIndex(parsed.hourly, `wind_direction_${level}`, 0);
    const heightMslMeters = getHourlyNumberAtIndex(parsed.hourly, `geopotential_height_${level}`, 0);
    if (typeof speedKt === "number" && typeof dirFromDeg === "number" && typeof heightMslMeters === "number") {
      candidates.push({
        altitudeMslFt: feetFromMeters(heightMslMeters),
        speedKt,
        dirFromDeg,
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error("Open-Meteo upper-air response missing parseable winds.");
  }

  return altitudesFt.map((altitudeFt) => {
    const requestedMslFt = altitudeFt + elevationFt;
    const nearest = candidates.reduce((best, candidate) => {
      if (!best) {
        return candidate;
      }
      const bestDelta = Math.abs(best.altitudeMslFt - requestedMslFt);
      const candidateDelta = Math.abs(candidate.altitudeMslFt - requestedMslFt);
      return candidateDelta < bestDelta ? candidate : best;
    });

    return {
      altitudeFt,
      speedKt: nearest.speedKt,
      dirFromDeg: nearest.dirFromDeg,
      source: "auto",
    };
  });
}

export async function fetchNoaaSurfaceWind(
  lat: number,
  lng: number,
  fetcher: typeof fetch = fetch,
): Promise<SurfaceWind> {
  const pointsUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`;
  const errors: string[] = [];
  let points: z.infer<typeof pointsSchema> | null = null;

  try {
    const pointsPayload = await fetchJson(pointsUrl, fetcher);
    points = pointsSchema.parse(pointsPayload);
  } catch (error) {
    errors.push(`NOAA points failed: ${String(error)}`);
  }

  if (points) {
    try {
      const stationsPayload = await fetchJson(points.properties.observationStations, fetcher);
      const stations = stationsSchema.parse(stationsPayload);
      const firstStation = stations.features[0];
      const stationId = firstStation ? stationIdFromFeature(firstStation) : undefined;

      if (!stationId) {
        throw new Error("No observation station ID found.");
      }

      const obsPayload = await fetchJson(
        `https://api.weather.gov/stations/${stationId}/observations/latest`,
        fetcher,
      );
      const obs = latestObservationSchema.parse(obsPayload);

      const speedValue = obs.properties.windSpeed?.value;
      const speedUnit = obs.properties.windSpeed?.unitCode;
      const directionDeg = obs.properties.windDirection?.value;
      if (typeof speedValue === "number" && typeof directionDeg === "number") {
        return {
          speedKt: observationSpeedToKnots(speedValue, speedUnit),
          dirFromDeg: directionDeg,
          source: "observation",
          observationTime: obs.properties.timestamp,
        };
      }
      throw new Error("Observation missing numeric wind speed and direction.");
    } catch (error) {
      errors.push(`NOAA observation failed: ${String(error)}`);
    }

    try {
      const forecastPayload = await fetchJson(points.properties.forecastHourly, fetcher);
      const forecast = hourlyForecastSchema.parse(forecastPayload);
      const period = forecast.properties.periods[0];

      const speedKt = parseSpeedStringToKnots(period?.windSpeed ?? "");
      const direction = parseCardinalDirection(period?.windDirection ?? "");
      if (typeof speedKt === "number" && typeof direction === "number") {
        return {
          speedKt,
          dirFromDeg: direction,
          source: "forecast",
        };
      }
      throw new Error("Forecast period missing parseable wind data.");
    } catch (error) {
      errors.push(`NOAA forecast failed: ${String(error)}`);
    }
  }

  try {
    return await fetchOpenMeteoSurfaceWind(lat, lng, fetcher);
  } catch (error) {
    errors.push(`Open-Meteo failed: ${String(error)}`);
  }

  throw new Error(`Unable to determine surface wind from NOAA/NWS or Open-Meteo. ${errors.join(" | ")}`);
}

export function extrapolateWindProfile(
  surfaceWind: SurfaceWind,
  altitudesFt: number[],
  alpha = 0.14,
): WindLayer[] {
  return altitudesFt.map((altitudeFt) => {
    const altitudeM = Math.max(altitudeFt * 0.3048, 1);
    const speedKt = surfaceWind.speedKt * Math.pow(altitudeM / 10, alpha);
    return {
      altitudeFt,
      speedKt,
      dirFromDeg: surfaceWind.dirFromDeg,
      source: "auto",
    };
  });
}

export { canopyPresets, findPresetByModel } from "./presets";
