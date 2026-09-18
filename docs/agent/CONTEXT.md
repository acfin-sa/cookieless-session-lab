# System context

Human companion: [ARCHITECTURE.md](../../ARCHITECTURE.md). Index: [AGENTS.md](../../AGENTS.md).

## Layers

```
Auth0 proves the human
  └── HostSession (Layer A) authorizes the BFF
        └── Looker cookieless session (Layer B) authorizes the iframe
```

- Layer A: Auth0 Authorization Code + PKCE. Tokens stay on `HostSession`. Browser presents `host_session_id` (HttpOnly cookie) and `host_access_token` (memory JWT). The JWT claim `host_session_id` is the same opaque key as the cookie (legacy claim: `hsid`).
- Layer B: reachable only after Layer A bearer verification (`require_bearer_session` in `app/services/host_session_auth.py`). Host calls Looker acquire / generate / DELETE.

## Trust boundaries

| Boundary | Trusted | Untrusted | Contract |
| --- | --- | --- | --- |
| Browser → host cookie routes | `HostSession` | cookie value | Cookie locates; does not authorize Looker |
| Browser → host bearer routes | signing key `APP_KEY_SECRET` | JWT | `/api/looker/*` and `/api/lab/*` require current `jti` |
| Host → Auth0 | client secret + stored refresh | browser | Auth0 tokens never returned to JS |
| Host → Looker API | API credentials + `session_reference_token` | iframe / JS | Host chooses session; JSON stripped of reference |
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
| `host_session_id` | yes, HttpOnly | no | store key `_sessions_by_id` |
| `host_access_token` | no | yes (`host-client.js`) | copy for observatory |
| Auth0 refresh/access/id | no | no | yes |
| `session_reference_token` | no | no | yes |
| `authentication_token` | no | URL once | copy + `looker_authentication_consumed` |
| nav / api | no | iframe / SDK | last values for next generate |
| `oauth_pkce_state` | SessionMiddleware cookie, 600s | no | Starlette session, not HostSession |

`SessionStore` (`app/services/session_store.py`) is keyed **only** by `host_session_id`. There is no Auth0 `sub` index.

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
| Looker acquire | `POST /api/looker/acquire-embed-session` → `looker_client.acquire_embed_session` | create or reattach via stored reference; new auth token |
| Looker generate | `PUT /api/looker/generate-embed-tokens` → `looker_client.generate_embed_tokens` | identity from HostSession, not body |
| Freeze | `HostSession.freeze_token_refresh` | generate returns 200 + `frozen: true`, no Looker rotate |
| Dead session | `session_reference_token_ttl == 0` | `LookerSessionDead` → HTTP 409 `code: SESSION_DEAD` |

Acquire is not generate. Auth0 code exchange is not host refresh.

## `session:expired`

Iframe `session:expired` / `session:status` with `expired=true` (`POST /api/lab/events`) calls `HostSession.mark_iframe_expired`. It MUST NOT revoke `session_reference_token`, smash nav/api `expires_at`, or un-consume `authentication_token`.

## Logout

`GET /logout` (`app/routes/auth0.py` `logout`): end Looker for **this** HostSession, `revoke_auth0_refresh` for **this** refresh token, `host_session_revoked=True`, `session_store.delete(host_session_id)`, clear cookie, Auth0 `/v2/logout`.

This is **this-browser only**. Logout-everywhere (revoke all HostSessions for `sub`) is **not implemented**.

## Embed clients

Same host contract, two browsers of it:

- `app/static/js/src/embed-sdk-tab.js` — `@looker/embed-sdk` `initCookieless`
- `app/static/js/src/postmessage-tab.js` — raw `session:tokens:request` / `session:tokens`

Client events (`POST /api/lab/events`) set `iframe_client_kind` to `embed_sdk`
or `raw_postmessage` so iframe started/expired flags stay per tab. The host
still accepts the older field `embed_client` and values `sdk` / `postmessage`.

`docs/sequence-happy-path.mmd` is the raw postMessage happy path only.
