// Leaflet styling for each GeoJSON feature category. Pure functions of feature
// properties; no map state, so these are easy to reason about independently.
import { WALK_HIGHWAYS } from "./graph.js";

export function groupForCategory(category) {
  if (category === "context-road") return "contextRoads";
  if (category === "road") return "roads";
  if (category === "landuse") return "landuse";
  if (category === "leisure") return "leisure";
  if (category === "cityblock") return "cityBlocks";
  if (category === "building") return "buildings";
  if (category === "barrier") return "barriers";
  if (category && category.startsWith("context-")) return "context";
  if (category && category.startsWith("poi")) return "pois";
  return "buildings";
}

function roadWeight(props) {
  const lanes = parseInt(props.lanes, 10);
  return Number.isFinite(lanes) ? Math.min(3 + lanes * 1.5, 10) : 7;
}

function scaleStroke(weight, zoomScale) {
  return Math.max(1, weight * zoomScale);
}

/** Outermost green verge underlay drawn before the gray outline and road fill. */
export function roadVergeStyle(props, zoomScale = 1) {
  return null;
}

/** Mid gray outline between the road fill and outer green verge. */
export function roadCasingStyle(props, zoomScale = 1) {
  const hw = props.highway;
  if (WALK_HIGHWAYS.has(hw)) return null;
  if (hw === "primary") {
    return {
      color: "#9d9d9d",
      weight: scaleStroke(11, zoomScale),
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
    };
  }
  const fillWeight =
    hw === "service" || hw === "track" ? 3.5 : roadWeight(props);
  return {
    color: "#9d9d9d",
    weight: scaleStroke(fillWeight + 2.8, zoomScale),
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
  };
}

export function roadStyle(props, zoomScale = 1) {
  const hw = props.highway;

  if (WALK_HIGHWAYS.has(hw)) {
    return {
      color: "#8f8b80",
      weight: scaleStroke(2.5, zoomScale),
      opacity: 0.9,
      dashArray: "1,7",
      lineCap: "round",
      className: "road-path",
    };
  }

  if (hw === "service" || hw === "track") {
    return {
      color: "#bebebe",
      weight: scaleStroke(3.5, zoomScale),
      opacity: 1,
      lineCap: "round",
    };
  }

  if (hw === "primary") {
    return {
      color: "#bebebe",
      weight: scaleStroke(8, zoomScale),
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
    };
  }

  // car roads (residential, unclassified, etc.)
  return {
    color: "#bebebe",
    weight: scaleStroke(roadWeight(props), zoomScale),
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
  };
}

export function roadCenterlineStyle(props, zoomScale = 1) {
  if (props.highway !== "primary") return null;
  return {
    color: "#f2cb3d",
    weight: scaleStroke(2.2, zoomScale),
    opacity: 1,
    dashArray: "10,10",
    lineCap: "round",
    lineJoin: "round",
  };
}

export function contextRoadCasingStyle() {
  return {
    color: "#60656c",
    weight: 9,
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  };
}

export function contextRoadCenterlineStyle() {
  return {
    color: "#f2cb3d",
    weight: 2,
    opacity: 0.95,
    dashArray: "11,10",
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  };
}

export function contextWaterEdgeStyle() {
  return {
    color: "#8dcfeb",
    weight: 8,
    opacity: 0.95,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  };
}

export function contextWaterCoreStyle() {
  return {
    color: "#64c1ea",
    weight: 4.8,
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
          color: "#9bad92",
          weight: 1,
          fillColor: "#c7d9bc",
          fillOpacity: 0.9,
        };
      }
      return {
        color: "#9db99a",
        weight: 1,
        fillColor: "#c6dbc0",
        fillOpacity: 0.9,
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
        color: "#d9c7a3",
        weight: 1,
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

    const sizes = [20, 24, 29];
    const size = sizes[seed % sizes.length];
    const flipped = ((seed >> 2) & 1) === 1;
    return { size, flipped };
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
    const { size, flipped } = treeVariantFromLatLng(latlng);
    return L.marker(latlng, {
      icon: L.divIcon({
        className: `tree-icon${flipped ? " tree-icon--flip" : ""}`,
        iconSize: [size, size],
        iconAnchor: [Math.round(size / 2), Math.round(size * 0.9)],
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: -100,
    });
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
