// Converts raw Overpass JSON (data/ecoverde-raw.json) into a clean GeoJSON
// FeatureCollection consumed by the frontend (data/ecoverde.geojson).
const fs = require("fs");
const path = require("path");

const RAW_PATH = path.join(__dirname, "..", "data", "ecoverde-raw.json");
const BARRIERS_PATH = path.join(__dirname, "..", "data", "barriers-raw.json");
const CONTEXT_PATH = path.join(__dirname, "..", "data", "context-raw.json");
const OUT_PATH = path.join(__dirname, "..", "data", "ecoverde.geojson");

const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
// fetched separately via bbox: the area(...) query misses the perimeter wall
// because it sits exactly on the neighbourhood boundary edge.
const barriersRaw = JSON.parse(fs.readFileSync(BARRIERS_PATH, "utf8"));
// optional: the national highway and stream just outside the subdivision, shown
// faintly for geographic context (see tools/refresh-osm-data.js).
const contextRaw = fs.existsSync(CONTEXT_PATH)
  ? JSON.parse(fs.readFileSync(CONTEXT_PATH, "utf8"))
  : { elements: [] };

const nodes = new Map(); // id -> [lon, lat]
const ways = new Map(); // id -> element
const relations = [];

for (const el of raw.elements) {
  if (el.type === "node") nodes.set(el.id, [el.lon, el.lat]);
  else if (el.type === "way") ways.set(el.id, el);
  else if (el.type === "relation") relations.push(el);
}

function wayCoords(way) {
  return way.nodes.map((id) => nodes.get(id)).filter(Boolean);
}

function isClosed(coords) {
  if (coords.length < 4) return false;
  const [x1, y1] = coords[0];
  const [x2, y2] = coords[coords.length - 1];
  return x1 === x2 && y1 === y2;
}

/** Parses a "B18 L16" style name into { block, lot }. */
function parseBlockLot(tags) {
  const name = tags.name || "";
  const match = name.match(/B\s*(\d+)\s*L\s*(\d+)/i);
  if (match) return { block: match[1], lot: match[2] };
  if (tags["addr:lot"])
    return { block: tags["addr:block"] || null, lot: tags["addr:lot"] };
  return { block: null, lot: null };
}

/** Parses a "Block 18" / "Block 14A" city_block name into its block key (e.g. "18", "14A"). */
function parseCityBlockKey(name) {
  const match = (name || "").match(/Block\s*(\w+)/i);
  return match ? match[1] : null;
}

const features = [];

for (const [, el] of ways) {
  const tags = el.tags || {};
  const coords = wayCoords(el);
  if (coords.length < 2) continue;

  let category = "other";
  if (tags.building) category = "building";
  else if (tags.highway) category = "road";
  else if (tags.landuse) category = "landuse";
  else if (tags.natural) category = "natural";
  else if (tags.leisure) category = "leisure";
  else if (tags.barrier) category = "barrier";
  else if (tags.place === "city_block") category = "cityblock";

  const closed = isClosed(coords) && category !== "barrier";
  const geometry = closed
    ? { type: "Polygon", coordinates: [coords] }
    : { type: "LineString", coordinates: coords };

  const props = { category, ...tags };

  if (category === "building") {
    const { block, lot } = parseBlockLot(tags);
    props.block = block;
    props.lot = lot;
    props.searchLabel =
      tags.name || (block && lot ? `B${block} L${lot}` : null);
  }

  if (category === "cityblock") {
    props.block = parseCityBlockKey(tags.name);
  }

  features.push({ type: "Feature", properties: props, geometry });
}

for (const el of raw.elements) {
  if (el.type !== "node" || !el.tags) continue;
  const tags = el.tags;
  const category = tags.shop
    ? "poi-shop"
    : tags.amenity
      ? "poi-amenity"
      : tags.office
        ? "poi-office"
        : tags.natural === "tree"
          ? "poi-tree"
        : tags.leisure
          ? "poi-leisure"
          : null;
  if (!category) continue;
  features.push({
    type: "Feature",
    properties: { category, ...tags },
    geometry: { type: "Point", coordinates: [el.lon, el.lat] },
  });
}

// Ecoverde Homes neighbourhood bbox (from Nominatim), used to exclude barriers
// that belong to unrelated compounds picked up by the wider bbox query.
const SUBDIVISION_BBOX = {
  minLat: 13.8640792,
  maxLat: 13.8678693,
  minLon: 121.202926,
  maxLon: 121.2072337,
};

function isInsideSubdivision(coords) {
  return coords.every(
    ([lon, lat]) =>
      lon >= SUBDIVISION_BBOX.minLon &&
      lon <= SUBDIVISION_BBOX.maxLon &&
      lat >= SUBDIVISION_BBOX.minLat &&
      lat <= SUBDIVISION_BBOX.maxLat,
  );
}

for (const el of barriersRaw.elements) {
  if (el.type !== "way" || !el.tags || !el.tags.barrier) continue;
  const coords = el.geometry.map((p) => [p.lon, p.lat]);
  if (coords.length < 2) continue;
  if (!isInsideSubdivision(coords)) continue;
  features.push({
    type: "Feature",
    properties: { category: "barrier", ...el.tags },
    geometry: { type: "LineString", coordinates: coords },
  });
}

// National highway and stream just outside the subdivision wall, kept separate from the
// main road/barrier categories so the frontend can render them as faint background context.
for (const el of contextRaw.elements) {
  if (el.type !== "way" || !el.tags || !el.geometry) continue;
  const coords = el.geometry.map((p) => [p.lon, p.lat]);
  if (coords.length < 2) continue;

  let category = null;
  if (el.tags.highway) category = "context-road";
  else if (el.tags.waterway) category = "context-water";
  if (!category) continue;

  features.push({
    type: "Feature",
    properties: { category, ...el.tags },
    geometry: { type: "LineString", coordinates: coords },
  });
}

const collection = { type: "FeatureCollection", features };
fs.writeFileSync(OUT_PATH, JSON.stringify(collection));

const counts = features.reduce((acc, f) => {
  acc[f.properties.category] = (acc[f.properties.category] || 0) + 1;
  return acc;
}, {});
console.log("Wrote", features.length, "features to", OUT_PATH);
console.log(counts);

const buildingsWithBlockLot = features.filter(
  (f) =>
    f.properties.category === "building" &&
    f.properties.block &&
    f.properties.lot,
).length;
const buildingsTotal = features.filter(
  (f) => f.properties.category === "building",
).length;
console.log(
  `Buildings with block/lot: ${buildingsWithBlockLot}/${buildingsTotal}`,
);
