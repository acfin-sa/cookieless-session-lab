# Invariants

MUST / MUST NOT for this tree. Match `app/` if this file and comments disagree; then fix comments, not product behavior, without a human ask.

Lifecycle and trust-boundary detail: [CONTEXT.md](CONTEXT.md). File/route map: [CODEMAP.md](CODEMAP.md).

## Token ownership

- MUST keep `session_reference_token` on the server (`HostSession.looker_session_reference_token`).
- MUST strip `session_reference_token` from JSON in `app/routes/looker.py` before returning acquire/generate payloads.
- MUST NOT put `session_reference_token` in URLs, `localStorage`, cookies, or `session:tokens` bodies.
- MUST NOT return Auth0 refresh, access, or ID tokens to the browser.
- MUST keep `authentication_token` single-use on the embed login URL (`/login/embed`); mark consumed via `POST /api/lab/events` method `iframe navigation to embed login URL`.
- MUST treat `navigation_token` and `api_token` as sibling JWTs: independent TTL/`exp`; `generate_tokens` rotates both; they are not Layer B identity.
- MUST NOT send a navigation or API TTL on acquire or generate. Looker returns those TTLs. They cannot outlive `session_length`; a shorter `LOOKER_EMBED_SESSION_LENGTH` is the only host-side cap.
- MUST treat `authentication_token` as single-use and outside the nav/api ask window. Its usual Looker TTL is ~30s. `generate_tokens` leaves it unchanged.
- MUST treat `session_reference_token` expiry as the acquire countdown. `generate_tokens` stores Looker's remaining TTL and keeps `looker_session_reference_issued_at`. Reattach keeps that issued-at unless the new absolute expiry is more than 15 seconds later (`note_session_reference_window`).
- MUST NOT extend `session_reference_token` lifetime on generate or reattach. A new countdown is acquire with no stored reference.
- MUST read live `session_length` from `LOOKER_EMBED_SESSION_LENGTH` after `load_dotenv`. A value in `.env` overrides the `os.getenv` fallback. The swimlane follows Looker's returned TTL.
- MUST treat `host_session_id` as opaque lookup only.
- MUST treat `host_access_token` as the host BFF bearer (Layer A). It gates
  `/api/looker/*` and `/api/lab/*`; it is not Looker's `api_token` and not Auth0
  access. Looker identity is `session_reference_token`.
- MUST keep observatory badges (Auth0 / Host / Looker) aligned with
  `docs/token-method-map.json` `badge`. MUST NOT label `host_access_token` as
  Auth0 or Looker.

## Authorization gates

- MUST require cookie session for `POST /api/host/bootstrap` and `POST /api/host/refresh`.
- MUST require bearer (`require_bearer_session`) for all `/api/looker/*` and `/api/lab/*`.
- MUST reject stale host JWT `jti` after refresh (401).
- Host JWT renewal in the browser is success-chained: `storeHostAccessToken` calls `scheduleHostRefresh` (one timeout). A failed `POST /api/host/refresh` does not schedule the next one. `fetchWithHostAccessToken` retries a 401 once via refresh. Auth0 refresh failure on that route returns 401 and does not mint.
- MUST NOT treat an embed `session:expired` while nav/api and session-reference TTLs remain as proof those Looker clocks expired. Generate can fail because the host bearer could not be refreshed.
- MUST NOT treat host-JWT expiry as an immediate UI teardown. The page changes only when a bearer call fails and refresh fails. See CONTEXT "Host JWT refresh chain".
- MUST NOT treat the browser clock as the authority for host JWT or Looker expiry. `Date.now()` drives display and `scheduleHostRefresh` only.
- MUST NOT call Looker acquire/generate/end without a valid Layer A session.

## Looker generate identity

- MUST load `session_reference_token` (and last nav/api) from `HostSession`, not from the request body.
- MUST map `session_reference_token_ttl == 0` to `LookerSessionDead` → HTTP 409 `{ "code": "SESSION_DEAD" }`.
- MUST return HTTP 200 with `frozen: true` when `freeze_token_refresh` is on (no Looker rotate).
- MUST NOT treat freeze as session death.
- MUST log generate freeze at the host HTTP boundary without claiming nav/api rotation.
- MUST log Looker acquire/generate/end failures once at the HTTP boundary (not also in `looker_client`).

## Swimlane clocks

- MUST draw Looker swimlane bars from returned TTLs and `HostSession.looker_token_spans`.
- MUST keep one `session_reference_token` span across `generate_tokens`.
- MUST keep each navigation and API generation after refresh (`close_reason` `refreshed`), including the window Looker already replaced.
- MUST hatch the last `EXPIRING_WINDOW_SECONDS` (60) of each `navigation_token` and `api_token` span. That is when Looker sends `session:tokens:request` for that JWT. The snapshot field is `looker_refresh_window_seconds`. The page reads that field.
- MUST leave `authentication_token` out of that hatch and out of the expiring state. A tick marks `/login/embed`. The bar length stays the returned single-use window.
- MUST stop a `revoked` span at the close (End Looker or TTL 0). A `dropped` span still runs to Looker's TTL, with a tick at the drop.
- MUST put `generate_tokens` and Looker acquire markers on the Looker and iframe lanes. Host JWT mint markers stay on the Auth0 and Host lanes.
- MUST size the swimlane axis through the Looker span ends. Host and Auth0 bars past that axis get a continuation mark.
- MUST NOT clip Looker bars to now+60s or replace a span's `issued_at` when the token refreshes.
- MUST NOT record a generate marker or open nav/api spans when freeze skips the Looker call.

## session:expired vs revoke

- MUST treat `session:expired` / expired `session:status` as iframe session-level “cannot keep working.”
- MUST NOT revoke `session_reference_token` on that event.
- MUST NOT overwrite each nav/api JWT `expires_at` from that event.
- MUST NOT un-consume `authentication_token` because the iframe expired.

## User-Agent

- MUST forward the **current request** UA (`request_user_agent`) on acquire, generate, and end.
- MUST NOT claim generate always uses the login-time `HostSession.user_agent`.
- MUST NOT confuse observatory `looker_bound_user_agent` (login snapshot) with the UA sent to Looker.

## Logout

- MUST implement `POST /logout` (CSRF-protected) as this-browser: one cookie → one `HostSession` delete.
- MUST NOT implement or document in-repo logout-everywhere as existing behavior.
- MUST NOT infer a `sub` index; `SessionStore` is keyed only by `host_session_id`.
- Logout-everywhere (revoke every HostSession + Auth0 refresh + Looker session for `sub`) is a **product rule for a real app**, not this lab.

## Embed client

- The only Looker iframe client is the Embed SDK (`embed-sdk-tab.js` `initCookieless`).
- End Looker deletes Layer B and leaves the embed disconnected. The next acquire is the **Start Looker session** button. MUST NOT remount the Embed SDK as part of End Looker.
- MUST NOT send `session_reference_token` on `session:tokens`.
- Looker sends `session:tokens:request` on its own (load, then either nav or api inside its last 60s). The host does not poll for that ask.
- MUST implement acquire and generate callbacks. The Embed SDK does not call Looker's generate API.
- MUST NOT answer a later `session:tokens:request` with the original acquire TTLs. The SDK caches those full values and calls `generateTokens` only when `Date.now() > generateTokensTime` (first ask's cached TTL minus 120s). An ask on that gate does not generate. Looker shows session interrupted. `session_reference_token` remains. Send remaining seconds, or generate and push before the gate.
- This lab's correction is `armIframeTokenRotation` in `embed-sdk-tab.js`. On acquire it sets `generateTokensTime` to 150s before the returned nav/api TTL (`ROTATION_LEAD_SECONDS`), before the first `session:tokens:request` can set that gate to `ttl - 120`. It rotates and pushes `session:tokens` at that lead. `syncCookielessRemainingTtls` keeps the cached TTLs equal to seconds remaining and re-pins the gate after EmbedClientEx rewrites it to `ttl - 120`. Setting the gate to the past only when the ask arrives still fails the `>` check.
- A failed generate or iframe `session:expired` MUST be visible. `record_client_event` writes refresh marker `embed session interrupted`.

## Lab vs production

- MUST treat `SessionStore` as process-local (restart wipes both layers).
- MUST NOT commit `.env` or real token values.
