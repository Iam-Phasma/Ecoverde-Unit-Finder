// Leaflet styling for each GeoJSON feature category. Pure functions of feature
// properties; no map state, so these are easy to reason about independently.
import { WALK_HIGHWAYS } from "./graph.js";

export function groupForCategory(category) {
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

/** A wider, solid underlay drawn before the road fill so intersections join cleanly (no blurred CSS filters). */
export function roadCasingStyle(props) {
  const hw = props.highway;
  if (WALK_HIGHWAYS.has(hw)) return null;
  const fillWeight =
    hw === "service" || hw === "track" ? 3.5 : roadWeight(props);
  return {
    color: "#d9cdbb",
    weight: fillWeight + 3,
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
  };
}

function roadStyle(props) {
  const hw = props.highway;

  if (WALK_HIGHWAYS.has(hw)) {
    return {
      color: "#b98a4e",
      weight: 2.5,
      opacity: 0.9,
      dashArray: "1,7",
      lineCap: "round",
      className: "road-path",
    };
  }

  if (hw === "service" || hw === "track") {
    return {
      color: "#efe4cf",
      weight: 3.5,
      opacity: 1,
      lineCap: "round",
    };
  }

  // car roads (residential, unclassified, etc.)
  return {
    color: "#ffffff",
    weight: roadWeight(props),
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
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
      return {
        color: "#b7ceac",
        weight: 1,
        fillColor: "#cfe3c7",
        fillOpacity: 0.9,
      };
    case "leisure":
      return {
        color: "#9fc98f",
        weight: 1,
        fillColor: "#b9dcae",
        fillOpacity: 0.9,
      };
    case "natural":
      return {
        color: "#8fbede",
        weight: 1,
        fillColor: "#a9d3e6",
        fillOpacity: 0.9,
      };
    case "building":
      return {
        color: "#c3b49c",
        weight: 1,
        fillColor: "#d9cdbb",
        fillOpacity: 0.95,
      };
    case "cityblock":
      return {
        weight: 0,
        opacity: 0,
        fill: false,
        interactive: false,
      };
    case "context-road":
      return {
        color: "#e8b93b",
        weight: 4,
        opacity: 0.55,
        lineCap: "round",
        interactive: false,
      };
    case "context-water":
      return {
        color: "#6fa8c9",
        weight: 2,
        opacity: 0.55,
        dashArray: "1,4",
        lineCap: "round",
        interactive: false,
      };
    case "poi-tree":
      return {
        color: "#6fad66",
        weight: 1.2,
        opacity: 0.95,
        fillColor: "#87c97d",
        fillOpacity: 0.68,
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
  const colors = {
    "poi-shop": "#c9622a",
    "poi-amenity": "#2f7d4f",
    "poi-office": "#3a5fcd",
    "poi-leisure": "#2f7d4f",
    "poi-tree": "#7fbf7f",
  };
  const color = colors[feature.properties.category] || "#555";
  // Keep only actual OSM tree points visible. Hide other POI point markers.
  if (feature.properties && feature.properties.category === "poi-tree") {
    return L.circleMarker(latlng, {
      radius: 8,
      color: "#6fad66",
      weight: 1.2,
      opacity: 0.95,
      fillColor: "#87c97d",
      fillOpacity: 0.68,
      interactive: false,
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
