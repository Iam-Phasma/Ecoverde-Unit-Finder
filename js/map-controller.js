// Owns the Leaflet map instance, all data layers, the road-network routing graph,
// the draggable gate marker, and unit/block highlight + ETA popup behavior.
import {
  buildRoadGraph,
  connectSnapNodesIfSameSegment,
  findGateNodeKey,
  findRoute,
  largestComponentKeys,
  snapPointToGraph,
  unsnapPoint,
} from "./graph.js";
import {
  contextRoadCasingStyle,
  contextRoadCenterlineStyle,
  groupForCategory,
  pointToLayer,
  roadCasingStyle,
  roadCenterlineStyle,
  styleForFeature,
} from "./style.js";
import { escapeHtml, numericCompare } from "./utils.js";

const ETA_SPEEDS_KMH = { car: 20, motorcycle: 25, bicycle: 15, walk: 5 };
const MIN_REPOSITION_ROUTE_KM = 0.01;
const ROAD_TAP_MAX_SNAP_PX = 16;
const REROUTE_PICK_BANNER_TEXT = "Tap the road segment you want to avoid.";

function blockageMarkerIconSvg() {
  return '<svg class="avoid-marker-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-4.5 9h9"/></svg>';
}

export function createMapController() {
  const map = L.map("map", {
    zoomControl: false,
    attributionControl: false,
    minZoom: 15,
    maxZoom: 22,
  });
  const isPhoneViewport = window.matchMedia("(max-width: 720px)");

  const navControl = L.control({ position: "bottomright" });
  navControl.onAdd = function () {
    const container = L.DomUtil.create(
      "div",
      "leaflet-bar leaflet-control recenter-control",
    );

    const zoomIn = L.DomUtil.create("a", "", container);
    zoomIn.href = "#";
    zoomIn.title = "Zoom in";
    zoomIn.setAttribute("role", "button");
    zoomIn.setAttribute("aria-label", "Zoom in");
    zoomIn.innerHTML =
      '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14m-7 7V5"/></svg>';

    const center = L.DomUtil.create("a", "", container);
    center.href = "#";
    center.title = "Center map";
    center.setAttribute("role", "button");
    center.setAttribute("aria-label", "Center map");
    center.innerHTML =
      '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h4V4m12 4h-4V4M4 16h4v4m12-4h-4v4"/></svg>';

    const zoomOut = L.DomUtil.create("a", "", container);
    zoomOut.href = "#";
    zoomOut.title = "Zoom out";
    zoomOut.setAttribute("role", "button");
    zoomOut.setAttribute("aria-label", "Zoom out");
    zoomOut.innerHTML =
      '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14"/></svg>';

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(zoomIn, "click", (e) => {
      L.DomEvent.preventDefault(e);
      map.zoomIn();
    });
    L.DomEvent.on(center, "click", (e) => {
      L.DomEvent.preventDefault(e);
      recenterMap();
    });
    L.DomEvent.on(zoomOut, "click", (e) => {
      L.DomEvent.preventDefault(e);
      map.zoomOut();
    });
    return container;
  };
  navControl.addTo(map);

  const layers = {
    context: L.layerGroup().addTo(map),
    landuse: L.layerGroup().addTo(map),
    leisure: L.layerGroup().addTo(map),
    leisureDots: L.layerGroup().addTo(map),
    roadNames: L.layerGroup().addTo(map),
    cityBlocks: L.layerGroup().addTo(map),
    roadsCasing: L.layerGroup().addTo(map),
    roads: L.layerGroup().addTo(map),
    roadsCenter: L.layerGroup().addTo(map),
    contextRoadsCasing: L.layerGroup().addTo(map),
    contextRoads: L.layerGroup().addTo(map),
    contextRoadsCenter: L.layerGroup().addTo(map),
    obstacle: L.layerGroup(),
    administrative: L.layerGroup(),
    buildings: L.layerGroup().addTo(map),
    barriers: L.layerGroup().addTo(map),
    pois: L.layerGroup().addTo(map),
    route: L.layerGroup().addTo(map),
    gate: L.layerGroup().addTo(map),
  };

  const buildingLayerById = new Map(); // "block|lot" (lowercased) -> { layer, props }
  const cityBlockLayersByKey = new Map(); // block key (e.g. "18", "14A") -> { layers: [...], props }
  const blockSelect = document.getElementById("block-select");
  const lotSelect = document.getElementById("lot-select");
  const routePanel = document.getElementById("route-panel");
  const routeUnitEl = document.getElementById("route-unit");
  const routeMetaEl = document.getElementById("route-meta");
  const routeEtaRowsEl = document.getElementById("route-eta-rows");
  const routeNarrativeEl = document.getElementById("route-narrative");
  const routeDismissBtn = document.getElementById("route-dismiss");
  const routeClearBtn = document.getElementById("route-clear");
  const routeRerouteBtn = document.getElementById("route-reroute");
  const rerouteBanner = document.getElementById("reroute-banner");

  let highlighted = null;
  let dataBounds = null;

  // road-network graph used to animate a route from the subdivision gate to a house
  let roadGraph = null; // drivable roads only, footways/paths excluded
  let roadNameByEdge = new Map(); // undirected edge "a|b" -> road name
  let roadNameCandidates = []; // [{ name, latlng }]
  let mainRoadComponent = null;
  let gateNodeKey = null;
  let gateMarker = null; // draggable marker letting the user relocate the route's starting point
  let gateMoved = false; // true once the user drags the gate marker away from its default position
  let routeAnimId = null;
  let activeDest = null; // { destCenter, bounds } for the currently highlighted building
  let lastEtaInfo = null; // { latlng, distanceMeters, pathLatLngs } for reopening route details
  let avoidMode = false;
  let rerouteBlocked = false;
  let avoidMarker = null;
  let avoidedEdgeKeys = new Set();
  let avoidPickHandler = null;
  let panelHideTimer = null;
  let panelMode = "route"; // "route" | "block"
  let unitCountByBlock = new Map();

  routeDismissBtn?.addEventListener("click", () => hideRoutePanel());
  routeClearBtn?.addEventListener("click", () => clearSelection());
  routeRerouteBtn?.addEventListener("click", () => {
    if (avoidMode) {
      endAvoidRoadPickMode();
      return;
    }
    beginAvoidRoadPick();
  });
  updateRerouteButtonState();
  map.on("zoomend", refreshRoadNameLabels);

  function loadData(url) {
    fetch(url, { cache: "no-store" })
      .then((res) => res.json())
      .then(renderData)
      .catch((err) => console.error("Failed to load map data", err));
  }

  function renderData(collection) {
    layers.leisureDots.clearLayers();
    layers.roadNames.clearLayers();
    layers.obstacle.clearLayers();
    layers.administrative.clearLayers();
    roadNameByEdge = new Map();
    roadNameCandidates = [];
    const lotsByBlock = new Map(); // block -> Set(lot)

    const geoJsonLayer = L.geoJSON(collection, {
      style: styleForFeature,
      pointToLayer: pointToLayer,
      onEachFeature: (feature, layer) => {
        const props = feature.properties || {};

        if (props.category === "building" && props.block && props.lot) {
          buildingLayerById.set(`${props.block}|${props.lot}`.toLowerCase(), {
            layer,
            props,
          });
          if (!lotsByBlock.has(props.block))
            lotsByBlock.set(props.block, new Set());
          lotsByBlock.get(props.block).add(props.lot);
          layer.on("click", () => reopenEtaPopupFor(layer));
        }
        if (props.category === "cityblock" && props.block) {
          if (!cityBlockLayersByKey.has(props.block))
            cityBlockLayersByKey.set(props.block, { layers: [], props });
          cityBlockLayersByKey.get(props.block).layers.push(layer);
        }
        if (props.category === "road") {
          indexRoadEdgeNames(feature);
          const casingStyle = roadCasingStyle(props);
          if (casingStyle) {
            layers.roadsCasing.addLayer(
              L.polyline(layer.getLatLngs(), casingStyle),
            );
          }
          const centerlineStyle = roadCenterlineStyle(props);
          if (centerlineStyle) {
            layers.roadsCenter.addLayer(
              L.polyline(layer.getLatLngs(), centerlineStyle),
            );
          }
          if (props.name) {
            const candidate = createRoadNameCandidate(layer, props.name);
            if (candidate) roadNameCandidates.push(candidate);
          }
        }
        if (props.category === "context-road") {
          layers.contextRoadsCasing.addLayer(
            L.polyline(layer.getLatLngs(), contextRoadCasingStyle()),
          );
          layers.contextRoadsCenter.addLayer(
            L.polyline(layer.getLatLngs(), contextRoadCenterlineStyle()),
          );
        }
      },
    });

    dataBounds = null; // computed below, excluding "context-*" features so they don't skew the default fit

    geoJsonLayer.eachLayer((layer) => {
      const category = layer.feature.properties.category;
      const group = layers[groupForCategory(category)] || layers.buildings;
      group.addLayer(layer);
      if (category === "leisure") {
        const props = layer.feature?.properties || {};
        if (!(props.sport === "basketball" || props.surface === "concrete")) {
          addLeisureTextureDots(layer);
        }
      }

      if (!category.startsWith("context-")) {
        const layerBounds = layer.getBounds
          ? layer.getBounds()
          : L.latLngBounds([layer.getLatLng(), layer.getLatLng()]);
        dataBounds = dataBounds ? dataBounds.extend(layerBounds) : layerBounds;
      }
    });

    populateBlockSelect(lotsByBlock, cityBlockLayersByKey);
    unitCountByBlock = new Map(
      [...lotsByBlock.entries()].map(([block, lots]) => [block, lots.size]),
    );

    roadGraph = buildRoadGraph(collection.features);
    mainRoadComponent = largestComponentKeys(roadGraph);
    gateNodeKey = findGateNodeKey(
      collection.features,
      roadGraph,
      mainRoadComponent,
    );
    initGateMarker();

    map.fitBounds(dataBounds, { padding: [20, 20] });
    // pad by 50% so panning can push the subdivision halfway off-screen, but never fully away
    map.setMaxBounds(dataBounds.pad(0.5));
    updateMinZoom();
    window.addEventListener("resize", updateMinZoom);
    populateObstaclePins(collection.features);
    populateAdministrativePins(collection.features);
    refreshRoadNameLabels();
  }

  function populateObstaclePins(features) {
    if (!Array.isArray(features)) return;
    for (const feature of features) {
      const pin = obstaclePinMetaForFeature(feature);
      if (!pin) continue;
      const latlng = featureCenterLatLng(feature);
      if (!latlng) continue;
      layers.obstacle.addLayer(createObstaclePin(latlng, pin));
    }
  }

  function obstaclePinMetaForFeature(feature) {
    const props = feature?.properties || {};
    const trafficCalming = String(props.traffic_calming || "").toLowerCase();
    const noExit = String(props.noexit || props.no_exit || "").toLowerCase();

    if (
      trafficCalming === "hump" ||
      trafficCalming === "speed_bump" ||
      trafficCalming === "speed hump" ||
      trafficCalming === "bump" ||
      trafficCalming === "table" ||
      trafficCalming === "speed_table"
    ) {
      return { type: "speedBump", label: "Speed Bump" };
    }
    if (noExit === "yes" || noExit === "true" || noExit === "1") {
      return { type: "noExit", label: "No Exit" };
    }
    return null;
  }

  function obstacleIconSvg(type) {
    const common = 'class="obstacle-pin-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"';
    if (type === "noExit") {
      return `<svg ${common}><path stroke="currentColor" stroke-linecap="round" stroke-width="2.6" d="m6 6 12 12m3-6a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>`;
    }
    return `<svg ${common}><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.6" d="M16.881 16H7.119a1 1 0 0 1-.772-1.636l4.881-5.927a1 1 0 0 1 1.544 0l4.88 5.927a1 1 0 0 1-.77 1.636Z"/></svg>`;
  }

  function createObstaclePin(latlng, pin) {
    const toneClass =
      pin.type === "noExit"
        ? "obstacle-pin-badge--no-exit"
        : "obstacle-pin-badge--speed-bump";
    const iconHtml = obstacleIconSvg(pin.type);
    return L.marker(latlng, {
      icon: L.divIcon({
        className: "obstacle-pin",
        html: `<span class="obstacle-pin-badge ${toneClass}" title="${escapeHtml(pin.label)}">${iconHtml}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
      keyboard: false,
    }).bindTooltip(pin.label, {
      direction: "top",
      offset: [0, -20],
      opacity: 0.92,
    });
  }

  function populateAdministrativePins(features) {
    if (!Array.isArray(features)) return;
    const bestByType = new Map();
    const modelUnitPins = [];
    const realEstatePins = [];
    const gazeboPins = [];
    for (const feature of features) {
      const pin = pinMetaForFeature(feature);
      if (!pin) continue;
      if (pin.type === "modelUnit") {
        modelUnitPins.push({ feature, pin });
        continue;
      }
      if (pin.type === "realEstate") {
        realEstatePins.push({ feature, pin });
        continue;
      }
      if (pin.type === "gazebo") {
        gazeboPins.push({ feature, pin });
        continue;
      }
      const existing = bestByType.get(pin.type);
      if (!existing || pin.score > existing.pin.score) {
        bestByType.set(pin.type, { feature, pin });
      }
    }

    for (const { feature, pin } of bestByType.values()) {
      const latlng = featureCenterLatLng(feature);
      if (!latlng) continue;
      layers.administrative.addLayer(createAdministrativePin(latlng, pin));
    }

    for (const { feature, pin } of modelUnitPins) {
      const latlng = featureCenterLatLng(feature);
      if (!latlng) continue;
      layers.administrative.addLayer(createAdministrativePin(latlng, pin));
    }

    for (const { feature, pin } of realEstatePins) {
      const latlng = featureCenterLatLng(feature);
      if (!latlng) continue;
      layers.administrative.addLayer(createAdministrativePin(latlng, pin));
    }

    for (const { feature, pin } of gazeboPins) {
      const latlng = featureCenterLatLng(feature);
      if (!latlng) continue;
      layers.administrative.addLayer(createAdministrativePin(latlng, pin));
    }
  }

  function pinMetaForFeature(feature) {
    const props = feature?.properties || {};
    const name = String(props.name || "");
    const office = String(props.office || "");
    const amenity = String(props.amenity || "");

    if (props.sport === "basketball" || props.leisure === "pitch") {
      return { type: "basketball", label: "Basketball Court", score: 1 };
    }
    if (props.man_made === "water_tower") {
      return { type: "waterTower", label: "Water Tower", score: 1 };
    }
    if (amenity === "toilets") {
      return { type: "restroom", label: "Restroom", score: 1 };
    }
    if (
      office.toLowerCase().includes("security") ||
      name.toLowerCase().includes("guard")
    ) {
      return { type: "guard", label: "Guard Shack", score: 2 };
    }
    if (
      office.toLowerCase().includes("estate_agent") ||
      office.toLowerCase().includes("estate") ||
      name.toLowerCase().includes("real estate") ||
      name.toLowerCase().includes("admin building")
    ) {
      const score = props.category === "poi-office" ? 3 : 2;
      return { type: "realEstate", label: "Real State Office", score };
    }
    if (name.toLowerCase().includes("model unit")) {
      return {
        type: "modelUnit",
        label: "Model Unit",
        score: 2,
      };
    }
    if (props.building === "gazebo") {
      return { type: "gazebo", label: "Gazebo", score: 2 };
    }
    if (props.building === "pavilion") {
      const score = name.toLowerCase().includes("club house") ? 3 : 1;
      return { type: "pavilion", label: "Pavilion", score };
    }
    return null;
  }

  function administrativeIconSvg(type) {
    const common = 'class="admin-pin-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"';
    switch (type) {
      case "basketball":
        return `<svg ${common} fill="currentColor"><path fill-rule="evenodd" d="M12 2a10 10 0 1 0 10 10A10.009 10.009 0 0 0 12 2Zm6.613 4.614a8.523 8.523 0 0 1 1.93 5.32 20.093 20.093 0 0 0-5.949-.274c-.059-.149-.122-.292-.184-.441a23.879 23.879 0 0 0-.566-1.239 11.41 11.41 0 0 0 4.769-3.366ZM10 3.707a8.82 8.82 0 0 1 2-.238 8.5 8.5 0 0 1 5.664 2.152 9.608 9.608 0 0 1-4.476 3.087A45.755 45.755 0 0 0 10 3.707Zm-6.358 6.555a8.57 8.57 0 0 1 4.73-5.981 53.99 53.99 0 0 1 3.168 4.941 32.078 32.078 0 0 1-7.9 1.04h.002Zm2.01 7.46a8.51 8.51 0 0 1-2.2-5.707v-.262a31.641 31.641 0 0 0 8.777-1.219c.243.477.477.964.692 1.449-.114.032-.227.067-.336.1a13.569 13.569 0 0 0-6.942 5.636l.009.003ZM12 20.556a8.508 8.508 0 0 1-5.243-1.8 11.717 11.717 0 0 1 6.7-5.332.509.509 0 0 1 .055-.02 35.65 35.65 0 0 1 1.819 6.476 8.476 8.476 0 0 1-3.331.676Zm4.772-1.462A37.232 37.232 0 0 0 15.113 13a12.513 12.513 0 0 1 5.321.364 8.56 8.56 0 0 1-3.66 5.73h-.002Z" clip-rule="evenodd"/></svg>`;
      case "pavilion":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 20v-9l-4 1.125V20h4Zm0 0h8m-8 0V6.66667M16 20v-9l4 1.125V20h-4Zm0 0V6.66667M18 8l-6-4-6 4m5 1h2m-2 3h2"/></svg>`;
      case "waterTower":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 6v2s-3 1-3 3.25 1 2.25 1 3-1 1.125-1 2.25V19c0 .9375 1 2 2.5 2s2-.9375 2-.9375S13 21 14.5 21s2.5-1.0625 2.5-2v-2.5c0-1.125-1-1.5-1-2.25s1-.75 1-3S14 8 14 8V6m-3 0h-1V3h5v3h-1m-3 0h3m-5.95629 6h8.91259M8 17h9"/></svg>`;
      case "realEstate":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M3 21h18M4 18h16M6 10v8m4-8v8m4-8v8m4-8v8M4 9.5v-.955a1 1 0 0 1 .458-.84l7-4.52a1 1 0 0 1 1.084 0l7 4.52a1 1 0 0 1 .458.84V9.5a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5Z"/></svg>`;
      case "restroom":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linejoin="round" stroke-width="2" d="M9 5h-.16667c-.86548 0-1.70761.28071-2.4.8L3.5 8l2 3.5L8 10v9h8v-9l2.5 1.5 2-3.5-2.9333-2.2c-.6924-.51929-1.5346-.8-2.4-.8H15M9 5c0 1.5 1.5 3 3 3s3-1.5 3-3M9 5h6"/></svg>`;
      case "guard":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 20a16.405 16.405 0 0 1-5.092-5.804A16.694 16.694 0 0 1 5 6.666L12 4l7 2.667a16.695 16.695 0 0 1-1.908 7.529A16.406 16.406 0 0 1 12 20Z"/></svg>`;
      case "modelUnit":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m4 12 8-8 8 8M6 10.5V19a1 1 0 0 0 1 1h3v-3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v3h3a1 1 0 0 0 1-1v-8.5"/></svg>`;
      case "gazebo":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M4.5 17H4a1 1 0 0 1-1-1 3 3 0 0 1 3-3h1m0-3.05A2.5 2.5 0 1 1 9 5.5M19.5 17h.5a1 1 0 0 0 1-1 3 3 0 0 0-3-3h-1m0-3.05a2.5 2.5 0 1 0-2-4.45m.5 13.5h-7a1 1 0 0 1-1-1 3 3 0 0 1 3-3h3a3 3 0 0 1 3 3 1 1 0 0 1-1 1Zm-1-9.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z"/></svg>`;
      default:
        return "";
    }
  }

  function featureCenterLatLng(feature) {
    const geometry = feature?.geometry;
    if (!geometry || !geometry.type) return null;

    if (geometry.type === "Point") {
      const [lng, lat] = geometry.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return L.latLng(lat, lng);
    }

    if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
      const polygonLayer = L.geoJSON(feature);
      const bounds = polygonLayer.getBounds && polygonLayer.getBounds();
      if (!bounds || !bounds.isValid()) return null;
      return bounds.getCenter();
    }

    return null;
  }

  function createAdministrativePin(latlng, pin) {
    const iconHtml = administrativeIconSvg(pin.type);
    return L.marker(latlng, {
      icon: L.divIcon({
        className: "admin-pin",
        html: `<span class="admin-pin-badge" title="${escapeHtml(pin.label)}">${iconHtml}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 28],
      }),
      keyboard: false,
    }).bindTooltip(pin.label, {
      direction: "top",
      offset: [0, -20],
      opacity: 0.92,
    });
  }

  function addLeisureTextureDots(layer) {
    const ring = getOuterRingLatLngs(layer);
    if (!ring || ring.length < 3) return;

    const lats = ring.map((p) => p.lat);
    const lons = ring.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);

    const spacingMeters = 6;
    const meanLat = (minLat + maxLat) / 2;
    const metersPerDegLat = 111320;
    const metersPerDegLon = Math.max(
      1,
      Math.abs(Math.cos((meanLat * Math.PI) / 180) * 111320),
    );
    const dLat = spacingMeters / metersPerDegLat;
    const dLon = spacingMeters / metersPerDegLon;

    const polygon = ring.map((p) => [p.lat, p.lng]);
    let count = 0;
    const maxDots = 1400;

    for (let lat = minLat + dLat * 0.5; lat <= maxLat; lat += dLat) {
      for (let lon = minLon + dLon * 0.5; lon <= maxLon; lon += dLon) {
        if (count >= maxDots) break;
        if (!pointInPolygon([lat, lon], polygon)) continue;
        layers.leisureDots.addLayer(
          L.circleMarker([lat, lon], {
            radius: 1.25,
            color: "#7faa73",
            weight: 0,
            fillColor: "#7faa73",
            fillOpacity: 0.92,
            interactive: false,
          }),
        );
        count++;
      }
      if (count >= maxDots) break;
    }
  }

  function getOuterRingLatLngs(layer) {
    if (!layer.getLatLngs) return null;
    const ll = layer.getLatLngs();
    if (!Array.isArray(ll) || ll.length === 0) return null;

    let ring = null;
    if (ll[0] && typeof ll[0].lat === "number") {
      ring = ll;
    } else if (Array.isArray(ll[0])) {
      if (ll[0].length > 0 && Array.isArray(ll[0][0])) {
        ring = ll[0][0];
      } else {
        ring = ll[0];
      }
    }
    return ring || null;
  }

  function pointInPolygon(point, polygon) {
    const x = point[1];
    const y = point[0];
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][1];
      const yi = polygon[i][0];
      const xj = polygon[j][1];
      const yj = polygon[j][0];
      const intersects =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function createRoadNameCandidate(roadLayer, name) {
    const latlngs = roadLayer.getLatLngs ? roadLayer.getLatLngs() : null;
    if (!Array.isArray(latlngs) || latlngs.length === 0) return null;

    const flat = Array.isArray(latlngs[0]) ? latlngs.flat() : latlngs;
    if (!flat.length) return null;
    const mid = flat[Math.floor(flat.length / 2)];
    if (!mid) return null;

    return { name, latlng: mid };
  }

  function createRoadNameLabel(latlng, name) {
    return L.marker(latlng, {
      icon: L.divIcon({
        className: "road-name-label",
        html: `<span class="road-name-text">${escapeHtml(name)}</span>`,
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: -100,
    });
  }

  function estimateRoadLabelSize(name) {
    const text = String(name || "");
    const width = Math.max(56, Math.min(210, text.length * 7.1 + 18));
    return { width, height: 24 };
  }

  function boxIntersects(a, b) {
    return !(
      a.right <= b.left ||
      a.left >= b.right ||
      a.bottom <= b.top ||
      a.top >= b.bottom
    );
  }

  function roadLabelBoxAt(point, size) {
    const halfW = size.width / 2;
    const halfH = size.height / 2;
    return {
      left: point.x - halfW,
      right: point.x + halfW,
      top: point.y - halfH,
      bottom: point.y + halfH,
    };
  }

  function collectObstacleBoxesPx() {
    const boxes = [];
    layers.obstacle.eachLayer((layer) => {
      if (!layer?.getLatLng) return;
      const ll = layer.getLatLng();
      const pt = map.latLngToContainerPoint(ll);
      const r = 18;
      boxes.push({
        left: pt.x - r,
        right: pt.x + r,
        top: pt.y - r,
        bottom: pt.y + r,
      });
    });
    return boxes;
  }

  function findRoadLabelPlacement(latlng, name, obstacleBoxes, usedLabelBoxes) {
    const center = map.latLngToContainerPoint(latlng);
    const size = estimateRoadLabelSize(name);
    const offsets = [
      [0, 0],
      [0, -30],
      [0, 30],
      [30, 0],
      [-30, 0],
      [24, -24],
      [-24, -24],
      [24, 24],
      [-24, 24],
      [42, 0],
      [-42, 0],
      [0, -42],
      [0, 42],
    ];

    for (const [dx, dy] of offsets) {
      const candidate = L.point(center.x + dx, center.y + dy);
      const box = roadLabelBoxAt(candidate, size);
      const blockedByObstacle = obstacleBoxes.some((b) => boxIntersects(box, b));
      if (blockedByObstacle) continue;
      const blockedByLabel = usedLabelBoxes.some((b) => boxIntersects(box, b));
      if (blockedByLabel) continue;
      return { latlng: map.containerPointToLatLng(candidate), box };
    }

    return null;
  }

  function refreshRoadNameLabels() {
    layers.roadNames.clearLayers();
    if (!map.hasLayer(layers.roadNames) || roadNameCandidates.length === 0) return;

    const thresholdMeters = pixelsToMeters(mergePixelsForZoom(map.getZoom()));
    const obstacleBoxes = collectObstacleBoxesPx();
    const usedLabelBoxes = [];
    const byName = new Map();
    for (const candidate of roadNameCandidates) {
      if (!byName.has(candidate.name)) byName.set(candidate.name, []);
      byName.get(candidate.name).push(candidate.latlng);
    }

    for (const [name, points] of byName) {
      const kept = [];
      for (const point of points) {
        const tooClose = kept.some((k) => k.distanceTo(point) < thresholdMeters);
        if (tooClose) continue;
        const placed = findRoadLabelPlacement(
          point,
          name,
          obstacleBoxes,
          usedLabelBoxes,
        );
        if (!placed) continue;
        kept.push(point);
        usedLabelBoxes.push(placed.box);
        layers.roadNames.addLayer(createRoadNameLabel(placed.latlng, name));
      }
    }
  }

  function mergePixelsForZoom(zoom) {
    if (zoom <= 16) return 170;
    if (zoom === 17) return 130;
    if (zoom === 18) return 95;
    return 64;
  }

  function pixelsToMeters(px) {
    const center = map.getCenter();
    const centerPt = map.latLngToContainerPoint(center);
    const shifted = L.point(centerPt.x + px, centerPt.y);
    const shiftedLatLng = map.containerPointToLatLng(shifted);
    return center.distanceTo(shiftedLatLng);
  }

  function indexRoadEdgeNames(feature) {
    const props = feature.properties || {};
    const roadName = props.name;
    if (!roadName || !feature.geometry || feature.geometry.type !== "LineString") return;
    const coords = feature.geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coordGraphKey(coords[i]);
      const b = coordGraphKey(coords[i + 1]);
      roadNameByEdge.set(edgeNameKey(a, b), roadName);
    }
  }

  function coordGraphKey(coord) {
    return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
  }

  function edgeNameKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function setLayerVisibility(key, visible) {
    const mapping = {
      obstacle: layers.obstacle,
      roadNames: layers.roadNames,
      administrative: layers.administrative,
    };
    const layerGroup = mapping[key];
    if (!layerGroup) return;

    if (visible) {
      if (!map.hasLayer(layerGroup)) layerGroup.addTo(map);
      if (key === "roadNames") refreshRoadNameLabels();
    } else if (map.hasLayer(layerGroup)) {
      map.removeLayer(layerGroup);
    }
  }

  /** Locks zooming out past the point where the whole subdivision already fits on screen. */
  function updateMinZoom() {
    if (!dataBounds) return;
    const fitZoom = map.getBoundsZoom(dataBounds, false, [20, 20]);
    map.setMinZoom(fitZoom);
    if (map.getZoom() < fitZoom) map.setZoom(fitZoom);
  }

  /** Centers on the whole subdivision, or on the active route's start/end if one is drawn. */
  function recenterMap() {
    if (lastEtaInfo && activeDest && gateMarker) {
      const bounds = L.latLngBounds([gateMarker.getLatLng(), lastEtaInfo.latlng]);
      if (activeDest.bounds) bounds.extend(activeDest.bounds);
      // extra top padding reserves room for the ETA popup, which sits above the destination
      map.fitBounds(bounds, {
        maxZoom: 19,
        paddingTopLeft: [60, 180],
        paddingBottomRight: [60, 60],
      });
    } else if (dataBounds) {
      map.fitBounds(dataBounds, { padding: [20, 20] });
    }
  }

  function updateRerouteButtonState() {
    if (!routeRerouteBtn) return;
    routeRerouteBtn.disabled = !activeDest;
    routeRerouteBtn.textContent = avoidMode
      ? "Cancel"
      : rerouteBlocked
        ? "Pick another"
        : "Re-route";
    routeRerouteBtn.title = avoidMode
      ? "Cancel road selection"
      : rerouteBlocked
        ? "Pick another road to avoid"
        : "Pick a road point to avoid and recalculate route";

    if (routeClearBtn) routeClearBtn.disabled = avoidMode;
    if (routeDismissBtn) routeDismissBtn.disabled = avoidMode;

    if (rerouteBanner) {
      if (avoidMode) {
        rerouteBanner.textContent = REROUTE_PICK_BANNER_TEXT;
        rerouteBanner.classList.remove("hidden");
      } else if (rerouteBlocked) {
        rerouteBanner.innerHTML = `No alternate route from this start point. Tap the <span class="reroute-banner-icon" aria-hidden="true">${blockageMarkerIconSvg()}</span> marker to remove avoidance, or move the start point.`;
        rerouteBanner.classList.remove("hidden");
      } else {
        rerouteBanner.textContent = REROUTE_PICK_BANNER_TEXT;
        rerouteBanner.classList.add("hidden");
      }
    }
  }

  function clearAvoidance() {
    avoidedEdgeKeys.clear();
    rerouteBlocked = false;
    if (avoidMarker) {
      layers.route.removeLayer(avoidMarker);
      avoidMarker = null;
    }
  }

  function endAvoidRoadPickMode() {
    if (avoidPickHandler) {
      map.off("click", avoidPickHandler);
      avoidPickHandler = null;
    }
    avoidMode = false;
    updateRerouteButtonState();
  }

  function clearAvoidanceAndReroute() {
    clearAvoidance();
    if (activeDest) {
      showRoute({ fromReroute: true });
    }
  }

  function removeBlockedEdgesForRouting(blockedEdgeKeys) {
    if (!roadGraph || !blockedEdgeKeys || blockedEdgeKeys.size === 0) {
      return () => {};
    }

    const removed = [];
    for (const edgeKey of blockedEdgeKeys) {
      const parts = String(edgeKey).split("|");
      if (parts.length !== 2) continue;
      const [a, b] = parts;
      const aEdges = roadGraph.adj.get(a);
      const bEdges = roadGraph.adj.get(b);
      if (!aEdges || !bEdges) continue;

      for (let i = aEdges.length - 1; i >= 0; i--) {
        if (aEdges[i].to === b) {
          removed.push({ from: a, edge: aEdges[i] });
          aEdges.splice(i, 1);
        }
      }
      for (let i = bEdges.length - 1; i >= 0; i--) {
        if (bEdges[i].to === a) {
          removed.push({ from: b, edge: bEdges[i] });
          bEdges.splice(i, 1);
        }
      }
    }

    return () => {
      for (const item of removed) {
        const edges = roadGraph.adj.get(item.from);
        if (!edges) continue;
        edges.push(item.edge);
      }
    };
  }

  function runRouteWithAvoidance(startKey, endKey) {
    const restore = removeBlockedEdgesForRouting(avoidedEdgeKeys);
    const route = findRoute(roadGraph, startKey, endKey);
    restore();
    return route;
  }

  function beginAvoidRoadPick() {
    if (!activeDest || !roadGraph || !gateNodeKey || avoidMode) return;
    rerouteBlocked = false;
    avoidMode = true;
    updateRerouteButtonState();
    if (isPhoneViewport.matches) {
      hideRoutePanel();
    }

    if (avoidPickHandler) {
      map.off("click", avoidPickHandler);
      avoidPickHandler = null;
    }

    avoidPickHandler = (evt) => {
      if (!avoidMode || !evt?.latlng) return;

      const snapKey = snapPointToGraph(
        roadGraph,
        [evt.latlng.lng, evt.latlng.lat],
        mainRoadComponent,
      );
      if (!snapKey) return;

      const snapMeta = roadGraph.snapMeta?.get(snapKey);
      const snapCoord = roadGraph.nodes.get(snapKey);
      if (!snapMeta?.edgeKey || !snapCoord) {
        unsnapPoint(roadGraph, snapKey);
        return;
      }

      const tapPoint = map.latLngToContainerPoint(evt.latlng);
      const snapLatLng = L.latLng(snapCoord[1], snapCoord[0]);
      const snappedPoint = map.latLngToContainerPoint(snapLatLng);
      const tapDistancePx = tapPoint.distanceTo(snappedPoint);
      if (tapDistancePx > ROAD_TAP_MAX_SNAP_PX) {
        unsnapPoint(roadGraph, snapKey);
        return;
      }

      unsnapPoint(roadGraph, snapKey);
      clearAvoidance();
      avoidedEdgeKeys.add(snapMeta.edgeKey);

      avoidMarker = L.marker(snapLatLng, {
        icon: L.divIcon({
          className: "avoid-marker",
          html: `<div class="avoid-marker-badge" title="Tap to remove avoided road">${blockageMarkerIconSvg()}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        title: "Tap to remove avoided road",
        keyboard: false,
      })
        .addTo(layers.route)
        .on("click", () => clearAvoidanceAndReroute());

      endAvoidRoadPickMode();
      showRoute({ fromReroute: true });
    };

    map.on("click", avoidPickHandler);
  }

  function clearRoute(options = {}) {
    const { preservePanel = false, preserveAvoidMarker = false } = options;
    if (routeAnimId) {
      cancelAnimationFrame(routeAnimId);
      routeAnimId = null;
    }
    layers.route.clearLayers();
    lastEtaInfo = null;
    if (!preserveAvoidMarker) {
      clearAvoidance();
      avoidMarker = null;
    }
    if (!preservePanel) hideRoutePanel();
  }

  /** Creates the draggable marker for the route's starting point (the subdivision gate). */
  function initGateMarker() {
    if (!roadGraph || !gateNodeKey) return;
    const [lon, lat] = roadGraph.nodes.get(gateNodeKey);
    gateMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: "gate-marker",
        html: '<div class="gate-marker-handle">✥</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      draggable: true,
      autoPan: true,
      title: "Drag to move the starting point",
    }).addTo(layers.gate);

    gateMarker.on("dragend", () => relocateGate(gateMarker.getLatLng()));
  }

  /** Re-snaps the gate to the nearest drivable road point and redraws the active route from there. */
  function relocateGate(latlng) {
    if (!roadGraph) return;
    const newKey = snapPointToGraph(roadGraph, [latlng.lng, latlng.lat], mainRoadComponent);
    if (!newKey) return;

    if (activeDest?.destCenter) {
      const destSnapKey = snapPointToGraph(
        roadGraph,
        [activeDest.destCenter.lng, activeDest.destCenter.lat],
        mainRoadComponent,
      );
      if (destSnapKey) {
        connectSnapNodesIfSameSegment(roadGraph, newKey, destSnapKey);
        const trialRoute = findRoute(roadGraph, newKey, destSnapKey);
        unsnapPoint(roadGraph, destSnapKey);
        const trialKm = (trialRoute?.distance || 0) / 1000;
        if (trialKm <= MIN_REPOSITION_ROUTE_KM) {
          unsnapPoint(roadGraph, newKey);
          if (gateNodeKey && roadGraph.nodes.has(gateNodeKey) && gateMarker) {
            const [oldLon, oldLat] = roadGraph.nodes.get(gateNodeKey);
            gateMarker.setLatLng([oldLat, oldLon]);
          }
          return;
        }
      }
    }

    if (gateNodeKey) unsnapPoint(roadGraph, gateNodeKey);
    gateNodeKey = newKey;
    gateMoved = true;

    const [lon, lat] = roadGraph.nodes.get(gateNodeKey);
    gateMarker.setLatLng([lat, lon]);

    if (activeDest) showRoute();
  }

  /** Recomputes and (re)draws the route to the active destination, always using drivable roads. */
  function showRoute(options = {}) {
    const { fromReroute = false } = options;
    if (!activeDest) return;
    clearRoute({ preservePanel: fromReroute, preserveAvoidMarker: true });

    if (fromReroute && avoidedEdgeKeys.size > 0 && avoidMarker) {
      avoidMarker.addTo(layers.route);
    }

    const { destCenter, bounds } = activeDest;
    let route = null;
    let destSnapKey = null;
    if (roadGraph && gateNodeKey && destCenter) {
      destSnapKey = snapPointToGraph(roadGraph, [destCenter.lng, destCenter.lat], mainRoadComponent);
      if (destSnapKey) {
        connectSnapNodesIfSameSegment(roadGraph, gateNodeKey, destSnapKey);
        route = runRouteWithAvoidance(gateNodeKey, destSnapKey);
      }
    }

    if (route) {
      rerouteBlocked = false;
      const pathLatLngs = route.keys.map((k) => {
        const [lon, lat] = roadGraph.nodes.get(k);
        return L.latLng(lat, lon);
      });
      unsnapPoint(roadGraph, destSnapKey);
      const routeBounds = L.latLngBounds(pathLatLngs);
      if (bounds) routeBounds.extend(bounds);
      if (!fromReroute) {
        map.fitBounds(routeBounds, { maxZoom: 19, padding: [60, 60] });
      }
      animateRoute(pathLatLngs, route.keys, route.distance, destCenter, {
        animatePanel: !fromReroute,
      });
    } else {
      if (fromReroute) {
        rerouteBlocked = true;
        hideRoutePanel();
      }
      unsnapPoint(roadGraph, destSnapKey);
      if (fromReroute && gateMarker && destCenter) {
        const blockedBounds = L.latLngBounds([gateMarker.getLatLng(), destCenter]);
        if (bounds) blockedBounds.extend(bounds);
        map.fitBounds(blockedBounds, { maxZoom: 19, padding: [60, 60] });
      } else if (bounds) {
        map.fitBounds(bounds, { maxZoom: 20, padding: [80, 80] });
      }
    }
    updateRerouteButtonState();
  }

  /** Animates a marker along the route, then updates route details in the corner panel. */
  function animateRoute(pathLatLngs, pathNodeKeys, distanceMeters, destLatLng, options = {}) {
    L.polyline(pathLatLngs, {
      className: "route-casing",
      color: "#1a1a1a",
      weight: 8,
      opacity: 0.9,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(layers.route);

    L.polyline(pathLatLngs, {
      className: "route-flow",
      color: "#e0a800",
      weight: 5,
      opacity: 1,
      dashArray: "14,12",
      lineCap: "round",
      lineJoin: "round",
    }).addTo(layers.route);

    const cumulative = [0];
    for (let i = 1; i < pathLatLngs.length; i++) {
      cumulative.push(
        cumulative[i - 1] + pathLatLngs[i - 1].distanceTo(pathLatLngs[i]),
      );
    }
    const total = cumulative[cumulative.length - 1] || 0;

    const marker = L.marker(pathLatLngs[0], {
      icon: L.divIcon({
        className: "route-marker",
        html: '<div class="route-marker-badge"><svg class="route-marker-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M13.849 4.22c-.684-1.626-3.014-1.626-3.698 0L8.397 8.387l-4.552.361c-1.775.14-2.495 2.331-1.142 3.477l3.468 2.937-1.06 4.392c-.413 1.713 1.472 3.067 2.992 2.149L12 19.35l3.897 2.354c1.52.918 3.405-.436 2.992-2.15l-1.06-4.39 3.468-2.938c1.353-1.146.633-3.336-1.142-3.477l-4.552-.36-1.754-4.17Z"/></svg></div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      interactive: false,
    }).addTo(layers.route);

    const VISUAL_SPEED_MPS = 70; // fast-forwarded, purely for the animation
    const duration = Math.min(
      4000,
      Math.max(1200, (total / VISUAL_SPEED_MPS) * 1000),
    );
    const start = performance.now();
    renderRoutePanel(destLatLng, total, pathLatLngs, pathNodeKeys, options);

    function step(now) {
      const t = Math.min((now - start) / duration, 1);
      const targetDist = t * total;
      let idx = 0;
      while (idx < cumulative.length - 2 && cumulative[idx + 1] < targetDist)
        idx++;
      const segStart = cumulative[idx];
      const segEnd = cumulative[idx + 1] ?? segStart;
      const segT =
        segEnd > segStart ? (targetDist - segStart) / (segEnd - segStart) : 0;
      const p1 = pathLatLngs[idx];
      const p2 = pathLatLngs[idx + 1] ?? p1;
      marker.setLatLng([
        p1.lat + (p2.lat - p1.lat) * segT,
        p1.lng + (p2.lng - p1.lng) * segT,
      ]);

      if (t < 1) {
        routeAnimId = requestAnimationFrame(step);
      } else {
        routeAnimId = null;
      }
    }
    routeAnimId = requestAnimationFrame(step);
  }

  /** Renders the corner route panel with unit details, ETAs, and short turn-by-turn narrative. */
  function renderRoutePanel(latlng, distanceMeters, pathLatLngs, pathNodeKeys, options = {}) {
    if (!routePanel || !routeUnitEl || !routeMetaEl || !routeEtaRowsEl || !routeNarrativeEl) return;

    setPanelMode("route");

    lastEtaInfo = { latlng, distanceMeters, pathLatLngs, pathNodeKeys };
    const distanceKm = distanceMeters / 1000;

    const block = highlighted?.props?.block || "-";
    const lot = highlighted?.props?.lot || "-";
    routeUnitEl.textContent = `Block ${block}, Lot ${lot}`;
    routeMetaEl.textContent = `ETA from the ${gateMoved ? "start point" : "gate"} · ${distanceKm.toFixed(2)} km`;

    const rows = [
      ["🚗", "Car", ETA_SPEEDS_KMH.car],
      ["🏍️", "Motorcycle", ETA_SPEEDS_KMH.motorcycle],
      ["🚲", "Bicycle", ETA_SPEEDS_KMH.bicycle],
      ["🚶", "Walk", ETA_SPEEDS_KMH.walk],
    ]
      .map(([icon, label, speed]) => {
        const minutes = (distanceKm / speed) * 60;
        const text = minutes < 1 ? "< 1 min" : `${Math.round(minutes)} min`;
        return `<div class="route-eta-row"><span>${icon} ${label}</span><strong>${text}</strong></div>`;
      })
      .join("");
    routeEtaRowsEl.innerHTML = rows;

    routeNarrativeEl.innerHTML = buildNarrative(pathLatLngs, pathNodeKeys, distanceMeters);
    showRoutePanel(options);
  }

  /** Renders the corner panel for block-only search with block details and unit count. */
  function renderBlockPanel(entry) {
    if (!routePanel || !routeUnitEl || !routeMetaEl) return;
    setPanelMode("block");

    const block = entry?.props?.block || "-";
    const units = unitCountByBlock.get(block);
    routeUnitEl.textContent = `Block ${block}`;
    routeMetaEl.textContent = Number.isFinite(units)
      ? `${units} unit${units === 1 ? "" : "s"}`
      : "Unit count unavailable";

    showRoutePanel();
  }

  function setPanelMode(mode) {
    panelMode = mode;
    if (!routePanel) return;

    const isBlockMode = mode === "block";
    routePanel.classList.toggle("route-panel--block", isBlockMode);

    if (routeEtaRowsEl) routeEtaRowsEl.hidden = isBlockMode;
    const narrativeWrap = routeNarrativeEl?.closest(".route-narrative-wrap");
    if (narrativeWrap) narrativeWrap.hidden = isBlockMode;
    if (routeRerouteBtn) routeRerouteBtn.hidden = isBlockMode;

    if (routeClearBtn) {
      routeClearBtn.textContent = isBlockMode ? "Close" : "Clear route";
      routeClearBtn.setAttribute(
        "aria-label",
        isBlockMode ? "Close block selection" : "Clear route",
      );
      routeClearBtn.title = isBlockMode
        ? "Clear block selection"
        : "Clear route and selection";
    }

    if (routeDismissBtn) {
      routeDismissBtn.textContent = "Dismiss";
      routeDismissBtn.setAttribute("aria-label", "Dismiss");
      routeDismissBtn.title = "Close panel";
    }
  }

  function showRoutePanel(options = {}) {
    const { animatePanel = true } = options;
    if (!routePanel) return;
    if (panelHideTimer) {
      clearTimeout(panelHideTimer);
      panelHideTimer = null;
    }

    if (!animatePanel) {
      routePanel.classList.remove("hidden", "is-hiding");
      if (!routePanel.classList.contains("is-visible")) {
        routePanel.classList.add("is-visible");
      }
      return;
    }

    routePanel.classList.remove("hidden", "is-hiding", "is-visible");
    // Restart animation when panel updates for a new destination.
    void routePanel.offsetWidth;
    routePanel.classList.add("is-visible");
  }

  function hideRoutePanel(options = {}) {
    const { immediate = false } = options;
    if (!routePanel) return;
    if (panelHideTimer) {
      clearTimeout(panelHideTimer);
      panelHideTimer = null;
    }
    if (immediate) {
      routePanel.classList.remove("is-visible", "is-hiding");
      routePanel.classList.add("hidden");
      return;
    }
    if (routePanel.classList.contains("hidden") || routePanel.classList.contains("is-hiding")) return;
    routePanel.classList.remove("is-visible");
    routePanel.classList.add("is-hiding");
    panelHideTimer = setTimeout(() => {
      routePanel.classList.add("hidden");
      routePanel.classList.remove("is-hiding");
      panelHideTimer = null;
    }, 140);
  }

  function buildNarrative(pathLatLngs, pathNodeKeys, distanceMeters) {
    if (!Array.isArray(pathLatLngs) || pathLatLngs.length < 2) {
      return "From your position, route guidance is unavailable for this destination.";
    }

    const steps = [];
    const legs = buildNamedLegs(pathLatLngs, pathNodeKeys);
    const startLabel = gateMoved ? "your position" : "the gate";

    const firstLeg = legs[0];
    const firstRoad = firstLeg && firstLeg.name ? ` on ${formatRoadName(firstLeg.name)}` : "";
    const firstDist = firstLeg
      ? Math.max(5, Math.round(firstLeg.distanceMeters))
      : Math.max(5, Math.round(pathLatLngs[0].distanceTo(pathLatLngs[1])));
    steps.push(`From ${startLabel}, go straight ${formatTurnIcon("straight")}${firstRoad} for ${firstDist} meters.`);

    for (let i = 1; i < legs.length && i <= 3; i++) {
      const leg = legs[i];
      const boundary = leg.startPointIndex;
      const prev = pathLatLngs[boundary - 1];
      const curr = pathLatLngs[boundary];
      const next = pathLatLngs[boundary + 1];
      const turn = prev && curr && next ? describeTurn(prev, curr, next) : null;
      const roadRef = leg.name ? ` onto ${formatRoadName(leg.name)}` : "";
      const dist = Math.max(5, Math.round(leg.distanceMeters));
      const crossingCount = countCrossingsForLeg(pathNodeKeys, leg.startPointIndex, leg.endPointIndex);

      if (turn) {
        steps.push(`Then at crossing, turn ${turn} ${formatTurnIcon(turn.includes("left") ? "left" : "right")}${roadRef} and continue for ${dist} meters.`);
      } else {
        const crossingText = crossingCount > 0
          ? ` after ${ordinalWord(crossingCount)} crossing`
          : "";
        steps.push(`Then continue straight ${formatTurnIcon("straight")}${crossingText}${roadRef} for ${dist} meters.`);
      }
    }

    steps.push(`You will arrive after about ${Math.round(distanceMeters)} meters.`);
    return steps.join(" ");
  }

  function formatRoadName(name) {
    return `<span class="route-road-name">${escapeHtml(name)}</span>`;
  }

  function formatTurnIcon(type) {
    const rotation =
      type === "left" ? "-90" : type === "right" ? "90" : "0";
    return `<span class="route-turn-icon" aria-hidden="true"><svg class="route-turn-icon-svg" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" style="transform: rotate(${rotation}deg)"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v13m0-13 4 4m-4-4-4 4"/></svg></span>`;
  }

  function buildNamedLegs(pathLatLngs, pathNodeKeys) {
    if (
      !Array.isArray(pathLatLngs) ||
      !Array.isArray(pathNodeKeys) ||
      pathLatLngs.length !== pathNodeKeys.length ||
      pathLatLngs.length < 2
    ) {
      return [];
    }

    const segments = [];
    for (let i = 1; i < pathLatLngs.length; i++) {
      const aKey = pathNodeKeys[i - 1];
      const bKey = pathNodeKeys[i];
      const name = roadNameByEdge.get(edgeNameKey(aKey, bKey)) || null;
      const distanceMeters = pathLatLngs[i - 1].distanceTo(pathLatLngs[i]);
      segments.push({
        name,
        distanceMeters,
        startPointIndex: i - 1,
        endPointIndex: i,
      });
    }

    const legs = [];
    for (const seg of segments) {
      const prev = legs[legs.length - 1];
      if (prev && prev.name === seg.name) {
        prev.distanceMeters += seg.distanceMeters;
        prev.endPointIndex = seg.endPointIndex;
      } else {
        legs.push({ ...seg });
      }
    }
    return legs;
  }

  function countCrossingsForLeg(pathNodeKeys, startPointIndex, endPointIndex) {
    if (!Array.isArray(pathNodeKeys) || !roadGraph || !roadGraph.adj) return 0;
    let count = 0;
    for (let i = startPointIndex + 1; i < endPointIndex; i++) {
      const nodeKey = pathNodeKeys[i];
      const degree = (roadGraph.adj.get(nodeKey) || []).length;
      if (degree >= 3) count++;
    }
    return count;
  }

  function ordinalWord(n) {
    const words = ["zero", "first", "second", "third", "fourth", "fifth", "sixth"];
    return words[n] || `${n}th`;
  }

  function describeTurn(a, b, c) {
    const bearingAB = bearingDegrees(a, b);
    const bearingBC = bearingDegrees(b, c);
    let delta = bearingBC - bearingAB;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;

    const abs = Math.abs(delta);
    if (abs < 20) return null;
    if (abs < 55) return delta > 0 ? "slightly right" : "slightly left";
    return delta > 0 ? "right" : "left";
  }

  function bearingDegrees(from, to) {
    const lat1 = (from.lat * Math.PI) / 180;
    const lat2 = (to.lat * Math.PI) / 180;
    const dLon = ((to.lng - from.lng) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const brng = (Math.atan2(y, x) * 180) / Math.PI;
    return (brng + 360) % 360;
  }

  /** Fully clears the current selection: highlight, route, and destination state. */
  function clearSelection() {
    endAvoidRoadPickMode();
    clearHighlight();
    clearRoute();
    clearAvoidance();
    activeDest = null;
    updateRerouteButtonState();
  }

  function populateBlockSelect(lotsByBlock, cityBlockLayersByKey) {
    const blocks = [
      ...new Set([...lotsByBlock.keys(), ...cityBlockLayersByKey.keys()]),
    ].sort(numericCompare);
    blockSelect.innerHTML =
      '<option value="">Block</option>' +
      blocks
        .map(
          (b) =>
            `<option value="${escapeHtml(b)}">Block ${escapeHtml(b)}</option>`,
        )
        .join("");

    blockSelect.addEventListener("change", () => {
      const lots = lotsByBlock.get(blockSelect.value);
      if (!lots) {
        lotSelect.innerHTML = '<option value="">Lot</option>';
        lotSelect.disabled = true;
        return;
      }
      const sortedLots = [...lots].sort(numericCompare);
      lotSelect.innerHTML =
        '<option value="">Lot</option>' +
        sortedLots
          .map(
            (l) =>
              `<option value="${escapeHtml(l)}">Lot ${escapeHtml(l)}</option>`,
          )
          .join("");
      lotSelect.disabled = false;
    });
  }

  function clearHighlight() {
    if (highlighted) {
      const style = styleForFeature({ properties: highlighted.props });
      for (const layer of highlighted.layers) {
        layer.setStyle(style);
        const el = layer.getElement && layer.getElement();
        if (el) el.classList.remove("building-highlight");
      }
      highlighted = null;
    }
  }

  /** Reopens the route panel when the highlighted unit is clicked again after dismissing it. */
  function reopenEtaPopupFor(layer) {
    if (!highlighted || !highlighted.layers.includes(layer) || !lastEtaInfo) return;
    // Clicking the same active unit while panel is already shown should be a no-op.
    if (routePanel && routePanel.classList.contains("is-visible") && !routePanel.classList.contains("hidden")) return;
    renderRoutePanel(
      lastEtaInfo.latlng,
      lastEtaInfo.distanceMeters,
      lastEtaInfo.pathLatLngs,
      lastEtaInfo.pathNodeKeys,
    );
  }

  function highlightBuilding(entry) {
    const isSameAsCurrent =
      highlighted &&
      highlighted.props &&
      highlighted.props.block === entry.props.block &&
      highlighted.props.lot === entry.props.lot;

    // Repeated Find on the same unit should not restart route/panel animations.
    // If the panel was dismissed, reopen it using existing route details.
    if (isSameAsCurrent && activeDest && lastEtaInfo) {
      const panelVisible =
        routePanel &&
        routePanel.classList.contains("is-visible") &&
        !routePanel.classList.contains("hidden");
      if (panelVisible) return;
      renderRoutePanel(
        lastEtaInfo.latlng,
        lastEtaInfo.distanceMeters,
        lastEtaInfo.pathLatLngs,
        lastEtaInfo.pathNodeKeys,
      );
      return;
    }

    clearHighlight();
    clearRoute();
    entry.layer.setStyle({
      color: "#ff5a36",
      weight: 3,
      fillColor: "#ff5a36",
      fillOpacity: 0.7,
    });
    entry.layer.bringToFront();
    const el = entry.layer.getElement && entry.layer.getElement();
    if (el) el.classList.add("building-highlight");
    highlighted = { layers: [entry.layer], props: entry.props };

    const bounds = entry.layer.getBounds ? entry.layer.getBounds() : null;
    const destCenter = bounds ? bounds.getCenter() : null;
    activeDest = destCenter ? { destCenter, bounds } : null;
    clearAvoidance();
    updateRerouteButtonState();

    if (activeDest) {
      showRoute();
    } else if (bounds) {
      map.fitBounds(bounds, { maxZoom: 20, padding: [80, 80] });
    }
  }

  /** Highlights a whole city_block boundary (possibly split across several ways). No route is drawn. */
  function highlightCityBlock(entry) {
    endAvoidRoadPickMode();
    clearHighlight();
    clearRoute();
    activeDest = null;
    clearAvoidance();
    updateRerouteButtonState();

    let bounds = null;
    for (const layer of entry.layers) {
      layer.setStyle({
        color: "#ff5a36",
        weight: 3,
        opacity: 1,
        dashArray: null,
        fill: true,
        fillColor: "#ff5a36",
        fillOpacity: 0.12,
      });
      layer.bringToFront();
      const layerBounds = layer.getBounds ? layer.getBounds() : null;
      if (layerBounds) bounds = bounds ? bounds.extend(layerBounds) : layerBounds;
    }
    highlighted = { layers: entry.layers, props: entry.props };

    if (bounds) {
      map.fitBounds(bounds, { maxZoom: 19, padding: [40, 40] });
    }

    renderBlockPanel(entry);
  }

  return {
    map,
    blockSelect,
    lotSelect,
    buildingLayerById,
    cityBlockLayersByKey,
    loadData,
    highlightBuilding,
    highlightCityBlock,
    clearSelection,
    setLayerVisibility,
  };
}
