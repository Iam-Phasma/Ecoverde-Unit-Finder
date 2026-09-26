// Bootstraps the map and wires up the search form + layers menu UI.
import { createMapController } from "./map-controller.js";

const GITHUB_PAGES_HOST_PATTERN = /\.github\.io$/i;
const GITHUB_PAGES_REPO_PATH = "/Ecoverde-Unit-Finder";
const VERCEL_HOSTNAME = "ecoverde-unit-finder.vercel.app";

if (GITHUB_PAGES_HOST_PATTERN.test(window.location.hostname)) {
  const path = window.location.pathname.startsWith(GITHUB_PAGES_REPO_PATH)
    ? window.location.pathname.slice(GITHUB_PAGES_REPO_PATH.length) || "/"
    : window.location.pathname || "/";
  const redirectUrl = `https://${VERCEL_HOSTNAME}${path}${window.location.search}${window.location.hash}`;
  window.location.replace(redirectUrl);
}

if ("serviceWorker" in navigator) {
  const registerServiceWorker = () => {
    navigator.serviceWorker
      .register("sw.js")
      .catch((err) => console.warn("Service worker registration failed", err));
  };

  if ("requestIdleCallback" in window) {
    requestIdleCallback(registerServiceWorker, { timeout: 2000 });
  } else {
    window.addEventListener("load", registerServiceWorker, { once: true });
  }
}

const controller = createMapController();
controller.loadData("data/ecoverde.geojson");

const LAYER_PREFS_STORAGE_KEY = "ecoverde:layer-visibility";
const DEFAULT_LAYER_PREFS = {
  obstacle: false,
  administrative: true,
  roadNames: false,
  decoration: true,
};

const searchForm = document.getElementById("search-form");
const findButton = searchForm.querySelector('button[type="submit"]');
const layersToggle = document.getElementById("layers-toggle");
const layersPanel = document.getElementById("layers-panel");
const layerObstacle = document.getElementById("layer-obstacle");
const layerAdministrative = document.getElementById("layer-administrative");
const layerRoadNames = document.getElementById("layer-road-names");
const layerDecoration = document.getElementById("layer-decoration");
const routeClearButton = document.getElementById("route-clear");

function readLayerPrefs() {
  try {
    const raw = localStorage.getItem(LAYER_PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYER_PREFS };
    const parsed = JSON.parse(raw);
    return {
      obstacle: Boolean(parsed?.obstacle),
      administrative: parsed?.administrative ?? DEFAULT_LAYER_PREFS.administrative,
      roadNames: Boolean(parsed?.roadNames),
      decoration: parsed?.decoration ?? DEFAULT_LAYER_PREFS.decoration,
    };
  } catch {
    return { ...DEFAULT_LAYER_PREFS };
  }
}

function writeLayerPrefs() {
  const next = {
    obstacle: Boolean(layerObstacle.checked),
    administrative: Boolean(layerAdministrative.checked),
    roadNames: Boolean(layerRoadNames.checked),
    decoration: Boolean(layerDecoration.checked),
  };
  try {
    localStorage.setItem(LAYER_PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage write issues (private mode/quota) and continue.
  }
}

function updateFindButtonState() {
  const hasBlock = Boolean(controller.blockSelect.value);
  findButton.disabled = !hasBlock;
}

function resetSelectionInputs() {
  controller.blockSelect.value = "";
  controller.blockSelect.dispatchEvent(new Event("change"));
  controller.lotSelect.value = "";
  updateFindButtonState();
}

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

layerObstacle.addEventListener("change", () => {
  controller.setLayerVisibility("obstacle", layerObstacle.checked);
  writeLayerPrefs();
});

layerAdministrative.addEventListener("change", () => {
  controller.setLayerVisibility("administrative", layerAdministrative.checked);
  writeLayerPrefs();
});

layerRoadNames.addEventListener("change", () => {
  controller.setLayerVisibility("roadNames", layerRoadNames.checked);
  writeLayerPrefs();
});

layerDecoration.addEventListener("change", () => {
  controller.setLayerVisibility("decoration", layerDecoration.checked);
  writeLayerPrefs();
});

controller.blockSelect.addEventListener("change", updateFindButtonState);
controller.lotSelect.addEventListener("change", updateFindButtonState);
routeClearButton?.addEventListener("click", resetSelectionInputs);

const layerPrefs = readLayerPrefs();
layerObstacle.checked = layerPrefs.obstacle;
layerAdministrative.checked = layerPrefs.administrative;
layerRoadNames.checked = layerPrefs.roadNames;
layerDecoration.checked = layerPrefs.decoration;

// Default state (when no cache): administrative + decoration on; others off.
controller.setLayerVisibility("roadNames", layerRoadNames.checked);
controller.setLayerVisibility("administrative", layerAdministrative.checked);
controller.setLayerVisibility("obstacle", layerObstacle.checked);
controller.setLayerVisibility("decoration", layerDecoration.checked);
updateFindButtonState();

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const block = controller.blockSelect.value;
  const lot = controller.lotSelect.value;
  if (!block) {
    controller.clearSelection();
    return;
  }

  if (!lot) {
    const blockEntry = controller.cityBlockLayersByKey.get(block);
    if (blockEntry) {
      controller.highlightCityBlock(blockEntry);
    } else {
      console.warn(`No block boundary matching Block ${block}.`);
    }
    return;
  }

  const entry = controller.buildingLayerById.get(`${block}|${lot}`.toLowerCase());

  if (entry) {
    controller.highlightBuilding(entry);
  } else {
    console.warn(`No unit matching Block ${block}, Lot ${lot}.`);
  }
});
