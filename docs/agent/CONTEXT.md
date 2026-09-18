# System context

This file is the detailed source of truth for trust boundaries, token
inventory, storage, renew paths, User-Agent, logout, and embed clients.
File/route/symbol map: [CODEMAP.md](CODEMAP.md). MUST / MUST NOT:
[INVARIANTS.md](INVARIANTS.md). Method catalog:
[docs/token-method-map.json](../token-method-map.json). Index:
[AGENTS.md](../../AGENTS.md).

Human companions teach the model and should link here for depth, not copy
these matrices: [README.md](../../README.md),
[ARCHITECTURE.md](../../ARCHITECTURE.md),
[docs/cookieless-brief.md](../cookieless-brief.md).

## Layers

```
Auth0 proves the human
  └── HostSession (Layer A) authorizes the BFF
        └── Looker cookieless session (Layer B) authorizes the iframe
```

- Layer A: Auth0 Authorization Code + PKCE. Tokens stay on `HostSession`. Browser presents `host_session_id` (HttpOnly cookie) and `host_access_token` (memory JWT).
- Layer B: reachable only after Layer A bearer verification (`require_bearer_session` in `app/services/host_session_auth.py`). Host calls Looker acquire / generate / DELETE.

## Trust boundaries

| Boundary | Trusted | Untrusted | Contract |
| --- | --- | --- | --- |
| Browser → host cookie routes | `HostSession` | cookie value | HttpOnly, `SameSite=Lax` cookie (`Secure` when `APP_BASE_URL` is https) locates the record; does not authorize Looker |
| Browser → host bearer routes | signing key `APP_KEY_SECRET` | JWT | HS256; `typ=host_access`; HostSession from JWT claim `hsid`; not revoked; current `jti`. Required on `/api/looker/*` and `/api/lab/*` |
| Host → Auth0 | client secret + stored refresh | browser | Auth0 tokens never returned to JS |
| Host → Looker API | API credentials + `session_reference_token` | iframe / JS | Host chooses session; JSON stripped of reference; acquire sends `embed_domain=APP_BASE_URL` |
| Browser → iframe | origin + `event.source` (raw tab) | Looker frame | Deliver nav/api only; never session reference |

## Token inventory

### Layer A (host / Auth0)

| Token | Created | Storage | Browser | End |
| --- | --- | --- | --- | --- |
| `host_session_id` | `callback` + `set_host_session_cookie` | cookie + `SessionStore` key | opaque cookie | logout / cookie max-age 12h |
| `host_session_reference` | `callback` (`uuid4`) | `HostSession` | observatory metadata only | HostSession delete |
| Auth0 refresh | `/oauth/token` code or refresh | `HostSession.auth0_refresh_token` | MUST NOT | revoke / rotation / delete |
| Auth0 access / id | same | `HostSession` | MUST NOT | expiry / replace / delete |
| `host_access_token` | `mint_host_access_token` | memory + HostSession for TTL display | JSON bootstrap/refresh | `exp`, `jti` rotate, `host_session_revoked` |

`host_session_reference` is pedagogical. It is not sent to Auth0 or Looker.

`host_access_token` is a **Host** badge on `/lab`, not Auth0 and not Looker. It
is minted by `mint_host_access_token` and sent as `Authorization: Bearer` on
`/api/looker/*` and `/api/lab/*` so Layer A can gate Layer B. Looker identity
remains `session_reference_token`. Observatory `badge` comes from
`docs/token-method-map.json`; do not map every Layer A card to the word Auth0.

### Layer B (Looker — four tokens)

| Token | Role | Storage | Browser JSON |
| --- | --- | --- | --- |
| `session_reference_token` | Layer B identity; input to generate/DELETE | `HostSession.looker_session_reference_token` | MUST NOT; stripped in `app/routes/looker.py` |
| `authentication_token` | single-use `/login/embed` URL | URL once; consumed flag on HostSession | yes, acquire only |
| `navigation_token` | in-iframe navigation JWT | iframe / embed URL | yes |
| `api_token` | iframe Looker API JWT | iframe | yes |

`navigation_token` and `api_token` are siblings: independent TTLs; `generate_tokens` rotates both. They are not aliases and are not Layer B identity.

## Storage matrix

| Handle | Browser cookie | Browser memory | Server `HostSession` |
| --- | --- | --- | --- |
| `host_session_id` | yes, HttpOnly, `SameSite=Lax` | no | store key `_sessions_by_id` |
| `host_access_token` | no | yes (`host-client.js`) | copy for observatory |
| Auth0 refresh/access/id | no | no | yes |
| `session_reference_token` | no | no | yes |
| `authentication_token` | no | URL once | copy + `looker_authentication_consumed` |
| nav / api | no | iframe / SDK | last values for next generate |
| `oauth_pkce_state` | SessionMiddleware cookie, 600s | no | Starlette session, not HostSession |

`SessionStore` (`app/services/session_store.py`) is keyed **only** by `host_session_id`. There is no Auth0 `sub` index.

## Configured lifetimes

Repository-controlled knobs (locations in [CODEMAP.md](CODEMAP.md)):

| Handle | Default | Where |
| --- | --- | --- |
| `host_access_token` | 200 s | `HOST_ACCESS_TOKEN_TTL_SECONDS` in `app/config.py` (hardcoded, not `.env`) |
| Looker `session_length` | 720 s | `LOOKER_EMBED_SESSION_LENGTH` |
| `host_session_id` cookie | 12 h | `HOST_SESSION_COOKIE_MAX_AGE` |
| `oauth_pkce_state` | 600 s | SessionMiddleware in `app/web.py` |

Auth0 access/refresh durations come from the Auth0 tenant, not lab env. Looker
returns `authentication_token_ttl`, `navigation_token_ttl`, `api_token_ttl`,
and `session_reference_token_ttl`. Typical Looker values are authentication
~30 s and navigation/API ~10 minutes; the UI follows returned values rather
than assuming them.

## User-Agent

- Acquire / generate / end pass `request_user_agent(request)` (current request `User-Agent` header) into `looker-sdk` `transport_options`.
- Observatory field `looker_bound_user_agent` is **login-time** `HostSession.user_agent` (`build_observatory_snapshot`). Routes do not compare later requests to that stored value.
- `force_user_agent_mismatch` replaces UA with `LOOKER_MISMATCH_USER_AGENT` (`CookielessLab/ua-mismatch`) on **generate only**, and only when freeze is off. Freeze short-circuits generate (no Looker call), so mismatch is not sent and not logged as if it fired.

MUST NOT document “always the original login UA.”

## Renew paths

| Path | Functions | Effect |
| --- | --- | --- |
| Host bootstrap | `POST /api/host/bootstrap` → `bootstrap_host_access_token` | cookie; mint if missing or &lt;30s to expiry |
| Host refresh | `POST /api/host/refresh` → `refresh_host_access_token` | cookie; optional `refresh_auth0_tokens`; always mint host JWT |
| Looker acquire | `POST /api/looker/acquire-embed-session` → `looker_client.acquire_embed_session` | `embed_domain=APP_BASE_URL`; create or reattach via stored reference; new auth token |
| Looker generate | `PUT /api/looker/generate-embed-tokens` → `looker_client.generate_embed_tokens` | identity from HostSession, not body; if Looker returns a replacement `session_reference_token`, the server stores it |
| Freeze | `HostSession.freeze_token_refresh` | generate returns 200 + `frozen: true`, no Looker rotate |
| Dead session | `session_reference_token_ttl == 0` | `LookerSessionDead` → HTTP 409 `code: SESSION_DEAD` |

Acquire is not generate. Auth0 code exchange is not host refresh.

## `session:expired`

Iframe `session:expired` / `session:status` with `expired=true` (`POST /api/lab/events`) calls `HostSession.mark_iframe_expired`. It MUST NOT revoke `session_reference_token`, smash nav/api `expires_at`, or un-consume `authentication_token`.

The observatory therefore keeps separate nav/api expiry clocks, separate
session-level state for each SDK/raw iframe, and the session reference alive
until Looker reports zero TTL, the host ends Layer B, or the lab drops its
local reference.

## Logout

`POST /logout` (`app/routes/auth0.py` `logout`, CSRF-protected): end Looker for **this** HostSession, `revoke_auth0_refresh` for **this** refresh token, `host_session_revoked=True`, `session_store.delete(host_session_id)`, clear cookie, Auth0 `/v2/logout`.

This is **this-browser only**. Logout-everywhere (revoke all HostSessions for `sub`) is **not implemented**.

## Embed clients

Same host contract, two browsers of it:

- `app/static/js/src/embed-sdk-tab.js` — `@looker/embed-sdk` `initCookieless`
- `app/static/js/src/postmessage-tab.js` — raw `session:tokens:request` / `session:tokens`

`docs/sequence-happy-path.mmd` is the raw postMessage happy path only.
