import { getEmbedSDK } from "@looker/embed-sdk";
import { fetchWithHostAccessToken, reportEvent } from "./host-client.js";

let embedSdk = null;
let embedConnection = null;
let pageConfig = null;
let cookielessIssuedAtMs = 0;
let cookielessIssuedTtls = null;
let cookielessTtlTimer = null;
let generateInFlight = null;
let rotationTimer = null;

// Looker's refresh ask and the SDK gate both sit 120s before the TTL the iframe
// was told. Pinning the gate 150s before expiry makes that ask strictly later,
// so EmbedClientEx's `Date.now() > generateTokensTime` check calls generateTokens.
const ROTATION_LEAD_SECONDS = 150;
const ROTATION_RETRY_WAIT_MS = 10000;

function numericTtl(value) {
  const ttl = Number(value);
  return Number.isFinite(ttl) ? ttl : 0;
}

function normalizeCookielessTokens(tokens) {
  return {
    ...tokens,
    api_token_ttl: numericTtl(tokens.api_token_ttl),
    navigation_token_ttl: numericTtl(tokens.navigation_token_ttl),
    session_reference_token_ttl: numericTtl(tokens.session_reference_token_ttl),
  };
}

function rememberCookielessIssuance(tokens) {
  cookielessIssuedAtMs = Date.now();
  cookielessIssuedTtls = {
    api: numericTtl(tokens.api_token_ttl),
    navigation: numericTtl(tokens.navigation_token_ttl),
    session: numericTtl(tokens.session_reference_token_ttl),
  };
  armIframeTokenRotation();
}

function applyTokensToCookielessSession(tokens) {
  const session = embedSdk?._cookielessSession;
  if (!session) {
    return;
  }
  const apiTtl = numericTtl(tokens.api_token_ttl);
  const navigationTtl = numericTtl(tokens.navigation_token_ttl);
  const sessionTtl = numericTtl(tokens.session_reference_token_ttl);

  session.cookielessApiToken = tokens.api_token;
  session.cookielessApiTokenTtl = apiTtl;
  session.cookielessNavigationToken = tokens.navigation_token;
  session.cookielessNavigationTokenTtl = navigationTtl;
  session.cookielessSessionReferenceTokenTtl = sessionTtl;
  pinGenerateTokensTime();
}

function pushSessionTokensToIframe(tokens) {
  if (!embedConnection || typeof embedConnection.send !== "function") {
    return;
  }
  embedConnection.send("session:tokens", {
    api_token: tokens.api_token,
    api_token_ttl: numericTtl(tokens.api_token_ttl),
    navigation_token: tokens.navigation_token,
    navigation_token_ttl: numericTtl(tokens.navigation_token_ttl),
    session_reference_token_ttl: numericTtl(tokens.session_reference_token_ttl),
  });
}

function soonestIframeTtlSeconds() {
  if (!cookielessIssuedTtls) {
    return 0;
  }
  return Math.min(cookielessIssuedTtls.api, cookielessIssuedTtls.navigation);
}

function rotationDelaySeconds() {
  const remainingSeconds = remainingCookielessTtl(soonestIframeTtlSeconds());
  return Math.max(0, remainingSeconds - ROTATION_LEAD_SECONDS);
}

function pinGenerateTokensTime() {
  const session = embedSdk?._cookielessSession;
  if (!session || !cookielessIssuedTtls || !cookielessIssuedAtMs) {
    return;
  }
  const delaySeconds = rotationDelaySeconds();
  // Inside the lead window the gate must already be in the past. An ask that
  // arrives on an equal timestamp does not pass EmbedClientEx's `>` check.
  session.generateTokensTime = delaySeconds === 0 ? Date.now() - 1 : Date.now() + delaySeconds * 1000;
}

function armIframeTokenRotation() {
  if (rotationTimer) {
    clearTimeout(rotationTimer);
    rotationTimer = null;
  }
  if (!cookielessIssuedTtls || !cookielessIssuedAtMs) {
    return;
  }
  pinGenerateTokensTime();
  const delayMs = rotationDelaySeconds() * 1000;
  rotationTimer = setTimeout(() => {
    rotationTimer = null;
    rotateIframeTokens();
  }, delayMs);
}

function rotateIframeTokens() {
  const session = embedSdk?._cookielessSession;
  if (session) {
    session.generateTokensTime = Date.now() - 1;
  }
  generateTokens()
    .then((tokens) => {
      applyTokensToCookielessSession(tokens);
      pushSessionTokensToIframe(tokens);
      // When EmbedClientEx itself invoked generateTokens, it rewrites
      // generateTokensTime to ttl-120 after the callback resolves. That is the
      // same instant as the next ask. Put the gate back once that write lands.
      setTimeout(pinGenerateTokensTime, 0);
    })
    .catch(() => {
      rotationTimer = setTimeout(rotateIframeTokens, ROTATION_RETRY_WAIT_MS);
    });
}

function remainingCookielessTtl(issuedTtl) {
  const elapsedSeconds = (Date.now() - cookielessIssuedAtMs) / 1000;
  return Math.max(0, Math.round(issuedTtl - elapsedSeconds));
}

// Rewrite the SDK's cached TTLs to seconds actually left, and keep
// generateTokensTime ahead of Looker's ask. The 1s tick corrects the gate if
// EmbedClientEx replaced it.
function syncCookielessRemainingTtls() {
  const session = embedSdk?._cookielessSession;
  if (!session || !cookielessIssuedTtls || !cookielessIssuedAtMs) {
    return;
  }
  const apiTtl = remainingCookielessTtl(cookielessIssuedTtls.api);
  const navigationTtl = remainingCookielessTtl(cookielessIssuedTtls.navigation);
  const sessionTtl = remainingCookielessTtl(cookielessIssuedTtls.session);
  session.cookielessApiTokenTtl = apiTtl;
  session.cookielessNavigationTokenTtl = navigationTtl;
  session.cookielessSessionReferenceTokenTtl = sessionTtl;
  pinGenerateTokensTime();
}

function startCookielessTtlTimer() {
  if (cookielessTtlTimer) {
    clearInterval(cookielessTtlTimer);
  }
  cookielessTtlTimer = setInterval(syncCookielessRemainingTtls, 1000);
}

function stopCookielessTtlTimer() {
  if (cookielessTtlTimer) {
    clearInterval(cookielessTtlTimer);
    cookielessTtlTimer = null;
  }
  if (rotationTimer) {
    clearTimeout(rotationTimer);
    rotationTimer = null;
  }
  cookielessIssuedAtMs = 0;
  cookielessIssuedTtls = null;
  embedConnection = null;
}

async function acquireSession() {
  try {
    const tokens = normalizeCookielessTokens(
      await fetchWithHostAccessToken("/api/looker/acquire-embed-session", { method: "POST", body: "{}" })
    );
    rememberCookielessIssuance(tokens);
    reportEvent({
      method: "POST /api/looker/acquire-embed-session",
      actor: "Browser",
      summary: "Embed SDK acquire callback received browser-safe tokens",
      tokens_in: ["host_access_token"],
      tokens_out: ["authentication_token", "navigation_token", "api_token"],
    });
    return tokens;
  } catch (error) {
    reportEvent({
      method: "POST /api/looker/acquire-embed-session",
      actor: "Browser",
      summary: String(error),
      ok: false,
      error: String(error),
      embed_client: "sdk",
    });
    throw error;
  }
}

function generateTokens(_tokensFromIframe) {
  if (generateInFlight) {
    return generateInFlight;
  }
  generateInFlight = generateTokensOnce().finally(() => {
    generateInFlight = null;
  });
  return generateInFlight;
}

async function generateTokensOnce() {
  // TOKEN: navigation_token, api_token
  // CREATED BY: PUT /api/looker/generate-embed-tokens (server loads session_reference_token)
  // CONSUMED BY: Embed SDK postMessage session:tokens into the iframe
  // LIVES AT: iframe. The SDK may pass last nav/api here; we ignore them as identity.
  // TTL: ~10 minutes
  // WHY: iframe is an untrusted peer. It may ask; it may not choose the session.
  try {
    const tokens = normalizeCookielessTokens(
      await fetchWithHostAccessToken("/api/looker/generate-embed-tokens", {
        method: "PUT",
        body: "{}",
      })
    );
    rememberCookielessIssuance(tokens);
    await reportEvent({
      method: "PUT /api/looker/generate-embed-tokens",
      actor: "Browser",
      summary: tokens.frozen
        ? "Embed SDK generate callback — refresh was frozen"
        : "Embed SDK generate callback received rotated nav/api tokens",
      tokens_in: ["host_access_token"],
      tokens_out: ["navigation_token", "api_token"],
    });
    return tokens;
  } catch (error) {
    await reportEvent({
      method: "PUT /api/looker/generate-embed-tokens",
      actor: "Browser",
      summary: `Embed SDK generate failed. Looker will show session interrupted even if session_reference_token still has time. ${error.message}`,
      tokens_in: ["host_access_token", "navigation_token", "api_token"],
      tokens_out: [],
      ok: false,
      error: String(error),
      embed_client: "sdk",
    });
    throw error;
  }
}

function reportEmbedSessionExpired(method, summary) {
  return reportEvent({
    method,
    actor: "iframe postMessage",
    summary,
    tokens_in: ["iframe_session_sdk"],
    tokens_out: [],
    ok: false,
    expired: true,
    embed_client: "sdk",
  });
}

function coldStartDashboardFilters() {
  return pageConfig.coldStartDashboardFilters || {};
}

function mountDashboard(containerSelector) {
  embedSdk = getEmbedSDK();
  embedSdk.initCookieless(pageConfig.lookerEmbedHost, acquireSession, generateTokens);

  const builder = embedSdk
    .createDashboardWithId(String(pageConfig.lookerDashboardId))
    .appendTo(containerSelector)
    .withParams({
      embed_domain: pageConfig.embedDomain,
    })
    .withFilters(coldStartDashboardFilters());
  builder
    .on("session:status", (event) => {
      if (event?.expired) {
        reportEmbedSessionExpired(
          "session:status",
          "iframe session:status expired=true — embed cannot keep working; session_reference not revoked. Nav/api JWT clocks are unchanged."
        );
        return;
      }
      reportEvent({
        method: "session:status",
        actor: "iframe postMessage",
        summary: JSON.stringify({ expired: false, status: event?.status }),
        tokens_in: ["api_token", "navigation_token"],
        tokens_out: [],
        ok: true,
        embed_client: "sdk",
      });
    })
    .on("session:expired", () => {
      reportEmbedSessionExpired(
        "session:expired",
        "iframe session:expired — embed cannot keep working; session_reference not revoked. Nav/api JWT clocks are unchanged."
      );
    })
    .build()
    .connect()
    .then((connection) => {
      embedConnection = connection;
      syncCookielessRemainingTtls();
      reportEvent({
        method: "iframe navigation to embed login URL",
        actor: "Browser",
        summary: "Embed SDK connected; authentication_token consumed inside /login/embed",
        tokens_in: ["authentication_token", "navigation_token"],
        tokens_out: [],
        embed_client: "sdk",
      });
    })
    .catch((error) => {
      reportEvent({
        method: "Embed SDK connect",
        actor: "Browser",
        summary: String(error),
        ok: false,
        error: String(error),
        embed_client: "sdk",
      });
    });
}

export function startEmbedSdkTab(config) {
  pageConfig = config;
  const root = document.getElementById("embed-sdk-root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  if (!config.lookerDashboardId || !config.lookerEmbedHost) {
    root.textContent =
      "Set LOOKER_EMBED_HOST and LOOKER_EMBED_DASHBOARD_ID in .env";
    return;
  }
  startCookielessTtlTimer();
  mountDashboard("#embed-sdk-root");
}

export function stopEmbedSdkTab() {
  stopCookielessTtlTimer();
  document.getElementById("embed-sdk-root").innerHTML = "";
  // Drop the SDK handle so the next startEmbedSdkTab does not keep callbacks
  // wired to a torn-down iframe after switching to the postMessage tab.
  embedSdk = null;
}
