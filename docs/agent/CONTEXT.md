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

Human write-up of this contract: [ARCHITECTURE.md](../../ARCHITECTURE.md) sections "Looker cookieless contract" and "Reading the lifetime swimlane".

Looker returns the TTLs. The lab sets only `session_length` (`LOOKER_EMBED_SESSION_LENGTH`, default 720). Usual Looker values:

| Token | Usual TTL | Role | Storage | Browser JSON |
| --- | --- | --- | --- | --- |
| `session_reference_token` | `session_length` | Layer B identity; input to generate/DELETE | `HostSession.looker_session_reference_token` | MUST NOT; stripped in `app/routes/looker.py` |
| `authentication_token` | ~30 s, single use | `/login/embed` once | URL once; consumed flag on HostSession | yes, acquire only |
| `navigation_token` | ~10 min | in-iframe navigation JWT | iframe / embed URL | yes |
| `api_token` | ~10 min | iframe Looker API JWT | iframe | yes |

`navigation_token` and `api_token` are siblings with independent `exp`. They are not aliases and are not Layer B identity. Acquire and generate usually mint them together. Draw each returned TTL. `generate_tokens` rotates both when Looker asks.

`session_reference_token` countdown starts at acquire. `generate_tokens` stores the returned remaining `session_reference_token_ttl` and keeps `looker_session_reference_issued_at`. A new reference string, if Looker returns one, replaces the secret and leaves the countdown in place. Reattach (acquire with the stored reference) ignores `session_length` and keeps that issued-at when the new absolute expiry is within 15 seconds of the previous one. A later expiry beyond that starts a new span (`HostSession.note_session_reference_window`). There is no refresh that extends this TTL. A new countdown requires acquire with no stored reference (`end_embed_session` or a dropped/missing reference, then acquire).

`LOOKER_EMBED_SESSION_LENGTH` is `os.getenv` after `load_dotenv(ROOT_DIR / ".env")` in `app/config.py`. A set `.env` value wins over the Python fallback. The swimlane and cards use Looker's `session_reference_token_ttl`, not that integer. Changing `.env` or the fallback requires a process restart; an already acquired session keeps its returned TTL. `/architecture` prints the loaded integer (`views.architecture`).

`authentication_token` is consumed by iframe navigation to `/login/embed`. `generate_tokens` leaves it unchanged. Its TTL is shorter than the nav/api ask window, so it stays out of the expiring state (`build_observatory_snapshot` and `currentTokenState`).

### When the iframe asks

1. First `session:tokens:request` after load reuses acquire's navigation and API tokens. Embed SDK: `initCookieless`. Raw tab: `postmessage-tab.js`.
2. Looker sends `session:tokens:request` again when either sibling TTL is inside the last 60 seconds.
3. That ask calls `generate_tokens`, which rotates both siblings.
4. `EXPIRING_WINDOW_SECONDS` in `app/services/observatory.py` is that window. Snapshot field `looker_refresh_window_seconds` feeds the swimlane hatch, the expiring state, and the lab overlay. Do not fork a second constant in JS.
5. Freeze returns the current JWTs (`frozen: true`) and does not open new spans or record a generate marker.

`session_reference_token_ttl == 0` is session death (`SESSION_DEAD`), even if nav/api `exp` is still in the future.

### Swimlane

`HostSession.looker_token_spans` is the history the swimlane draws (issued, expires, closed, close reason; no secrets). Reasons: `refreshed` (generate), `replaced` (later acquire), `consumed` (embed login), `dropped` (lab drop; bar still runs to Looker's TTL), `revoked` (End Looker or TTL 0; bar stops at the close).

`app/static/js/src/observatory.js` `renderGantt` sizes the axis through those Looker ends (plus iframe envelope). It stacks successive nav/api spans, hatches the last `looker_refresh_window_seconds` of each, and puts `generate_tokens` / acquire markers on the Looker and iframe lanes. Host JWT markers stay on the Auth0 and Host lanes. Host and Auth0 bars that outlive the axis draw a continuation chevron. Do not clip Looker bars to now+60s.

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
| Host refresh | `POST /api/host/refresh` → `refresh_host_access_token` | cookie. If `auth0_refresh_token` is set, `refresh_auth0_tokens` runs first; `Auth0RefreshError` returns HTTP 401 and does not mint. Otherwise `mint_host_access_token`. |
| Looker acquire | `POST /api/looker/acquire-embed-session` → `looker_client.acquire_embed_session` | `embed_domain=APP_BASE_URL`; create or reattach via stored reference; new auth token |
| Looker generate | `PUT /api/looker/generate-embed-tokens` → `looker_client.generate_embed_tokens` | identity from HostSession, not body; if Looker returns a replacement `session_reference_token`, the server stores it |
| Freeze | `HostSession.freeze_token_refresh` | generate returns 200 + `frozen: true`, no Looker rotate |
| Dead session | `session_reference_token_ttl == 0` | `LookerSessionDead` → HTTP 409 `code: SESSION_DEAD` |

Acquire is not generate. Auth0 code exchange is not host refresh. Generate does not extend `session_reference_token`.

### Host JWT refresh chain

`app/static/js/src/host-client.js`:

- `bootstrapHostSession` → `POST /api/host/bootstrap` (cookie only) → `storeHostAccessToken`.
- `storeHostAccessToken` sets memory JWT + `hostAccessExpiresAt` from `expires_at` (else JWT `exp`) and calls `scheduleHostRefresh`.
- `scheduleHostRefresh` is one `setTimeout`, not an interval. Wait is `max(5000, remainingMs - leadMs)`. The lead is the literal subtracted in that function. On fire it calls `refreshHostAccessToken`. Success stores the new JWT and therefore schedules the next timeout. Failure is `console.warn` only; it does not schedule another attempt.
- `fetchWithHostAccessToken`: on HTTP 401 (except bootstrap/refresh themselves), call `refreshHostAccessToken` once and retry the original request with the new bearer. A second 401 throws.
- `refreshHostAccessToken` coalesces with `refreshInFlight`. It does not send the bearer; the cookie selects the HostSession.

Embed acquire and generate go through `fetchWithHostAccessToken`. If the chained refresh has failed and the 401 retry also fails, `generateTokens` / the postMessage generate path throw while nav/api `exp` and `session_reference_token_ttl` can still be in the future. The iframe then emits `session:expired` or shows its interrupted state. That is not evidence that a Looker token expired. `authentication_token` is already consumed at `/login/embed` and is not an input to generate.

Expiry of the host JWT alone does not change the page. Effects below require the JWT to be expired **and** `POST /api/host/refresh` to fail:

| Surface | Behavior |
| --- | --- |
| Embed SDK | `generateTokens` throws on the next `session:tokens:request` (either sibling inside `EXPIRING_WINDOW_SECONDS`). Looker shows its interrupted state. The iframe keeps working until that ask. |
| Raw postMessage | `postmessage-tab.js` posts `session:tokens` with `session_reference_token_ttl: 0` so the iframe expires. |
| Observatory | `poll` catches and `console.warn`s. Cards, gantt, and event log stay on the last snapshot. The 1s `renderCards` / `renderGantt` interval still moves those old clocks. |
| Controls | Freeze, UA mismatch, drop reference, and End Looker call `showLabError`. Toggles revert. |
| Browser-originated events | `reportEvent` `console.warn`s; the row is not stored. |
| Login | No redirect. The host cookie can still be valid. |
| Copy event log | `#btn-copy-event-log` copies the in-memory snapshot; it does not call the API. |

### Whose clock expires a token

`verify_host_access_token` (`app/services/host_tokens.py`) and Looker enforce absolute `exp` / returned TTLs. Browser `Date.now()` is used for countdowns, the swimlane now-line, and `scheduleHostRefresh` remaining time. Setting the browser clock forward makes the UI look expired and can fire host refresh early. It does not make PyJWT reject the host JWT, and it does not make Looker expire nav, api, or session reference. There is no lab time-scale control. Chrome virtual time (`Emulation.setVirtualTimePolicy`) does not move this Python process or Looker, and the Looker iframe may not share it.

### Shortening navigation and API TTLs

`EmbedCookielessSessionAcquire` and `EmbedCookielessSessionGenerateTokens` have no navigation or API TTL fields (`looker_sdk` `api40/models.py`). Response fields `navigation_token_ttl` and `api_token_ttl` are Looker's. Usual value is ~10 minutes when `session_length` is longer than that. Those tokens cannot outlive the session, so `LOOKER_EMBED_SESSION_LENGTH` below ~600 seconds caps the TTLs Looker returns on acquire and on later generate (remaining session reference). Apply it the same way as any session-length change: restart, end Layer B, acquire with no stored reference.

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
