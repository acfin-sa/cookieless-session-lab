import { fetchWithHostAccessToken, reportEvent } from "./host-client.js";
import { IFRAME_CLIENT_KIND_RAW_POSTMESSAGE, withIframeClientKind } from "./iframe-client-kind.js";

let pageConfig = null;
let browserHeldEmbedTokens = null;
let connectedIframeWindows = new WeakSet();
let listenerBound = false;
let rawIframe = null;

function lookerOrigin() {
  return new URL(pageConfig.lookerEmbedHost).origin;
}

function cookielessLoginUrl(authenticationToken, navigationToken, dashboardId) {
  // TOKEN: authentication_token (query, single use), navigation_token (embed_navigation_token)
  // CREATED BY: POST /api/looker/acquire-embed-session
  // CONSUMED BY: GET /login/embed/... on the Looker origin (iframe navigation)
  // LIVES AT: URL once for authentication_token; navigation_token also later via postMessage
  // TTL: authentication ~30s single-use; navigation ~10 min
  // WHY: bootstrap handle belongs on the URL exactly once. The iframe is not allowed to mint it.
  const embedUrl = new URL(`/embed/dashboards/${dashboardId}`, pageConfig.lookerEmbedHost);
  embedUrl.searchParams.set("embed_domain", pageConfig.embedDomain);
  embedUrl.searchParams.set("embed_navigation_token", navigationToken);
  const targetUri = encodeURIComponent(`${embedUrl.pathname}${embedUrl.search}${embedUrl.hash}`);
  return `${lookerOrigin()}/login/embed/${targetUri}?embed_authentication_token=${authenticationToken}`;
}

function reportRawEvent(event) {
  return reportEvent(withIframeClientKind(event, IFRAME_CLIENT_KIND_RAW_POSTMESSAGE));
}

function isRawIframeMessage(event) {
  return Boolean(rawIframe) && event.source === rawIframe.contentWindow;
}

function parseLookerIframeMessage(event) {
  if (!isRawIframeMessage(event) || event.origin !== lookerOrigin()) {
    return null;
  }
  let data = event.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data;
}

function postSessionTokensToIframe(contentWindow, tokens) {
  // TOKEN: api_token, navigation_token
  // CREATED BY: acquire (first reply) or generate_tokens (later replies)
  // CONSUMED BY: Looker UI inside the iframe
  // LIVES AT: iframe. Never include session_reference_token.
  // TTL: ~10 minutes
  // WHY: iframe may ask; host answers. This is the untrusted-peer boundary.
  const message = {
    type: "session:tokens",
    api_token: tokens.api_token,
    api_token_ttl: tokens.api_token_ttl,
    navigation_token: tokens.navigation_token,
    navigation_token_ttl: tokens.navigation_token_ttl,
    session_reference_token_ttl: tokens.session_reference_token_ttl,
  };
  contentWindow.postMessage(JSON.stringify(message), lookerOrigin());
}

async function handleLookerIframeMessage(event) {
  const data = parseLookerIframeMessage(event);
  if (!data) {
    return;
  }
  if (data.type === "session:expired" || (data.type === "session:status" && data.expired)) {
    await reportRawEvent({
      method: data.type === "session:expired" ? "session:expired" : "session:status",
      actor: "iframe postMessage",
      summary: "iframe session expired — embed cannot keep working; session_reference not revoked. Nav/api JWT clocks are unchanged.",
      tokens_in: ["iframe_session_postmessage"],
      tokens_out: [],
      ok: false,
      expired: true,
    });
    return;
  }
  if (data.type === "session:status") {
    await reportRawEvent({
      method: "session:status",
      actor: "iframe postMessage",
      summary: JSON.stringify({ expired: false, status: data.status }),
      tokens_in: ["api_token", "navigation_token"],
      tokens_out: [],
      ok: true,
    });
    return;
  }
  if (data.type !== "session:tokens:request") {
    return;
  }
  await reportRawEvent({
    method: "postMessage session:tokens:request",
    actor: "iframe postMessage",
    summary: "Looker iframe asked the host for tokens",
    tokens_in: [],
    tokens_out: [],
  });
  const iframeWindow = event.source;
  if (!connectedIframeWindows.has(iframeWindow) && browserHeldEmbedTokens) {
    connectedIframeWindows.add(iframeWindow);
    postSessionTokensToIframe(iframeWindow, browserHeldEmbedTokens);
    await reportRawEvent({
      method: "postMessage session:tokens",
      actor: "Browser",
      summary: "first reply reused acquire tokens (no generate_tokens yet)",
      tokens_in: ["api_token", "navigation_token"],
      tokens_out: ["api_token", "navigation_token"],
    });
    return;
  }
  try {
    const tokens = await fetchWithHostAccessToken("/api/looker/generate-embed-tokens", {
      method: "PUT",
      body: "{}",
    });
    browserHeldEmbedTokens = { ...browserHeldEmbedTokens, ...tokens };
    postSessionTokensToIframe(iframeWindow, browserHeldEmbedTokens);
    await reportRawEvent({
      method: "postMessage session:tokens",
      actor: "Browser",
      summary: tokens.frozen
        ? "replied with unrotated tokens because freeze is on"
        : "replied with generate_tokens output",
      tokens_in: ["api_token", "navigation_token"],
      tokens_out: ["api_token", "navigation_token"],
    });
  } catch (error) {
    iframeWindow.postMessage(
      JSON.stringify({ type: "session:tokens", session_reference_token_ttl: 0 }),
      lookerOrigin()
    );
    await reportRawEvent({
      method: "postMessage session:tokens",
      actor: "Browser",
      summary: `generate failed; sent ttl=0 so the iframe can expire. ${error.message}`,
      ok: false,
      error: error.message,
    });
  }
}

function bindListener() {
  if (listenerBound) {
    return;
  }
  window.addEventListener("message", handleLookerIframeMessage);
  listenerBound = true;
}

function createIframe(container, url) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("allowfullscreen", "true");
  iframe.setAttribute("title", "Looker cookieless embed");
  rawIframe = iframe;
  iframe.src = url;
  container.appendChild(iframe);
  return iframe;
}

async function acquireAndMount(container) {
  const tokens = await fetchWithHostAccessToken("/api/looker/acquire-embed-session", {
    method: "POST",
    body: "{}",
  });
  browserHeldEmbedTokens = tokens;
  await reportRawEvent({
    method: "POST /api/looker/acquire-embed-session",
    actor: "Browser",
    summary: "raw postMessage tab received browser-safe tokens",
    tokens_in: ["host_access_token"],
    tokens_out: ["authentication_token", "navigation_token", "api_token"],
  });
  const url = cookielessLoginUrl(
    tokens.authentication_token,
    tokens.navigation_token,
    pageConfig.lookerDashboardId
  );
  createIframe(container, url);
  await reportRawEvent({
    method: "iframe navigation to embed login URL",
    actor: "Browser",
    summary: "raw postMessage tab set iframe src to /login/embed with embed_authentication_token",
    tokens_in: ["authentication_token", "navigation_token"],
    tokens_out: [],
  });
}

export async function startPostMessageTab(config) {
  pageConfig = config;
  document.getElementById("postmessage-root").innerHTML = "";
  rawIframe = null;
  if (!config.lookerDashboardId || !config.lookerEmbedHost) {
    document.getElementById("postmessage-root").textContent =
      "Set LOOKER_EMBED_HOST and LOOKER_EMBED_DASHBOARD_ID in .env";
    return;
  }
  bindListener();
  await acquireAndMount(document.getElementById("postmessage-root"));
}

export function stopPostMessageTab() {
  if (listenerBound) {
    window.removeEventListener("message", handleLookerIframeMessage);
    listenerBound = false;
  }
  browserHeldEmbedTokens = null;
  connectedIframeWindows = new WeakSet();
  rawIframe = null;
  document.getElementById("postmessage-root").innerHTML = "";
}
