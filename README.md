# Ecoverde-Unit-Finder

A low-poly map of the **Ecoverde Homes** subdivision in Quilib, Rosario, Batangas with a house **block/lot search**.

## How it works

- `data/ecoverde-raw.json` — raw Overpass API export for the subdivision (buildings, roads, landuse, POIs).
- `data/barriers-raw.json` — raw Overpass API export (bbox query) for perimeter walls/fences; fetched separately because the area-based query above misses ways sitting exactly on the neighbourhood boundary edge.
- `tools/build-geojson.js` — converts the raw OSM exports into `data/ecoverde.geojson`, parsing each house's `name` tag (e.g. `"B18 L16"`) into `block`/`lot` fields used by search.
- `index.html` / `style.css` / `js/` — the map UI. Renders roads, buildings, parks/landuse, the perimeter wall/fence and POIs as flat colored shapes (no photo tiles), and lets you search by block & lot to highlight and zoom to a unit.
  - `js/graph.js` — road graph building and Dijkstra routing (pure logic, no DOM).
  - `js/style.js` — Leaflet styling per feature category.
  - `js/map-controller.js` — the map, layers, gate marker, routing, and highlight/popup behavior.
  - `js/main.js` — entry point; wires up the search form and layers menu.
  - `js/utils.js` — small string/DOM helpers.

## Running locally

```powershell
node tools/serve.js
```

Then open http://localhost:8080 in your browser.

## Refreshing the map data

If you edited OSM and want the map to pick it up, re-fetch and rebuild in one step:

```powershell
node tools/refresh-osm-data.js
```

This re-queries Overpass for relation `20433499` (Ecoverde Homes) plus the perimeter
wall/fence bbox, overwrites `data/ecoverde-raw.json` / `data/barriers-raw.json`, and
rebuilds `data/ecoverde.geojson`. OSM edits can take a few minutes to appear in Overpass,
so re-run it again if your change isn't showing yet.

Alternatively, re-run the Overpass query manually (e.g. via Overpass Turbo), save the
result to `data/ecoverde-raw.json`, then rebuild:

```powershell
node tools/build-geojson.js
```

## Data source & license

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
