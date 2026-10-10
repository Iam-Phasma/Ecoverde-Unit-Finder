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
const layerDecorationOption = document.getElementById(
  "layer-decoration-option",
);
const routeClearButton = document.getElementById("route-clear");
const isPhoneDevice = detectPhoneDevice();
const FIND_ICON_SEARCH_SVG =
  '<svg class="find-toggle-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-width="2" d="m21 21-3.5-3.5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"/></svg>';
const FIND_ICON_SUCCESS_SVG =
  '<svg class="find-toggle-icon w-6 h-6 text-gray-800 dark:text-white" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 11h2v5m-2 0h4m-2.592-8.5h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>';

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

layersToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  const expanded = layersPanel.classList.toggle("hidden") === false;
  layersToggle.setAttribute("aria-expanded", String(expanded));
});

document.addEventListener("click", (e) => {
  if (
    !layersPanel.classList.contains("hidden") &&
    !layersPanel.contains(e.target)
  ) {
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
setFindIconForIdleState();
setupLyketOverrides();
updateFindButtonState();

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

  // Slow "trailer" drift of the map behind the overlay (fine-pointer, motion-ok devices only).
  const driftEnabled =
    window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    setTimeout(() => overlay.classList.add("hidden"), WELCOME_FADE_MS);
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
}

const deepLinkParams = new URLSearchParams(location.search);
const deepLinkBlock = (deepLinkParams.get("block") || "").trim();
const deepLinkLot = (deepLinkParams.get("lot") || "").trim();

function buildShareUrl() {
  const block = controller.blockSelect.value;
  const lot = controller.lotSelect.value;
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  if (block) url.searchParams.set("block", block);
  if (block && lot) url.searchParams.set("lot", lot);
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
  setupWelcomeOverlay();
}
