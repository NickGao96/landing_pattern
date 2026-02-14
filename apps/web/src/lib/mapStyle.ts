import type { StyleSpecification } from "maplibre-gl";

const glyphsUrl = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

function esriSatelliteStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: glyphsUrl,
    sources: {
      esri: {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: "esri-satellite",
        type: "raster",
        source: "esri",
      },
    ],
  };
}

function osmFallbackStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: glyphsUrl,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: "osm-base",
        type: "raster",
        source: "osm",
      },
    ],
  };
}

export function resolveMapStyle(): StyleSpecification | string {
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
  if (token) {
    return `https://api.mapbox.com/styles/v1/mapbox/satellite-v9?access_token=${token}`;
  }

  // Use tokenless satellite source by default.
  return esriSatelliteStyle();
}

export function resolveMapFallbackStyle(): StyleSpecification {
  return osmFallbackStyle();
}
