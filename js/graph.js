// Pure routing logic: building the drivable road graph and finding shortest paths.
// No DOM/Leaflet dependencies, so this module is easy to test/reuse in isolation.

export const WALK_HIGHWAYS = new Set([
  "footway",
  "path",
  "pedestrian",
  "steps",
  "cycleway",
]);

export function haversineMeters(a, b) {
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

function coordKey(coord) {
  return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
}

/** Undirected graph of drivable road segments (footways/paths excluded), keyed by rounded "lon,lat" coordinate, for routing. */
export function buildRoadGraph(features) {
  const graph = { nodes: new Map(), adj: new Map(), snapMeta: new Map() };

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
export function snapPointToGraph(graph, coord, allowedKeys) {
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
  const edgeKey =
    best.aKey < best.bKey
      ? `${best.aKey}|${best.bKey}`
      : `${best.bKey}|${best.aKey}`;
  graph.snapMeta?.set(snapKey, { edgeKey, aKey: best.aKey, bKey: best.bKey });
  graph.adj.set(snapKey, [
    { to: best.aKey, dist: distA },
    { to: best.bKey, dist: distB },
  ]);
  graph.adj.get(best.aKey).push({ to: snapKey, dist: distA });
  graph.adj.get(best.bKey).push({ to: snapKey, dist: distB });
  return snapKey;
}

/** Removes a node added by snapPointToGraph, restoring the graph to its original state. */
export function unsnapPoint(graph, snapKey) {
  if (!snapKey || !graph.adj.has(snapKey)) return;
  for (const { to } of graph.adj.get(snapKey)) {
    const neighborEdges = graph.adj.get(to);
    if (!neighborEdges) continue;
    const idx = neighborEdges.findIndex((e) => e.to === snapKey);
    if (idx !== -1) neighborEdges.splice(idx, 1);
  }
  graph.adj.delete(snapKey);
  graph.nodes.delete(snapKey);
  graph.snapMeta?.delete(snapKey);
}

/** Connects two snapped nodes directly when both come from the same source road segment. */
export function connectSnapNodesIfSameSegment(graph, aKey, bKey) {
  if (!graph?.nodes?.has(aKey) || !graph?.nodes?.has(bKey)) return false;
  const aMeta = graph.snapMeta?.get(aKey);
  const bMeta = graph.snapMeta?.get(bKey);
  if (!aMeta || !bMeta || aMeta.edgeKey !== bMeta.edgeKey) return false;

  const aCoord = graph.nodes.get(aKey);
  const bCoord = graph.nodes.get(bKey);
  const dist = haversineMeters(aCoord, bCoord);

  const aEdges = graph.adj.get(aKey) || [];
  const bEdges = graph.adj.get(bKey) || [];
  if (!aEdges.some((e) => e.to === bKey)) aEdges.push({ to: bKey, dist });
  if (!bEdges.some((e) => e.to === aKey)) bEdges.push({ to: aKey, dist });
  return true;
}

/** Returns the keys of the largest connected component, so routing never snaps to a small, disconnected cluster of road ways. */
export function largestComponentKeys(graph) {
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
export function findGateNodeKey(features, graph, mainComponentKeys) {
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
export function findRoute(graph, startKey, endKey) {
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
