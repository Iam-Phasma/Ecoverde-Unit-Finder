# Ecoverde-Unit-Finder

A flat, top-down, solid-UI map of the **Ecoverde Homes** subdivision (Rosario, Batangas, Philippines) with a house **block/lot search**. Built with plain HTML/CSS/JS + [Leaflet](https://leafletjs.com/), sourced from OpenStreetMap data.

## How it works

- `data/ecoverde-raw.json` — raw Overpass API export for the subdivision (buildings, roads, landuse, POIs).
- `data/barriers-raw.json` — raw Overpass API export (bbox query) for perimeter walls/fences; fetched separately because the area-based query above misses ways sitting exactly on the neighbourhood boundary edge.
- `tools/build-geojson.js` — converts the raw OSM exports into `data/ecoverde.geojson`, parsing each house's `name` tag (e.g. `"B18 L16"`) into `block`/`lot` fields used by search.
- `index.html` / `style.css` / `app.js` — the map UI. Renders roads, buildings, parks/landuse, the perimeter wall/fence and POIs as flat colored shapes (no photo tiles), and lets you search by block & lot to highlight and zoom to a unit.

## Running locally

```powershell
node tools/serve.js
```

Then open http://localhost:8080 in your browser.

## Refreshing the map data

Re-run the Overpass query for relation `20433499` (Ecoverde Homes) if the OSM data changes, save the result to `data/ecoverde-raw.json`, then rebuild:

```powershell
node tools/build-geojson.js
```

## Deploying

This is a static site — push to GitHub and enable GitHub Pages (serve from the repo root / `main` branch).

## Data source & license

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
