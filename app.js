(function () {
  "use strict";

  const map = L.map("map", {
    zoomControl: true,
    attributionControl: false,
    minZoom: 15,
    maxZoom: 22,
  });

  const layers = {
    landuse: L.layerGroup().addTo(map),
    leisure: L.layerGroup().addTo(map),
    cityBlocks: L.layerGroup().addTo(map),
    roadsCasing: L.layerGroup().addTo(map),
    roads: L.layerGroup().addTo(map),
    buildings: L.layerGroup().addTo(map),
    barriers: L.layerGroup().addTo(map),
    pois: L.layerGroup().addTo(map),
    route: L.layerGroup().addTo(map),
    gate: L.layerGroup().addTo(map),
  };

  const buildingLayerById = new Map(); // "block|lot" (lowercased) -> { layer, props }
  const cityBlockLayersByKey = new Map(); // block key (e.g. "18", "14A") -> { layers: [...], props }
  let highlighted = null;
  let dataBounds = null;

  // road-network graph used to animate a route from the subdivision gate to a house
  const ETA_SPEEDS_KMH = { car: 20, bicycle: 15, walk: 5 };
  let roadGraph = null; // drivable roads only, footways/paths excluded
  let mainRoadComponent = null;
  let gateNodeKey = null;
  let gateMarker = null; // draggable marker letting the user relocate the route's starting point
  let gateMoved = false; // true once the user drags the gate marker away from its default position
  let routeAnimId = null;
  let activeDest = null; // { destCenter, bounds } for the currently highlighted building

  const searchForm = document.getElementById("search-form");
  const blockSelect = document.getElementById("block-select");
  const lotSelect = document.getElementById("lot-select");
  const layersToggle = document.getElementById("layers-toggle");
  const layersPanel = document.getElementById("layers-panel");
  const layerObstacle = document.getElementById("layer-obstacle");
  const layerLeisure = document.getElementById("layer-leisure");
  const layerAdministrative = document.getElementById("layer-administrative");

  layersToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const expanded = layersPanel.classList.toggle("hidden") === false;
    layersToggle.setAttribute("aria-expanded", String(expanded));
  });

  document.addEventListener("click", (e) => {
    if (!layersPanel.classList.contains("hidden") && !layersPanel.contains(e.target)) {
      layersPanel.classList.add("hidden");
      layersToggle.setAttribute("aria-expanded", "false");
    }
  });

  // None of these are wired to existing layers yet — Obstacle/Leisure/Administrative
  // refer to data that hasn't been fetched, not the current barriers/leisure layers.
  layerObstacle.addEventListener("change", () => {});
  layerLeisure.addEventListener("change", () => {});
  layerAdministrative.addEventListener("change", () => {});

  fetch("data/ecoverde.geojson")
    .then((res) => res.json())
    .then(renderData)
    .catch((err) => console.error("Failed to load map data", err));

  function renderData(collection) {
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
        }
        if (props.category === "cityblock" && props.block) {
          if (!cityBlockLayersByKey.has(props.block))
            cityBlockLayersByKey.set(props.block, { layers: [], props });
          cityBlockLayersByKey.get(props.block).layers.push(layer);
        }
        if (props.category === "road") {
          const casingStyle = roadCasingStyle(props);
          if (casingStyle) {
            layers.roadsCasing.addLayer(
              L.polyline(layer.getLatLngs(), casingStyle),
            );
          }
        }
      },
    });

    dataBounds = geoJsonLayer.getBounds();

    geoJsonLayer.eachLayer((layer) => {
      const group =
        layers[groupForCategory(layer.feature.properties.category)] ||
        layers.buildings;
      group.addLayer(layer);
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
    updateMinZoom();
    window.addEventListener("resize", updateMinZoom);
  }

  /** Locks zooming out past the point where the whole subdivision already fits on screen. */
  function updateMinZoom() {
    if (!dataBounds) return;
    const fitZoom = map.getBoundsZoom(dataBounds, false, [20, 20]);
    map.setMinZoom(fitZoom);
    if (map.getZoom() < fitZoom) map.setZoom(fitZoom);
  }

  /** Undirected graph of drivable road segments (footways/paths excluded), keyed by rounded "lon,lat" coordinate, for routing. */
  function buildRoadGraph(features) {
    const graph = { nodes: new Map(), adj: new Map() };

    function ensureNode(coord) {
      const key = coordKey(coord);
      if (!graph.nodes.has(key)) {
        graph.nodes.set(key, coord);
        graph.adj.set(key, []);
      }
      return key;
    }

    for (const f of features) {
      if (f.properties.category !== "road" || f.geometry.type !== "LineString")
        continue;
      if (WALK_HIGHWAYS.has(f.properties.highway)) continue;
      const coords = f.geometry.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const a = ensureNode(coords[i]);
        const b = ensureNode(coords[i + 1]);
        const dist = haversineMeters(coords[i], coords[i + 1]);
        graph.adj.get(a).push({ to: b, dist });
        graph.adj.get(b).push({ to: a, dist });
      }
    }

    return graph;
  }

  function coordKey(coord) {
    return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
  }

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** Projects coord onto segment a-b (planar approximation, fine at this scale) and returns the closest point plus its distance. */
  function closestPointOnSegment(coord, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((coord[0] - a[0]) * dx + (coord[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const point = [a[0] + t * dx, a[1] + t * dy];
    return { point, dist: haversineMeters(coord, point) };
  }

  /**
   * Snaps coord onto the nearest point along any road edge (not just an existing vertex), so a
   * house doesn't get routed to a far-off intersection just because the fronting road segment
   * has no vertex near it. Mutates graph with a temporary node; call unsnapPoint to remove it.
   */
  function snapPointToGraph(graph, coord, allowedKeys) {
    let best = null;
    for (const [key, edges] of graph.adj) {
      if (allowedKeys && !allowedKeys.has(key)) continue;
      const a = graph.nodes.get(key);
      for (const edge of edges) {
        if (allowedKeys && !allowedKeys.has(edge.to)) continue;
        const b = graph.nodes.get(edge.to);
        const { point, dist } = closestPointOnSegment(coord, a, b);
        if (!best || dist < best.dist) {
          best = { aKey: key, bKey: edge.to, point, dist };
        }
      }
    }
    if (!best) return null;

    const snapKey = `snap:${Math.random().toString(36).slice(2)}`;
    const distA = haversineMeters(best.point, graph.nodes.get(best.aKey));
    const distB = haversineMeters(best.point, graph.nodes.get(best.bKey));
    graph.nodes.set(snapKey, best.point);
    graph.adj.set(snapKey, [
      { to: best.aKey, dist: distA },
      { to: best.bKey, dist: distB },
    ]);
    graph.adj.get(best.aKey).push({ to: snapKey, dist: distA });
    graph.adj.get(best.bKey).push({ to: snapKey, dist: distB });
    return snapKey;
  }

  /** Removes a node added by snapPointToGraph, restoring the graph to its original state. */
  function unsnapPoint(graph, snapKey) {
    if (!snapKey || !graph.adj.has(snapKey)) return;
    for (const { to } of graph.adj.get(snapKey)) {
      const neighborEdges = graph.adj.get(to);
      if (!neighborEdges) continue;
      const idx = neighborEdges.findIndex((e) => e.to === snapKey);
      if (idx !== -1) neighborEdges.splice(idx, 1);
    }
    graph.adj.delete(snapKey);
    graph.nodes.delete(snapKey);
  }

  /** Returns the keys of the largest connected component, so routing never snaps to a small, disconnected cluster of road ways. */
  function largestComponentKeys(graph) {
    const visited = new Set();
    let best = new Set();
    for (const start of graph.nodes.keys()) {
      if (visited.has(start)) continue;
      const comp = new Set([start]);
      const stack = [start];
      visited.add(start);
      while (stack.length) {
        const cur = stack.pop();
        for (const edge of graph.adj.get(cur) || []) {
          if (!visited.has(edge.to)) {
            visited.add(edge.to);
            comp.add(edge.to);
            stack.push(edge.to);
          }
        }
      }
      if (comp.size > best.size) best = comp;
    }
    return best;
  }

  /** Uses the subdivision's mapped entrance park as the "gate", snapped onto the nearest point along a routable road. */
  function findGateNodeKey(features, graph, mainComponentKeys) {
    const gateFeature = features.find(
      (f) =>
        f.properties.category === "leisure" &&
        f.properties.name === "Ecoverde Homes Entrance Park",
    );
    if (!gateFeature) return null;
    const ring =
      gateFeature.geometry.type === "Polygon"
        ? gateFeature.geometry.coordinates[0]
        : gateFeature.geometry.coordinates;
    const centroid = ring
      .reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1]], [0, 0])
      .map((v) => v / ring.length);
    // permanent snap: the gate is reused for every route, so it's never unsnapped
    return snapPointToGraph(graph, centroid, mainComponentKeys);
  }

  /** Dijkstra's shortest path; returns { keys, distance } in meters, or null if unreachable. */
  function findRoute(graph, startKey, endKey) {
    if (
      !startKey ||
      !endKey ||
      !graph.nodes.has(startKey) ||
      !graph.nodes.has(endKey)
    )
      return null;

    const dist = new Map();
    const prev = new Map();
    const visited = new Set();
    for (const key of graph.nodes.keys()) dist.set(key, Infinity);
    dist.set(startKey, 0);

    while (true) {
      let u = null;
      let best = Infinity;
      for (const [key, d] of dist) {
        if (!visited.has(key) && d < best) {
          best = d;
          u = key;
        }
      }
      if (u === null || u === endKey) break;
      visited.add(u);
      for (const edge of graph.adj.get(u) || []) {
        if (visited.has(edge.to)) continue;
        const nd = best + edge.dist;
        if (nd < dist.get(edge.to)) {
          dist.set(edge.to, nd);
          prev.set(edge.to, u);
        }
      }
    }

    if (dist.get(endKey) === Infinity || dist.get(endKey) === undefined)
      return null;

    const keys = [endKey];
    let cur = endKey;
    while (cur !== startKey) {
      cur = prev.get(cur);
      if (!cur) return null;
      keys.push(cur);
    }
    keys.reverse();
    return { keys, distance: dist.get(endKey) };
  }

  function clearRoute() {
    if (routeAnimId) {
      cancelAnimationFrame(routeAnimId);
      routeAnimId = null;
    }
    layers.route.clearLayers();
    map.closePopup();
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
      animateRoute(pathLatLngs, route.distance, destCenter);
    } else {
      unsnapPoint(roadGraph, destSnapKey);
      if (bounds) map.fitBounds(bounds, { maxZoom: 20, padding: [80, 80] });
    }
  }

  /** Animates a marker along the route, then opens an ETA popup at the house. */
  function animateRoute(pathLatLngs, distanceMeters, destLatLng) {
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
    showEtaPopup(destLatLng, total);

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

  /** Renders the ETA popup with estimated Car/Bicycle/Walk times for the drawn route. */
  function showEtaPopup(latlng, distanceMeters) {
    const distanceKm = distanceMeters / 1000;
    const rows = [
      ["🚗", "Car", ETA_SPEEDS_KMH.car],
      ["🚲", "Bicycle", ETA_SPEEDS_KMH.bicycle],
      ["🚶", "Walk", ETA_SPEEDS_KMH.walk],
    ]
      .map(([icon, label, speed]) => {
        const minutes = (distanceKm / speed) * 60;
        const text = minutes < 1 ? "< 1 min" : `${Math.round(minutes)} min`;
        return `<div class="eta-row"><span>${icon} ${label}</span><strong>${text}</strong></div>`;
      })
      .join("");

    L.popup({
      className: "eta-popup",
      closeButton: true,
      offset: [0, -28],
    })
      .setLatLng(latlng)
      .setContent(
        `<div class="eta-title">ETA from the ${gateMoved ? "start point" : "gate"} &middot; ${distanceKm.toFixed(2)} km</div>${rows}`,
      )
      .openOn(map);
  }

  function numericCompare(a, b) {
    return parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);
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

  function groupForCategory(category) {
    if (category === "road") return "roads";
    if (category === "landuse") return "landuse";
    if (category === "leisure") return "leisure";
    if (category === "cityblock") return "cityBlocks";
    if (category === "building") return "buildings";
    if (category === "barrier") return "barriers";
    if (category && category.startsWith("poi")) return "pois";
    return "buildings";
  }

  /** A wider, solid underlay drawn before the road fill so intersections join cleanly (no blurred CSS filters). */
  function roadCasingStyle(props) {
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

  function styleForFeature(feature) {
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
      default:
        return {
          color: "#c3b49c",
          weight: 1,
          fillColor: "#d9cdbb",
          fillOpacity: 0.7,
        };
    }
  }

  const WALK_HIGHWAYS = new Set([
    "footway",
    "path",
    "pedestrian",
    "steps",
    "cycleway",
  ]);

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

  function roadWeight(props) {
    const lanes = parseInt(props.lanes, 10);
    return Number.isFinite(lanes) ? Math.min(3 + lanes * 1.5, 10) : 7;
  }

  function pointToLayer(feature, latlng) {
    const colors = {
      "poi-shop": "#c9622a",
      "poi-amenity": "#2f7d4f",
      "poi-office": "#3a5fcd",
      "poi-leisure": "#2f7d4f",
    };
    const color = colors[feature.properties.category] || "#555";
    return L.circleMarker(latlng, {
      radius: 6,
      color: "#fff",
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1,
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

  function highlightBuilding(entry) {
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

    if (bounds) map.fitBounds(bounds, { maxZoom: 19, padding: [40, 40] });
  }

  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const block = blockSelect.value;
    const lot = lotSelect.value;
    if (!block) return;

    if (!lot) {
      const blockEntry = cityBlockLayersByKey.get(block);
      if (blockEntry) {
        highlightCityBlock(blockEntry);
      } else {
        console.warn(`No block boundary matching Block ${block}.`);
      }
      return;
    }

    const entry = buildingLayerById.get(`${block}|${lot}`.toLowerCase());

    if (entry) {
      highlightBuilding(entry);
    } else {
      console.warn(`No unit matching Block ${block}, Lot ${lot}.`);
    }
  });

  function escapeHtml(str) {
    return String(str).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
})();
