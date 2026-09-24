import {
  bootstrapHostSession,
  fetchWithHostAccessToken,
  printLookerIframeTokens,
} from "./host-client.js";
import { bindObservatory, remainingNavigationAndApiSeconds } from "./observatory.js";
import { startEmbedSdkTab, stopEmbedSdkTab } from "./embed-sdk-tab.js";

const pageConfig = JSON.parse(document.getElementById("page-config").textContent);
const SPLIT_STORAGE_KEY = "lab-observatory-width";
const HEIGHT_STORAGE_KEY = "lab-split-height";

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
  const paragraph = document.createElement("p");
  paragraph.className = "hint";
  paragraph.style.padding = "1rem";
  paragraph.textContent = message;
  document.body.insertAdjacentElement("afterbegin", paragraph);
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
  const overlay = requireElement("overlay-embed-sdk");
  const refreshWindowSeconds = remaining.refreshWindowSeconds ?? 60;
  if (soonestRemainingSeconds === undefined || soonestRemainingSeconds >= refreshWindowSeconds) {
    overlay.classList.add("hidden");
    overlay.textContent = "";
  } else {
    overlay.classList.remove("hidden");
    overlay.textContent = `nav/api expiring in ${soonestRemainingSeconds}s — Looker refresh window`;
  }
}

function startEmbed() {
  startEmbedSdkTab(pageConfig);
}

let lookerEmbedConnected = false;

function showLookerSessionButton(connected) {
  lookerEmbedConnected = connected;
  const button = requireElement("btn-end-looker");
  if (connected) {
    button.textContent = "End Looker session";
    button.title =
      "Delete the Looker cookieless session and clear Layer B tokens on the host. Auth0 login stays. The embed stays blank until you start a Looker session.";
    return;
  }
  button.textContent = "Start Looker session";
  button.title = "Acquire a new Looker cookieless session and connect the Embed SDK.";
}

function showEmbedWaitingForStart() {
  const root = document.getElementById("embed-sdk-root");
  if (!root) {
    return;
  }
  root.textContent = "Looker session ended. Start Looker session to acquire and connect the embed.";
}

function formatPageElapsed(totalSeconds) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function startPageElapsedTimer() {
  const element = requireElement("page-elapsed");
  const render = () => {
    const elapsedSeconds = performance.now() / 1000;
    element.textContent = formatPageElapsed(elapsedSeconds);
    element.dateTime = `PT${Math.floor(elapsedSeconds)}S`;
  };
  render();
  setInterval(render, 1000);
}

function initLabUi() {
  bindWidthSplit();
  bindHeightSplit();
  const observatory = bindObservatory({
    cards: requireElement("token-cards"),
    gantt: requireElement("gantt"),
    events: requireElement("event-log"),
    eventLogCopy: requireElement("btn-copy-event-log"),
    catalog: requireElement("method-catalog"),
    freeze: requireElement("toggle-freeze"),
  });

  async function postLabControl(body, revert) {
    try {
      await fetchWithHostAccessToken("/api/lab/controls", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await observatory.poll();
    } catch (error) {
      if (revert) {
        revert();
      }
      showLabError(`Lab control request failed: ${error.message}`);
    }
  }

  onElementEvent("toggle-freeze", "change", async (event) => {
    const checked = event.target.checked;
    await postLabControl({ freeze_token_refresh: checked }, () => {
      event.target.checked = !checked;
    });
  });

  onElementEvent("btn-drop-session-reference", "click", async () => {
    try {
      await fetchWithHostAccessToken("/api/lab/drop-session-reference", { method: "POST" });
      await observatory.poll();
    } catch (error) {
      showLabError(`Drop session reference failed: ${error.message}`);
    }
  });

  onElementEvent("btn-end-looker", "click", async () => {
    if (!lookerEmbedConnected) {
      try {
        startEmbed();
        showLookerSessionButton(true);
        await observatory.poll();
      } catch (error) {
        showLabError(`Start Looker session failed: ${error.message}`);
      }
      return;
    }
    try {
      await fetchWithHostAccessToken("/api/looker/end-embed-session", { method: "POST" });
      stopEmbedSdkTab();
      showEmbedWaitingForStart();
      showLookerSessionButton(false);
      await observatory.poll();
    } catch (error) {
      showLabError(`End Looker session failed: ${error.message}`);
    }
  });

  setInterval(updateExpiryCountdownOverlays, 1000);
}

async function main() {
  globalThis.labPrintLookerIframeTokens = printLookerIframeTokens;
  startPageElapsedTimer();
  try {
    await bootstrapHostSession();
  } catch (error) {
    console.warn("[lab] host bootstrap failed", error.message);
    showLabError(`Could not bootstrap host session: ${error.message}. Try /login.`);
    return;
  }

  try {
    initLabUi();
    startEmbed();
    showLookerSessionButton(true);
  } catch (error) {
    console.warn("[lab] UI init failed", error.message);
    showLabError(`Lab UI failed to initialize: ${error.message}`);
  }
}

main();
