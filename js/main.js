// Bootstraps the map and wires up the search form + layers menu UI.
import { createMapController } from "./map-controller.js";

const controller = createMapController();
controller.loadData("data/ecoverde.geojson");

const searchForm = document.getElementById("search-form");
const findButton = searchForm.querySelector('button[type="submit"]');
const layersToggle = document.getElementById("layers-toggle");
const layersPanel = document.getElementById("layers-panel");
const layerObstacle = document.getElementById("layer-obstacle");
const layerAdministrative = document.getElementById("layer-administrative");
const layerRoadNames = document.getElementById("layer-road-names");
const routeClearButton = document.getElementById("route-clear");

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
});

layerAdministrative.addEventListener("change", () => {
  controller.setLayerVisibility("administrative", layerAdministrative.checked);
});

layerRoadNames.addEventListener("change", () => {
  controller.setLayerVisibility("roadNames", layerRoadNames.checked);
});

controller.blockSelect.addEventListener("change", updateFindButtonState);
controller.lotSelect.addEventListener("change", updateFindButtonState);
routeClearButton?.addEventListener("click", resetSelectionInputs);

// Default state: all optional layers are off.
controller.setLayerVisibility("roadNames", layerRoadNames.checked);
controller.setLayerVisibility("administrative", layerAdministrative.checked);
controller.setLayerVisibility("obstacle", layerObstacle.checked);
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
