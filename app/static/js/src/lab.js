import { api, bootstrapHostSession } from "./host-client.js";
import { bindObservatory, navApiRemaining } from "./observatory.js";
import { startEmbedSdkTab, stopEmbedSdkTab } from "./embed-sdk-tab.js";
import { startPostMessageTab, stopPostMessageTab } from "./postmessage-tab.js";

const pageConfig = JSON.parse(document.getElementById("page-config").textContent);
const SPLIT_STORAGE_KEY = "lab-observatory-width";
const HEIGHT_STORAGE_KEY = "lab-split-height";
let activeTab = "sdk";
let runningTab = null;

function requireElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id} in lab.html — run npm run build:js if you edited src/`);
  }
  return element;
}

function bind(id, event, handler) {
  requireElement(id).addEventListener(event, handler);
}

function showLabError(message) {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p class="hint" style="padding:1rem">${message}</p>`
  );
}

function bindSplitPanel() {
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

function updateOverlays() {
  const remaining = navApiRemaining();
  const soonest = [remaining.navigation, remaining.api]
    .filter((value) => value !== null)
    .sort((left, right) => left - right)[0];
  const overlays = [requireElement("overlay-sdk"), requireElement("overlay-pm")];
  for (const overlay of overlays) {
    if (soonest === undefined || soonest >= 60) {
      overlay.classList.add("hidden");
      overlay.textContent = "";
    } else {
      overlay.classList.remove("hidden");
      overlay.textContent = `nav/api expiring in ${soonest}s — Looker refresh window`;
    }
  }
}

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  requireElement("stage-sdk").classList.toggle("hidden", tab !== "sdk");
  requireElement("stage-postmessage").classList.toggle("hidden", tab !== "postmessage");
  requireElement("tab-caption").textContent =
    tab === "sdk"
      ? "SDK tab: initCookieless moves tokens for you. Compare with the postMessage tab."
      : "Raw postMessage tab: you will see session:tokens:request and session:tokens in the log.";
}

async function startActiveTab() {
  if (activeTab === runningTab) {
    return;
  }
  if (activeTab === "sdk") {
    stopPostMessageTab();
    runningTab = "sdk";
    startEmbedSdkTab(pageConfig);
    return;
  }
  stopEmbedSdkTab();
  runningTab = "postmessage";
  await startPostMessageTab(pageConfig);
}

function initLabUi() {
  bindSplitPanel();
  bindHeightSplit();
  bindObservatory({
    cards: requireElement("token-cards"),
    gantt: requireElement("gantt"),
    events: requireElement("event-log"),
    catalog: requireElement("method-catalog"),
    freeze: requireElement("toggle-freeze"),
    ua: requireElement("toggle-ua"),
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", async () => {
      setTab(button.dataset.tab);
      await startActiveTab();
    });
  });

  bind("toggle-freeze", "change", async (event) => {
    await api("/api/lab/controls", {
      method: "POST",
      body: JSON.stringify({ freeze_token_refresh: event.target.checked }),
    });
  });

  bind("toggle-ua", "change", async (event) => {
    await api("/api/lab/controls", {
      method: "POST",
      body: JSON.stringify({ force_user_agent_mismatch: event.target.checked }),
    });
  });

  bind("btn-drop-ref", "click", async () => {
    await api("/api/lab/drop-session-reference", { method: "POST" });
  });

  bind("btn-end-looker", "click", async () => {
    await api("/api/looker/end-embed-session", { method: "POST" });
    stopEmbedSdkTab();
    stopPostMessageTab();
    runningTab = null;
    await startActiveTab();
  });

  setInterval(updateOverlays, 1000);
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
    await startActiveTab();
  } catch (error) {
    console.warn("[lab] UI init failed", error.message);
    showLabError(`Lab UI failed to initialize: ${error.message}`);
  }
}

main();
