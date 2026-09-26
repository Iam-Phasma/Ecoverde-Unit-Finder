# Ecoverde-Unit-Finder

A clean, low-poly interactive map of **Ecoverde Homes** (Quilib, Rosario, Batangas) focused on fast **block/lot unit finding** and practical in-subdivision routing.

Vercel: https://ecoverde-unit-finder.vercel.app/ \
Pages: https://iam-phasma.github.io/Ecoverde-Unit-Finder/

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

## Root file layout

These files intentionally stay at the repository root:

- `index.html`: App entry page.
- `style.css`: Global map/app styles.
- `sw.js`: Service worker (must remain at root to control the full app scope).
- `favicon.svg`, `tree.svg`: Static root-served assets.
- `README.md`, `LICENSE`: Project metadata.

All map data belongs in `data/`, app logic in `js/`, and maintenance scripts in `tools/`.

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
