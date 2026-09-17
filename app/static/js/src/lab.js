import { fetchWithHostAccessToken, bootstrapHostSession } from "./host-client.js";
import { bindObservatory, remainingNavigationAndApiSeconds } from "./observatory.js";
import { startEmbedSdkTab, stopEmbedSdkTab } from "./embed-sdk-tab.js";
import { startPostMessageTab, stopPostMessageTab } from "./postmessage-tab.js";

const pageConfig = JSON.parse(document.getElementById("page-config").textContent);
const SPLIT_STORAGE_KEY = "lab-observatory-width";
const HEIGHT_STORAGE_KEY = "lab-split-height";
const EMBED_SDK_TAB = "embed-sdk";
const POSTMESSAGE_TAB = "postmessage";
let selectedTab = EMBED_SDK_TAB;
let mountedEmbedTab = null;

function requireElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id} in lab.html — run npm run build:js if you edited src/`);
  }
  return element;
}

function onElementEvent(id, event, handler) {
  requireElement(id).addEventListener(event, handler);
}

function showLabError(message) {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p class="hint" style="padding:1rem">${message}</p>`
  );
}

function bindWidthSplit() {
  const grid = document.querySelector(".lab-grid");
  const observatory = grid.querySelector(".observatory");
  const handle = requireElement("lab-resize-handle");
  const savedWidth = localStorage.getItem(SPLIT_STORAGE_KEY);
  if (savedWidth) {
    observatory.style.flexBasis = savedWidth;
  }

  let dragging = false;

  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    dragging = true;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (event) => {
    if (!dragging) {
      return;
    }
    const rect = grid.getBoundingClientRect();
    const minWidth = 280;
    const maxWidth = rect.width - 280 - handle.offsetWidth;
    const width = Math.min(maxWidth, Math.max(minWidth, event.clientX - rect.left));
    observatory.style.flexBasis = `${width}px`;
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(SPLIT_STORAGE_KEY, observatory.style.flexBasis);
  });
}

function bindHeightSplit() {
  const grid = document.querySelector(".lab-grid");
  const handle = requireElement("lab-height-handle");
  const savedHeight = localStorage.getItem(HEIGHT_STORAGE_KEY);
  if (savedHeight) {
    grid.style.height = savedHeight;
  }

  let dragging = false;

  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    dragging = true;
    handle.classList.add("dragging");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (event) => {
    if (!dragging) {
      return;
    }
    const rect = grid.getBoundingClientRect();
    const minHeight = 280;
    const height = Math.max(minHeight, event.clientY - rect.top);
    grid.style.height = `${height}px`;
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(HEIGHT_STORAGE_KEY, grid.style.height);
  });
}

function updateExpiryCountdownOverlays() {
  const remaining = remainingNavigationAndApiSeconds();
  const soonestRemainingSeconds = [remaining.navigation, remaining.api]
    .filter((value) => value !== null)
    .sort((left, right) => left - right)[0];
  const overlays = [requireElement("overlay-embed-sdk"), requireElement("overlay-postmessage")];
  for (const overlay of overlays) {
    if (soonestRemainingSeconds === undefined || soonestRemainingSeconds >= 60) {
      overlay.classList.add("hidden");
      overlay.textContent = "";
    } else {
      overlay.classList.remove("hidden");
      overlay.textContent = `nav/api expiring in ${soonestRemainingSeconds}s — Looker refresh window`;
    }
  }
}

function selectTab(tab) {
  selectedTab = tab;
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  requireElement("stage-embed-sdk").classList.toggle("hidden", tab !== EMBED_SDK_TAB);
  requireElement("stage-postmessage").classList.toggle("hidden", tab !== POSTMESSAGE_TAB);
  requireElement("tab-caption").textContent =
    tab === EMBED_SDK_TAB
      ? "SDK tab: initCookieless moves tokens for you. Compare with the postMessage tab."
      : "Raw postMessage tab: you will see session:tokens:request and session:tokens in the log.";
}

async function startSelectedTab() {
  if (selectedTab === mountedEmbedTab) {
    return;
  }
  if (selectedTab === EMBED_SDK_TAB) {
    stopPostMessageTab();
    mountedEmbedTab = EMBED_SDK_TAB;
    startEmbedSdkTab(pageConfig);
    return;
  }
  stopEmbedSdkTab();
  mountedEmbedTab = POSTMESSAGE_TAB;
  await startPostMessageTab(pageConfig);
}

function initLabUi() {
  bindWidthSplit();
  bindHeightSplit();
  bindObservatory({
    cards: requireElement("token-cards"),
    gantt: requireElement("gantt"),
    events: requireElement("event-log"),
    catalog: requireElement("method-catalog"),
    freeze: requireElement("toggle-freeze"),
    userAgentMismatchToggle: requireElement("toggle-user-agent-mismatch"),
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", async () => {
      selectTab(button.dataset.tab);
      await startSelectedTab();
    });
  });

  onElementEvent("toggle-freeze", "change", async (event) => {
    await fetchWithHostAccessToken("/api/lab/controls", {
      method: "POST",
      body: JSON.stringify({ freeze_token_refresh: event.target.checked }),
    });
  });

  onElementEvent("toggle-user-agent-mismatch", "change", async (event) => {
    await fetchWithHostAccessToken("/api/lab/controls", {
      method: "POST",
      body: JSON.stringify({ force_user_agent_mismatch: event.target.checked }),
    });
  });

  onElementEvent("btn-drop-session-reference", "click", async () => {
    await fetchWithHostAccessToken("/api/lab/drop-session-reference", { method: "POST" });
  });

  onElementEvent("btn-end-looker", "click", async () => {
    await fetchWithHostAccessToken("/api/looker/end-embed-session", { method: "POST" });
    stopEmbedSdkTab();
    stopPostMessageTab();
    mountedEmbedTab = null;
    await startSelectedTab();
  });

  setInterval(updateExpiryCountdownOverlays, 1000);
}

async function main() {
  try {
    await bootstrapHostSession();
  } catch (error) {
    console.warn("[lab] host bootstrap failed", error.message);
    showLabError(`Could not bootstrap host session: ${error.message}. Try /login.`);
    return;
  }

  try {
    initLabUi();
    await startSelectedTab();
  } catch (error) {
    console.warn("[lab] UI init failed", error.message);
    showLabError(`Lab UI failed to initialize: ${error.message}`);
  }
}

main();
