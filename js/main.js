// Bootstraps the map and wires up the search form + layers menu UI.
import { createMapController } from "./map-controller.js?v=20261010-route-pause-3";

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

const isLocalhost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

if ("serviceWorker" in navigator && isLocalhost) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) registration.unregister();
  });
  if ("caches" in window) {
    caches.keys().then((keys) => {
      for (const key of keys) caches.delete(key);
    });
  }
}

if ("serviceWorker" in navigator && !isLocalhost) {
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
const RECENT_SEARCHES_STORAGE_KEY = "ecoverde:recent-searches:v1";
const UI_SIZE_STORAGE_KEY = "ecoverde:ui-size:v1";
const MAX_RECENT_SEARCHES = 5;
const deepLinkParams = new URLSearchParams(location.search);
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
const recentToggle = document.getElementById("recent-toggle");
const recentPanel = document.getElementById("recent-panel");
const recentList = document.getElementById("recent-list");
const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const uiSizeSelect = document.getElementById("ui-size-select");
const uiSizeSection = document.querySelector(".settings-section-ui");
const layerObstacle = document.getElementById("layer-obstacle");
const layerAdministrative = document.getElementById("layer-administrative");
const layerAmenities = document.getElementById("layer-amenities");
const layerRoadNames = document.getElementById("layer-road-names");
const layerDecoration = document.getElementById("layer-decoration");
const layerDecorationOption = document.getElementById(
  "layer-decoration-option",
);
const routeClearButton = document.getElementById("route-clear");
const isPhoneDevice = detectPhoneDevice();
const FIND_ICON_SEARCH_SVG =
  '<svg class="find-toggle-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-width="2" d="m21 21-3.5-3.5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"/></svg>';
const FIND_ICON_SUCCESS_SVG =
  '<svg class="find-toggle-icon w-6 h-6 text-gray-800 dark:text-white" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 11h2v5m-2 0h4m-2.592-8.5h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>';
const deepLinkBlock = (deepLinkParams.get("block") || "").trim();
const deepLinkLot = (deepLinkParams.get("lot") || "").trim();

function parseBooleanParam(value) {
  if (value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return null;
}

function parseNumberParam(value) {
  if (value === null) return null;
  const parsed = Number.parseFloat(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

const deepLinkLayerPrefs = {
  obstacle: parseBooleanParam(deepLinkParams.get("obs")),
  administrative: parseBooleanParam(deepLinkParams.get("adm")),
  amenities: parseBooleanParam(deepLinkParams.get("amen")),
  roadNames: parseBooleanParam(deepLinkParams.get("road")),
  decoration: parseBooleanParam(deepLinkParams.get("deco")),
};

const deepLinkViewState = {
  lat: parseNumberParam(deepLinkParams.get("lat")),
  lng: parseNumberParam(deepLinkParams.get("lng")),
  zoom: parseNumberParam(deepLinkParams.get("z")),
};

function hasDeepLinkViewState() {
  return (
    Number.isFinite(deepLinkViewState.lat) &&
    Number.isFinite(deepLinkViewState.lng) &&
    Number.isFinite(deepLinkViewState.zoom)
  );
}

function defaultLayerPrefs() {
  return isPhoneDevice
    ? { ...DEFAULT_LAYER_PREFS_PHONE }
    : { ...DEFAULT_LAYER_PREFS_DESKTOP };
}

function detectPhoneDevice() {
  const uaMobile = navigator.userAgentData?.mobile;
  if (typeof uaMobile === "boolean") return uaMobile;

  const ua = navigator.userAgent || "";
  const isTablet =
    /iPad|Tablet|Kindle|Silk|PlayBook|Nexus 7|Nexus 9|Nexus 10/i.test(ua);
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

function resolveLayerPrefWithDeepLink(key, fallbackValue) {
  const deepLinkValue = deepLinkLayerPrefs[key];
  return typeof deepLinkValue === "boolean" ? deepLinkValue : fallbackValue;
}

function readRecentSearches() {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        const block = String(entry?.block ?? "").trim();
        const lot = String(entry?.lot ?? "").trim();
        if (!block) return null;
        return { block, lot };
      })
      .filter(Boolean)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

function writeRecentSearches(recentSearches) {
  try {
    localStorage.setItem(
      RECENT_SEARCHES_STORAGE_KEY,
      JSON.stringify(recentSearches),
    );
  } catch {
    // Ignore storage write issues (private mode/quota) and continue.
  }
}

const UI_SIZE_SEQUENCE = ["default", "x2", "x4", "x6"];

function readUiSize() {
  try {
    const raw = String(localStorage.getItem(UI_SIZE_STORAGE_KEY) || "").trim();
    if (raw === "compact") return "default";
    if (raw === "large") return "x2";
    if (raw === "tv") return "x4";
    if (raw === "x8") return "x6";
    return UI_SIZE_SEQUENCE.includes(raw) ? raw : "default";
  } catch {
    return "default";
  }
}

function writeUiSize(size) {
  try {
    localStorage.setItem(UI_SIZE_STORAGE_KEY, size);
  } catch {
    // Ignore storage write issues (private mode/quota) and continue.
  }
}

function applyUiSize(size) {
  const mode = UI_SIZE_SEQUENCE.includes(size) ? size : "default";
  document.body.classList.toggle("ui-size-2x", mode === "x2");
  document.body.classList.toggle("ui-size-4x", mode === "x4");
  document.body.classList.toggle("ui-size-6x", mode === "x6");
  if (uiSizeSelect) uiSizeSelect.value = mode;
  return mode;
}

const findLabel = findButton.querySelector(".find-toggle-label");

const VIEW_LABEL = isPhoneDevice ? "View" : "Info";

function setFindLabel(text) {
  if (findLabel) findLabel.textContent = text;
  findButton.title =
    text === VIEW_LABEL
      ? "View selected block or lot"
      : "Find selected block or lot";
}

function setFindIconHtml(svgMarkup) {
  const icon = findButton.querySelector(".find-toggle-icon");
  if (!icon) return;
  icon.outerHTML = svgMarkup;
}

function setLyketButtonVisible(visible) {
  const root = document.getElementById("lyket-button");
  if (!root) return;
  root.classList.toggle("hidden", !visible);
  root.setAttribute("aria-hidden", visible ? "false" : "true");
}

function setFindIconForIdleState() {
  setFindIconHtml(FIND_ICON_SEARCH_SVG);
  setLyketButtonVisible(true);
}

function setFindIconForSuccessfulSearch() {
  setFindIconHtml(FIND_ICON_SUCCESS_SVG);
  setLyketButtonVisible(false);
}

function applyLyketLayoutOverrides() {
  const root = document.getElementById("lyket-button");
  if (!root) return;
  const wrap = root.firstElementChild;
  const button = root.querySelector("button");
  const counter = wrap && wrap.children ? wrap.children[1] : null;
  const ripple = button?.querySelector("div");

  if (wrap) {
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.style.justifyContent = "flex-start";
    wrap.style.gap = "4px";
    wrap.style.columnGap = "4px";
    wrap.style.width = "auto";
  }

  if (button) {
    button.style.margin = "0";
    button.style.padding = "0";
    button.style.width = "auto";
    button.style.minWidth = "0";
    button.style.transform = "none";
    button.style.transition = "none";
    button.style.animation = "none";
  }

  if (counter) {
    counter.style.margin = "0";
    counter.style.marginLeft = "0";
    counter.style.padding = "0";
    counter.style.left = "0";
    counter.style.transform = "none";
    counter.style.minWidth = "0";
    counter.style.width = "auto";
    counter.style.display = "block";
  }

  if (ripple) {
    ripple.style.display = "none";
    ripple.style.width = "0";
    ripple.style.height = "0";
    ripple.style.margin = "0";
    ripple.style.padding = "0";
  }
}

function setupLyketOverrides() {
  const root = document.getElementById("lyket-button");
  if (!root) return;
  const popClassName = "lyket-like-pop";
  const thanksClassName = "lyket-thanks-visible";
  let popTimer = null;
  let thanksTimer = null;
  const isLiked = () =>
    root.querySelector("button")?.classList.contains("css-fpg8om");
  let wasLiked = Boolean(isLiked());
  let buttonClassObserver = null;

  function triggerLikePop() {
    const button = root.querySelector("button");
    if (!button) return;
    button.classList.remove(popClassName);
    // Force reflow so repeated likes retrigger the animation reliably.
    void button.offsetWidth;
    button.classList.add(popClassName);
    if (popTimer) clearTimeout(popTimer);
    popTimer = setTimeout(() => {
      button.classList.remove(popClassName);
      popTimer = null;
    }, 420);
  }

  function showThanksMessage() {
    root.classList.remove(thanksClassName);
    // Force reflow so repeated likes retrigger the message animation.
    void root.offsetWidth;
    root.classList.add(thanksClassName);
    if (thanksTimer) clearTimeout(thanksTimer);
    thanksTimer = setTimeout(() => {
      root.classList.remove(thanksClassName);
      thanksTimer = null;
    }, 1500);
  }

  applyLyketLayoutOverrides();
  setTimeout(applyLyketLayoutOverrides, 250);
  setTimeout(applyLyketLayoutOverrides, 1000);
  setTimeout(applyLyketLayoutOverrides, 2000);

  function syncLikedStateFromClass() {
    const likedNow = Boolean(isLiked());
    if (!wasLiked && likedNow) {
      triggerLikePop();
      showThanksMessage();
    }
    wasLiked = likedNow;
  }

  function attachButtonClassObserver() {
    if (buttonClassObserver) {
      buttonClassObserver.disconnect();
      buttonClassObserver = null;
    }
    const button = root.querySelector("button");
    if (!button) return;
    buttonClassObserver = new MutationObserver(() => {
      syncLikedStateFromClass();
    });
    buttonClassObserver.observe(button, {
      attributes: true,
      attributeFilter: ["class"],
    });
    syncLikedStateFromClass();
  }

  attachButtonClassObserver();
  const rootObserver = new MutationObserver(() => {
    applyLyketLayoutOverrides();
    attachButtonClassObserver();
  });
  rootObserver.observe(root, { subtree: true, childList: true });
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

let recentSearches = readRecentSearches();

function closeRecentPanel() {
  if (!recentPanel || !recentToggle) return;
  recentPanel.classList.add("hidden");
  recentToggle.setAttribute("aria-expanded", "false");
}

function closeSettingsPanel() {
  settingsPanel.classList.add("hidden");
  settingsToggle.setAttribute("aria-expanded", "false");
}

function formatRecentSearchLabel(entry) {
  return entry.lot
    ? `Block ${entry.block}, Lot ${entry.lot}`
    : `Block ${entry.block}`;
}

function renderRecentSearches() {
  if (!recentList || !recentToggle) return;
  recentList.innerHTML = "";

  if (!recentSearches.length) {
    recentToggle.disabled = true;
    const empty = document.createElement("p");
    empty.className = "recent-item-empty";
    empty.textContent = "No recent searches yet.";
    recentList.appendChild(empty);
    return;
  }

  recentToggle.disabled = false;

  for (const entry of recentSearches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-item";
    button.textContent = formatRecentSearchLabel(entry);
    button.addEventListener("click", () => {
      const hasBlock = [...controller.blockSelect.options].some(
        (option) => option.value === entry.block,
      );
      if (!hasBlock) return;
      controller.blockSelect.value = entry.block;
      controller.blockSelect.dispatchEvent(new Event("change"));
      if (entry.lot) {
        const hasLot = [...controller.lotSelect.options].some(
          (option) => option.value === entry.lot,
        );
        controller.lotSelect.value = hasLot ? entry.lot : "";
      } else {
        controller.lotSelect.value = "";
      }
      controller.lotSelect.dispatchEvent(new Event("change"));
      closeRecentPanel();
      searchForm.requestSubmit();
    });
    recentList.appendChild(button);
  }
}

function addRecentSearch(block, lot = "") {
  const next = {
    block: String(block || "").trim(),
    lot: String(lot || "").trim(),
  };
  if (!next.block) return;
  recentSearches = [
    next,
    ...recentSearches.filter(
      (entry) => !(entry.block === next.block && entry.lot === next.lot),
    ),
  ].slice(0, MAX_RECENT_SEARCHES);
  writeRecentSearches(recentSearches);
  renderRecentSearches();
}

settingsToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  closeRecentPanel();
  const expanded = settingsPanel.classList.toggle("hidden") === false;
  settingsToggle.setAttribute("aria-expanded", String(expanded));
  if (expanded) layerAmenities.focus();
});

recentToggle?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeSettingsPanel();
  const expanded = recentPanel.classList.toggle("hidden") === false;
  recentToggle.setAttribute("aria-expanded", String(expanded));
  if (expanded) recentList.querySelector(".recent-item")?.focus();
});

document.addEventListener("click", (e) => {
  if (
    !settingsPanel.classList.contains("hidden") &&
    !settingsPanel.contains(e.target)
  ) {
    closeSettingsPanel();
  }
  if (
    recentPanel &&
    !recentPanel.classList.contains("hidden") &&
    !recentPanel.contains(e.target)
  ) {
    closeRecentPanel();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeSettingsPanel();
  closeRecentPanel();
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
  setFindIconForIdleState();
  updateFindButtonState();
});
controller.lotSelect.addEventListener("change", () => {
  setFindLabel("Find");
  setFindIconForIdleState();
  updateFindButtonState();
});
routeClearButton?.addEventListener("click", () => {
  setFindIconForIdleState();
  resetSelectionInputs();
});

const layerPrefs = readLayerPrefs();
layerObstacle.checked = resolveLayerPrefWithDeepLink(
  "obstacle",
  layerPrefs.obstacle,
);
layerAdministrative.checked = resolveLayerPrefWithDeepLink(
  "administrative",
  layerPrefs.administrative,
);
layerAmenities.checked = resolveLayerPrefWithDeepLink(
  "amenities",
  layerPrefs.amenities,
);
layerRoadNames.checked = resolveLayerPrefWithDeepLink(
  "roadNames",
  layerPrefs.roadNames,
);

if (isPhoneDevice) {
  layerDecoration.checked = false;
  layerDecoration.disabled = true;
  layerDecorationOption?.setAttribute("hidden", "");
  layerDecorationOption?.setAttribute("aria-hidden", "true");
} else {
  layerDecoration.checked = resolveLayerPrefWithDeepLink(
    "decoration",
    layerPrefs.decoration,
  );
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
setFindIconForIdleState();
setupLyketOverrides();
updateFindButtonState();
renderRecentSearches();

if (isPhoneDevice) {
  uiSizeSection?.setAttribute("hidden", "");
  uiSizeSection?.setAttribute("aria-hidden", "true");
  applyUiSize("default");
} else {
  uiSizeSection?.removeAttribute("hidden");
  uiSizeSection?.removeAttribute("aria-hidden");
  let uiSizeMode = applyUiSize(readUiSize());
  uiSizeSelect?.addEventListener("change", () => {
    const nextMode = uiSizeSelect.value;
    if (!UI_SIZE_SEQUENCE.includes(nextMode)) return;
    if (uiSizeMode === nextMode) return;
    uiSizeMode = applyUiSize(nextMode);
    writeUiSize(uiSizeMode);
  });
}

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (findLabel?.textContent === VIEW_LABEL && controller.isRoutePanelOpen()) {
    controller.hideRoutePanel();
    return;
  }
  const block = controller.blockSelect.value;
  const lot = controller.lotSelect.value;
  if (!block) {
    controller.clearSelection();
    setFindLabel("Find");
    setFindIconForIdleState();
    return;
  }

  if (!lot) {
    const blockEntry = controller.cityBlockLayersByKey.get(block);
    if (blockEntry) {
      controller.highlightCityBlock(blockEntry);
      setFindLabel(VIEW_LABEL);
      setFindIconForSuccessfulSearch();
      addRecentSearch(block);
    } else {
      console.warn(`No block boundary matching Block ${block}.`);
    }
    return;
  }

  const entry = controller.buildingLayerById.get(
    `${block}|${lot}`.toLowerCase(),
  );

  if (entry) {
    controller.highlightBuilding(entry);
    setFindLabel(VIEW_LABEL);
    setFindIconForSuccessfulSearch();
    addRecentSearch(block, lot);
  } else {
    console.warn(`No unit matching Block ${block}, Lot ${lot}.`);
  }
});

// Desktop-only welcome overlay: blurred map with a block/lot search, or skip to explore.
function setupWelcomeOverlay() {
  const overlay = document.getElementById("welcome");
  if (!overlay) return;

  const form = document.getElementById("welcome-form");
  const blockEl = document.getElementById("welcome-block");
  const lotEl = document.getElementById("welcome-lot");
  const findEl = document.getElementById("welcome-find");
  const skipEl = document.getElementById("welcome-skip");
  const previousFocus = document.activeElement;

  function copyOptions(source, target, placeholder) {
    target.innerHTML = source.innerHTML;
    const first = target.options[0];
    if (first && first.value === "") first.textContent = placeholder;
  }

  function syncOptions() {
    const current = blockEl.value;
    copyOptions(controller.blockSelect, blockEl, "Select Block");
    blockEl.value = current;
    copyOptions(controller.lotSelect, lotEl, "Select Lot");
    lotEl.disabled = controller.lotSelect.disabled;
    findEl.disabled = !blockEl.value;
    if (controller.blockSelect.options.length > 1) startDrift();
  }

  const WELCOME_FADE_MS = 300;

  // Keep the welcome map static at its current idle position.
  const driftEnabled = false;
  const DRIFT_SPEED_PX_S = 20;
  const DRIFT_RAMP_S = 2.5;
  const DRIFT_FRAME_MS = 1000 / 30;
  const DRIFT_RUN_MS = 60 * 1000;
  const DRIFT_PAUSE_MS = 2 * 60 * 1000;
  let welcomeClosed = false;
  let driftActive = false;
  let driftRaf = null;
  let driftStartTimer = null;
  let driftStopTimer = null;

  // Closed Catmull-Rom loop through the map's extents, so turns are rounded
  // and the view crosses the whole map before changing direction.
  function buildDriftPath() {
    const map = controller.map;
    const maxBounds = map.options.maxBounds;
    if (!maxBounds) return null;
    const data = L.latLngBounds(maxBounds).pad(-0.25);
    const zoom = map.getZoom();
    const c = data.getCenter();
    const f = 0.42;
    const lat = (s) => c.lat + s * f * (data.getNorth() - data.getSouth());
    const lng = (s) => c.lng + s * f * (data.getEast() - data.getWest());
    const corners = [
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1],
    ].map(([sx, sy]) => map.project([lat(sy), lng(sx)], zoom));
    const pts = [map.project(map.getCenter(), zoom)];
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      const q = corners[(i + 1) % 4];
      pts.push(p, p.add(q).divideBy(2));
    }
    return { pts, zoom };
  }

  function catmull(p0, p1, p2, p3, u) {
    const u2 = u * u;
    const u3 = u2 * u;
    const f = (a, b, c, d) =>
      0.5 *
      (2 * b +
        (-a + c) * u +
        (2 * a - 5 * b + 4 * c - d) * u2 +
        (-a + 3 * b - 3 * c + d) * u3);
    return L.point(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y));
  }

  function runDrift() {
    const path = buildDriftPath();
    if (!path) return;
    const { pts, zoom } = path;
    const n = pts.length;
    const segLen = pts.map((p, i) => p.distanceTo(pts[(i + 1) % n]));
    const total = segLen.reduce((s, v) => s + v, 0);
    if (!Number.isFinite(total) || total <= 0) return;
    let dist = 0;
    let last = performance.now();
    const t0 = last;
    let lastRender = -Infinity;

    function frame(now) {
      if (!driftActive) return;
      driftRaf = requestAnimationFrame(frame);
      // Keep the slow pan independent of the display's refresh rate.
      if (now - lastRender < DRIFT_FRAME_MS - 0.5) return;
      lastRender = now;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const ramp = Math.min((now - t0) / 1000 / DRIFT_RAMP_S, 1);
      dist =
        (dist + DRIFT_SPEED_PX_S * ramp * ramp * (3 - 2 * ramp) * dt) % total;

      let i = 0;
      let rem = dist;
      while (rem > segLen[i]) rem -= segLen[i++];
      const u = segLen[i] ? rem / segLen[i] : 0;
      const p = catmull(
        pts[(i - 1 + n) % n],
        pts[i],
        pts[(i + 1) % n],
        pts[(i + 2) % n],
        u,
      );
      controller.map.setView(controller.map.unproject(p, zoom), zoom, {
        animate: false,
      });
    }
    driftRaf = requestAnimationFrame(frame);
  }

  function startDrift(delay = 800) {
    if (!driftEnabled || welcomeClosed || document.hidden || driftActive || driftStartTimer) return;
    // wait for data to load and the initial view to settle
    driftStartTimer = setTimeout(() => {
      driftStartTimer = null;
      if (welcomeClosed || document.hidden) return;
      driftActive = true;
      controller.setWelcomeDriftActive(true);
      runDrift();
      driftStopTimer = setTimeout(() => {
        stopDrift();
        startDrift(DRIFT_PAUSE_MS);
      }, DRIFT_RUN_MS);
    }, delay);
  }

  function stopDrift() {
    clearTimeout(driftStartTimer);
    driftStartTimer = null;
    clearTimeout(driftStopTimer);
    driftStopTimer = null;
    if (!driftActive) return;
    driftActive = false;
    cancelAnimationFrame(driftRaf);
    driftRaf = null;
    controller.setWelcomeDriftActive(false);
  }
  function onVisibilityChange() {
    if (document.hidden) stopDrift();
    else startDrift();
  }
  function close() {
    if (welcomeClosed) return;
    welcomeClosed = true;
    stopDrift();
    optionsObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("keydown", onKeydown);
    document.body.classList.remove("welcome-open");
    overlay.classList.add("welcome--leaving");
    setTimeout(() => {
      overlay.classList.add("hidden");
      const fallback = controller.blockSelect;
      if (previousFocus && typeof previousFocus.focus === "function") {
        previousFocus.focus();
      } else if (fallback && typeof fallback.focus === "function") {
        fallback.focus();
      }
    }, WELCOME_FADE_MS);
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }

  const optionsObserver = new MutationObserver(syncOptions);
  optionsObserver.observe(controller.blockSelect, {
    childList: true,
  });

  blockEl.addEventListener("change", () => {
    controller.blockSelect.value = blockEl.value;
    controller.blockSelect.dispatchEvent(new Event("change"));
    copyOptions(controller.lotSelect, lotEl, "Select Lot");
    lotEl.disabled = controller.lotSelect.disabled;
    findEl.disabled = !blockEl.value;
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!blockEl.value) return;
    controller.lotSelect.value = lotEl.value;
    controller.lotSelect.dispatchEvent(new Event("change"));
    close();
    // let the overlay finish fading before the route computation and map animation start
    setTimeout(() => searchForm.requestSubmit(), WELCOME_FADE_MS + 50);
  });

  skipEl.addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("visibilitychange", onVisibilityChange);

  syncOptions();
  document.body.classList.add("welcome-open");
  overlay.classList.remove("hidden");
  blockEl.focus();
}

function applyDeepLinkViewState() {
  if (!hasDeepLinkViewState()) return false;
  const map = controller.map;
  const lat = deepLinkViewState.lat;
  const lng = deepLinkViewState.lng;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  const zoom = Math.max(
    map.getMinZoom(),
    Math.min(map.getMaxZoom(), deepLinkViewState.zoom),
  );
  map.setView([lat, lng], zoom, { animate: false });
  return true;
}

function applyDeepLinkViewStateWhenReady() {
  if (!hasDeepLinkViewState()) return;
  if (controller.blockSelect.options.length > 1) {
    applyDeepLinkViewState();
    return;
  }
  const observer = new MutationObserver(() => {
    if (controller.blockSelect.options.length <= 1) return;
    observer.disconnect();
    applyDeepLinkViewState();
  });
  observer.observe(controller.blockSelect, { childList: true });
}

function buildShareUrl() {
  const block = controller.blockSelect.value;
  const lot = controller.lotSelect.value;
  const center = controller.map.getCenter();
  const zoom = controller.map.getZoom();
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  if (block) url.searchParams.set("block", block);
  if (block && lot) url.searchParams.set("lot", lot);
  url.searchParams.set("lat", center.lat.toFixed(6));
  url.searchParams.set("lng", center.lng.toFixed(6));
  url.searchParams.set("z", zoom.toFixed(2));
  url.searchParams.set("obs", layerObstacle.checked ? "1" : "0");
  url.searchParams.set("adm", layerAdministrative.checked ? "1" : "0");
  url.searchParams.set("amen", layerAmenities.checked ? "1" : "0");
  url.searchParams.set("road", layerRoadNames.checked ? "1" : "0");
  url.searchParams.set("deco", isPhoneDevice ? "0" : layerDecoration.checked ? "1" : "0");
  return url.toString();
}

const routeShareButton = document.getElementById("route-share");
routeShareButton?.addEventListener("click", async () => {
  const url = buildShareUrl();
  const label = routeShareButton.querySelector("span");
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    ok = window.prompt("Copy this link:", url) !== null;
  }
  if (ok && label) {
    label.textContent = "Link copied";
    setTimeout(() => (label.textContent = "Share"), 1800);
  }
});

function applyDeepLink() {
  const hasBlock = [...controller.blockSelect.options].some(
    (o) => o.value === deepLinkBlock,
  );
  if (!hasBlock) return false;
  controller.blockSelect.value = deepLinkBlock;
  controller.blockSelect.dispatchEvent(new Event("change"));
  if (deepLinkLot) {
    const hasLot = [...controller.lotSelect.options].some(
      (o) => o.value === deepLinkLot,
    );
    if (hasLot) controller.lotSelect.value = deepLinkLot;
  }
  controller.lotSelect.dispatchEvent(new Event("change"));
  searchForm.requestSubmit();
  setTimeout(() => {
    applyDeepLinkViewState();
  }, 0);
  return true;
}

if (deepLinkBlock) {
  // Block options are populated asynchronously once map data loads.
  if (!applyDeepLink()) {
    const observer = new MutationObserver(() => {
      if (applyDeepLink()) observer.disconnect();
    });
    observer.observe(controller.blockSelect, { childList: true });
  }
} else {
  applyDeepLinkViewStateWhenReady();
  setupWelcomeOverlay();
}
