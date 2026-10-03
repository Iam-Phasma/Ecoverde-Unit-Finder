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
      .register("sw.js", { updateViaCache: "none" })
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

const LAYER_PREFS_STORAGE_KEY = "ecoverde:layer-visibility:v2";
const DEFAULT_LAYER_PREFS_DESKTOP = {
  obstacle: false,
  administrative: false,
  amenities: false,
  roadNames: true,
  decoration: true,
};

const DEFAULT_LAYER_PREFS_PHONE = {
  obstacle: false,
  administrative: false,
  amenities: false,
  roadNames: true,
  decoration: false,
};

const searchForm = document.getElementById("search-form");
const findButton = searchForm.querySelector('button[type="submit"]');
const layersToggle = document.getElementById("layers-toggle");
const layersPanel = document.getElementById("layers-panel");
const layerObstacle = document.getElementById("layer-obstacle");
const layerAdministrative = document.getElementById("layer-administrative");
const layerAmenities = document.getElementById("layer-amenities");
const layerRoadNames = document.getElementById("layer-road-names");
const layerDecoration = document.getElementById("layer-decoration");
const layerDecorationOption = document.getElementById("layer-decoration-option");
const routeClearButton = document.getElementById("route-clear");
const isPhoneDevice = detectPhoneDevice();

function defaultLayerPrefs() {
  return isPhoneDevice
    ? { ...DEFAULT_LAYER_PREFS_PHONE }
    : { ...DEFAULT_LAYER_PREFS_DESKTOP };
}

function detectPhoneDevice() {
  const uaMobile = navigator.userAgentData?.mobile;
  if (typeof uaMobile === "boolean") return uaMobile;

  const ua = navigator.userAgent || "";
  const isTablet = /iPad|Tablet|Kindle|Silk|PlayBook|Nexus 7|Nexus 9|Nexus 10/i.test(
    ua,
  );
  if (isTablet) return false;

  return /iPhone|iPod|Windows Phone|IEMobile|Opera Mini|Android.*Mobile|Mobile/i.test(
    ua,
  );
}

function readLayerPrefs() {
  const fallback = defaultLayerPrefs();
  try {
    const raw = localStorage.getItem(LAYER_PREFS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      obstacle: Boolean(parsed?.obstacle),
      administrative: parsed?.administrative ?? fallback.administrative,
      amenities: parsed?.amenities ?? fallback.amenities,
      roadNames: parsed?.roadNames ?? fallback.roadNames,
      decoration: parsed?.decoration ?? fallback.decoration,
    };
  } catch {
    return fallback;
  }
}

function writeLayerPrefs() {
  const next = {
    obstacle: Boolean(layerObstacle.checked),
    administrative: Boolean(layerAdministrative.checked),
    amenities: Boolean(layerAmenities.checked),
    roadNames: Boolean(layerRoadNames.checked),
    decoration: isPhoneDevice ? false : Boolean(layerDecoration.checked),
  };
  try {
    localStorage.setItem(LAYER_PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage write issues (private mode/quota) and continue.
  }
}

const findLabel = findButton.querySelector(".find-toggle-label");

function setFindLabel(text) {
  if (findLabel) findLabel.textContent = text;
  findButton.title =
    text === "View" ? "View selected block or lot" : "Find selected block or lot";
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

layerAmenities.addEventListener("change", () => {
  controller.setLayerVisibility("amenities", layerAmenities.checked);
  writeLayerPrefs();
});

layerRoadNames.addEventListener("change", () => {
  controller.setLayerVisibility("roadNames", layerRoadNames.checked);
  writeLayerPrefs();
});

layerDecoration.addEventListener("change", () => {
  if (isPhoneDevice) return;
  controller.setLayerVisibility("decoration", layerDecoration.checked);
  writeLayerPrefs();
});

controller.blockSelect.addEventListener("change", () => {
  setFindLabel("Find");
  updateFindButtonState();
});
controller.lotSelect.addEventListener("change", () => {
  setFindLabel("Find");
  updateFindButtonState();
});
routeClearButton?.addEventListener("click", resetSelectionInputs);

const layerPrefs = readLayerPrefs();
layerObstacle.checked = layerPrefs.obstacle;
layerAdministrative.checked = layerPrefs.administrative;
layerAmenities.checked = layerPrefs.amenities;
layerRoadNames.checked = layerPrefs.roadNames;

if (isPhoneDevice) {
  layerDecoration.checked = false;
  layerDecoration.disabled = true;
  layerDecorationOption?.setAttribute("hidden", "");
  layerDecorationOption?.setAttribute("aria-hidden", "true");
} else {
  layerDecoration.checked = layerPrefs.decoration;
  layerDecoration.disabled = false;
  layerDecorationOption?.removeAttribute("hidden");
  layerDecorationOption?.removeAttribute("aria-hidden");
}

// Default state (when no cache): administrative + decoration on; others off.
controller.setLayerVisibility("roadNames", layerRoadNames.checked);
controller.setLayerVisibility("administrative", layerAdministrative.checked);
controller.setLayerVisibility("amenities", layerAmenities.checked);
controller.setLayerVisibility("obstacle", layerObstacle.checked);
controller.setLayerVisibility(
  "decoration",
  isPhoneDevice ? false : layerDecoration.checked,
);

if (isPhoneDevice) writeLayerPrefs();
updateFindButtonState();

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const block = controller.blockSelect.value;
  const lot = controller.lotSelect.value;
  if (!block) {
    controller.clearSelection();
    setFindLabel("Find");
    return;
  }

  if (!lot) {
    const blockEntry = controller.cityBlockLayersByKey.get(block);
    if (blockEntry) {
      controller.highlightCityBlock(blockEntry);
      setFindLabel("View");
    } else {
      console.warn(`No block boundary matching Block ${block}.`);
    }
    return;
  }

  const entry = controller.buildingLayerById.get(`${block}|${lot}`.toLowerCase());

  if (entry) {
    controller.highlightBuilding(entry);
    setFindLabel("View");
  } else {
    console.warn(`No unit matching Block ${block}, Lot ${lot}.`);
  }
});

// Desktop-only welcome overlay: blurred map with a block/lot search, or skip to explore.
function setupWelcomeOverlay() {
  const overlay = document.getElementById("welcome");
  if (!overlay || isPhoneDevice) return;

  const form = document.getElementById("welcome-form");
  const blockEl = document.getElementById("welcome-block");
  const lotEl = document.getElementById("welcome-lot");
  const findEl = document.getElementById("welcome-find");
  const skipEl = document.getElementById("welcome-skip");

  function syncOptions() {
    const current = blockEl.value;
    blockEl.innerHTML = controller.blockSelect.innerHTML;
    blockEl.value = current;
    lotEl.innerHTML = controller.lotSelect.innerHTML;
    lotEl.disabled = controller.lotSelect.disabled;
    findEl.disabled = !blockEl.value;
  }

  function close() {
    document.removeEventListener("keydown", onKeydown);
    overlay.classList.add("welcome--leaving");
    setTimeout(() => overlay.classList.add("hidden"), 300);
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }

  new MutationObserver(syncOptions).observe(controller.blockSelect, {
    childList: true,
  });

  blockEl.addEventListener("change", () => {
    controller.blockSelect.value = blockEl.value;
    controller.blockSelect.dispatchEvent(new Event("change"));
    lotEl.innerHTML = controller.lotSelect.innerHTML;
    lotEl.disabled = controller.lotSelect.disabled;
    findEl.disabled = !blockEl.value;
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!blockEl.value) return;
    controller.lotSelect.value = lotEl.value;
    controller.lotSelect.dispatchEvent(new Event("change"));
    close();
    searchForm.requestSubmit();
  });

  skipEl.addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);

  syncOptions();
  overlay.classList.remove("hidden");
}

setupWelcomeOverlay();
