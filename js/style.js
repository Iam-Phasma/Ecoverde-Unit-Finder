// Leaflet styling for each GeoJSON feature category. Pure functions of feature
// properties; no map state, so these are easy to reason about independently.
import { WALK_HIGHWAYS } from "./graph.js";

export function groupForCategory(category) {
  if (category === "context-road") return "contextRoads";
  if (category === "road") return "roads";
  if (category === "landuse") return "landuse";
  if (category === "parking") return "parking";
  if (category === "leisure") return "leisure";
  if (category === "cityblock") return "cityBlocks";
  if (category === "building") return "buildings";
  if (category === "barrier") return "barriers";
  if (category && category.startsWith("context-")) return "context";
  if (category && category.startsWith("poi")) return "pois";
  return "buildings";
}

const WEB_MERCATOR_METERS_PER_PIXEL_AT_Z0 = 156543.03392;
const ROAD_STYLE_REFERENCE_ZOOM = 17;
const ROAD_STYLE_REFERENCE_LAT = 14.5;

function roadTravelWidthMeters(props) {
  const hw = String(props?.highway || "").toLowerCase();
  const lanes = parseInt(props?.lanes, 10);

  if (WALK_HIGHWAYS.has(hw)) return 0.62;
  if (hw === "track") return 1.5;
  if (hw === "service") return 1.9;
  if (hw === "primary") return 4.2;
  if (Number.isFinite(lanes)) {
    const laneCount = Math.max(1, Math.min(6, lanes));
    return laneCount * 1.25 + 0.28;
  }
  return 2.5;
}

function normalizeRoadStyleContext(context) {
  if (typeof context === "number") {
    return { zoom: ROAD_STYLE_REFERENCE_ZOOM, lat: ROAD_STYLE_REFERENCE_LAT, zoomScale: context };
  }
  return {
    zoom: Number.isFinite(context?.zoom) ? context.zoom : ROAD_STYLE_REFERENCE_ZOOM,
    lat: Number.isFinite(context?.lat) ? context.lat : ROAD_STYLE_REFERENCE_LAT,
    zoomScale: Number.isFinite(context?.zoomScale) ? context.zoomScale : null,
  };
}

function metersPerPixel(zoom, lat) {
  const latRad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return (WEB_MERCATOR_METERS_PER_PIXEL_AT_Z0 * Math.cos(latRad)) / Math.pow(2, zoom);
}

function metersToPixels(widthMeters, context, minPixels = 1) {
  const c = normalizeRoadStyleContext(context);
  if (c.zoomScale !== null) return Math.max(minPixels, widthMeters * c.zoomScale);
  const mpp = metersPerPixel(c.zoom, c.lat);
  return Math.max(minPixels, widthMeters / Math.max(mpp, 1e-9));
}

function contextRoadTravelWidthMeters(props) {
  const hw = String(props?.highway || "").toLowerCase();
  if (hw === "primary") return 8.4;
  if (hw === "secondary") return 7.0;
  return 6.2;
}

function contextWaterCoreWidthMeters(props) {
  const waterway = String(props?.waterway || "").toLowerCase();
  if (waterway === "river") return 5.4;
  if (waterway === "stream") return 4.8;
  return 6.8;
}

/** Outermost green verge underlay drawn before the gray outline and road fill. */
export function roadVergeStyle(props, zoomScale = 1) {
  return null;
}

/** Mid gray outline between the road fill and outer green verge. */
export function roadCasingStyle(props, styleContext) {
  const hw = props.highway;
  if (WALK_HIGHWAYS.has(hw)) {
    const walkMeters = roadTravelWidthMeters(props);
    return {
      color: "#9d9d9d",
      weight: metersToPixels(walkMeters + 0.28, styleContext, 0.72),
      opacity: 0.82,
      lineCap: "round",
      lineJoin: "round",
    };
  }
  const carriageMeters = roadTravelWidthMeters(props);
  const casingMeters = carriageMeters + (hw === "primary" ? 1.6 : 0.9);
  if (hw === "primary") {
    return {
      color: "#9d9d9d",
      weight: metersToPixels(casingMeters, styleContext, 0.7),
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
    };
  }
  return {
    color: "#9d9d9d",
    weight: metersToPixels(casingMeters, styleContext, 0.7),
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
  };
}

export function roadStyle(props, styleContext) {
  const hw = props.highway;

  if (WALK_HIGHWAYS.has(hw)) {
    return {
      color: "#bebebe",
      weight: metersToPixels(roadTravelWidthMeters(props), styleContext, 0.6),
      opacity: 0.98,
      lineCap: "round",
      lineJoin: "round",
    };
  }

  if (hw === "service" || hw === "track") {
    return {
      color: "#bebebe",
      weight: metersToPixels(roadTravelWidthMeters(props), styleContext, 0.65),
      opacity: 1,
      lineCap: "round",
    };
  }

  if (hw === "primary") {
    return {
      color: "#bebebe",
      weight: metersToPixels(roadTravelWidthMeters(props), styleContext, 0.8),
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
    };
  }

  // car roads (residential, unclassified, etc.)
  return {
    color: "#bebebe",
    weight: metersToPixels(roadTravelWidthMeters(props), styleContext, 0.7),
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
  };
}

export function roadCenterlineStyle(props, styleContext) {
  if (props.highway !== "primary") return null;
  return {
    color: "#f2cb3d",
    weight: metersToPixels(0.1, styleContext, 0.65),
    opacity: 1,
    dashArray: "10,10",
    lineCap: "round",
    lineJoin: "round",
  };
}

export function contextRoadStyle(props, styleContext) {
  return {
    color: "#60656c",
    weight: metersToPixels(contextRoadTravelWidthMeters(props), styleContext, 0.9),
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  };
}

export function contextRoadCasingStyle(props, styleContext) {
  const hw = String(props?.highway || "").toLowerCase();
  const baseMeters = contextRoadTravelWidthMeters(props);
  const casingMeters = baseMeters + (hw === "primary" ? 2.1 : 1.7);
  return {
    color: "#bdbdbd",
    weight: metersToPixels(casingMeters, styleContext, 1),
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  };
}

export function contextRoadCenterlineStyle(props, styleContext) {
  const hw = String(props?.highway || "").toLowerCase();
  const centerMeters = hw === "primary" ? 0.2 : 0.14;
  return {
    color: "#f2cb3d",
    weight: metersToPixels(centerMeters, styleContext, 0.65),
    opacity: 0.95,
    dashArray: "11,10",
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  };
}

export function contextWaterEdgeStyle(props, styleContext) {
  const coreMeters = contextWaterCoreWidthMeters(props);
  const edgeMeters = coreMeters + 2.8;
  return {
    color: "#8dcfeb",
    weight: metersToPixels(edgeMeters, styleContext, 0.9),
    opacity: 0.95,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  };
}

export function contextWaterCoreStyle(props, styleContext) {
  const coreMeters = contextWaterCoreWidthMeters(props);
  return {
    color: "#64c1ea",
    weight: metersToPixels(coreMeters, styleContext, 0.7),
    opacity: 0.98,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  };
}

/** Perimeter wall/fence around the subdivision. */
function barrierStyle(props) {
  if (props.barrier === "wall") {
    return {
      color: "#8a7e6c",
      weight: 4,
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
    };
  }
  if (props.barrier === "fence") {
    return {
      color: "#a89b85",
      weight: 2,
      opacity: 0.9,
      dashArray: "3,4",
      lineCap: "round",
    };
  }
  return { color: "#8a7e6c", weight: 2.5, opacity: 0.8 };
}

export function styleForFeature(feature) {
  const c = feature.properties.category;
  switch (c) {
    case "road":
      return roadStyle(feature.properties);
    case "context-road":
      return contextRoadStyle(feature.properties);
    case "context-water":
      return {
        color: "transparent",
        weight: 0,
        opacity: 0,
        interactive: false,
      };
    case "barrier":
      return barrierStyle(feature.properties);
    case "landuse":
      if (
        feature.properties.landuse === "grass" ||
        feature.properties.landuse === "grassland"
      ) {
        return {
          color: "#5f8f4c",
          weight: 1,
          fillColor: "#7fb769",
          fillOpacity: 0.94,
        };
      }
      if (feature.properties.landuse === "industrial") {
        return {
          color: "#93b368",
          weight: 1,
          fillColor: "#b9d89a",
          fillOpacity: 1,
          className: "scrapyard-stripes",
        };
      }
      return {
        color: "#9db99a",
        weight: 1,
        fillColor: "#c6dbc0",
        fillOpacity: 0.9,
      };
    case "parking":
      return {
        color: "#8f918f",
        weight: 1,
        fillColor: "#babeb9",
        fillOpacity: 0.92,
      };
    case "leisure":
      if (
        feature.properties.sport === "basketball" ||
        feature.properties.surface === "concrete"
      ) {
        return {
          color: "#a8a39a",
          weight: 1,
          fillColor: "#c9c5bc",
          fillOpacity: 0.95,
        };
      }
      if (
        feature.properties.leisure === "garden" ||
        feature.properties.leisure === "park"
      ) {
        return {
          color: "#92bc58",
          weight: 0,
          opacity: 0,
          fillColor: "#92bc58",
          fillOpacity: 0.94,
        };
      }
      return {
        color: "#9fc98f",
        weight: 1,
        fillColor: "#b9dcae",
        fillOpacity: 0.9,
      };
    case "natural":
      if (
        feature.properties.natural === "water" ||
        feature.properties.natural === "wetland" ||
        feature.properties.natural === "bay"
      ) {
        return {
          color: "#8fbede",
          weight: 1,
          fillColor: "#a9d3e6",
          fillOpacity: 0.9,
        };
      }
      if (feature.properties.natural === "grassland") {
        return {
          color: "#598845",
          weight: 1,
          fillColor: "#74ad61",
          fillOpacity: 0.94,
        };
      }
      return {
        color: "#9fc98f",
        weight: 1,
        fillColor: "#b9dcae",
        fillOpacity: 0.9,
      };
    case "building":
      return {
        color: "#b9935f",
        weight: 1,
        fillColor: "#e4cb9e",
        fillOpacity: 0.95,
      };
    case "cityblock":
      return {
        color: "transparent",
        weight: 0,
        opacity: 0,
        fillColor: "#efdbb6",
        fillOpacity: 0.9,
        interactive: false,
      };
    case "context-road":
      return {
        color: "#60656c",
        weight: 6,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      };
    case "context-water":
      return {
        color: "transparent",
        weight: 0,
        opacity: 0,
        lineCap: "round",
        interactive: false,
      };
    case "poi-tree":
      return {
        color: "#5f8d47",
        weight: 0,
        opacity: 1,
        fillColor: "#5f8d47",
        fillOpacity: 0.7,
      };
    case "poi-shop":
    case "poi-amenity":
    case "poi-office":
    case "poi-leisure":
      return {
        color: "transparent",
        weight: 0,
        opacity: 0,
        fillColor: "transparent",
        fillOpacity: 0,
      };
    default:
      return {
        color: "#c3b49c",
        weight: 1,
        fillColor: "#d9cdbb",
        fillOpacity: 0.7,
      };
  }
}

export function pointToLayer(feature, latlng) {
  function treeVariantFromLatLng(point) {
    // Stable pseudo-random seed from coordinates so variants stay consistent.
    const latSeed = Math.round((point.lat + 90) * 100000);
    const lngSeed = Math.round((point.lng + 180) * 100000);
    const seed = Math.abs((latSeed * 31 + lngSeed * 17) ^ (latSeed * 13));

    const sizeMetersSet = [4.2, 5.1, 6.0];
    const rotations = [
      "tree-icon--rot-neg30",
      "tree-icon--rot-neg24",
      "tree-icon--rot-neg18",
      "tree-icon--rot-neg12",
      "tree-icon--rot-neg6",
      "tree-icon--rot-6",
      "tree-icon--rot-12",
      "tree-icon--rot-18",
      "tree-icon--rot-24",
      "tree-icon--rot-30",
    ];
    const sizeMeters = sizeMetersSet[seed % sizeMetersSet.length];
    const size = Math.round(
      metersToPixels(sizeMeters, { zoom: 19, lat: point.lat }, 8),
    );
    const flipped = ((seed >> 2) & 1) === 1;
    const assetClass = "tree-icon--asset2";
    const rotationClass = rotations[Math.floor(Math.random() * rotations.length)];
    return { size, sizeMeters, flipped, assetClass, rotationClass };
  }

  const colors = {
    "poi-shop": "#c9622a",
    "poi-amenity": "#2f7d4f",
    "poi-office": "#3a5fcd",
    "poi-leisure": "#2f7d4f",
    "poi-tree": "#5f8d47",
  };
  const color = colors[feature.properties.category] || "#555";
  // Keep only actual OSM tree points visible. Hide other POI point markers.
  if (feature.properties && feature.properties.category === "poi-tree") {
    const { size, sizeMeters, flipped, assetClass, rotationClass } = treeVariantFromLatLng(latlng);
    const marker = L.marker(latlng, {
      icon: L.divIcon({
        className: "tree-icon",
        html: `<span class="tree-icon__glyph ${assetClass} ${rotationClass}${flipped ? " tree-icon--flip" : ""}"></span>`,
        iconSize: [size, size],
        iconAnchor: [Math.round(size / 2), Math.round(size * 0.9)],
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: -100,
    });
    marker._treeVariant = {
      sizeMeters,
      assetClass,
      rotationClass,
      flipped,
      isBackground: false,
    };
    marker._treePixelSize = size;
    return marker;
  }

  if (feature.properties && typeof feature.properties.category === "string" && feature.properties.category.startsWith("poi-")) {
    return L.circleMarker(latlng, {
      radius: 0.1,
      color: "transparent",
      weight: 0,
      fillOpacity: 0,
      opacity: 0,
      interactive: false,
    });
  }

  return L.circleMarker(latlng, {
    radius: 6,
    color: "#fff",
    weight: 1.5,
    fillColor: color,
    fillOpacity: 1,
  });
}
