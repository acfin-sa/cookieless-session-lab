import { fetchWithHostAccessToken } from "./host-client.js";

const EXPIRING_WINDOW_SECONDS_FALLBACK = 60;

function refreshWindowSeconds() {
  const value = Number(snapshot?.looker_refresh_window_seconds);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return EXPIRING_WINDOW_SECONDS_FALLBACK;
}
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
let barLabelSpanIndex = null;
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
  // authentication_token is ~30s and single-use. The 60s hatch is the nav/api ask window.
  if (token.id !== "authentication_token" && remaining < refreshWindowSeconds()) {
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

function tokenCardTtlMetaLabel(state, remaining, lifetime, token) {
  if (token?.id === "authentication_token" && state === "consumed") {
    const spans = tokenSpans(token);
    const span = spans[spans.length - 1];
    const contract = span ? secondsBetweenIso(span.issued_at, span.expires_at) : null;
    if (contract !== null) {
      return `single-use window ${formatClock(contract)}`;
    }
  }
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
    const hideConsumedClock = token.id === "authentication_token" && state === "consumed";
    const remainingLabel = !hideConsumedClock && remaining !== null ? ` · ${formatClock(remaining)}` : "";
      card.innerHTML = `
      <header>
        <span class="layer">${escapeHtml(tokenBadge(token))}</span>
        <h3>${escapeHtml(token.name)}</h3>
      </header>
      <div class="storage">Stored in <code>${escapeHtml(token.storage)}</code>.${token.purpose ? ` ${escapeHtml(token.purpose)}` : ""}</div>
      <div class="meta"><span>issued at ${token.issued_at ? new Date(token.issued_at).toLocaleTimeString() : "—"} · ${tokenCardTtlMetaLabel(state, remaining, lifetime, token)}</span></div>
      <div class="ttl-bar"><div class="ttl-fill" title="TTL" style="width:${ttlWidth}%"></div></div>
      <div class="state"><span>${state}${remainingLabel}</span></div>
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

function tokenSpans(token) {
  if (Array.isArray(token.spans) && token.spans.length > 0) {
    return token.spans;
  }
  if (!token.issued_at) {
    return [];
  }
  const end = token.expires_at || token.planned_expires_at;
  if (!end) {
    return [];
  }
  return [
    {
      issued_at: token.issued_at,
      expires_at: end,
      closed_at: null,
      close_reason: null,
    },
  ];
}

function parseIsoMs(value) {
  const ms = Date.parse(value || "");
  return Number.isNaN(ms) ? null : ms;
}

function spanContractEndMs(span) {
  return parseIsoMs(span.expires_at);
}

function spanDrawEndMs(span) {
  const contractEnd = spanContractEndMs(span);
  if (contractEnd === null) {
    return null;
  }
  if (span.close_reason === "revoked" && span.closed_at) {
    const closed = parseIsoMs(span.closed_at);
    const start = parseIsoMs(span.issued_at);
    if (closed !== null && start !== null) {
      return Math.max(start, Math.min(contractEnd, closed));
    }
  }
  return contractEnd;
}

function secondsBetweenIso(startIso, endIso) {
  const start = parseIsoMs(startIso);
  const end = parseIsoMs(endIso);
  if (start === null || end === null) {
    return null;
  }
  return Math.max(0, Math.round((end - start) / 1000));
}

function ganttLaneLayout() {
  const lanes = [];
  const laneGap = 10;
  let y = 8;
  for (const spec of GANTT_LANES) {
    const tokens = ganttLaneRows(spec.id);
    if (tokens.length === 0) {
      continue;
    }
    const headerHeight = spec.emphasized ? 24 : 18;
    const padBottom = spec.emphasized ? 10 : 6;
    const defaultRowHeight = spec.emphasized ? 30 : 26;
    const top = y;
    let cursor = top + headerHeight;
    const rows = tokens.map((token) => {
      const spans = spec.id === "looker" ? tokenSpans(token) : [];
      const spanCount = spec.id === "looker" ? Math.max(1, spans.length) : 1;
      let height = defaultRowHeight;
      let barHeight = 14;
      let barGap = 3;
      if (spanCount > 1) {
        barHeight = 10;
        barGap = 3;
        height = 4 + spanCount * barHeight + (spanCount - 1) * barGap + 4;
      }
      const row = {
        token,
        top: cursor,
        height,
        barHeight,
        barGap,
        spanCount,
      };
      cursor += height;
      return row;
    });
    const height = headerHeight + rows.reduce((sum, row) => sum + row.height, 0) + padBottom;
    lanes.push({
      ...spec,
      rows,
      top,
      height,
      headerHeight,
      bottom: top + height,
    });
    y += height + laneGap;
  }
  return { lanes, height: Math.max(14, y - laneGap + 6), laneGap };
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
  let contractEnd = null;
  if (token.expires_at) {
    contractEnd = Date.parse(token.expires_at);
  } else if (token.planned_expires_at) {
    contractEnd = Date.parse(token.planned_expires_at);
  }
  if (contractEnd === null || Number.isNaN(contractEnd)) {
    return null;
  }
  const end = Math.max(start, contractEnd);
  const visibleEnd = Math.max(start, Math.min(end, horizonEndMs));
  return {
    start,
    end,
    visibleEnd,
    clipped: end > horizonEndMs + 500,
  };
}

function ganttHorizonEndMs(t0, now) {
  let end = Math.max(t0 + 12 * 60 * 1000, now + 45 * 1000);
  for (const token of snapshot.tokens || []) {
    if (tokenLaneId(token) !== "looker") {
      continue;
    }
    for (const span of tokenSpans(token)) {
      const drawEnd = spanDrawEndMs(span);
      if (drawEnd !== null) {
        end = Math.max(end, drawEnd);
      }
    }
  }
  for (const iframe of snapshot.iframe_sessions || []) {
    const expiredAt = parseIsoMs(iframe.expires_at);
    const plannedAt = parseIsoMs(iframe.planned_expires_at);
    if (expiredAt !== null) {
      end = Math.max(end, expiredAt);
    }
    if (plannedAt !== null) {
      end = Math.max(end, plannedAt);
    }
  }
  return end + 12 * 1000;
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

function tokenHasNoExpiry(token) {
  return !token.expires_at && !token.planned_expires_at;
}

function ganttRemainingSeconds(token) {
  if (tokenHasNoExpiry(token)) {
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

const GANTT_STATE_COLORS = {
  alive: "#3dd68c",
  expiring: "#f0b429",
  expired: "#ef5b5b",
  consumed: "#b57bff",
  revoked: "#c45c5c",
  unborn: "#5b6578",
};

function spanFill(token, span) {
  if (!span.closed_at) {
    return GANTT_STATE_COLORS[currentTokenState(token)] || GANTT_STATE_COLORS.alive;
  }
  if (span.close_reason === "consumed") {
    return GANTT_STATE_COLORS.consumed;
  }
  if (span.close_reason === "revoked") {
    return GANTT_STATE_COLORS.revoked;
  }
  if (span.close_reason === "dropped") {
    return "#6cb6ff";
  }
  if (span.close_reason === "replaced" || span.close_reason === "refreshed") {
    return GANTT_STATE_COLORS.alive;
  }
  return GANTT_STATE_COLORS.unborn;
}

function ganttSpanLabelText(token, span) {
  const name = token.name || token.id;
  const askWindow = refreshWindowSeconds();
  const contract = secondsBetweenIso(span.issued_at, span.expires_at);
  const contractText = contract === null ? "unknown window" : formatClock(contract);
  if (token.id === "authentication_token") {
    if (span.close_reason === "consumed") {
      return `${name}: single-use window ${contractText}. Tick marks /login/embed. The window is the Looker TTL.`;
    }
    return `${name}: single-use window ${contractText}. Acquire mints it. generate_tokens leaves it unchanged.`;
  }
  if (token.id === "session_reference_token") {
    if (span.close_reason === "dropped") {
      return `${name}: session window ${contractText}. Tick is the host dropping its copy. Looker keeps the session until the bar ends.`;
    }
    if (span.close_reason === "revoked") {
      return `${name}: ended at the bar tip. Session window was ${contractText}. generate_tokens leaves this expiry on its original countdown.`;
    }
    if (span.close_reason === "replaced") {
      return `${name}: previous session window ${contractText}. A later acquire started a new session.`;
    }
    return `${name}: session window ${contractText}. generate_tokens leaves this expiry on its original countdown.`;
  }
  if (token.id === "navigation_token" || token.id === "api_token") {
    const job = token.id === "navigation_token" ? "in-iframe navigation" : "iframe Looker API calls";
    if (span.close_reason === "refreshed") {
      const closed = parseIsoMs(span.closed_at);
      const contractEnd = spanContractEndMs(span);
      const hatchStart = contractEnd === null ? null : contractEnd - askWindow * 1000;
      if (closed !== null && hatchStart !== null && closed >= hatchStart) {
        return `${name}: window ${contractText} (${job}). Replaced inside the hatched last ${askWindow}s, when Looker asked.`;
      }
      return `${name}: window ${contractText} (${job}). Replaced when Looker asked for the other sibling, which was already inside its last ${askWindow}s.`;
    }
    if (span.close_reason === "replaced") {
      return `${name}: window ${contractText} (${job}). Acquire minted the next JWT.`;
    }
    if (!span.closed_at) {
      const state = currentTokenState(token);
      const remaining = remainingSeconds(token);
      const remainText = remaining === null ? "" : `, ${formatClock(remaining)} left`;
      return `${name}: ${state}${remainText}. Window ${contractText} (${job}). Hatch is this JWT's last ${askWindow}s. Looker asks when either sibling enters that window, then rotates both.`;
    }
    return `${name}: window ${contractText} (${job}). ${span.close_reason || "closed"}.`;
  }
  return ganttBarLabelText(token);
}

function syncGanttLegend() {
  if (typeof document === "undefined") {
    return;
  }
  const hatch = document.getElementById("gantt-legend-hatch-text");
  if (!hatch) {
    return;
  }
  const askWindow = refreshWindowSeconds();
  hatch.textContent = `hatch: last ${askWindow}s of navigation_token and api_token, when Looker asks`;
}

function refreshMarkerStyle(process) {
  if (String(process).includes("generate_tokens")) {
    return { stroke: "#f0b429", width: 2, dash: "2 2" };
  }
  if (String(process).includes("Looker acquire")) {
    return { stroke: "#6cb6ff", width: 1.5, dash: "4 3" };
  }
  return { stroke: "#8b97ab", width: 1, dash: "3 4" };
}

function refreshMarkerBand(process, lanes) {
  const looker = lanes.find((lane) => lane.id === "looker");
  const iframe = lanes.find((lane) => lane.id === "iframe");
  const auth0 = lanes.find((lane) => lane.id === "auth0");
  const host = lanes.find((lane) => lane.id === "host");
  const chartTop = lanes[0]?.top ?? 8;
  const chartBottom = lanes[lanes.length - 1]?.bottom ?? chartTop;
  if (String(process).includes("generate_tokens") || String(process).includes("Looker acquire")) {
    if (looker) {
      return { y1: looker.top, y2: iframe ? iframe.bottom : looker.bottom };
    }
  }
  if (String(process).includes("host_access_token")) {
    return { y1: auth0?.top ?? host?.top ?? chartTop, y2: host?.bottom ?? chartBottom };
  }
  return { y1: chartTop, y2: chartBottom };
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

function lookerSpanBarY(row, spanIndex) {
  if (row.spanCount <= 1) {
    return row.top + (row.height - row.barHeight) / 2;
  }
  return row.top + 4 + spanIndex * (row.barHeight + row.barGap);
}

function appendLookerSpanBar(parts, token, span, spanIndex, y, barHeight, x) {
  const start = parseIsoMs(span.issued_at);
  const drawEnd = spanDrawEndMs(span);
  if (start === null || drawEnd === null) {
    return null;
  }
  const x1 = x(start);
  const x2 = Math.max(x1 + 2, x(drawEnd));
  const opacity = span.closed_at ? 0.55 : 0.9;
  parts.push(
    `<rect class="gantt-bar-hit" data-bar-token-id="${escapeHtml(token.id)}" data-span-index="${spanIndex}" x="${x1}" y="${y}" width="${x2 - x1}" height="${barHeight}" rx="3" fill="${spanFill(token, span)}" opacity="${opacity}" cursor="pointer"></rect>`,
  );
  const contractEnd = spanContractEndMs(span);
  const asksForRefresh = token.id === "navigation_token" || token.id === "api_token";
  if (asksForRefresh && span.close_reason !== "revoked" && contractEnd !== null) {
    const hatchStart = Math.max(start, contractEnd - refreshWindowSeconds() * 1000);
    const hx1 = x(hatchStart);
    const hx2 = x(contractEnd);
    if (hx2 > hx1) {
      parts.push(
        `<rect x="${hx1}" y="${y}" width="${hx2 - hx1}" height="${barHeight}" fill="url(#hatch)" pointer-events="none"></rect>`,
      );
    }
  }
  if ((span.close_reason === "consumed" || span.close_reason === "dropped") && span.closed_at) {
    const tick = parseIsoMs(span.closed_at);
    if (tick !== null && tick >= start && tick <= drawEnd) {
      const tickX = x(tick);
      parts.push(
        `<line x1="${tickX}" x2="${tickX}" y1="${y - 2}" y2="${y + barHeight + 2}" stroke="#f7f4ee" stroke-width="2" pointer-events="none"></line>`,
      );
    }
  }
  return { start, end: drawEnd };
}

function appendLaneBar(parts, token, y, barHeight, x, horizonEndMs) {
  const range = ganttBarRange(token, horizonEndMs);
  if (!range) {
    return null;
  }
  const color = GANTT_STATE_COLORS[currentTokenState(token)] || GANTT_STATE_COLORS.unborn;
  const x1 = x(range.start);
  const visibleX = x(range.visibleEnd);
  const x2 = range.clipped ? Math.max(x1 + 2, visibleX - 8) : Math.max(x1 + 2, visibleX);
  const title = range.clipped ? "<title>continues past the Looker time axis</title>" : "";
  parts.push(
    `<rect class="gantt-bar-hit" data-bar-token-id="${escapeHtml(token.id)}" x="${x1}" y="${y}" width="${Math.max(0, x2 - x1)}" height="${barHeight}" rx="3" fill="${color}" opacity="0.85" cursor="pointer">${title}</rect>`,
  );
  if (range.clipped) {
    parts.push(
      `<polygon points="${x2},${y} ${x2 + 7},${y + barHeight / 2} ${x2},${y + barHeight}" fill="${color}" opacity="0.85" pointer-events="none"></polygon>`,
    );
  }
  return range;
}

function renderGantt(root, nowMs = Date.now()) {
  if (!snapshot) {
    return;
  }
  const t0 = Date.parse(snapshot.login_started_at);
  if (Number.isNaN(t0)) {
    root.innerHTML = "";
    return;
  }
  syncGanttLegend();
  const now = nowMs;
  const horizonEndMs = ganttHorizonEndMs(t0, now);
  const horizon = Math.max(horizonEndMs - t0, 1);
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
    for (const row of lane.rows) {
      const token = row.token;
      const labelY = row.top + row.height / 2 + 4;
      parts.push(`<text x="10" y="${labelY}" fill="#c5cedb" font-size="11">${escapeHtml(token.name || token.id)}</text>`);
      if (lane.id === "looker") {
        const spans = tokenSpans(token);
        spans.forEach((span, spanIndex) => {
          const y = lookerSpanBarY(row, spanIndex);
          appendLookerSpanBar(parts, token, span, spanIndex, y, row.barHeight, x);
        });
        continue;
      }
      const y = row.top + (row.height - row.barHeight) / 2;
      appendLaneBar(parts, token, y, row.barHeight, x, horizonEndMs);
    }
  }
  const chartTop = lanes[0]?.top ?? 8;
  const chartBottom = lanes[lanes.length - 1]?.bottom ?? height;
  for (const [index, marker] of (snapshot.refresh_markers || []).entries()) {
    const at = marker.at || marker;
    const process = marker.process || "token renew";
    const mx = x(Date.parse(at));
    const band = refreshMarkerBand(process, lanes);
    const style = refreshMarkerStyle(process);
    const y1 = band.y1 ?? chartTop;
    const y2 = band.y2 ?? chartBottom;
    parts.push(`<line x1="${mx}" x2="${mx}" y1="${y1}" y2="${y2}" stroke="${style.stroke}" stroke-width="${style.width}" stroke-dasharray="${style.dash}" pointer-events="none"></line>`);
    parts.push(`<rect class="refresh-hit" data-refresh-index="${index}" data-refresh-process="${escapeHtml(process)}" x="${mx - 6}" y="${y1}" width="12" height="${Math.max(0, y2 - y1)}" fill="transparent" cursor="pointer"></rect>`);
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
    const lookerSpans = tokenLaneId(openBarToken) === "looker" ? tokenSpans(openBarToken) : [];
    const openSpan = barLabelSpanIndex !== null ? lookerSpans[barLabelSpanIndex] : null;
    if (openSpan) {
      const start = parseIsoMs(openSpan.issued_at);
      const end = spanDrawEndMs(openSpan);
      if (start !== null && end !== null) {
        const leftPercent = (x((start + end) / 2) / width) * 100;
        parts.push(ganttPopupLabelHtml(ganttSpanLabelText(openBarToken, openSpan), leftPercent));
      }
    } else {
      const range = ganttBarRange(openBarToken, horizonEndMs);
      if (range) {
        const midX = x((range.start + range.visibleEnd) / 2);
        const leftPercent = (midX / width) * 100;
        parts.push(ganttPopupLabelHtml(ganttBarLabelText(openBarToken), leftPercent));
      }
    }
  } else {
    barLabelTokenId = null;
    barLabelSpanIndex = null;
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
    refreshWindowSeconds: refreshWindowSeconds(),
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
      barLabelSpanIndex = barHit.dataset.spanIndex === undefined ? null : Number(barHit.dataset.spanIndex);
      barLabelUntil = Date.now() + GANTT_POPUP_DURATION_MS;
      clearBarLabelTimer();
      barLabelTimer = setTimeout(() => {
        barLabelTokenId = null;
        barLabelSpanIndex = null;
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
    barLabelSpanIndex = null;
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
