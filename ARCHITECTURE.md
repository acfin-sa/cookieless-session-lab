# Architecture — nested cookieless sessions

This lab is a **design method**, not a product. The observatory exists so you can watch every handle move. The rules below are encoded in code comments at token boundaries (`TOKEN:`). Do not water them down.

## 1. HTTP is stateless

A “session” is not a browser object. It is:

1. A **server record** (the real session).
2. A **handle** the client presents on later requests so the server can find that record.

Without the record, the handle is a random string. Without the handle, the record is unreachable.

In this lab:

| Layer | Server record | Handle the client presents |
| --- | --- | --- |
| A — Host | `HostSession` keyed by `host_session_id` (cookie value) | `host_session_id` cookie (opaque) + `host_access_token` (short-lived JWT) |
| B — Looker | Looker’s embed session | `authentication_token` (URL once), `navigation_token` (in-iframe navigation), `api_token` (iframe API calls) |

`session_reference_token` (Looker) and `host_session_reference` (us) never leave the host server. They are not handles the *browser* presents; they are handles the *host* presents to Looker / to itself.

## 2. Why cookieless embed exists

On a first-party site, the handle is usually a cookie. The browser sends it automatically. That works because the cookie’s site matches the page’s site.

An embedded Looker iframe is **cross-site**. A Looker session cookie would be a **third-party cookie**. Many browsers never send it. Looker then cannot see who you are.

Cookieless embed replaces “the browser will attach a cookie” with “the embedding app will attach tokens.” The iframe is an untrusted peer that *asks* for those tokens; the host *mints* them via Looker Admin APIs.

### Vanity-domain / first-party cookie fallback (not implemented)

If you put Looker on a subdomain of the host (`looker.myapp.com` serving the same site as `myapp.com`), Looker’s session cookie becomes first-party and signed-embed cookies work again. That is a DNS / certificate trick, not a token protocol. It is unavailable for many Looker Cloud and multi-tenant setups. This lab implements the token split instead of a vanity domain.

## 3. Split handles by privilege and lifetime

| Privilege | Lifetime | Where it lives | Examples |
| --- | --- | --- | --- |
| High (can mint other tokens / prove identity for a long time) | Long | **Server only** | Auth0 refresh token, `host_session_reference`, Looker `session_reference_token` |
| Low (can call APIs or restore a page *now*) | Short (~5–10 min) | Browser memory or iframe | `host_access_token`, Looker `navigation_token`, Looker `api_token` |
| Bootstrap (create an iframe session) | Single use, ~30 s | **URL once** | Looker `authentication_token` (aka authorization token) |

If a short-lived token leaks, the window is small. If a long-lived high-privilege token leaks, an attacker can mint fresh short-lived material until you revoke. That is why `session_reference_token` must never appear in the iframe URL, `localStorage`, or a JSON response to the browser.

`host_session_id` is a first-party **opaque** cookie: it only identifies which `HostSession` to load. It cannot call Looker by itself. `host_access_token` is the short-lived privilege for `/api/*`.

### What controls duration (lab env vs tenant settings)

**Auth0 token durations are Auth0 tenant settings, not lab env vars.** This repo does not configure them from `.env`. In the Auth0 Dashboard you set, among other things:

- Access token and ID token lifetime (API / application settings)
- Refresh token absolute and idle expiration, and rotation / reuse detection
- Universal Login SSO session: Idle Session Lifetime and Maximum Session Lifetime

After login or refresh, the lab stores Auth0 tokens on `HostSession` and shows `exp` in the observatory when the JWT carries it. Refresh tokens have no `exp` in the UI until Auth0 revokes them or they expire per tenant policy.

**What this lab does configure:**

| Setting | Where | Role |
| --- | --- | --- |
| `HOST_ACCESS_TOKEN_TTL_SECONDS` | `app/config.py` (default **200** s) | `host_access_token` JWT lifetime |
| `LOOKER_EMBED_SESSION_LENGTH` | `.env` (default **720** s) | Looker `session_length` at acquire |
| `HOST_SESSION_COOKIE_MAX_AGE` | `app/services/host_session_auth.py` (12 h) | How long the opaque `host_session_id` cookie lasts |

Looker `navigation_token` / `api_token` TTLs (~10 min) and `authentication_token` (~30 s) come back from Looker on acquire/generate; they are not env vars here. Those two short-lived tokens are **not the same JWT** and are **not** the embed session itself — see below.

### Two Looker JWTs, one embed session

`navigation_token` and `api_token` are two different short-lived JWTs. Acquire and `generate_tokens` usually mint them **together**, but each response field has its own `exp` / TTL. Losing one clock is not the same as losing the other, and neither clock is Layer B identity.

| Token | What it authorizes |
| --- | --- |
| `navigation_token` | Moving around **inside** the embed: page / dashboard navigation in the iframe |
| `api_token` | Looker **API calls** the iframe makes (queries, data) |

Layer B identity is `session_reference_token` (host-only). The iframe’s “I can’t keep working” signal is a **session-level event**, not a per-JWT death certificate.

### `session:expired` is session-level

`session:expired` (and `session:status` with `expired=true`) means the embed considers its **usable token pair** dead. Looker does **not** say “nav died” or “api died.” Typical causes: both TTLs ran out without a successful `generate_tokens`, generate failed, or Layer B identity ended.

The observatory must match that model:

- Label the shared event **iframe session expired** on a Layer B row.
- Let each nav/api card follow **its own JWT `exp`**. Do not smash both `expires_at` values to now, and do not paint both cards from one flag.

## 4. The iframe is an untrusted peer

The Looker UI inside the iframe may:

- `postMessage` `session:tokens:request`
- navigate using `navigation_token` (in-iframe page/dashboard moves)
- call Looker APIs using `api_token` (queries, data)

It may **not**:

- call `acquire_embed_cookieless_session` or `generate_tokens_for_cookieless_session`
- see `session_reference_token`
- dictate which session the host uses

The Embed SDK and the raw `postMessage` tab both obey this. They differ only in *who types the messages*. Compare the two tabs in the observatory.

## 5. Bind session to client context

Looker binds a cookieless session to the **User-Agent** of the browser that acquired it. Generate-tokens with a different UA returns **400**. This lab always forwards the original browser UA, and has a control to send a fake one so you can watch the 400 land in the event log.

Looker also binds **embed_domain** (allow-list in Admin, or passed at acquire time on Looker 23.8+). A missing allow-list looks like a broken iframe, not a neat JSON error — check the event log and Looker Admin.

## 6. Refresh is not acquire

| Method | What it does |
| --- | --- |
| `POST /embed/cookieless_session/acquire` | Creates **or reattaches** identity. Issues a new `authentication_token` for a new iframe. If you pass an existing `session_reference_token`, you join the same session (needed for a second iframe). Session length is **not** extended on reattach. |
| `PUT /embed/cookieless_session/generate_tokens` | Rotates `navigation_token` and `api_token` **without** creating a new identity. If `session_reference_token_ttl == 0`, the session is dead; acquire again. |

When Looker returns `session_reference_token_ttl == 0` on `generate_tokens`, the host raises `LookerSessionDead` and `PUT /api/looker/generate-embed-tokens` responds with **HTTP 409** and `code: SESSION_DEAD`. Layer B is finished — the iframe cannot refresh nav/api. **Layer A can still be valid:** `host_session_id`, stored Auth0 refresh, and a fresh `host_access_token` may all still work. The human can call acquire again without Auth0 login unless the IdP SSO session has also ended.

Layer A has the same split: Auth0 `/oauth/token` (code) **creates** the host session; Auth0 `/oauth/token` (refresh) + `POST /api/host/refresh` **rotates** `host_access_token`.

## 7. Nested sessions

```
Auth0 proves the human
    └── HostSession authorizes the BFF  (Layer A)
            └── Looker cookieless session authorizes the iframe  (Layer B)
```

Losing any outer layer must refuse the inner ones:

- Logout / missing `host_session_id` → no acquire, no generate, Looker session deleted.
- Expired `host_access_token` → Looker routes return 401 even if Looker tokens are still alive.
- Dead Looker `session_reference_token` (`ttl == 0` → `LookerSessionDead` / HTTP 409 on generate, or dropped on the server) → iframe dies; host login can remain. `session:expired` from the iframe is **iframe session expired** (session-level). It does not revoke `session_reference_token`, overwrite a consumed `authentication_token`, or rewrite each JWT’s `exp`.

The observatory colors this on purpose.

## 8. Failure is part of the lesson

| Failure | Lab control or reproduction |
| --- | --- |
| Token expired | Wait, or **Freeze token refresh** and watch nav/api die |
| `authentication_token` consumed | Load the iframe; a second acquire is required for a new auth token |
| User-Agent mismatch | **Force User-Agent mismatch** on next generate_tokens |
| Missing embed-domain allow-list | Documented in README; acquire fails or iframe refuses |
| Lost server state | **Drop session_reference on server** |

## Token map (both layers)

See [`docs/token-method-map.json`](docs/token-method-map.json) — the method catalog table is generated from that file. Every token-moving function in this repo has a `TOKEN:` comment:

```
TOKEN: <name>
CREATED BY / CONSUMED BY
LIVES AT
TTL
WHY
```

## Runtime shape

```
Browser
  host_session_id        HttpOnly cookie, opaque
  host_access_token      memory only (HOST_ACCESS_TOKEN_TTL_SECONDS, default 200 s)
  authentication_token   URL once (~30 s, single use)
  navigation_token       embed URL + postMessage (~10 min) — in-iframe navigation
  api_token              postMessage into iframe (~10 min) — iframe Looker API calls

Host server (in-memory HostSession)
  host_session_reference
  Auth0 refresh + access + id tokens
  current host_access_token (so the observatory can show TTL)
  Looker session_reference_token
  last Looker navigation_token + api_token  (for generate_tokens)
```

Restarting the process wipes Layer A and Layer B. That is intentional for a local lab.

## Local origin and cookies

The browser origin for this lab is **`http://localhost:3000`**. Auth0 callback URLs, Looker `embed_domain`, and redirects are built from `APP_BASE_URL`, never from whatever IP the process bound.

`host_session_id` and `oauth_pkce_state` are first-party cookies: `HttpOnly`, `SameSite=Lax`. `Secure` is set only when `APP_BASE_URL` is `https`. On the HTTP lab they must be `Secure=False` or the browser will drop them.
