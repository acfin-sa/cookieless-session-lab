# Invariants

MUST / MUST NOT for this tree. Match `app/` if this file and comments disagree; then fix comments, not product behavior, without a human ask.

## Token ownership

- MUST keep `session_reference_token` on the server (`HostSession.looker_session_reference_token`).
- MUST strip `session_reference_token` from JSON in `app/routes/looker.py` before returning acquire/generate payloads.
- MUST NOT put `session_reference_token` in URLs, `localStorage`, cookies, or `postMessage` bodies.
- MUST NOT return Auth0 refresh, access, or ID tokens to the browser.
- MUST keep `authentication_token` single-use on the embed login URL (`/login/embed`); mark consumed via `POST /api/lab/events` method `iframe navigation to embed login URL`.
- MUST treat `navigation_token` and `api_token` as sibling JWTs: independent TTL/`exp`; `generate_tokens` rotates both; they are not Layer B identity.
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
- MUST NOT call Looker acquire/generate/end without a valid Layer A session.

## Looker generate identity

- MUST load `session_reference_token` (and last nav/api) from `HostSession`, not from the request body.
- MUST map `session_reference_token_ttl == 0` to `LookerSessionDead` → HTTP 409 `{ "code": "SESSION_DEAD" }`.
- MUST return HTTP 200 with `frozen: true` when `freeze_token_refresh` is on (no Looker rotate).
- MUST NOT treat freeze as session death.
- MUST log generate freeze at the host HTTP boundary without claiming nav/api rotation.
- MUST log Looker acquire/generate/end failures once at the HTTP boundary (not also in `looker_client`).

## session:expired vs revoke

- MUST treat `session:expired` / expired `session:status` as iframe session-level “cannot keep working.”
- MUST NOT revoke `session_reference_token` on that event.
- MUST NOT overwrite each nav/api JWT `expires_at` from that event.
- MUST NOT un-consume `authentication_token` because the iframe expired.

## User-Agent

- MUST forward the **current request** UA (`request_user_agent`) on acquire, generate, and end, except:
- MUST send `LOOKER_MISMATCH_USER_AGENT` on generate only when `force_user_agent_mismatch` is true **and** `freeze_token_refresh` is false. Freeze wins: no Looker call, no mismatch UA.
- MUST NOT claim generate always uses the login-time `HostSession.user_agent`.
- MUST NOT confuse observatory `looker_bound_user_agent` (login snapshot) with the UA sent to Looker.

## Logout

- MUST implement `POST /logout` (CSRF-protected) as this-browser: one cookie → one `HostSession` delete.
- MUST NOT implement or document in-repo logout-everywhere as existing behavior.
- MUST NOT infer a `sub` index; `SessionStore` is keyed only by `host_session_id`.
- Logout-everywhere (revoke every HostSession + Auth0 refresh + Looker session for `sub`) is a **product rule for a real app**, not this lab.

## Embed clients

- MUST keep Embed SDK and raw postMessage as two clients of the same host contract.
- MUST NOT send `session_reference_token` on `session:tokens`.
- MUST validate raw postMessage `event.source` and Looker origin in `postmessage-tab.js`.

## Lab vs production

- MUST treat `SessionStore` as process-local (restart wipes both layers).
- MUST NOT commit `.env` or real token values.
- MUST keep `host_session_reference` pedagogical (not an Auth0/Looker credential).
