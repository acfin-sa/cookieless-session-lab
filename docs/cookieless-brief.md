# Cookieless Looker — study brief

Understand cookieless Looker, refresh vs session tokens, browser vs server storage, server role on renew, multi-browser logout, and how to check validity — enough to modularize later.

Reference lab: `cookieless-session-lab` (Layer A host + Layer B Looker embed).

---

## 1. What “cookieless” means for Looker

Looker is embedded cross-origin. The browser cannot reliably send Looker session cookies (third-party cookies).

**Cookieless** = the host app proves who the embed is, instead of the Looker’s cookies being in charge of that verification. The host server talks to Looker Admin APIs, mints short-lived tokens, and feeds them to the iframe (Embed SDK or `postMessage`). The iframe is an untrusted peer: it may *ask* for tokens; it must not own the long-lived identity.

Two nested sessions:


| Layer          | What it is               | Identity handle (server-only)                         |
| -------------- | ------------------------ | ----------------------------------------------------- |
| **A — Host**   | Your app’s login (Auth0) | Host session record + opaque `host_session_id` cookie |
| **B — Looker** | Cookieless embed         | `session_reference_token` (never to the browser)      |


Logout / missing host session → no acquire, no generate.

Layer B dies with the host gate, not the other way around.

---

## 2. Refresh tokens vs session tokens


| Kind                      | Role                                                     | Lifetime (typical)  | Privilege                   |
| ------------------------- | -------------------------------------------------------- | ------------------- | --------------------------- |
| **Session / short-lived** | Prove access *now* (API call, iframe nav, host `/api/`*) | Minutes             | Limited                     |
| **Refresh / long-lived**  | Mint new short-lived material without full login         | Hours–days (policy) | High — can mint more tokens |


**Layer A (Auth0 / host)**

- Auth0 **refresh_token** — long-lived; server only; used to get new Auth0 access/id when needed.
- Auth0 **access_token** / **id_token** — short-lived; server only in this design.
- **host_access_token** — short-lived host JWT in browser memory; authorizes `/api/`*. Not Auth0’s refresh token.

**Layer B (Looker)**

- **session_reference_token** — Looker embed *session identity*; server only; input to `generate_tokens` / end session. Behaves like “session handle”.
- **authentication_token** — one-shot bootstrap (~30s); put on embed login URL once; then consumed.
- **navigation_token** — short-lived; iframe navigation inside the embed.
- **api_token** — short-lived; iframe Looker API calls.

`navigation_token` and `api_token` are siblings under the same `session_reference_token`. Separate JWTs, separate jobs, usually rotated together by `generate_tokens`.

An iframe `session:expired` is a *session-level* signal — not proof that each JWT’s `exp` failed independently, and not automatic revoke of `session_reference_token`.

**Rule:**

- long-lived + high privilege → server only.
- Short-lived → may touch the browser (memory / iframe), never `localStorage` for secrets you care about.

---

## 3. Browser vs server

### Browser


| Handle                          | Where               | Notes                                                  |
| ------------------------------- | ------------------- | ------------------------------------------------------ |
| `host_session_id`               | HttpOnly cookie     | Opaque. Only identifies which host record to load.     |
| `host_access_token`             | Memory              | Short JWT for `/api/*`. Refreshed via cookie + server. |
| `authentication_token`          | URL once            | Then gone.                                             |
| `navigation_token`, `api_token` | Iframe / SDK memory | Never include `session_reference_token`.               |


### Server


| Handle                         | Notes                                                |
| ------------------------------ | ---------------------------------------------------- |
| HostSession record             | Auth0 tokens, Looker reference, flags, event log     |
| Auth0 refresh / access / id    | Never returned to JS                                 |
| `session_reference_token`      | Never in URL, `localStorage`, or JSON to the browser |
| `host_session_reference` (lab) | Internal host id; not a client credential            |


---

## 4. What the server does on renew

Renew ≠ login. Renew = rotate short-lived tokens while identity stays on the server.

**Host renew (**`POST /api/host/refresh`**)**

1. Browser sends opaque cookie (and may send expiring bearer).
2. Server loads HostSession.
3. If Auth0 refresh is present, server may refresh Auth0 tokens.
4. Server mints a new `host_access_token`.
5. Browser stores the new JWT in memory only.

**Looker renew (**`generate_tokens`**)**

1. Browser asks (SDK callback or `session:tokens:request`).
2. Server loads `session_reference_token` (and last nav/api if Looker requires them).
3. Server calls Looker; gets new `navigation_token` + `api_token` (+ TTLs).
4. Server returns **only** browser-safe tokens to the iframe path.
5. If Looker returns `session_reference_token_ttl == 0`, Layer B is dead → acquire again (Layer A may still be fine).

The server is the only party allowed to hold long-lived handles and to call Looker Admin APIs.

---

## 5. Logout: same user, two browsers

Each browser has its own cookie + its own in-memory `host_access_token`. Server may have **one HostSession per cookie** (or per tab strategy), not “one global user flag” unless you build that.

**Close session in browser 1 only**

1. Browser 1 → logout.
2. Server: revoke that HostSession, revoke Auth0 refresh if you use it, call Looker end-session if a `session_reference_token` exists, clear cookie.
3. Browser 1: cookie gone, memory tokens gone → logged out.
4. Browser 2: still has its cookie and tokens → **still logged in** until its host session is revoked or cookies/tokens expire.

To log out **everywhere**, the server must revoke **all** HostSessions (and Auth0 refresh / Looker sessions) for that user id — not only the current cookie. That is a deliberate product choice; cookieless does not give it for free.

---

## 6. Is a token valid? Is the user logged in?

There is no single global “am I logged in?” bit. Check by layer and by handle:


| Check                   | How                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| Host cookie session     | Server: cookie → HostSession exists and not revoked                                                  |
| `host_access_token`     | Verify JWT signature + `exp` (+ `jti` if you track revoke)                                           |
| Auth0 refresh           | Call Auth0; failure / revoke = dead                                                                  |
| Looker nav/api          | Own `exp` / TTL; iframe may also fire `session:expired`                                              |
| Looker session identity | `generate_tokens` / end-session against `session_reference_token`; `ttl == 0` ⇒ session dead         |
| “Logged in” for UX      | Cookie + live HostSession (and optionally a valid host JWT). Looker embed up is a *second* question. |


Observability (as in the lab): snapshot of presence, `exp`, revoked/consumed flags, and an event log beat guessing from the iframe alone.

---

## 7. Modules to extract later

Keep boundaries hard so cookieless stays modular:

1. **Auth0 login** — authorize, callback, logout, PKCE.
2. **Host session** — server record, opaque cookie, mint/verify `host_access_token`.
3. **Looker bridge** — acquire, generate, end; map browser-safe vs server-only tokens.
4. **Renewal** — host refresh path; Looker generate path; freeze/failure behavior.
5. **Logout / revoke** — per-browser vs all-sessions; Auth0 revoke + Looker end + cookie clear.

Do not mix: iframe must never see `session_reference_token` or Auth0 refresh. Host JWT must not become a long-lived cookie.

---

## One-line summary

Cookieless Looker = **server holds identity and long-lived handles; browser only gets short-lived tokens and an opaque host cookie; renew is server-side minting; logout is per host session unless you revoke all sessions for that user.**
