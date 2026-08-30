// Owns the Leaflet map instance, all data layers, the road-network routing graph,
// the draggable gate marker, and unit/block highlight + ETA popup behavior.
import {
  buildRoadGraph,
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

const ETA_SPEEDS_KMH = { car: 20, bicycle: 15, walk: 5 };

export function createMapController() {
  const map = L.map("map", {
    zoomControl: false,
    attributionControl: false,
    minZoom: 15,
    maxZoom: 22,
  });

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
    zoomIn.innerHTML = "+";

    const center = L.DomUtil.create("a", "", container);
    center.href = "#";
    center.title = "Center map";
    center.setAttribute("role", "button");
    center.setAttribute("aria-label", "Center map");
    center.innerHTML = "⊙";

    const zoomOut = L.DomUtil.create("a", "", container);
    zoomOut.href = "#";
    zoomOut.title = "Zoom out";
    zoomOut.setAttribute("role", "button");
    zoomOut.setAttribute("aria-label", "Zoom out");
    zoomOut.innerHTML = "−";

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
  let panelHideTimer = null;

  routeDismissBtn?.addEventListener("click", () => hideRoutePanel());
  routeClearBtn?.addEventListener("click", () => clearSelection());
  map.on("zoomend", refreshRoadNameLabels);

  function loadData(url) {
    fetch(url)
      .then((res) => res.json())
      .then(renderData)
      .catch((err) => console.error("Failed to load map data", err));
  }

  function renderData(collection) {
    layers.leisureDots.clearLayers();
    layers.roadNames.clearLayers();
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
    refreshRoadNameLabels();
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

  function refreshRoadNameLabels() {
    layers.roadNames.clearLayers();
    if (!map.hasLayer(layers.roadNames) || roadNameCandidates.length === 0) return;

    const thresholdMeters = pixelsToMeters(mergePixelsForZoom(map.getZoom()));
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
        kept.push(point);
        layers.roadNames.addLayer(createRoadNameLabel(point, name));
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
      roadNames: layers.roadNames,
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

  function clearRoute() {
    if (routeAnimId) {
      cancelAnimationFrame(routeAnimId);
      routeAnimId = null;
    }
    layers.route.clearLayers();
    lastEtaInfo = null;
    hideRoutePanel();
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
    if (gateNodeKey) unsnapPoint(roadGraph, gateNodeKey);
    gateNodeKey = newKey;
    gateMoved = true;

    const [lon, lat] = roadGraph.nodes.get(gateNodeKey);
    gateMarker.setLatLng([lat, lon]);

    if (activeDest) showRoute();
  }

  /** Recomputes and (re)draws the route to the active destination, always using drivable roads. */
  function showRoute() {
    if (!activeDest) return;
    clearRoute();

    const { destCenter, bounds } = activeDest;
    let route = null;
    let destSnapKey = null;
    if (roadGraph && gateNodeKey && destCenter) {
      destSnapKey = snapPointToGraph(roadGraph, [destCenter.lng, destCenter.lat], mainRoadComponent);
      if (destSnapKey) route = findRoute(roadGraph, gateNodeKey, destSnapKey);
    }

    if (route) {
      const pathLatLngs = route.keys.map((k) => {
        const [lon, lat] = roadGraph.nodes.get(k);
        return L.latLng(lat, lon);
      });
      unsnapPoint(roadGraph, destSnapKey);
      const routeBounds = L.latLngBounds(pathLatLngs);
      if (bounds) routeBounds.extend(bounds);
      map.fitBounds(routeBounds, { maxZoom: 19, padding: [60, 60] });
      animateRoute(pathLatLngs, route.keys, route.distance, destCenter);
    } else {
      unsnapPoint(roadGraph, destSnapKey);
      if (bounds) map.fitBounds(bounds, { maxZoom: 20, padding: [80, 80] });
    }
  }

  /** Animates a marker along the route, then updates route details in the corner panel. */
  function animateRoute(pathLatLngs, pathNodeKeys, distanceMeters, destLatLng) {
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
        html: "🚗",
        iconSize: [22, 22],
      }),
      interactive: false,
    }).addTo(layers.route);

    const VISUAL_SPEED_MPS = 70; // fast-forwarded, purely for the animation
    const duration = Math.min(
      4000,
      Math.max(1200, (total / VISUAL_SPEED_MPS) * 1000),
    );
    const start = performance.now();
    renderRoutePanel(destLatLng, total, pathLatLngs, pathNodeKeys);

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
  function renderRoutePanel(latlng, distanceMeters, pathLatLngs, pathNodeKeys) {
    if (!routePanel || !routeUnitEl || !routeMetaEl || !routeEtaRowsEl || !routeNarrativeEl) return;

    lastEtaInfo = { latlng, distanceMeters, pathLatLngs, pathNodeKeys };
    const distanceKm = distanceMeters / 1000;

    const block = highlighted?.props?.block || "-";
    const lot = highlighted?.props?.lot || "-";
    routeUnitEl.textContent = `Block ${block}, Lot ${lot}`;
    routeMetaEl.textContent = `ETA from the ${gateMoved ? "start point" : "gate"} · ${distanceKm.toFixed(2)} km`;

    const rows = [
      ["🚗", "Car", ETA_SPEEDS_KMH.car],
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
    showRoutePanel();
  }

  function showRoutePanel() {
    if (!routePanel) return;
    if (panelHideTimer) {
      clearTimeout(panelHideTimer);
      panelHideTimer = null;
    }
    routePanel.classList.remove("hidden", "is-hiding", "is-visible");
    // Restart animation when panel updates for a new destination.
    void routePanel.offsetWidth;
    routePanel.classList.add("is-visible");
  }

  function hideRoutePanel() {
    if (!routePanel) return;
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
    const icon = type === "left" ? "←" : type === "right" ? "→" : "↑";
    return `<span class="route-turn-icon" aria-hidden="true">${icon}</span>`;
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
    clearHighlight();
    clearRoute();
    activeDest = null;
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

    if (activeDest) {
      showRoute();
    } else if (bounds) {
      map.fitBounds(bounds, { maxZoom: 20, padding: [80, 80] });
    }
  }

  /** Highlights a whole city_block boundary (possibly split across several ways). No route is drawn. */
  function highlightCityBlock(entry) {
    clearHighlight();
    clearRoute();
    activeDest = null;

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
      showBlockClearButton(bounds);
    }
  }

  /** Places a small × button at the top of the highlighted block boundary to clear the selection. */
  function showBlockClearButton(bounds) {
    const topCenter = L.latLng(bounds.getNorth(), bounds.getCenter().lng);
    L.marker(topCenter, {
      icon: L.divIcon({
        className: "block-clear-marker",
        html: '<div class="block-clear-handle">&times;</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
    })
      .addTo(layers.route)
      .on("click", () => clearSelection());
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
