# Ecoverde-Unit-Finder

A clean, low-poly interactive map of **Ecoverde Homes** (Quilib, Rosario, Batangas) focused on fast **block/lot unit finding** and practical in-subdivision routing.

## What you can do

- Search homes by **Block** and **Lot**.
- Highlight the selected unit and focus the map on it.
- Show route distance and estimated travel times for car, bicycle, and walking.
- Drag the start point to simulate a different origin.
- Re-route by marking a road segment to avoid, then tap the marker again to remove that avoidance.
- Use optional overlays like road names, obstacles, and administrative points.
- Get clearer map labels and controls with built-in button tooltips.

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
