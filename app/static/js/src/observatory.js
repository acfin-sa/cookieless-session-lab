import { fetchWithHostAccessToken } from "./host-client.js";

const EXPIRING_WINDOW_SECONDS = 60;
const TOKEN_HIGHLIGHT_DURATION_MS = 12_000;
let snapshot = null;
let methodMap = null;
let selectedEventId = null;
let highlightedTokenIds = [];
let highlightUntil = 0;
let refreshLabelIndex = null;
let refreshLabelUntil = 0;
let refreshLabelTimer = null;
let barLabelTokenId = null;
let barLabelUntil = 0;
let barLabelTimer = null;
const GANTT_POPUP_DURATION_MS = 3000;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function methodListHtml(methods) {
  if (!methods || methods.length === 0) {
    return "—";
  }
  return methods
    .map((method) => `<span class="method-line">${escapeHtml(method)}</span>`)
    .join("");
}

function currentTokenState(token) {
  if (token.state === "consumed" || token.state === "revoked" || token.state === "expired") {
    return token.state;
  }
  if (!token.present && token.state === "unborn") {
    return "unborn";
  }
  if (!token.expires_at) {
    return token.present ? "alive" : "unborn";
  }

  const expiresAtMs = Date.parse(token.expires_at);
  if (Number.isNaN(expiresAtMs)) {
    return token.present ? "alive" : "unborn";
  }
  const remaining = (expiresAtMs - Date.now()) / 1000;
  if (remaining <= 0) {
    return "expired";
  }
  if (remaining < EXPIRING_WINDOW_SECONDS) {
    return "expiring";
  }
  return "alive";
}

function remainingSeconds(token) {
  if (!token.expires_at) {
    return null;
  }
  const expiresAtMs = Date.parse(token.expires_at);
  if (Number.isNaN(expiresAtMs)) {
    return null;
  }
  return Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
}

function formatClock(seconds) {
  if (seconds === null) {
    return "no exp";
  }
  const total = Math.max(0, Math.floor(seconds));
  if (total >= 3600) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function tokenBadge(token) {
  if (token.badge) {
    return token.badge;
  }
  if (token.layer === "B") {
    return "Looker";
  }
  if (String(token.id || "").startsWith("auth0_")) {
    return "Auth0";
  }
  if (String(token.id || "").startsWith("host_")) {
    return "Host";
  }
  if (token.layer === "A") {
    return "Host";
  }
  return `${token.layer} Layer`;
}

function tokenLifetimeSeconds(token) {
  if (!token.issued_at || !token.expires_at) {
    return null;
  }
  return Math.max(0, Math.floor((Date.parse(token.expires_at) - Date.parse(token.issued_at)) / 1000));
}

function formatLifetime(seconds) {
  if (seconds === null) {
    return null;
  }
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${seconds}s`;
}

function tokenCardTtlMetaLabel(state, remaining, lifetime) {
  if (state === "expiring" && remaining !== null) {
    return `expires in ${formatClock(remaining)}`;
  }
  if (lifetime === null) {
    return "no expiry";
  }
  if (state === "alive") {
    return `alive for ${formatLifetime(lifetime)}`;
  }
  return `lives for ${formatLifetime(lifetime)}`;
}

function iframeSessionCardHtml(iframeSession) {
  const iframeState = iframeSession?.state || "unborn";
  const iframeLabel = {
    unborn: "not started",
    alive: "usable",
    expired: "iframe session expired",
    revoked: "ended with Layer B identity",
  }[iframeState] || iframeState;
  const iframeReason = iframeSession?.state_reason
    ? `<p class="state-reason">${escapeHtml(iframeSession.state_reason)}</p>`
    : "";
  return `
    <article class="token-card layer-b-cell state-${iframeState}" data-token="${escapeHtml(iframeSession.id)}">
        <header>
          <span class="layer">Looker</span>
          <h3>${escapeHtml(iframeSession.name)}</h3>
        </header>
        <div class="storage">${escapeHtml(iframeSession?.purpose || "session-level signal.")}</div>
        <div class="state"><span>${escapeHtml(iframeLabel)}</span></div>
        ${iframeReason}
      </article>
  `;
}

function renderCards(root) {
  if (!snapshot) {
    return;
  }
  root.innerHTML = "";
  for (const token of snapshot.tokens) {
    const state = currentTokenState(token);
    const remaining = remainingSeconds(token);
    const lifetime = tokenLifetimeSeconds(token);
    const originalTtl = token.ttl_seconds || lifetime;
    let ttlRatio;
    if (remaining === null || !originalTtl) {
      ttlRatio = token.present ? 1 : 0;
    } else {
      ttlRatio = Math.min(1, remaining / Math.max(originalTtl, 1));
    }
    const card = document.createElement("article");
    card.className = `token-card state-${state}`;
    card.dataset.token = token.id;
    const ttlWidth = state === "expired" || state === "revoked" || state === "consumed" ? 100 : Math.round(ttlRatio * 100);
    const reason = token.state_reason
      ? `<p class="state-reason">${escapeHtml(token.state_reason)}</p>`
      : "";
      card.innerHTML = `
      <header>
        <span class="layer">${escapeHtml(tokenBadge(token))}</span>
        <h3>${escapeHtml(token.name)}</h3>
      </header>
      <div class="storage">Stored in <code>${escapeHtml(token.storage)}</code>.${token.purpose ? ` ${escapeHtml(token.purpose)}` : ""}</div>
      <div class="meta"><span>issued at ${token.issued_at ? new Date(token.issued_at).toLocaleTimeString() : "—"} · ${tokenCardTtlMetaLabel(state, remaining, lifetime)}</span></div>
      <div class="ttl-bar"><div class="ttl-fill" title="TTL" style="width:${ttlWidth}%"></div></div>
      <div class="state"><span>${state}${remaining !== null ? ` · ${formatClock(remaining)}` : ""}</span></div>
      ${reason}
      <dl>
        <dt>Created by:</dt><dd>${methodListHtml(token.created_by)}</dd>
        ${(token.renewed_by || []).length ? `<dt>Renewed by:</dt><dd>${methodListHtml(token.renewed_by)}</dd>` : ""}
        <dt>Consumed by:</dt><dd>${methodListHtml(token.consumed_by)}</dd>
      </dl>
    `;
    root.appendChild(card);
  }
  const iframeSessions = snapshot.iframe_sessions || [];
  for (const iframeSession of iframeSessions) {
    root.insertAdjacentHTML("beforeend", iframeSessionCardHtml(iframeSession));
  }
  applyTokenHighlights();
}

function applyTokenHighlights() {
  const active = Date.now() < highlightUntil;
  const tokenIds = active ? highlightedTokenIds : [];
  document.querySelectorAll(".token-card, .layer-b-cell").forEach((card) => {
    card.classList.toggle("hot", tokenIds.includes(card.dataset.token));
  });
}

const GANTT_LANES = [
  {
    id: "auth0",
    label: "Auth0",
    fill: "#141922",
    labelFill: "#8b97ab",
    emphasized: false,
  },
  {
    id: "host",
    label: "Host",
    fill: "#161b24",
    labelFill: "#8b97ab",
    emphasized: false,
  },
  {
    id: "looker",
    label: "Looker",
    fill: "#1a283c",
    labelFill: "#6cb6ff",
    emphasized: true,
  },
  {
    id: "iframe",
    label: "iframe",
    fill: "#12161e",
    labelFill: "#8b97ab",
    emphasized: false,
  },
];

function tokenLaneId(token) {
  if (String(token.id || "").startsWith("iframe_session")) {
    return "iframe";
  }
  const badge = tokenBadge(token);
  if (badge === "Auth0") {
    return "auth0";
  }
  if (badge === "Host") {
    return "host";
  }
  return "looker";
}

function isLookerTokenId(tokenId) {
  const token = (snapshot.tokens || []).find((item) => item.id === tokenId);
  return Boolean(token) && tokenLaneId(token) === "looker";
}

function ganttLaneRows(laneId) {
  if (laneId === "iframe") {
    return [...(snapshot.iframe_sessions || [])];
  }
  return (snapshot.tokens || []).filter((token) => tokenLaneId(token) === laneId);
}

function ganttLaneLayout() {
  const lanes = [];
  const laneGap = 10;
  let y = 8;
  for (const spec of GANTT_LANES) {
    const rows = ganttLaneRows(spec.id);
    if (rows.length === 0) {
      continue;
    }
    const headerHeight = spec.emphasized ? 24 : 18;
    const rowHeight = spec.emphasized ? 30 : 26;
    const padBottom = spec.emphasized ? 10 : 6;
    const top = y;
    const height = headerHeight + rows.length * rowHeight + padBottom;
    lanes.push({
      ...spec,
      rows,
      top,
      height,
      headerHeight,
      rowHeight,
      contentTop: top + headerHeight,
      bottom: top + height,
    });
    y += height + laneGap;
  }
  return { lanes, height: y - laneGap + 6, laneGap };
}

function ganttBarRange(token, horizonEndMs) {
  if (!token.issued_at) {
    return null;
  }
  if (!token.present && token.state === "unborn") {
    return null;
  }
  const start = Date.parse(token.issued_at);
  if (Number.isNaN(start)) {
    return null;
  }
  let end = null;
  if (token.expires_at) {
    end = Date.parse(token.expires_at);
  } else if (token.planned_expires_at) {
    end = Date.parse(token.planned_expires_at);
  }
  if (end === null || Number.isNaN(end)) {
    return null;
  }
  const clippedEnd = Math.min(end, horizonEndMs);
  return {
    start,
    end: Math.max(start, clippedEnd),
    hatchEnd: end,
  };
}

function findGanttToken(tokenId) {
  if (!snapshot || !tokenId) {
    return null;
  }
  const fromTokens = (snapshot.tokens || []).find((token) => token.id === tokenId);
  if (fromTokens) {
    return fromTokens;
  }
  const fromIframes = (snapshot.iframe_sessions || []).find((token) => token.id === tokenId);
  if (fromIframes) {
    return fromIframes;
  }
  return null;
}

const TOKENS_WITHOUT_EXPIRY = new Set(["auth0_refresh", "host_session_reference"]);

function tokenHasNoExpiry(token) {
  return TOKENS_WITHOUT_EXPIRY.has(token.id) || (!token.expires_at && !token.planned_expires_at);
}

function ganttRemainingSeconds(token) {
  if (TOKENS_WITHOUT_EXPIRY.has(token.id)) {
    return null;
  }
  const fromExpires = remainingSeconds(token);
  if (fromExpires !== null) {
    return fromExpires;
  }
  if (!token.planned_expires_at) {
    return null;
  }
  return Math.max(0, Math.floor((Date.parse(token.planned_expires_at) - Date.now()) / 1000));
}

function ganttBarLabelText(token) {
  const name = token.name || token.id;
  const state = currentTokenState(token);
  if (tokenHasNoExpiry(token) && (state === "alive" || state === "unborn")) {
    return `${name}: ${state}, does not expire`;
  }
  const remaining = ganttRemainingSeconds(token);
  if (state === "consumed" || state === "revoked" || state === "expired" || state === "unborn") {
    return `${name}: ${state}`;
  }
  if (remaining === null) {
    return `${name}: ${state}, does not expire`;
  }
  return `${name}: ${state} for ${formatClock(remaining)}`;
}

function clearRefreshLabelTimer() {
  if (refreshLabelTimer) {
    clearTimeout(refreshLabelTimer);
    refreshLabelTimer = null;
  }
}

function clearBarLabelTimer() {
  if (barLabelTimer) {
    clearTimeout(barLabelTimer);
    barLabelTimer = null;
  }
}

function ganttPopupLabelHtml(text, leftPercent) {
  const clampedPreferred = Math.min(100, Math.max(0, leftPercent));
  return `<div class="gantt-popup-label" data-preferred-left="${clampedPreferred}" style="left:${clampedPreferred}%">${escapeHtml(text)}</div>`;
}

function clampGanttPopupLabels(root) {
  const edgePadding = 6;
  const containerWidth = root.clientWidth;
  if (containerWidth <= 0) {
    return;
  }
  root.querySelectorAll(".gantt-popup-label").forEach((label) => {
    const preferredPercent = Number(label.dataset.preferredLeft);
    const preferredLeft = Number.isFinite(preferredPercent)
      ? (preferredPercent / 100) * containerWidth
      : containerWidth / 2;
    label.style.left = `${preferredLeft}px`;
    label.style.transform = "translateX(-50%)";
    const labelWidth = label.offsetWidth;
    const halfWidth = labelWidth / 2;
    const minCenter = edgePadding + halfWidth;
    const maxCenter = Math.max(minCenter, containerWidth - edgePadding - halfWidth);
    const clampedCenter = Math.min(maxCenter, Math.max(minCenter, preferredLeft));
    label.style.left = `${clampedCenter}px`;
  });
}

function renderGantt(root) {
  if (!snapshot) {
    return;
  }
  const t0 = Date.parse(snapshot.login_started_at);
  if (Number.isNaN(t0)) {
    root.innerHTML = "";
    return;
  }
  const now = Date.now();
  const horizon = Math.max(now - t0 + 60_000, 12 * 60_000);
  const horizonEndMs = t0 + horizon;
  const left = 196;
  const width = 720;
  const { lanes, height, laneGap } = ganttLaneLayout();
  const x = (ms) => left + ((ms - t0) / horizon) * (width - left - 16);
  const parts = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Lifetime swimlane with Auth0, Host, Looker, and iframe lanes">`);
  parts.push(`
    <defs>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="#10141c" stroke-width="3"></line>
      </pattern>
    </defs>
  `);
  for (const [laneIndex, lane] of lanes.entries()) {
    parts.push(`<rect x="0" y="${lane.top}" width="${width}" height="${lane.height}" fill="${lane.fill}"></rect>`);
    if (lane.emphasized) {
      parts.push(`<rect x="0" y="${lane.top}" width="4" height="${lane.height}" fill="#6cb6ff"></rect>`);
    }
    if (laneIndex > 0) {
      const separatorY = lane.top - laneGap / 2;
      parts.push(`<line x1="0" x2="${width}" y1="${separatorY}" y2="${separatorY}" stroke="#c5cedb" stroke-width="2"></line>`);
    }
    const labelX = lane.emphasized ? 12 : 8;
    parts.push(`<text x="${labelX}" y="${lane.top + lane.headerHeight - 5}" fill="${lane.labelFill}" font-size="${lane.emphasized ? 12 : 10}" font-weight="700">${escapeHtml(lane.label)}</text>`);
    lane.rows.forEach((token, index) => {
      const y = lane.contentTop + index * lane.rowHeight + (lane.rowHeight - 14) / 2;
      const state = currentTokenState(token);
      const color = {
        alive: "#3dd68c",
        expiring: "#f0b429",
        expired: "#ef5b5b",
        consumed: "#b57bff",
        revoked: "#c45c5c",
        unborn: "#5b6578",
      }[state];
      parts.push(`<text x="10" y="${y + 11}" fill="#c5cedb" font-size="11">${escapeHtml(token.name || token.id)}</text>`);
      const range = ganttBarRange(token, horizonEndMs);
      if (range) {
        const x1 = x(range.start);
        const x2 = Math.max(x1 + 4, x(range.end));
        parts.push(`<rect class="gantt-bar-hit" data-bar-token-id="${escapeHtml(token.id)}" x="${x1}" y="${y}" width="${x2 - x1}" height="14" rx="3" fill="${color}" opacity="0.85" cursor="pointer"></rect>`);
        if ((token.id === "navigation_token" || token.id === "api_token") && token.expires_at) {
          const windowStart = range.hatchEnd - EXPIRING_WINDOW_SECONDS * 1000;
          const wx1 = x(windowStart);
          const wx2 = x(Math.min(range.hatchEnd, horizonEndMs));
          parts.push(`<rect x="${wx1}" y="${y}" width="${Math.max(0, wx2 - wx1)}" height="14" fill="url(#hatch)" pointer-events="none"></rect>`);
        }
      }
    });
  }
  const chartTop = lanes[0]?.top ?? 8;
  const chartBottom = lanes[lanes.length - 1]?.bottom ?? height;
  for (const [index, marker] of (snapshot.refresh_markers || []).entries()) {
    const at = marker.at || marker;
    const process = marker.process || "token renew";
    const mx = x(Date.parse(at));
    parts.push(`<line x1="${mx}" x2="${mx}" y1="${chartTop}" y2="${chartBottom}" stroke="#6cb6ff" stroke-dasharray="3 3" pointer-events="none"></line>`);
    parts.push(`<rect class="refresh-hit" data-refresh-index="${index}" data-refresh-process="${escapeHtml(process)}" x="${mx - 6}" y="${chartTop}" width="12" height="${Math.max(0, chartBottom - chartTop)}" fill="transparent" cursor="pointer"></rect>`);
  }
  const nowX = x(now);
  parts.push(`<line x1="${nowX}" x2="${nowX}" y1="${chartTop}" y2="${chartBottom}" stroke="#e8eef7" pointer-events="none"></line>`);
  parts.push("</svg>");
  const refreshLabelStillOpen = refreshLabelIndex !== null && Date.now() < refreshLabelUntil;
  const openMarker = refreshLabelStillOpen ? (snapshot.refresh_markers || [])[refreshLabelIndex] : null;
  if (openMarker) {
    const at = openMarker.at || openMarker;
    const process = openMarker.process || "token renew";
    const leftPercent = (x(Date.parse(at)) / width) * 100;
    parts.push(ganttPopupLabelHtml(process, leftPercent));
  } else {
    refreshLabelIndex = null;
  }
  const barLabelStillOpen = barLabelTokenId !== null && Date.now() < barLabelUntil;
  const openBarToken = barLabelStillOpen ? findGanttToken(barLabelTokenId) : null;
  if (openBarToken) {
    const range = ganttBarRange(openBarToken, horizonEndMs);
    if (range) {
      const midX = x((range.start + range.end) / 2);
      const leftPercent = (midX / width) * 100;
      parts.push(ganttPopupLabelHtml(ganttBarLabelText(openBarToken), leftPercent));
    }
  } else {
    barLabelTokenId = null;
  }
  root.innerHTML = parts.join("");
  clampGanttPopupLabels(root);
}

function isLookerEvent(event) {
  const method = String(event.method || "");
  if (method.startsWith("postMessage") || method.startsWith("iframe navigation")) {
    return false;
  }
  const tokenIds = [...(event.tokens_in || []), ...(event.tokens_out || [])];
  return tokenIds.some(isLookerTokenId);
}

// live event log table
function renderEvents(root) {
  if (!snapshot) {
    return;
  }
  root.innerHTML = "";
  const events = [...(snapshot.events || [])].reverse();
  for (const event of events) {
    const row = document.createElement("div");
    row.className = `event-row${isLookerEvent(event) ? " looker" : ""}${event.ok ? "" : " fail"}${String(event.id) === String(selectedEventId) ? " active" : ""}`;
    row.dataset.eventId = event.id;
    row.dataset.tokens = [...(event.tokens_in || []), ...(event.tokens_out || [])].join(",");
    const when = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : "";
    const tokensIn = escapeHtml((event.tokens_in || []).join(", ") || "—");
    const tokensOut = escapeHtml((event.tokens_out || []).join(", ") || "—");
    row.innerHTML = `
      <div><span class="when">${escapeHtml(when)}</span> · <span class="actor">${escapeHtml(event.actor)}</span></div>
      <div><strong>${escapeHtml(event.method)}</strong></div>
      <div>${escapeHtml(event.summary || "")}</div>
      <div class="when">in: ${joinCatalogList(event.tokens_in) || "—"} · out: ${joinCatalogList(event.tokens_out) || "—"}</div>
    `;
    root.appendChild(row);
  }
}

const CATALOG_COLUMN_COUNT = 6;

// Looker Admin acquire/generate/end are host-only APIs both embed tabs call.
// Catalog them once under EmbedSDK (the default tab); do not duplicate under Raw iFrame.
// iframe_embed_login is the shared /login/embed navigation — also listed once under EmbedSDK.
const CATALOG_GROUPS = [
  { id: "auth0", label: "Auth0" },
  { id: "host", label: "Host" },
  { id: "embed-sdk", label: "Embed SDK" },
  { id: "raw-iframe", label: "Raw iFrame" },
];

function catalogGroupId(method) {
  return method.group || "";
}

function joinCatalogList(values) {
  return (values || []).map((value) => escapeHtml(value)).join(", ");
}

function appendCatalogGroupHeader(body, label) {
  const row = document.createElement("tr");
  row.className = "catalog-group-row";
  const heading = document.createElement("th");
  heading.colSpan = CATALOG_COLUMN_COUNT;
  heading.scope = "colgroup";
  heading.textContent = label;
  row.appendChild(heading);
  body.appendChild(row);
}

function appendCatalogMethodRow(body, method) {
  const row = document.createElement("tr");
  row.innerHTML = `
      <td>${escapeHtml(method.method)}</td>
      <td>${escapeHtml(method.kind || "—")}</td>
      <td>${escapeHtml(method.direction)}</td>
      <td>${joinCatalogList(method.tokens_in)}</td>
      <td>${joinCatalogList(method.tokens_out)}</td>
      <td>${escapeHtml(method.where_after || "")}</td>
    `;
  body.appendChild(row);
}

function renderCatalog(table, map) {
  table.innerHTML = `
    <thead>
      <tr>
        <th>method</th>
        <th>role</th>
        <th>direction</th>
        <th>tokens in</th>
        <th>tokens out</th>
        <th>where token lives after</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const body = table.querySelector("tbody");
  const methods = map.methods || [];
  const grouped = new Map(CATALOG_GROUPS.map((group) => [group.id, []]));
  const ungrouped = [];
  for (const method of methods) {
    const groupId = catalogGroupId(method);
    if (grouped.has(groupId)) {
      grouped.get(groupId).push(method);
    } else {
      ungrouped.push(method);
    }
  }
  for (const group of CATALOG_GROUPS) {
    const groupMethods = grouped.get(group.id) || [];
    if (groupMethods.length === 0) {
      continue;
    }
    appendCatalogGroupHeader(body, group.label);
    for (const method of groupMethods) {
      appendCatalogMethodRow(body, method);
    }
  }
  for (const method of ungrouped) {
    appendCatalogMethodRow(body, method);
  }
}

export function highlightTokens(tokenIds, durationMs = TOKEN_HIGHLIGHT_DURATION_MS) {
  highlightedTokenIds = tokenIds;
  highlightUntil = Date.now() + durationMs;
  applyTokenHighlights();
}

export function remainingNavigationAndApiSeconds() {
  if (!snapshot) {
    return { navigation: null, api: null };
  }
  const byId = Object.fromEntries(snapshot.tokens.map((token) => [token.id, token]));
  return {
    navigation: remainingSeconds(byId.navigation_token || {}),
    api: remainingSeconds(byId.api_token || {}),
    flags: snapshot.flags,
  };
}

export function bindObservatory(elements) {
  methodMap = JSON.parse(document.getElementById("method-map").textContent);
  renderCatalog(elements.catalog, methodMap);

  elements.events.addEventListener("click", (event) => {
    const row = event.target.closest(".event-row");
    if (!row) {
      return;
    }
    selectedEventId = row.dataset.eventId;
    highlightTokens((row.dataset.tokens || "").split(",").filter(Boolean));
    renderEvents(elements.events);
  });

  elements.gantt.addEventListener("click", (event) => {
    const barHit = event.target.closest("[data-bar-token-id]");
    if (barHit) {
      clearRefreshLabelTimer();
      refreshLabelIndex = null;
      refreshLabelUntil = 0;
      barLabelTokenId = barHit.dataset.barTokenId;
      barLabelUntil = Date.now() + GANTT_POPUP_DURATION_MS;
      clearBarLabelTimer();
      barLabelTimer = setTimeout(() => {
        barLabelTokenId = null;
        barLabelUntil = 0;
        renderGantt(elements.gantt);
      }, GANTT_POPUP_DURATION_MS);
      renderGantt(elements.gantt);
      return;
    }
    const hit = event.target.closest("[data-refresh-index]");
    if (!hit) {
      return;
    }
    clearBarLabelTimer();
    barLabelTokenId = null;
    barLabelUntil = 0;
    refreshLabelIndex = Number(hit.dataset.refreshIndex);
    refreshLabelUntil = Date.now() + GANTT_POPUP_DURATION_MS;
    clearRefreshLabelTimer();
    refreshLabelTimer = setTimeout(() => {
      refreshLabelIndex = null;
      refreshLabelUntil = 0;
      renderGantt(elements.gantt);
    }, GANTT_POPUP_DURATION_MS);
    renderGantt(elements.gantt);
  });

  let pollInFlight = false;
  async function poll() {
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;
    try {
      const nextSnapshot = await fetchWithHostAccessToken("/api/lab/snapshot");
      if (!nextSnapshot || typeof nextSnapshot !== "object") {
        return;
      }
      snapshot = nextSnapshot;
      renderCards(elements.cards);
      renderGantt(elements.gantt);
      renderEvents(elements.events);
      if (elements.freeze) {
        elements.freeze.checked = Boolean(snapshot.flags?.freeze_token_refresh);
      }
      if (elements.userAgentMismatchToggle) {
        elements.userAgentMismatchToggle.checked = Boolean(snapshot.flags?.force_user_agent_mismatch);
      }
    } catch (error) {
      console.warn("Observatory snapshot poll failed", error);
    } finally {
      pollInFlight = false;
    }
  }

  poll();
  setInterval(() => {
    if (snapshot) {
      renderCards(elements.cards);
      renderGantt(elements.gantt);
    }
  }, 1000);
  setInterval(poll, 4000);

  return { poll };
}
