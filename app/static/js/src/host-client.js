let hostAccessToken = null;
let hostAccessExpiresAt = null;
let refreshTimer = null;
let userInfo = null;

function decodeExp(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}


async function parseError(response) {
  try {
    const body = await response.json();
    return body.detail || JSON.stringify(body);
  } catch {
    return response.statusText;
  }
}

export async function api(path, options = {}) {
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
      throw new Error(await parseError(retry));
    }
    if (retry.status === 204) {
      return null;
    }
    return retry.json();
  }
  if (!response.ok) {
    const error = new Error(await parseError(response));
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function rememberToken(payload) {
  hostAccessToken = payload.host_access_token;
  userInfo = payload.user || userInfo;
  hostAccessExpiresAt = payload.expires_at
    ? Date.parse(payload.expires_at)
    : decodeExp(hostAccessToken);
  scheduleHostRefresh();
}

function scheduleHostRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  const remainingMs = (hostAccessExpiresAt || Date.now()) - Date.now();
  const wait = Math.max(5_000, remainingMs - 60_000);
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
      throw new Error(await parseError(response));
    }
    return response.json();
  });
  rememberToken(payload);
  return payload;
}

export async function refreshHostAccessToken() {
  const payload = await fetch("/api/host/refresh", {
    method: "POST",
    credentials: "same-origin",
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(await parseError(response));
    }
    return response.json();
  });
  rememberToken(payload);
  return payload;
}

export async function reportEvent(event) {
  try {
    await api("/api/lab/events", {
      method: "POST",
      body: JSON.stringify(event),
    });
  } catch (error) {
    console.warn("[lab] event log failed", error.message);
  }
}

