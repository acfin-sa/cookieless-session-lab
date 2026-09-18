import { getEmbedSDK } from "@looker/embed-sdk";
import { fetchWithHostAccessToken, reportEvent } from "./host-client.js";

let embedSdk = null;
let pageConfig = null;

async function acquireSession() {
  try {
    const tokens = await fetchWithHostAccessToken("/api/looker/acquire-embed-session", { method: "POST", body: "{}" });
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

async function generateTokens(_tokensFromIframe) {
  // TOKEN: navigation_token, api_token
  // CREATED BY: PUT /api/looker/generate-embed-tokens (server loads session_reference_token)
  // CONSUMED BY: Embed SDK postMessage session:tokens into the iframe
  // LIVES AT: iframe. The SDK may pass last nav/api here; we ignore them as identity.
  // TTL: ~10 minutes
  // WHY: iframe is an untrusted peer. It may ask; it may not choose the session.
  const tokens = await fetchWithHostAccessToken("/api/looker/generate-embed-tokens", {
    method: "PUT",
    body: "{}",
  });
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
      if (generation !== mountGeneration) {
        return;
      }
      dashboardConnection = connection;
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
  mountDashboard("#embed-sdk-root");
}

export function stopEmbedSdkTab() {
  document.getElementById("embed-sdk-root").innerHTML = "";
  // Drop the SDK handle so the next startEmbedSdkTab does not keep callbacks
  // wired to a torn-down iframe after switching to the postMessage tab.
  embedSdk = null;
}
