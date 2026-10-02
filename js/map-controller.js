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
  WALK_HIGHWAYS,
} from "./graph.js";
import {
  contextRoadCasingStyle,
  contextRoadStyle,
  contextRoadCenterlineStyle,
  contextWaterCoreStyle,
  contextWaterEdgeStyle,
  groupForCategory,
  pointToLayer,
  roadCasingStyle,
  roadStyle,
  roadCenterlineStyle,
  roadVergeStyle,
  styleForFeature,
} from "./style.js";
import { escapeHtml, numericCompare } from "./utils.js";

const ETA_SPEEDS_KMH = { car: 20, motorcycle: 25, bicycle: 15, walk: 5 };
const MIN_REPOSITION_ROUTE_KM = 0.01;
const ROAD_TAP_MAX_SNAP_PX = 16;
const REROUTE_PICK_BANNER_TEXT = "Tap the road segment you want to avoid.";
const ROUTE_DEBUG_STORAGE_KEY = "ecoverde:route-debug";
const TREE_ROUTE_FADE_MAX_PX = 14;
const ADMIN_PIN_OVERLAP_PX = 26;
const WHEEL_ZOOM_COOLDOWN_MS = 170;
const FOREST_CLUMP_COUNT = 16;
const FOREST_CLUMP_MIN_TREES = 5;
const FOREST_CLUMP_MAX_TREES = 11;
const FOREST_HIGHWAY_CLEARANCE_METERS = 42;
const FOREST_RIVER_CLEARANCE_METERS = 32;
const TREE_MIN_PIXEL_SIZE = 8;
const TREE_NEIGHBOR_ROTATION_CLEARANCE_METERS = 14;
const TREE_ROTATION_VARIANTS = [
  { className: "tree-icon--rot-neg30", deg: -30 },
  { className: "tree-icon--rot-neg24", deg: -24 },
  { className: "tree-icon--rot-neg18", deg: -18 },
  { className: "tree-icon--rot-neg12", deg: -12 },
  { className: "tree-icon--rot-neg6", deg: -6 },
  { className: "tree-icon--rot-6", deg: 6 },
  { className: "tree-icon--rot-12", deg: 12 },
  { className: "tree-icon--rot-18", deg: 18 },
  { className: "tree-icon--rot-24", deg: 24 },
  { className: "tree-icon--rot-30", deg: 30 },
];
const TREE_ROTATION_CLASSES = TREE_ROTATION_VARIANTS.map((v) => v.className);
const TREE_ROTATION_DEG_BY_CLASS = Object.fromEntries(
  TREE_ROTATION_VARIANTS.map((v) => [v.className, v.deg]),
);

function blockageMarkerIconSvg() {
  return '<svg class="avoid-marker-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-4.5 9h9"/></svg>';
}

function parkingMarkerIconSvg() {
  return '<svg class="parking-pin-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h6l2 4m-8-4v8m0-8V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v9h2m8 0H9m4 0h2m4 0h2v-4m0 0h-5m3.5 5.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm-10 0a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z"/></svg>';
}

function parkingTooltipLabel(props = {}) {
  const details = [];
  if (props.capacity) details.push(`Capacity ${props.capacity}`);
  if (props.surface) details.push(`Surface ${props.surface}`);
  return details.length ? `Parking · ${details.join(" · ")}` : "Parking";
}

export function createMapController() {
  const bakedRenderer = L.canvas({ padding: 1.2 });
  const routeRenderer = L.svg({ padding: 1.2 });
  const map = L.map("map", {
    zoomControl: false,
    attributionControl: false,
    minZoom: 15,
    maxZoom: 22,
    preferCanvas: true,
    renderer: bakedRenderer,
    zoomAnimation: true,
    fadeAnimation: true,
    markerZoomAnimation: true,
    zoomSnap: 1,
    zoomDelta: 1,
    scrollWheelZoom: false,
  });
  let lastWheelZoomAt = 0;

  function installSingleStepWheelZoom() {
    const container = map.getContainer();
    container.addEventListener(
      "wheel",
      (evt) => {
        if (!evt || typeof evt.deltaY !== "number" || evt.deltaY === 0) return;
        evt.preventDefault();

        const now = performance.now();
        if (now - lastWheelZoomAt < WHEEL_ZOOM_COOLDOWN_MS) return;
        lastWheelZoomAt = now;

        const step = evt.deltaY < 0 ? 1 : -1;
        const nextZoom = Math.max(
          map.getMinZoom(),
          Math.min(map.getMaxZoom(), map.getZoom() + step),
        );
        if (nextZoom !== map.getZoom()) map.setZoom(nextZoom);
      },
      { passive: false },
    );
  }

  installSingleStepWheelZoom();
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
    forestTrees: L.layerGroup().addTo(map),
    context: L.layerGroup().addTo(map),
    landuse: L.layerGroup().addTo(map),
    leisure: L.layerGroup().addTo(map),
    leisureCourts: L.layerGroup().addTo(map),
    leisureDots: L.layerGroup().addTo(map),
    roadNames: L.layerGroup().addTo(map),
    cityBlocks: L.layerGroup().addTo(map),
    contextWaterEdge: L.layerGroup().addTo(map),
    contextWaterCore: L.layerGroup().addTo(map),
    footpathsCasing: L.layerGroup().addTo(map),
    footpaths: L.layerGroup().addTo(map),
    roadsVerge: L.layerGroup().addTo(map),
    roadsCasing: L.layerGroup().addTo(map),
    roads: L.layerGroup().addTo(map),
    roadsCenter: L.layerGroup().addTo(map),
    contextRoadsCasing: L.layerGroup().addTo(map),
    contextRoads: L.layerGroup().addTo(map),
    contextRoadsCenter: L.layerGroup().addTo(map),
    obstacle: L.layerGroup(),
    administrative: L.layerGroup().addTo(map),
    amenities: L.layerGroup().addTo(map),
    buildings: L.layerGroup().addTo(map),
    parking: L.layerGroup().addTo(map),
    parkingIcons: L.layerGroup().addTo(map),
    barriers: L.layerGroup().addTo(map),
    wallBarriers: L.layerGroup().addTo(map),
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
  let routeDebugEnabled = readRouteDebugEnabled();
  let activeRoutePathLatLngs = null;
  let administrativeSourceMarkers = [];
  let administrativeClusterMarkers = [];
  let amenitiesSourceMarkers = [];
  let amenitiesClusterMarkers = [];
  let treeScaleRafId = null;

  // Small console API for debugging route narrative decisions.
  if (typeof window !== "undefined") {
    window.ecoverdeRouteDebug = {
      get enabled() {
        return routeDebugEnabled;
      },
      set enabled(value) {
        routeDebugEnabled = setRouteDebugEnabled(Boolean(value));
      },
      toggle() {
        routeDebugEnabled = setRouteDebugEnabled(!routeDebugEnabled);
        return routeDebugEnabled;
      },
    };
  }

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
  map.on("zoomend", () => {
    refreshRoadNameLabels();
    applyRoadStrokeScale();
    applyTreeSizeScale();
    updateTreeRouteOcclusion(activeRoutePathLatLngs);
    updateAdministrativeClusters();
    updateAmenitiesClusters();
  });
  map.on("zoom", () => {
    scheduleTreeSizeScale();
  });

  function loadData(url) {
    fetch(url, { cache: "no-store" })
      .then((res) => res.json())
      .then(renderData)
      .catch((err) => console.error("Failed to load map data", err));
  }

  function renderData(collection) {
    layers.forestTrees.clearLayers();
    layers.leisureDots.clearLayers();
    layers.roadNames.clearLayers();
    layers.obstacle.clearLayers();
    layers.administrative.clearLayers();
    layers.amenities.clearLayers();
    layers.parking.clearLayers();
    layers.parkingIcons.clearLayers();
    layers.footpathsCasing.clearLayers();
    layers.footpaths.clearLayers();
    layers.barriers.clearLayers();
    layers.wallBarriers.clearLayers();
    administrativeSourceMarkers = [];
    administrativeClusterMarkers = [];
    amenitiesSourceMarkers = [];
    amenitiesClusterMarkers = [];
    roadNameByEdge = new Map();
    roadNameCandidates = [];
    const lotsByBlock = new Map(); // block -> Set(lot)

    const geoJsonLayer = L.geoJSON(collection, {
      style: styleForFeature,
      pointToLayer: pointToLayer,
      renderer: bakedRenderer,
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
          const isWalkHighway = WALK_HIGHWAYS.has(
            String(props.highway || "").toLowerCase(),
          );
          const roadStyleContext = {
            zoom: map.getZoom(),
            lat: layer.getBounds().getCenter().lat,
          };
          layer._roadRefLat = roadStyleContext.lat;
          const vergeStyle = roadVergeStyle(props, roadStyleContext);
          if (vergeStyle) {
            const vergeLayer = L.polyline(layer.getLatLngs(), {
              ...vergeStyle,
              renderer: bakedRenderer,
              noClip: true,
            });
            vergeLayer.feature = layer.feature;
            vergeLayer._roadRefLat = roadStyleContext.lat;
            layers.roadsVerge.addLayer(vergeLayer);
          }
          const casingStyle = roadCasingStyle(props, roadStyleContext);
          if (casingStyle) {
            const casingLayer = L.polyline(layer.getLatLngs(), {
              ...casingStyle,
              renderer: bakedRenderer,
              noClip: true,
            });
            casingLayer.feature = layer.feature;
            casingLayer._roadRefLat = roadStyleContext.lat;
            if (isWalkHighway) {
              layers.footpathsCasing.addLayer(casingLayer);
            } else {
              layers.roadsCasing.addLayer(casingLayer);
            }
          }
          const centerlineStyle = roadCenterlineStyle(props, roadStyleContext);
          if (centerlineStyle) {
            const centerLayer = L.polyline(layer.getLatLngs(), {
              ...centerlineStyle,
              renderer: bakedRenderer,
              noClip: true,
            });
            centerLayer.feature = layer.feature;
            centerLayer._roadRefLat = roadStyleContext.lat;
            layers.roadsCenter.addLayer(centerLayer);
          }
          if (props.name) {
            const candidate = createRoadNameCandidate(layer, props.name);
            if (candidate) roadNameCandidates.push(candidate);
          }
        }
        if (props.category === "context-road") {
          const styleContext = {
            zoom: map.getZoom(),
            lat: layer.getBounds().getCenter().lat,
          };
          layer._roadRefLat = styleContext.lat;

          layers.contextRoadsCasing.addLayer(
            Object.assign(
              L.polyline(layer.getLatLngs(), {
                ...contextRoadCasingStyle(props, styleContext),
                renderer: bakedRenderer,
                noClip: true,
              }),
              { feature: layer.feature, _roadRefLat: styleContext.lat },
            ),
          );
          const centerStyle = contextRoadCenterlineStyle(props, styleContext);
          if (centerStyle) {
            layers.contextRoadsCenter.addLayer(
              Object.assign(
                L.polyline(layer.getLatLngs(), {
                  ...centerStyle,
                  renderer: bakedRenderer,
                  noClip: true,
                }),
                { feature: layer.feature, _roadRefLat: styleContext.lat },
              ),
            );
          }
        }
        if (props.category === "context-water") {
          const styleContext = {
            zoom: map.getZoom(),
            lat: layer.getBounds().getCenter().lat,
          };

          layers.contextWaterEdge.addLayer(
            Object.assign(
              L.polyline(layer.getLatLngs(), {
                ...contextWaterEdgeStyle(props, styleContext),
                renderer: bakedRenderer,
                noClip: true,
              }),
              { feature: layer.feature, _roadRefLat: styleContext.lat },
            ),
          );
          layers.contextWaterCore.addLayer(
            Object.assign(
              L.polyline(layer.getLatLngs(), {
                ...contextWaterCoreStyle(props, styleContext),
                renderer: bakedRenderer,
                noClip: true,
              }),
              { feature: layer.feature, _roadRefLat: styleContext.lat },
            ),
          );
        }
      },
    });

    dataBounds = null; // computed below, excluding "context-*" features so they don't skew the default fit

    geoJsonLayer.eachLayer((layer) => {
      const category = layer.feature.properties.category;
      const props = layer.feature?.properties || {};

      if (category === "parking" && typeof layer.getBounds === "function") {
        const center = layer.getBounds().getCenter();
        const label = parkingTooltipLabel(props);
        const marker = L.marker(center, {
          icon: L.divIcon({
            className: "admin-pin parking-pin",
            html: `<span class="admin-pin-badge parking-pin-badge" title="${escapeHtml(label)}">${parkingMarkerIconSvg()}</span>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
          keyboard: false,
          zIndexOffset: 900,
        }).bindTooltip(label, {
          direction: "top",
          offset: [0, -20],
          opacity: 0.92,
        });
        amenitiesSourceMarkers.push(marker);
        layers.parkingIcons.addLayer(marker);
      }

      let group = layers[groupForCategory(category)] || layers.buildings;
      if (category === "barrier" && String(props.barrier || "") === "wall") {
        group = layers.wallBarriers;
      }
      if (
        category === "road" &&
        WALK_HIGHWAYS.has(String(props.highway || "").toLowerCase())
      ) {
        group = layers.footpaths;
      }
      if (
        category === "leisure" &&
        (props.sport === "basketball" || props.surface === "concrete")
      ) {
        // Draw hard courts above generic leisure fills so they remain visible.
        group = layers.leisureCourts;
      }
      group.addLayer(layer);
      if (category === "leisure") {
        if (props.leisure === "park" || props.leisure === "garden") {
          addParkCenterShade(layer);
        }
        if (
          !(props.sport === "basketball" || props.surface === "concrete") &&
          props.leisure !== "garden" &&
          props.leisure !== "park"
        ) {
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
    ensureScrapyardPattern();
    updateAdministrativeClusters();
    applyRoadStrokeScale();
    applyRoadLayerOrder();
    refreshRoadNameLabels();
    populatePeripheralForest(dataBounds, collection.features);
    applyTreeNeighborRotationDiversity();
    applyTreeSizeScale();
  }

  function bringGroupToFront(group) {
    if (!group || typeof group.eachLayer !== "function") return;
    group.eachLayer((layer) => layer?.bringToFront && layer.bringToFront());
  }

  function bringGroupToBack(group) {
    if (!group || typeof group.eachLayer !== "function") return;
    group.eachLayer((layer) => layer?.bringToBack && layer.bringToBack());
  }

  function applyRoadLayerOrder() {
    // Keep water under footpaths and both under regular roads.
    bringGroupToBack(layers.contextWaterCore);
    bringGroupToBack(layers.contextWaterEdge);
    bringGroupToFront(layers.footpathsCasing);
    bringGroupToFront(layers.footpaths);
    bringGroupToFront(layers.roadsVerge);
    bringGroupToFront(layers.roadsCasing);
    bringGroupToFront(layers.roads);
    bringGroupToFront(layers.roadsCenter);

    // Highways from context-road should sit above all other road layers.
    bringGroupToFront(layers.contextRoadsCasing);
    bringGroupToFront(layers.contextRoads);
    bringGroupToFront(layers.contextRoadsCenter);

    // Parking should remain visible over roads.
    bringGroupToFront(layers.parking);
    bringGroupToFront(layers.parkingIcons);
    bringGroupToFront(layers.leisureCourts);
    bringGroupToFront(layers.amenities);

    // Keep walls above other vector overlays. Fences remain in the normal barrier layer.
    bringGroupToFront(layers.wallBarriers);
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return () => {
      t += 0x6d2b79f5;
      let n = Math.imul(t ^ (t >>> 15), t | 1);
      n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
      return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seedFromBounds(bounds) {
    const c = bounds.getCenter();
    const a = Math.round((c.lat + 90) * 100000);
    const b = Math.round((c.lng + 180) * 100000);
    const span = Math.round(bounds.getNorth() * 1000 + bounds.getEast() * 1000);
    return (a * 31 + b * 17 + span * 13) >>> 0;
  }

  function randomAroundClump(center, latSpan, lngSpan, rnd) {
    const offsetLat = (rnd() + rnd() + rnd() - 1.5) * latSpan * 0.05;
    const offsetLng = (rnd() + rnd() + rnd() - 1.5) * lngSpan * 0.05;
    return L.latLng(center.lat + offsetLat, center.lng + offsetLng);
  }

  function collectVillageKeepoutPolygons(features) {
    const polygons = [];
    if (!Array.isArray(features)) return polygons;

    for (const feature of features) {
      const props = feature?.properties || {};
      const category = props.category;
      if (
        category !== "building" &&
        category !== "cityblock" &&
        category !== "landuse" &&
        category !== "leisure"
      ) {
        continue;
      }

      const geom = feature?.geometry;
      if (!geom) continue;

      if (geom.type === "Polygon" && Array.isArray(geom.coordinates?.[0])) {
        polygons.push(geom.coordinates[0].map(([lng, lat]) => [lat, lng]));
      } else if (
        geom.type === "MultiPolygon" &&
        Array.isArray(geom.coordinates)
      ) {
        for (const poly of geom.coordinates) {
          if (!Array.isArray(poly?.[0])) continue;
          polygons.push(poly[0].map(([lng, lat]) => [lat, lng]));
        }
      }
    }

    return polygons;
  }

  function collectHighwaySegments(features) {
    const segments = [];
    if (!Array.isArray(features)) return segments;

    const addLineSegments = (coords) => {
      if (!Array.isArray(coords) || coords.length < 2) return;
      for (let i = 0; i < coords.length - 1; i++) {
        const [lngA, latA] = coords[i];
        const [lngB, latB] = coords[i + 1];
        segments.push([L.latLng(latA, lngA), L.latLng(latB, lngB)]);
      }
    };

    for (const feature of features) {
      const props = feature?.properties || {};
      const category = props.category;
      const isHighway =
        category === "context-road" ||
        (category === "road" &&
          String(props.highway || "").toLowerCase() === "primary");
      if (!isHighway) continue;

      const geom = feature?.geometry;
      if (!geom) continue;
      if (geom.type === "LineString") {
        addLineSegments(geom.coordinates);
      } else if (
        geom.type === "MultiLineString" &&
        Array.isArray(geom.coordinates)
      ) {
        for (const line of geom.coordinates) addLineSegments(line);
      }
    }

    return segments;
  }

  function collectRiverSegments(features) {
    const segments = [];
    if (!Array.isArray(features)) return segments;

    const addLineSegments = (coords) => {
      if (!Array.isArray(coords) || coords.length < 2) return;
      for (let i = 0; i < coords.length - 1; i++) {
        const [lngA, latA] = coords[i];
        const [lngB, latB] = coords[i + 1];
        segments.push([L.latLng(latA, lngA), L.latLng(latB, lngB)]);
      }
    };

    for (const feature of features) {
      const props = feature?.properties || {};
      const category = props.category;
      const isRiverContext =
        category === "context-water" ||
        String(props.waterway || "").toLowerCase() === "river";
      if (!isRiverContext) continue;

      const geom = feature?.geometry;
      if (!geom) continue;
      if (geom.type === "LineString") {
        addLineSegments(geom.coordinates);
      } else if (
        geom.type === "MultiLineString" &&
        Array.isArray(geom.coordinates)
      ) {
        for (const line of geom.coordinates) addLineSegments(line);
      }
    }

    return segments;
  }

  function pointToSegmentDistanceMeters(point, a, b) {
    const refLatRad = (point.lat * Math.PI) / 180;
    const metersPerDegLat = 111320;
    const metersPerDegLng = Math.max(1, Math.cos(refLatRad) * 111320);

    const px = point.lng * metersPerDegLng;
    const py = point.lat * metersPerDegLat;
    const ax = a.lng * metersPerDegLng;
    const ay = a.lat * metersPerDegLat;
    const bx = b.lng * metersPerDegLng;
    const by = b.lat * metersPerDegLat;

    const abx = bx - ax;
    const aby = by - ay;
    const ab2 = abx * abx + aby * aby;
    if (ab2 === 0) return Math.hypot(px - ax, py - ay);

    const apx = px - ax;
    const apy = py - ay;
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    return Math.hypot(px - cx, py - cy);
  }

  // Creates non-interactive background forest around (but outside) the village.
  function populatePeripheralForest(bounds, features = []) {
    if (!bounds || !bounds.isValid()) return;

    const center = bounds.getCenter();
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lngSpan = bounds.getEast() - bounds.getWest();
    const rnd = mulberry32(seedFromBounds(bounds));
    const keepoutPolygons = collectVillageKeepoutPolygons(features);
    const highwaySegments = collectHighwaySegments(features);
    const riverSegments = collectRiverSegments(features);

    function insideVillageHalo(point) {
      const nx = (point.lng - center.lng) / Math.max(lngSpan * 0.58, 1e-9);
      const ny = (point.lat - center.lat) / Math.max(latSpan * 0.58, 1e-9);
      return nx * nx + ny * ny < 1;
    }

    function isInsideVillageGeometry(point) {
      const sample = [point.lat, point.lng];
      for (const polygon of keepoutPolygons) {
        if (polygon.length >= 3 && pointInPolygon(sample, polygon)) return true;
      }
      return false;
    }

    function isNearHighway(point) {
      for (const [a, b] of highwaySegments) {
        if (
          pointToSegmentDistanceMeters(point, a, b) <
          FOREST_HIGHWAY_CLEARANCE_METERS
        ) {
          return true;
        }
      }
      return false;
    }

    function isNearRiver(point) {
      for (const [a, b] of riverSegments) {
        if (
          pointToSegmentDistanceMeters(point, a, b) <
          FOREST_RIVER_CLEARANCE_METERS
        ) {
          return true;
        }
      }
      return false;
    }

    function addForestTree(point) {
      if (
        insideVillageHalo(point) ||
        isInsideVillageGeometry(point) ||
        isNearHighway(point) ||
        isNearRiver(point)
      ) {
        return;
      }
      const sizeMetersSet = [4.1, 5.1, 6.3];
      const sizeMeters =
        sizeMetersSet[Math.floor(rnd() * sizeMetersSet.length)];
      const size = treePixelSizeForMeters(sizeMeters, point.lat);
      const flipped = rnd() > 0.5;
      const assetClass = "tree-icon--asset2";
      const rotationClass =
        TREE_ROTATION_CLASSES[Math.floor(rnd() * TREE_ROTATION_CLASSES.length)];
      const marker = L.marker(point, {
        icon: buildTreeDivIcon(
          { assetClass, rotationClass, flipped, isBackground: true },
          size,
        ),
        interactive: false,
        keyboard: false,
        zIndexOffset: -700,
      });
      marker._treeVariant = {
        sizeMeters,
        assetClass,
        rotationClass,
        flipped,
        isBackground: true,
      };
      marker._treePixelSize = size;
      layers.forestTrees.addLayer(marker);
    }

    for (let i = 0; i < FOREST_CLUMP_COUNT; i++) {
      const angle = rnd() * Math.PI * 2;
      const radial = 1.08 + rnd() * 0.58;
      const wobble = 0.84 + rnd() * 0.32;
      const clumpCenter = L.latLng(
        center.lat + Math.sin(angle) * (latSpan * 0.5) * radial * wobble,
        center.lng + Math.cos(angle) * (lngSpan * 0.5) * radial * wobble,
      );

      const clumpTrees =
        FOREST_CLUMP_MIN_TREES +
        Math.floor(
          rnd() * (FOREST_CLUMP_MAX_TREES - FOREST_CLUMP_MIN_TREES + 1),
        );
      for (let t = 0; t < clumpTrees; t++) {
        addForestTree(randomAroundClump(clumpCenter, latSpan, lngSpan, rnd));
      }
    }

    // Add a sparse outer halo so clumps blend naturally into the background.
    const haloTrees = 72;
    for (let i = 0; i < haloTrees; i++) {
      const angle = rnd() * Math.PI * 2;
      const radial = 1.18 + rnd() * 0.72;
      const point = L.latLng(
        center.lat + Math.sin(angle) * (latSpan * 0.5) * radial,
        center.lng + Math.cos(angle) * (lngSpan * 0.5) * radial,
      );
      addForestTree(point);
    }
  }

  function ensureScrapyardPattern() {
    const svg = map.getPanes()?.overlayPane?.querySelector("svg");
    if (!svg) return;

    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      svg.insertBefore(defs, svg.firstChild || null);
    }

    if (defs.querySelector("#scrapyard-stripes-pattern")) return;

    const pattern = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "pattern",
    );
    pattern.setAttribute("id", "scrapyard-stripes-pattern");
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    pattern.setAttribute("width", "38");
    pattern.setAttribute("height", "38");
    pattern.setAttribute("patternTransform", "rotate(-25)");

    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", "0");
    bg.setAttribute("y", "0");
    bg.setAttribute("width", "38");
    bg.setAttribute("height", "38");
    bg.setAttribute("fill", "#b9d89a");

    const stripe = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect",
    );
    stripe.setAttribute("x", "0");
    stripe.setAttribute("y", "0");
    stripe.setAttribute("width", "16");
    stripe.setAttribute("height", "38");
    stripe.setAttribute("fill", "#a5cb74");

    pattern.appendChild(bg);
    pattern.appendChild(stripe);
    defs.appendChild(pattern);
  }

  function roadStyleContextForLayer(layer) {
    let lat = Number.isFinite(layer?._roadRefLat) ? layer._roadRefLat : null;
    if (!Number.isFinite(lat)) {
      if (typeof layer?.getBounds === "function") {
        const bounds = layer.getBounds();
        lat =
          bounds?.isValid && bounds.isValid() ? bounds.getCenter().lat : null;
      }
    }
    if (!Number.isFinite(lat) && typeof layer?.getLatLng === "function") {
      lat = layer.getLatLng()?.lat;
    }
    return { zoom: map.getZoom(), lat: Number.isFinite(lat) ? lat : 14.5 };
  }

  function treePixelSizeForMeters(sizeMeters, lat) {
    const latRad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
    const metersPerPixel =
      (156543.03392 * Math.cos(latRad)) / Math.pow(2, map.getZoom());
    return Math.max(
      TREE_MIN_PIXEL_SIZE,
      sizeMeters / Math.max(metersPerPixel, 1e-9),
    );
  }

  function scheduleTreeSizeScale() {
    if (treeScaleRafId !== null) return;
    treeScaleRafId = requestAnimationFrame(() => {
      treeScaleRafId = null;
      applyTreeSizeScale();
    });
  }

  function buildTreeDivIcon(variant, sizePx) {
    const glyphClasses = `${variant.assetClass} ${variant.rotationClass}${variant.flipped ? " tree-icon--flip" : ""}`;
    return L.divIcon({
      className: `tree-icon${variant.isBackground ? " tree-icon--bg" : ""}`,
      html: `<span class="tree-icon__glyph ${glyphClasses}"></span>`,
      iconSize: [sizePx, sizePx],
      iconAnchor: [Math.round(sizePx / 2), Math.round(sizePx * 0.9)],
    });
  }

  function rotationSeedIndex(latlng) {
    const a = Math.round((latlng.lat + 90) * 100000);
    const b = Math.round((latlng.lng + 180) * 100000);
    const seed = Math.abs((a * 31 + b * 17) ^ (a * 13));
    return seed % TREE_ROTATION_CLASSES.length;
  }

  function rotationDistanceScore(className, usedClasses) {
    const deg = TREE_ROTATION_DEG_BY_CLASS[className];
    if (!Number.isFinite(deg) || !usedClasses.length) return Infinity;
    let minDist = Infinity;
    for (const used of usedClasses) {
      const usedDeg = TREE_ROTATION_DEG_BY_CLASS[used];
      if (!Number.isFinite(usedDeg)) continue;
      const dist = Math.abs(deg - usedDeg);
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  }

  function applyTreeNeighborRotationDiversity() {
    const markers = [];
    const collect = (group) => {
      group.eachLayer((layer) => {
        if (!layer?._treeVariant || typeof layer.getLatLng !== "function")
          return;
        markers.push(layer);
      });
    };

    collect(layers.pois);
    collect(layers.forestTrees);
    if (!markers.length) return;

    // Stable order keeps layout consistent across re-renders.
    markers.sort((a, b) => {
      const pa = a.getLatLng();
      const pb = b.getLatLng();
      if (pa.lat !== pb.lat) return pa.lat - pb.lat;
      return pa.lng - pb.lng;
    });

    const placed = [];
    for (const marker of markers) {
      const here = marker.getLatLng();
      const usedByNeighbors = [];
      for (const prev of placed) {
        const there = prev.getLatLng();
        if (
          map.distance(here, there) <= TREE_NEIGHBOR_ROTATION_CLEARANCE_METERS
        ) {
          usedByNeighbors.push(prev._treeVariant.rotationClass);
        }
      }

      const start = rotationSeedIndex(here);
      let chosen = marker._treeVariant.rotationClass;
      let bestScore = rotationDistanceScore(chosen, usedByNeighbors);
      for (let i = 0; i < TREE_ROTATION_CLASSES.length; i++) {
        const candidate =
          TREE_ROTATION_CLASSES[(start + i) % TREE_ROTATION_CLASSES.length];
        const score = rotationDistanceScore(candidate, usedByNeighbors);
        if (score > bestScore) {
          chosen = candidate;
          bestScore = score;
        }
      }

      if (marker._treeVariant.rotationClass !== chosen) {
        marker._treeVariant.rotationClass = chosen;
        const sizePx =
          marker._treePixelSize ||
          treePixelSizeForMeters(marker._treeVariant.sizeMeters, here.lat);
        marker.setIcon(buildTreeDivIcon(marker._treeVariant, sizePx));
        marker._treePixelSize = sizePx;
      }

      placed.push(marker);
    }
  }

  function updateTreeMarkerElementSize(layer, sizePx) {
    const iconEl = layer && layer._icon;
    if (!iconEl) return false;

    iconEl.style.width = `${sizePx}px`;
    iconEl.style.height = `${sizePx}px`;
    iconEl.style.marginLeft = `${-Math.round(sizePx / 2)}px`;
    iconEl.style.marginTop = `${-Math.round(sizePx * 0.9)}px`;

    return true;
  }

  function applyTreeSizeScale() {
    const scaleLayer = (layerGroup) => {
      layerGroup.eachLayer((layer) => {
        const variant = layer?._treeVariant;
        if (
          !variant ||
          typeof layer.getLatLng !== "function" ||
          typeof layer.setIcon !== "function"
        )
          return;
        const lat = layer.getLatLng()?.lat;
        if (!Number.isFinite(lat)) return;
        const sizePx = treePixelSizeForMeters(variant.sizeMeters, lat);
        if (Math.abs((layer._treePixelSize ?? 0) - sizePx) < 0.12) return;

        // Update live DOM size first for smooth zoom animation; only rebuild icon when needed.
        const resizedInPlace = updateTreeMarkerElementSize(layer, sizePx);
        if (!resizedInPlace) {
          layer.setIcon(buildTreeDivIcon(variant, sizePx));
        }

        if (layer.options?.icon?.options) {
          layer.options.icon.options.iconSize = [sizePx, sizePx];
          layer.options.icon.options.iconAnchor = [
            Math.round(sizePx / 2),
            Math.round(sizePx * 0.9),
          ];
        }
        layer._treePixelSize = sizePx;
      });
    };

    scaleLayer(layers.pois);
    scaleLayer(layers.forestTrees);
  }

  function applyRoadStrokeScale() {
    layers.contextRoads.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (
        !props ||
        props.category !== "context-road" ||
        typeof layer.setStyle !== "function"
      )
        return;
      layer.setStyle(contextRoadStyle(props, roadStyleContextForLayer(layer)));
    });

    layers.contextRoadsCasing.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (
        !props ||
        props.category !== "context-road" ||
        typeof layer.setStyle !== "function"
      )
        return;
      layer.setStyle(
        contextRoadCasingStyle(props, roadStyleContextForLayer(layer)),
      );
    });

    layers.contextRoadsCenter.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (
        !props ||
        props.category !== "context-road" ||
        typeof layer.setStyle !== "function"
      )
        return;
      const centerStyle = contextRoadCenterlineStyle(
        props,
        roadStyleContextForLayer(layer),
      );
      if (centerStyle) layer.setStyle(centerStyle);
    });

    layers.contextWaterEdge.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (
        !props ||
        props.category !== "context-water" ||
        typeof layer.setStyle !== "function"
      )
        return;
      layer.setStyle(
        contextWaterEdgeStyle(props, roadStyleContextForLayer(layer)),
      );
    });

    layers.contextWaterCore.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (
        !props ||
        props.category !== "context-water" ||
        typeof layer.setStyle !== "function"
      )
        return;
      layer.setStyle(
        contextWaterCoreStyle(props, roadStyleContextForLayer(layer)),
      );
    });

    layers.footpathsCasing.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (
        !props ||
        props.category !== "road" ||
        typeof layer.setStyle !== "function"
      )
        return;
      layer.setStyle(roadCasingStyle(props, roadStyleContextForLayer(layer)));
    });

    layers.footpaths.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (
        !props ||
        props.category !== "road" ||
        typeof layer.setStyle !== "function"
      )
        return;
      layer.setStyle(roadStyle(props, roadStyleContextForLayer(layer)));
    });

    layers.roads.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (
        !props ||
        props.category !== "road" ||
        typeof layer.setStyle !== "function"
      )
        return;
      layer.setStyle(roadStyle(props, roadStyleContextForLayer(layer)));
    });

    layers.roadsVerge.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (!props || typeof layer.setStyle !== "function") return;
      layer.setStyle(roadVergeStyle(props, roadStyleContextForLayer(layer)));
    });

    layers.roadsCasing.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (!props || typeof layer.setStyle !== "function") return;
      layer.setStyle(roadCasingStyle(props, roadStyleContextForLayer(layer)));
    });

    layers.roadsCenter.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (!props || typeof layer.setStyle !== "function") return;
      const centerStyle = roadCenterlineStyle(
        props,
        roadStyleContextForLayer(layer),
      );
      if (centerStyle) layer.setStyle(centerStyle);
    });
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
    const common =
      'class="obstacle-pin-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"';
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
    const amenityPins = [];
    const modelUnitPins = [];
    const realEstatePins = [];
    const adminOfficePins = [];
    const gazeboPins = [];
    const amenityTypes = new Set(["basketball", "restroom", "pavilion"]);
    for (const feature of features) {
      const pin = pinMetaForFeature(feature);
      if (!pin) continue;
      if (amenityTypes.has(pin.type)) {
        amenityPins.push({ feature, pin });
        continue;
      }
      if (pin.type === "modelUnit") {
        modelUnitPins.push({ feature, pin });
        continue;
      }
      if (pin.type === "realEstate") {
        realEstatePins.push({ feature, pin });
        continue;
      }
      if (pin.type === "adminOffice") {
        adminOfficePins.push({ feature, pin });
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
      const marker = createAdministrativePin(latlng, pin);
      administrativeSourceMarkers.push(marker);
      layers.administrative.addLayer(marker);
    }

    for (const { feature, pin } of amenityPins) {
      const latlng = featureCenterLatLng(feature);
      if (!latlng) continue;
      const marker = createAdministrativePin(latlng, pin);
      amenitiesSourceMarkers.push(marker);
      layers.amenities.addLayer(marker);
    }

    for (const { feature, pin } of modelUnitPins) {
      const latlng = featureCenterLatLng(feature);
      if (!latlng) continue;
      const marker = createAdministrativePin(latlng, pin);
      administrativeSourceMarkers.push(marker);
      layers.administrative.addLayer(marker);
    }

    for (const { feature, pin } of realEstatePins) {
      const latlng = featureCenterLatLng(feature);
      if (!latlng) continue;
      const marker = createAdministrativePin(latlng, pin);
      administrativeSourceMarkers.push(marker);
      layers.administrative.addLayer(marker);
    }

    for (const { feature, pin } of adminOfficePins) {
      const latlng = featureCenterLatLng(feature);
      if (!latlng) continue;
      const marker = createAdministrativePin(latlng, pin);
      administrativeSourceMarkers.push(marker);
      layers.administrative.addLayer(marker);
    }

    for (const { feature, pin } of gazeboPins) {
      const latlng = featureCenterLatLng(feature);
      if (!latlng) continue;
      const marker = createAdministrativePin(latlng, pin);
      administrativeSourceMarkers.push(marker);
      layers.administrative.addLayer(marker);
    }
  }

  function setAdministrativeMarkerVisible(marker, visible) {
    marker.setOpacity(visible ? 1 : 0);
    const el = marker.getElement && marker.getElement();
    if (el) el.style.pointerEvents = visible ? "" : "none";
  }

  function clearAdministrativeClusterMarkers() {
    for (const marker of administrativeClusterMarkers) {
      layers.administrative.removeLayer(marker);
    }
    administrativeClusterMarkers = [];
  }

  function setAmenitiesMarkerVisible(marker, visible) {
    marker.setOpacity(visible ? 1 : 0);
    const el = marker.getElement && marker.getElement();
    if (el) el.style.pointerEvents = visible ? "" : "none";
  }

  function clearAmenitiesClusterMarkers() {
    for (const marker of amenitiesClusterMarkers) {
      layers.amenities.removeLayer(marker);
    }
    amenitiesClusterMarkers = [];
  }

  function createAmenitiesClusterMarker(latlng, count) {
    return L.marker(latlng, {
      icon: L.divIcon({
        className: "admin-pin admin-pin-cluster",
        html: `<span class="admin-pin-badge admin-pin-badge--cluster" title="${count} overlapping amenities">${count}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 28],
      }),
      interactive: false,
      keyboard: false,
    });
  }

  function updateAmenitiesClusters() {
    clearAmenitiesClusterMarkers();

    for (const marker of amenitiesSourceMarkers) {
      setAmenitiesMarkerVisible(marker, true);
    }

    if (
      (!map.hasLayer(layers.amenities) && !map.hasLayer(layers.parkingIcons)) ||
      amenitiesSourceMarkers.length < 2
    ) {
      return;
    }

    const points = amenitiesSourceMarkers.map((marker) =>
      map.latLngToContainerPoint(marker.getLatLng()),
    );
    const visited = new Array(amenitiesSourceMarkers.length).fill(false);

    for (let i = 0; i < amenitiesSourceMarkers.length; i++) {
      if (visited[i]) continue;
      const stack = [i];
      visited[i] = true;
      const groupIndexes = [];

      while (stack.length > 0) {
        const idx = stack.pop();
        groupIndexes.push(idx);

        for (let j = 0; j < amenitiesSourceMarkers.length; j++) {
          if (visited[j]) continue;
          if (points[idx].distanceTo(points[j]) <= ADMIN_PIN_OVERLAP_PX) {
            visited[j] = true;
            stack.push(j);
          }
        }
      }

      if (groupIndexes.length < 2) continue;

      let latSum = 0;
      let lngSum = 0;
      for (const idx of groupIndexes) {
        const marker = amenitiesSourceMarkers[idx];
        setAmenitiesMarkerVisible(marker, false);
        const ll = marker.getLatLng();
        latSum += ll.lat;
        lngSum += ll.lng;
      }

      const center = L.latLng(
        latSum / groupIndexes.length,
        lngSum / groupIndexes.length,
      );
      const clusterMarker = createAmenitiesClusterMarker(
        center,
        groupIndexes.length,
      );
      amenitiesClusterMarkers.push(clusterMarker);
      layers.amenities.addLayer(clusterMarker);
    }

    // Avoid cross-category icon overlap: if an amenities icon sits on top of a
    // currently visible administrative marker/cluster, hide the amenities icon.
    if (map.hasLayer(layers.administrative)) {
      const adminPoints = [];
      layers.administrative.eachLayer((layer) => {
        if (typeof layer?.getLatLng !== "function") return;
        if (typeof layer?.getOpacity === "function" && layer.getOpacity() <= 0.01)
          return;
        adminPoints.push(map.latLngToContainerPoint(layer.getLatLng()));
      });

      if (adminPoints.length > 0) {
        for (const marker of amenitiesSourceMarkers) {
          const point = map.latLngToContainerPoint(marker.getLatLng());
          const overlapsAdmin = adminPoints.some(
            (adminPoint) => point.distanceTo(adminPoint) <= ADMIN_PIN_OVERLAP_PX,
          );
          if (overlapsAdmin) setAmenitiesMarkerVisible(marker, false);
        }
      }
    }
  }

  function createAdministrativeClusterMarker(latlng, count) {
    return L.marker(latlng, {
      icon: L.divIcon({
        className: "admin-pin admin-pin-cluster",
        html: `<span class="admin-pin-badge admin-pin-badge--cluster" title="${count} overlapping administrative points">${count}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 28],
      }),
      interactive: false,
      keyboard: false,
    });
  }

  function updateAdministrativeClusters() {
    clearAdministrativeClusterMarkers();

    for (const marker of administrativeSourceMarkers) {
      setAdministrativeMarkerVisible(marker, true);
    }

    if (
      !map.hasLayer(layers.administrative) ||
      administrativeSourceMarkers.length < 2
    )
      return;

    const points = administrativeSourceMarkers.map((marker) =>
      map.latLngToContainerPoint(marker.getLatLng()),
    );
    const visited = new Array(administrativeSourceMarkers.length).fill(false);

    for (let i = 0; i < administrativeSourceMarkers.length; i++) {
      if (visited[i]) continue;
      const stack = [i];
      visited[i] = true;
      const groupIndexes = [];

      while (stack.length > 0) {
        const idx = stack.pop();
        groupIndexes.push(idx);

        for (let j = 0; j < administrativeSourceMarkers.length; j++) {
          if (visited[j]) continue;
          if (points[idx].distanceTo(points[j]) <= ADMIN_PIN_OVERLAP_PX) {
            visited[j] = true;
            stack.push(j);
          }
        }
      }

      if (groupIndexes.length < 2) continue;

      let latSum = 0;
      let lngSum = 0;
      for (const idx of groupIndexes) {
        const marker = administrativeSourceMarkers[idx];
        setAdministrativeMarkerVisible(marker, false);
        const ll = marker.getLatLng();
        latSum += ll.lat;
        lngSum += ll.lng;
      }

      const center = L.latLng(
        latSum / groupIndexes.length,
        lngSum / groupIndexes.length,
      );
      const clusterMarker = createAdministrativeClusterMarker(
        center,
        groupIndexes.length,
      );
      administrativeClusterMarkers.push(clusterMarker);
      layers.administrative.addLayer(clusterMarker);
    }
  }

  function pinMetaForFeature(feature) {
    const props = feature?.properties || {};
    const name = String(props.name || "");
    const office = String(props.office || "");
    const amenity = String(props.amenity || "");
    const lowerName = name.toLowerCase();
    const lowerOffice = office.toLowerCase();

    if (props.sport === "basketball" || props.leisure === "pitch") {
      return { type: "basketball", label: "Basketball Court", score: 1 };
    }
    if (props.man_made === "water_tower") {
      return { type: "waterTower", label: "Water Tower", score: 1 };
    }
    if (amenity === "toilets") {
      return { type: "restroom", label: "Restroom", score: 1 };
    }
    if (lowerOffice.includes("security") || lowerName.includes("guard")) {
      return { type: "guard", label: "Guard Shack", score: 2 };
    }
    if (
      lowerOffice.includes("estate_agent") ||
      lowerOffice.includes("estate") ||
      lowerName.includes("real estate") ||
      lowerName.includes("admin building")
    ) {
      const score = props.category === "poi-office" ? 3 : 2;
      return { type: "realEstate", label: "Real State Office", score };
    }
    if (
      (lowerOffice && lowerOffice !== "no" && lowerOffice !== "security") ||
      lowerName.includes("office") ||
      lowerName.includes("admin")
    ) {
      return {
        type: "adminOffice",
        label: name || "Admin Office",
        score: props.category === "poi-office" ? 3 : 2,
      };
    }
    if (lowerName.includes("model unit")) {
      return {
        type: "modelUnit",
        label: "Model Unit",
        score: 2,
      };
    }
    if (props.building === "gazebo") {
      return { type: "gazebo", label: "Waiting Shed", score: 2 };
    }
    if (props.building === "pavilion") {
      const score = name.toLowerCase().includes("club house") ? 3 : 1;
      return { type: "pavilion", label: "Club House", score };
    }
    return null;
  }

  function administrativeIconSvg(type) {
    const common =
      'class="admin-pin-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"';
    switch (type) {
      case "basketball":
        return `<svg ${common} fill="currentColor"><path fill-rule="evenodd" d="M12 2a10 10 0 1 0 10 10A10.009 10.009 0 0 0 12 2Zm6.613 4.614a8.523 8.523 0 0 1 1.93 5.32 20.093 20.093 0 0 0-5.949-.274c-.059-.149-.122-.292-.184-.441a23.879 23.879 0 0 0-.566-1.239 11.41 11.41 0 0 0 4.769-3.366ZM10 3.707a8.82 8.82 0 0 1 2-.238 8.5 8.5 0 0 1 5.664 2.152 9.608 9.608 0 0 1-4.476 3.087A45.755 45.755 0 0 0 10 3.707Zm-6.358 6.555a8.57 8.57 0 0 1 4.73-5.981 53.99 53.99 0 0 1 3.168 4.941 32.078 32.078 0 0 1-7.9 1.04h.002Zm2.01 7.46a8.51 8.51 0 0 1-2.2-5.707v-.262a31.641 31.641 0 0 0 8.777-1.219c.243.477.477.964.692 1.449-.114.032-.227.067-.336.1a13.569 13.569 0 0 0-6.942 5.636l.009.003ZM12 20.556a8.508 8.508 0 0 1-5.243-1.8 11.717 11.717 0 0 1 6.7-5.332.509.509 0 0 1 .055-.02 35.65 35.65 0 0 1 1.819 6.476 8.476 8.476 0 0 1-3.331.676Zm4.772-1.462A37.232 37.232 0 0 0 15.113 13a12.513 12.513 0 0 1 5.321.364 8.56 8.56 0 0 1-3.66 5.73h-.002Z" clip-rule="evenodd"/></svg>`;
      case "pavilion":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 20v-9l-4 1.125V20h4Zm0 0h8m-8 0V6.66667M16 20v-9l4 1.125V20h-4Zm0 0V6.66667M18 8l-6-4-6 4m5 1h2m-2 3h2"/></svg>`;
      case "waterTower":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 6v2s-3 1-3 3.25 1 2.25 1 3-1 1.125-1 2.25V19c0 .9375 1 2 2.5 2s2-.9375 2-.9375S13 21 14.5 21s2.5-1.0625 2.5-2v-2.5c0-1.125-1-1.5-1-2.25s1-.75 1-3S14 8 14 8V6m-3 0h-1V3h5v3h-1m-3 0h3m-5.95629 6h8.91259M8 17h9"/></svg>`;
      case "realEstate":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M3 21h18M4 18h16M6 10v8m4-8v8m4-8v8m4-8v8M4 9.5v-.955a1 1 0 0 1 .458-.84l7-4.52a1 1 0 0 1 1.084 0l7 4.52a1 1 0 0 1 .458.84V9.5a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5Z"/></svg>`;
      case "adminOffice":
        return `<svg ${common} fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21h18M5 21v-9.5A1.5 1.5 0 0 1 6.5 10H10V6.75A1.75 1.75 0 0 1 11.75 5h.5A1.75 1.75 0 0 1 14 6.75V10h3.5A1.5 1.5 0 0 1 19 11.5V21M10 21v-4h4v4M8 14h.01M16 14h.01"/></svg>`;
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

    const spacingMeters = 4.8;
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
    const maxDots = 2400;
    let rowIndex = 0;

    for (let lat = minLat + dLat * 0.5; lat <= maxLat; lat += dLat) {
      const rowOffset = rowIndex % 2 === 0 ? dLon * 0.5 : dLon;
      for (let lon = minLon + rowOffset; lon <= maxLon; lon += dLon) {
        if (count >= maxDots) break;
        if (!pointInPolygon([lat, lon], polygon)) continue;
        layers.leisureDots.addLayer(
          L.circleMarker([lat, lon], {
            radius: 1.1,
            color: "#a7c56a",
            weight: 0,
            fillColor: "#a7c56a",
            fillOpacity: 0.72,
            interactive: false,
          }),
        );
        count++;
      }
      rowIndex++;
      if (count >= maxDots) break;
    }
  }

  // Adds a subtle darker middle tone for park polygons, without texture dots.
  function addParkCenterShade(layer) {
    const ring = getOuterRingLatLngs(layer);
    if (!ring || ring.length < 3) return;

    const center = ring.reduce(
      (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
      { lat: 0, lng: 0 },
    );
    center.lat /= ring.length;
    center.lng /= ring.length;

    const innerRingOuter = smoothClosedRing(
      scaleRingTowardsCenter(ring, center, 0.74),
      2,
    );
    const innerRingCore = smoothClosedRing(
      scaleRingTowardsCenter(ring, center, 0.52),
      2,
    );

    layers.leisure.addLayer(
      L.polygon(innerRingOuter, {
        stroke: false,
        fillColor: "#80b24f",
        fillOpacity: 0.16,
        interactive: false,
        renderer: bakedRenderer,
      }),
    );

    layers.leisure.addLayer(
      L.polygon(innerRingCore, {
        stroke: false,
        fillColor: "#74a546",
        fillOpacity: 0.2,
        interactive: false,
        renderer: bakedRenderer,
      }),
    );
  }

  function scaleRingTowardsCenter(ring, center, scale) {
    return ring.map((p) =>
      L.latLng(
        center.lat + (p.lat - center.lat) * scale,
        center.lng + (p.lng - center.lng) * scale,
      ),
    );
  }

  // Chaikin corner-cutting for a softer rounded polygon silhouette.
  function smoothClosedRing(ring, iterations = 1) {
    let points = Array.isArray(ring) ? ring.slice() : [];
    if (points.length < 3) return points;

    for (let k = 0; k < iterations; k++) {
      const next = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        next.push(
          L.latLng(a.lat * 0.75 + b.lat * 0.25, a.lng * 0.75 + b.lng * 0.25),
        );
        next.push(
          L.latLng(a.lat * 0.25 + b.lat * 0.75, a.lng * 0.25 + b.lng * 0.75),
        );
      }
      points = next;
    }

    return points;
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
      const blockedByObstacle = obstacleBoxes.some((b) =>
        boxIntersects(box, b),
      );
      if (blockedByObstacle) continue;
      const blockedByLabel = usedLabelBoxes.some((b) => boxIntersects(box, b));
      if (blockedByLabel) continue;
      return { latlng: map.containerPointToLatLng(candidate), box };
    }

    return null;
  }

  function refreshRoadNameLabels() {
    layers.roadNames.clearLayers();
    if (!map.hasLayer(layers.roadNames) || roadNameCandidates.length === 0)
      return;

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
        const tooClose = kept.some(
          (k) => k.distanceTo(point) < thresholdMeters,
        );
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
    if (
      !roadName ||
      !feature.geometry ||
      feature.geometry.type !== "LineString"
    )
      return;
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
      amenities: layers.amenities,
      decoration: layers.pois,
    };
    const layerGroup = mapping[key];
    if (!layerGroup) return;

    if (key === "amenities") {
      const amenityGroups = [layers.amenities, layers.parkingIcons];
      if (visible) {
        for (const group of amenityGroups) {
          if (!map.hasLayer(group)) group.addTo(map);
        }
      } else {
        for (const group of amenityGroups) {
          if (map.hasLayer(group)) map.removeLayer(group);
        }
      }
      updateAmenitiesClusters();
      return;
    }

    if (key === "decoration") {
      if (visible) {
        if (!map.hasLayer(layers.pois)) layers.pois.addTo(map);
        if (!map.hasLayer(layers.forestTrees)) layers.forestTrees.addTo(map);
      } else {
        if (map.hasLayer(layers.pois)) map.removeLayer(layers.pois);
        if (map.hasLayer(layers.forestTrees))
          map.removeLayer(layers.forestTrees);
      }
      return;
    }

    if (visible) {
      if (!map.hasLayer(layerGroup)) layerGroup.addTo(map);
      if (key === "roadNames") refreshRoadNameLabels();
      if (key === "administrative") updateAdministrativeClusters();
    } else if (map.hasLayer(layerGroup)) {
      map.removeLayer(layerGroup);
      if (key === "administrative") updateAdministrativeClusters();
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
      const bounds = L.latLngBounds([
        gateMarker.getLatLng(),
        lastEtaInfo.latlng,
      ]);
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
    activeRoutePathLatLngs = null;
    updateTreeRouteOcclusion(null);
    lastEtaInfo = null;
    if (!preserveAvoidMarker) {
      clearAvoidance();
      avoidMarker = null;
    }
    if (!preservePanel) hideRoutePanel();
  }

  function showGateMarker() {
    if (!gateMarker || map.hasLayer(gateMarker)) return;
    gateMarker.addTo(layers.gate);
  }

  function hideGateMarker() {
    if (!gateMarker || !map.hasLayer(gateMarker)) return;
    layers.gate.removeLayer(gateMarker);
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
    });

    gateMarker.on("dragend", () => relocateGate(gateMarker.getLatLng()));
  }

  /** Re-snaps the gate to the nearest drivable road point and redraws the active route from there. */
  function relocateGate(latlng) {
    if (!roadGraph) return;
    const newKey = snapPointToGraph(
      roadGraph,
      [latlng.lng, latlng.lat],
      mainRoadComponent,
    );
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
    showGateMarker();
    clearRoute({ preservePanel: fromReroute, preserveAvoidMarker: true });

    if (fromReroute && avoidedEdgeKeys.size > 0 && avoidMarker) {
      avoidMarker.addTo(layers.route);
    }

    const { destCenter, bounds } = activeDest;
    let route = null;
    let destSnapKey = null;
    if (roadGraph && gateNodeKey && destCenter) {
      destSnapKey = snapPointToGraph(
        roadGraph,
        [destCenter.lng, destCenter.lat],
        mainRoadComponent,
      );
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
      activeRoutePathLatLngs = pathLatLngs;
      unsnapPoint(roadGraph, destSnapKey);
      const routeBounds = L.latLngBounds(pathLatLngs);
      if (bounds) routeBounds.extend(bounds);
      if (!fromReroute) {
        map.fitBounds(routeBounds, { maxZoom: 19, padding: [60, 60] });
      }
      animateRoute(pathLatLngs, route.keys, route.distance, destCenter, {
        animatePanel: !fromReroute,
      });
      updateTreeRouteOcclusion(pathLatLngs);
    } else {
      activeRoutePathLatLngs = null;
      updateTreeRouteOcclusion(null);
      if (fromReroute) {
        rerouteBlocked = true;
        hideRoutePanel();
      }
      unsnapPoint(roadGraph, destSnapKey);
      if (fromReroute && gateMarker && destCenter) {
        const blockedBounds = L.latLngBounds([
          gateMarker.getLatLng(),
          destCenter,
        ]);
        if (bounds) blockedBounds.extend(bounds);
        map.fitBounds(blockedBounds, { maxZoom: 19, padding: [60, 60] });
      } else if (bounds) {
        map.fitBounds(bounds, { maxZoom: 20, padding: [80, 80] });
      }
    }
    updateRerouteButtonState();
  }

  function updateTreeRouteOcclusion(pathLatLngs) {
    const segmentPoints = [];
    if (Array.isArray(pathLatLngs) && pathLatLngs.length > 1) {
      for (let i = 0; i < pathLatLngs.length - 1; i++) {
        segmentPoints.push([
          map.latLngToContainerPoint(pathLatLngs[i]),
          map.latLngToContainerPoint(pathLatLngs[i + 1]),
        ]);
      }
    }

    layers.pois.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (
        !props ||
        props.category !== "poi-tree" ||
        typeof layer.getLatLng !== "function"
      )
        return;
      const el = layer.getElement && layer.getElement();
      if (!el) return;

      let shouldFade = false;
      if (segmentPoints.length > 0) {
        const treePoint = map.latLngToContainerPoint(layer.getLatLng());
        for (const [a, b] of segmentPoints) {
          const distPx = L.LineUtil.pointToSegmentDistance(treePoint, a, b);
          if (distPx <= TREE_ROUTE_FADE_MAX_PX) {
            shouldFade = true;
            break;
          }
        }
      }

      el.classList.toggle("tree-icon--faded", shouldFade);
    });
  }

  /** Animates a marker along the route, then updates route details in the corner panel. */
  function animateRoute(
    pathLatLngs,
    pathNodeKeys,
    distanceMeters,
    destLatLng,
    options = {},
  ) {
    L.polyline(pathLatLngs, {
      renderer: routeRenderer,
      className: "route-casing",
      color: "#1a1a1a",
      weight: 8,
      opacity: 0.9,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(layers.route);

    L.polyline(pathLatLngs, {
      renderer: routeRenderer,
      className: "route-flow",
      color: "#e0a800",
      weight: 5,
      opacity: 1,
      dashArray: "14,12",
      lineCap: "round",
      lineJoin: "round",
    }).addTo(layers.route);

    // Route is redrawn dynamically; re-apply wall priority each time.
    bringGroupToFront(layers.wallBarriers);

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
  function renderRoutePanel(
    latlng,
    distanceMeters,
    pathLatLngs,
    pathNodeKeys,
    options = {},
  ) {
    if (
      !routePanel ||
      !routeUnitEl ||
      !routeMetaEl ||
      !routeEtaRowsEl ||
      !routeNarrativeEl
    )
      return;

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

    routeNarrativeEl.innerHTML = buildNarrative(
      pathLatLngs,
      pathNodeKeys,
      distanceMeters,
    );
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
    if (
      routePanel.classList.contains("hidden") ||
      routePanel.classList.contains("is-hiding")
    )
      return;
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
    const debugRows = [];

    const firstLeg = legs[0];
    const firstRoad =
      firstLeg && firstLeg.name ? ` on ${formatRoadName(firstLeg.name)}` : "";
    const firstDist = firstLeg
      ? Math.max(5, Math.round(firstLeg.distanceMeters))
      : Math.max(5, Math.round(pathLatLngs[0].distanceTo(pathLatLngs[1])));
    steps.push(
      `From ${startLabel}, head out${firstRoad} for ${firstDist} meters.`,
    );
    if (routeDebugEnabled) {
      debugRows.push({
        step: 0,
        kind: "start",
        from: "start",
        to: firstLeg?.name || "(unnamed)",
        boundary: "-",
        isIntersection: "-",
        turn: "-",
        announcedTurn: "-",
        roadNameChanges: "-",
        crossingsBeforeTurn: "-",
        crossingsWithinLeg: firstLeg
          ? countCrossingsForLeg(
              pathNodeKeys,
              firstLeg.startPointIndex,
              firstLeg.endPointIndex,
            )
          : 0,
        meters: firstDist,
        instruction: steps[steps.length - 1],
      });
    }

    for (let i = 1; i < legs.length; i++) {
      const leg = legs[i];
      const prevLeg = legs[i - 1];
      const boundary = leg.startPointIndex;
      const prev = pathLatLngs[boundary - 1];
      const curr = pathLatLngs[boundary];
      const next = pathLatLngs[boundary + 1];
      const turn = prev && curr && next ? describeTurn(prev, curr, next) : null;
      const boundaryIsIntersection = isRealIntersectionOnPath(
        pathNodeKeys,
        boundary,
      );
      const lastBoundaryBeforeDestination = i === legs.length - 1;
      const roadNameChanges = (prevLeg?.name || null) !== (leg.name || null);
      const notableTurn = isNotableTurn(turn);
      const shouldAnnounceTurn =
        Boolean(turn) &&
        (boundaryIsIntersection ||
          roadNameChanges ||
          (lastBoundaryBeforeDestination && notableTurn));
      const effectiveTurn = shouldAnnounceTurn ? turn : null;
      const roadRef = leg.name ? ` onto ${formatRoadName(leg.name)}` : "";
      const dist = Math.max(5, Math.round(leg.distanceMeters));
      const crossingCount = countCrossingsForLeg(
        pathNodeKeys,
        leg.startPointIndex,
        leg.endPointIndex,
      );
      const turnCrossingCount = prevLeg
        ? countCrossingsForLeg(
            pathNodeKeys,
            prevLeg.startPointIndex,
            prevLeg.endPointIndex,
          )
        : 0;

      if (effectiveTurn) {
        if (turnCrossingCount > 1) {
          steps.push(
            `Then after ${ordinalWord(turnCrossingCount)} intersection, turn ${effectiveTurn} ${formatTurnIcon(effectiveTurn.includes("left") ? "left" : "right")}${roadRef} and continue for ${dist} meters.`,
          );
        } else if (turnCrossingCount === 1) {
          steps.push(
            `Then at intersection, turn ${effectiveTurn} ${formatTurnIcon(effectiveTurn.includes("left") ? "left" : "right")}${roadRef} and continue for ${dist} meters.`,
          );
        } else {
          steps.push(
            `Then turn ${effectiveTurn} ${formatTurnIcon(effectiveTurn.includes("left") ? "left" : "right")}${roadRef} and continue for ${dist} meters.`,
          );
        }
      } else {
        const crossingText =
          crossingCount > 0
            ? ` after ${ordinalWord(crossingCount)} intersection`
            : "";
        if (!crossingText && !roadRef) {
          steps.push(`Then continue for ${dist} meters.`);
        } else if (roadRef && !crossingText) {
          steps.push(
            `Then continue on ${formatRoadName(leg.name)} for ${dist} meters.`,
          );
        } else {
          steps.push(
            `Then continue straight ${formatTurnIcon("straight")}${crossingText}${roadRef} for ${dist} meters.`,
          );
        }
      }

      if (routeDebugEnabled) {
        debugRows.push({
          step: i,
          kind: "leg",
          from: prevLeg?.name || "(unnamed)",
          to: leg.name || "(unnamed)",
          boundary,
          isIntersection: boundaryIsIntersection,
          turn: turn || "none",
          announcedTurn: effectiveTurn || "none",
          roadNameChanges,
          crossingsBeforeTurn: turnCrossingCount,
          crossingsWithinLeg: crossingCount,
          meters: dist,
          instruction: steps[steps.length - 1],
        });
      }
    }

    steps.push(
      `You will arrive after about ${Math.round(distanceMeters)} meters.`,
    );
    if (routeDebugEnabled) {
      logRouteNarrativeDebug({
        startLabel,
        gateMoved,
        totalMeters: Math.round(distanceMeters),
        legsCount: legs.length,
        pathPoints: pathLatLngs.length,
        rows: debugRows,
        finalInstruction: steps[steps.length - 1],
      });
    }
    return steps.join(" ");
  }

  function readRouteDebugEnabled() {
    let fromQuery = null;
    try {
      const params = new URLSearchParams(window.location.search || "");
      const raw = (params.get("routeDebug") || "").toLowerCase();
      if (["1", "true", "yes", "on"].includes(raw)) fromQuery = true;
      if (["0", "false", "no", "off"].includes(raw)) fromQuery = false;
    } catch {
      fromQuery = null;
    }

    if (fromQuery !== null) {
      setRouteDebugEnabled(fromQuery);
      return fromQuery;
    }

    try {
      return window.localStorage.getItem(ROUTE_DEBUG_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setRouteDebugEnabled(enabled) {
    const next = Boolean(enabled);
    try {
      if (next) {
        window.localStorage.setItem(ROUTE_DEBUG_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(ROUTE_DEBUG_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors in private mode or restricted contexts.
    }
    console.info(`[route-debug] ${next ? "enabled" : "disabled"}`);
    return next;
  }

  function logRouteNarrativeDebug(summary) {
    console.groupCollapsed(
      `[route-debug] ${summary.startLabel} -> destination · ${summary.totalMeters}m · ${summary.legsCount} leg(s)`,
    );
    console.log({
      gateMoved: summary.gateMoved,
      pathPoints: summary.pathPoints,
      totalMeters: summary.totalMeters,
      finalInstruction: summary.finalInstruction,
    });
    console.table(summary.rows || []);
    console.groupEnd();
  }

  function formatRoadName(name) {
    return `<span class="route-road-name">${escapeHtml(name)}</span>`;
  }

  function formatTurnIcon(type) {
    const rotation = type === "left" ? "-90" : type === "right" ? "90" : "0";
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
      const name = resolveSegmentRoadName(aKey, bKey);
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
      let isStraightContinuation = false;
      let boundaryIsIntersection = false;
      if (prev) {
        const boundary = seg.startPointIndex;
        boundaryIsIntersection = isRealIntersectionOnPath(
          pathNodeKeys,
          boundary,
        );
        const a = pathLatLngs[boundary - 1];
        const b = pathLatLngs[boundary];
        const c = pathLatLngs[boundary + 1];
        const turn = a && b && c ? describeTurn(a, b, c) : null;
        isStraightContinuation = !turn;
      }

      const hasSameNamedRoad =
        Boolean(prev?.name) && Boolean(seg.name) && prev.name === seg.name;
      const isNonIntersectionContinuation =
        Boolean(prev) && !boundaryIsIntersection;
      const isUnnamedStraightContinuation =
        Boolean(prev) &&
        !prev.name &&
        !seg.name &&
        (isStraightContinuation || isNonIntersectionContinuation);
      const isNamedStraightContinuation =
        Boolean(prev) &&
        hasSameNamedRoad &&
        (isStraightContinuation || isNonIntersectionContinuation);
      const isUnnamedNamedStraightContinuation =
        Boolean(prev) &&
        isNonIntersectionContinuation &&
        isStraightContinuation &&
        ((Boolean(prev.name) && !seg.name) ||
          (!prev.name && Boolean(seg.name)));

      if (
        prev &&
        (isNamedStraightContinuation ||
          isUnnamedStraightContinuation ||
          isUnnamedNamedStraightContinuation)
      ) {
        // Preserve whichever segment carries a road name when one side is unnamed.
        if (!prev.name && seg.name) prev.name = seg.name;
        prev.distanceMeters += seg.distanceMeters;
        prev.endPointIndex = seg.endPointIndex;
      } else {
        legs.push({ ...seg });
      }
    }

    // The destination is snapped onto the nearest road segment, which can leave a tiny
    // unnamed tail leg (e.g., 5-10m) that reads as a redundant extra "continue straight".
    // Fold that tail into the previous leg when no real intersection separates them.
    if (legs.length >= 2) {
      const last = legs[legs.length - 1];
      const prev = legs[legs.length - 2];
      const boundary = last.startPointIndex;
      const hasDecisionBoundary = isRealIntersectionOnPath(
        pathNodeKeys,
        boundary,
      );
      const a = pathLatLngs[boundary - 1];
      const b = pathLatLngs[boundary];
      const c = pathLatLngs[boundary + 1];
      const boundaryTurn = a && b && c ? describeTurn(a, b, c) : null;
      const hasNotableBoundaryTurn = isNotableTurn(boundaryTurn);
      const isShortUnnamedTail = !last.name && last.distanceMeters <= 20;
      if (
        isShortUnnamedTail &&
        !hasDecisionBoundary &&
        !hasNotableBoundaryTurn
      ) {
        prev.distanceMeters += last.distanceMeters;
        prev.endPointIndex = last.endPointIndex;
        legs.pop();
      }
    }

    return legs;
  }

  function resolveSegmentRoadName(aKey, bKey) {
    const direct = roadNameByEdge.get(edgeNameKey(aKey, bKey));
    if (direct) return direct;

    const aMeta = roadGraph?.snapMeta?.get(aKey);
    const bMeta = roadGraph?.snapMeta?.get(bKey);

    if (aMeta && (bKey === aMeta.aKey || bKey === aMeta.bKey)) {
      return roadNameByEdge.get(aMeta.edgeKey) || null;
    }
    if (bMeta && (aKey === bMeta.aKey || aKey === bMeta.bKey)) {
      return roadNameByEdge.get(bMeta.edgeKey) || null;
    }
    if (aMeta && bMeta && aMeta.edgeKey === bMeta.edgeKey) {
      return roadNameByEdge.get(aMeta.edgeKey) || null;
    }

    return null;
  }

  function countCrossingsForLeg(pathNodeKeys, startPointIndex, endPointIndex) {
    if (!Array.isArray(pathNodeKeys) || !roadGraph || !roadGraph.adj) return 0;
    let count = 0;
    for (let i = startPointIndex + 1; i < endPointIndex; i++) {
      if (isRealIntersectionOnPath(pathNodeKeys, i)) count++;
    }
    return count;
  }

  function bearingBetweenCoords(a, b) {
    const lat1 = (a[1] * Math.PI) / 180;
    const lat2 = (b[1] * Math.PI) / 180;
    const dLon = ((b[0] - a[0]) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const brng = (Math.atan2(y, x) * 180) / Math.PI;
    return (brng + 360) % 360;
  }

  function bearingDeltaDegrees(from, to) {
    let delta = to - from;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return delta;
  }

  /**
   * Counts only real decision intersections for narrative text.
   * Lane merges/splits near the gate are ignored by requiring an off-route branch
   * with meaningful length and angular separation from the current travel direction.
   */
  function isRealIntersectionOnPath(pathNodeKeys, nodeIndex) {
    if (!Array.isArray(pathNodeKeys) || !roadGraph?.adj || !roadGraph?.nodes) {
      return false;
    }
    const nodeKey = pathNodeKeys[nodeIndex];
    const prevKey = pathNodeKeys[nodeIndex - 1];
    const nextKey = pathNodeKeys[nodeIndex + 1];
    if (!nodeKey || !prevKey || !nextKey) return false;

    const edges = roadGraph.adj.get(nodeKey) || [];
    if (edges.length < 3) return false;

    const nodeCoord = roadGraph.nodes.get(nodeKey);
    const nextCoord = roadGraph.nodes.get(nextKey);
    if (!nodeCoord || !nextCoord) return false;
    const forwardBearing = bearingBetweenCoords(nodeCoord, nextCoord);

    for (const edge of edges) {
      if (edge.to === prevKey || edge.to === nextKey) continue;
      // Tiny connector stubs are usually split/merge geometry, not a navigation decision.
      if ((edge.dist || 0) < 7) continue;
      const branchCoord = roadGraph.nodes.get(edge.to);
      if (!branchCoord) continue;
      const branchBearing = bearingBetweenCoords(nodeCoord, branchCoord);
      const delta = Math.abs(
        bearingDeltaDegrees(forwardBearing, branchBearing),
      );
      // A meaningful side branch indicates a real intersection/junction.
      if (delta >= 35 && delta <= 150) return true;
    }

    return false;
  }

  function ordinalWord(n) {
    const words = [
      "zero",
      "first",
      "second",
      "third",
      "fourth",
      "fifth",
      "sixth",
    ];
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

  function isNotableTurn(turn) {
    return turn === "left" || turn === "right";
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
    hideGateMarker();
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
    if (!highlighted || !highlighted.layers.includes(layer) || !lastEtaInfo)
      return;
    // Clicking the same active unit while panel is already shown should be a no-op.
    if (
      routePanel &&
      routePanel.classList.contains("is-visible") &&
      !routePanel.classList.contains("hidden")
    )
      return;
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
    hideGateMarker();
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
      if (layerBounds)
        bounds = bounds ? bounds.extend(layerBounds) : layerBounds;
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
