let hostAccessToken = null;
let hostAccessExpiresAt = null;
let refreshTimer = null;

function decodeJwtExpiryMilliseconds(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) {
      return null;
    }
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}


async function readErrorDetail(response) {
  try {
    const body = await response.json();
    return body.detail || JSON.stringify(body);
  } catch {
    return response.statusText;
  }
}

let lastPrintedLookerTokenFingerprint = "";
let lastLookerBrowserTokens = null;

export function rememberLookerBrowserTokens(tokens) {
  if (!tokens || typeof tokens !== "object") {
    return;
  }
  if (!tokens.navigation_token && !tokens.api_token) {
    return;
  }
  const fingerprint = `${tokens.navigation_token ?? ""}|${tokens.api_token ?? ""}`;
  if (fingerprint === lastPrintedLookerTokenFingerprint) {
    return;
  }
  lastPrintedLookerTokenFingerprint = fingerprint;
  lastLookerBrowserTokens = {
    navigation_token: tokens.navigation_token,
    api_token: tokens.api_token,
    navigation_token_ttl: tokens.navigation_token_ttl,
    api_token_ttl: tokens.api_token_ttl,
  };
  console.info("[lab] navigation_token", lastLookerBrowserTokens.navigation_token);
  console.info("[lab] api_token", lastLookerBrowserTokens.api_token);
  if (
    lastLookerBrowserTokens.navigation_token_ttl != null ||
    lastLookerBrowserTokens.api_token_ttl != null
  ) {
    console.info("[lab] navigation_token_ttl", lastLookerBrowserTokens.navigation_token_ttl);
    console.info("[lab] api_token_ttl", lastLookerBrowserTokens.api_token_ttl);
  }
}

/** Re-print the last nav/api pair held in memory (DevTools console). */
export function printLookerIframeTokens() {
  if (!lastLookerBrowserTokens) {
    console.warn(
      "[lab] no navigation_token/api_token yet — log in, open /lab, and complete Looker acquire (Looker env must be set)."
    );
    return null;
  }
  console.info("[lab] navigation_token", lastLookerBrowserTokens.navigation_token);
  console.info("[lab] api_token", lastLookerBrowserTokens.api_token);
  return { ...lastLookerBrowserTokens };
}

function parseJsonResponseBody(response) {
  if (response.status === 204) {
    return null;
  }
  return response.json().then((payload) => {
    rememberLookerBrowserTokens(payload);
    return payload;
  });
}

export async function fetchWithHostAccessToken(path, options = {}) {
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  if (hostAccessToken) {
    headers.authorization = `Bearer ${hostAccessToken}`;
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  if (response.status === 401 && path !== "/api/host/refresh" && path !== "/api/host/bootstrap") {
    await refreshHostAccessToken();
    headers.authorization = `Bearer ${hostAccessToken}`;
    const retry = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers,
    });
    if (!retry.ok) {
      const error = new Error(await readErrorDetail(retry));
      error.status = retry.status;
      throw error;
    }
    return parseJsonResponseBody(retry);
  }
  if (!response.ok) {
    const error = new Error(await readErrorDetail(response));
    error.status = response.status;
    throw error;
  }
  return parseJsonResponseBody(response);
}

function storeHostAccessToken(payload) {
  hostAccessToken = payload.host_access_token;
  hostAccessExpiresAt = payload.expires_at
    ? Date.parse(payload.expires_at)
    : decodeJwtExpiryMilliseconds(hostAccessToken);
  scheduleHostRefresh();
}

function scheduleHostRefresh() { // refreshes host_access_token
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  const remainingMs = (hostAccessExpiresAt || Date.now()) - Date.now();
  const wait = Math.max(5_000, remainingMs - 45_000);
  refreshTimer = setTimeout(() => {
    refreshHostAccessToken().catch((error) => {
      console.warn("[lab] host refresh failed", error.message);
    });
  }, wait);
}

export async function bootstrapHostSession() {
  const payload = await fetch("/api/host/bootstrap", {
    method: "POST",
    credentials: "same-origin",
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(await readErrorDetail(response));
    }
    return response.json();
  });
  storeHostAccessToken(payload);
  return payload;
}

let refreshInFlight = null;
export async function refreshHostAccessToken() {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    const response = await fetch("/api/host/refresh", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new Error(await readErrorDetail(response));
    }
    const payload = await response.json();
    storeHostAccessToken(payload);
    return payload;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}


export async function reportEvent(event) {
  try {
    await fetchWithHostAccessToken("/api/lab/events", {
      method: "POST",
      body: JSON.stringify(event),
    });
  } catch (error) {
    console.warn("[lab] event log failed", error.message);
  }
}
