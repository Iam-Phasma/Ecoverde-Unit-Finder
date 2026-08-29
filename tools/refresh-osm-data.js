// Manually re-fetches the latest OSM data for the Ecoverde Homes subdivision
// (relation 20433499) plus the perimeter wall/fence bbox, then rebuilds the
// geojson consumed by the frontend. Run this after editing OSM so the map
// picks up the change.
//
// Usage: node tools/refresh-osm-data.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const RELATION_ID = 20433499;

// Same bbox used by build-geojson.js to filter unrelated barriers picked up
// by the wider bbox query.
const SUBDIVISION_BBOX = {
  minLat: 13.8640792,
  minLon: 121.202926,
  maxLat: 13.8678693,
  maxLon: 121.2072337,
};

const mainQuery = `
[out:json][timeout:60];
area(${3600000000 + RELATION_ID})->.searchArea;
(
  way(area.searchArea)[building];
  way(area.searchArea)[highway];
  way(area.searchArea)[landuse];
  way(area.searchArea)[natural];
  way(area.searchArea)[leisure];
  way(area.searchArea)[barrier];
  way(area.searchArea)[place=city_block];
  node(area.searchArea)[shop];
  node(area.searchArea)[amenity];
  node(area.searchArea)[office];
  node(area.searchArea)[natural=tree];
);
out body;
>;
out skel qt;
`;

const barriersQuery = `
[out:json][timeout:60];
(
  way[barrier](${SUBDIVISION_BBOX.minLat},${SUBDIVISION_BBOX.minLon},${SUBDIVISION_BBOX.maxLat},${SUBDIVISION_BBOX.maxLon});
);
out geom;
`;

// A small buffer around the subdivision so the nearby national highway and stream show up
// for geographic context, without pulling in unrelated data far from the entrance.
const CONTEXT_BUFFER_DEG = 0.006;
const CONTEXT_BBOX = {
  minLat: SUBDIVISION_BBOX.minLat - CONTEXT_BUFFER_DEG,
  minLon: SUBDIVISION_BBOX.minLon - CONTEXT_BUFFER_DEG,
  maxLat: SUBDIVISION_BBOX.maxLat + CONTEXT_BUFFER_DEG,
  maxLon: SUBDIVISION_BBOX.maxLon + CONTEXT_BUFFER_DEG,
};

const contextQuery = `
[out:json][timeout:60];
(
  way[highway~"^(trunk|primary|secondary)$"](${CONTEXT_BBOX.minLat},${CONTEXT_BBOX.minLon},${CONTEXT_BBOX.maxLat},${CONTEXT_BBOX.maxLon});
  way[waterway~"^(river|stream)$"](${CONTEXT_BBOX.minLat},${CONTEXT_BBOX.minLon},${CONTEXT_BBOX.maxLat},${CONTEXT_BBOX.maxLon});
);
out geom;
`;

async function runQuery(query) {
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json,*/*",
      "User-Agent": "Ecoverde-Unit-Finder/1.0 (local dev data refresh)",
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) {
    throw new Error(`Overpass request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  console.log("Fetching subdivision data from Overpass (relation", RELATION_ID, ")...");
  const mainData = await runQuery(mainQuery);
  fs.writeFileSync(
    path.join(__dirname, "..", "data", "ecoverde-raw.json"),
    JSON.stringify(mainData),
  );
  console.log("Wrote data/ecoverde-raw.json (", mainData.elements.length, "elements)");

  console.log("Fetching perimeter wall/fence bbox...");
  const barriers = await runQuery(barriersQuery);
  fs.writeFileSync(
    path.join(__dirname, "..", "data", "barriers-raw.json"),
    JSON.stringify(barriers),
  );
  console.log("Wrote data/barriers-raw.json (", barriers.elements.length, "elements)");

  console.log("Fetching national highway/stream context bbox...");
  const context = await runQuery(contextQuery);
  fs.writeFileSync(
    path.join(__dirname, "..", "data", "context-raw.json"),
    JSON.stringify(context),
  );
  console.log("Wrote data/context-raw.json (", context.elements.length, "elements)");

  console.log("Rebuilding data/ecoverde.geojson...");
  execFileSync("node", [path.join(__dirname, "build-geojson.js")], {
    stdio: "inherit",
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
