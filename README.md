# cookieless-session-lab

Pedagogical test bench. Not a product. A developer logs in with Auth0, opens an embedded Looker dashboard, and **sees** a two-layer tokenized / cookieless session: which tokens exist, who owns them, which HTTP / postMessage methods create or consume them, when they expire, and how they refresh.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the design method. The method catalog in the UI is generated from [`docs/token-method-map.json`](docs/token-method-map.json).

## Run

```bash
cp .env.example .env
# fill Auth0 + Looker secrets in .env — never commit .env
npm install
npm run dev
```

Then open **http://localhost:3000**. Uvicorn binds `localhost:3000`. Auth0 callbacks, Looker `embed_domain`, and every redirect use `APP_BASE_URL` (`http://localhost:3000`).

Host cookies (`host_session_id`, `oauth_pkce_state`) are `HttpOnly; SameSite=Lax`. `Secure` is **off** on HTTP and **on** only when `APP_BASE_URL` starts with `https://`.

`npm run dev` creates `.venv`, installs Python deps, bundles `@looker/embed-sdk`, and starts the FastAPI app.

## Fill `.env`

Copy `.env.example`. You supply:

- Auth0 Regular Web App: `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`
- Optional `AUTH0_AUDIENCE` (leave empty if unused)
- `APP_KEY_SECRET` — signs the host access JWT and the PKCE state cookie
- Looker API: `LOOKER_BASE_URL`, `LOOKER_CLIENT_ID`, `LOOKER_CLIENT_SECRET`
  - Looker Cloud: `https://<instance>.cloud.looker.com` (HTTPS 443). Do **not** append `:19999` — that port is for self-hosted Looker and will time out on Cloud.
- `LOOKER_EMBED_HOST`, `LOOKER_EMBED_DASHBOARD_ID` (a real embeddable dashboard id)

Embed user **identity** comes from the Auth0 id token (`sub`, name, email). Embed **grants** are constants:

| Env | Default | Sent to Looker acquire as |
| --- | --- | --- |
| `LOOKER_EMBED_SESSION_LENGTH` | `720` (12 min) | `session_length` |
| `LOOKER_EMBED_FORCE_LOGOUT_LOGIN` | `true` | `force_logout_login` (Looker cookieless ignores this; login is always forced) |
| `LOOKER_EMBED_GROUP_IDS` | `1` | `group_ids` |
| `LOOKER_EMBED_EXTERNAL_GROUP_ID` | `cookieless-lab` | `external_group_id` |
| `LOOKER_EMBED_MODELS` | `dw_v3` | `models` |
| `LOOKER_EMBED_PERMISSIONS` | `access_data,see_looks,see_user_dashboards` | `permissions` |

## Auth0 application settings

Regular Web Application, Authorization Code + PKCE, Refresh Token grant, and `offline_access` (Allow Offline Access).

- Allowed Callback URLs: `http://localhost:3000/callback`
- Allowed Logout URLs: `http://localhost:3000`
- Allowed Web Origins: `http://localhost:3000`

If Auth0 does not return a refresh token, the lab still mints `host_access_token` from the HostSession and logs a warning. Enable `offline_access` to see Auth0 refresh in the constellation.

## Looker Admin prerequisites (human)

Do these in Looker Admin **before** the lab can acquire a cookieless session. Do not reset secrets from this repo.

1. **Embed SSO Authentication** enabled (Admin → Platform → Embed).
2. **Cookieless Embed** enabled (same Embed panel / cookieless API exposed).
3. **Embed JWT Secret** set. Do **not** reset it — a reset invalidates every live cookieless session.
4. This lab’s origin **`http://localhost:3000`** allow-listed as an embed domain **or** passed at cookieless session acquire time (Looker 23.8+). This lab always sends `embed_domain=http://localhost:3000` on acquire.
5. The API user (`LOOKER_CLIENT_ID`) can call `acquire_embed_cookieless_session` and `generate_tokens_for_cookieless_session` (Admin, or a role with `manage_embed_settings`).
6. **Persistent Sessions** on if you want multi-iframe attach (second iframe joins the same `session_reference_token`).

If cookieless endpoints are off, acquire often looks like a generic 404.

## Tour after login

You land on `/lab` — the Session Observatory. The Looker iframe stays on the right of a height-capped split; the method catalog sits full-width below.

1. **Token constellation** — eight cards, both layers.
2. **Lifetime swimlane** — Gantt from login `t=0`. Bars tick every second. Hatched end of nav/api = Looker’s ~60s refresh window. Dots = refresh markers.
3. **Live event log** — Browser / Host API / Auth0 / Looker API / iframe postMessage. Click a row to highlight tokens. The static happy-path mermaid lives on `/sequence` (same pattern as `/architecture`).
4. **Method catalog** — full-width table from `docs/token-method-map.json`, under the dashboards.
5. **Embed SDK** vs **Raw postMessage** — same observatory. Compare who moves `session:tokens:request` / `session:tokens`.
6. **Teaching controls**
   - Freeze token refresh — let nav/api expire and watch Looker break.
   - Force User-Agent mismatch — next `generate_tokens` sends a fake UA; Looker 400s in the log.
   - Drop `session_reference` on server — lost BFF state.
   - Countdown overlay on the iframe when nav/api are under 60s.

Logout revokes the Auth0 refresh token when possible, deletes the Looker cookieless session, drops the HostSession, and clears the cookie.

## Layers in one paragraph

**Layer A.** Auth0 Authorization Code + PKCE. Refresh, access, and id tokens stay on the server. Browser gets `host_session_id` (opaque HttpOnly cookie) and `host_access_token` (~200 s, memory). `POST /api/host/refresh` uses the cookie + stored Auth0 refresh to mint a new host access token.

**Layer B.** Only if Layer A bearer is valid. Host calls Looker `acquire` / `generate_tokens` / `DELETE` with the **browser User-Agent**. `session_reference_token` never appears in a browser JSON body. The iframe consumes `authentication_token` once on `/login/embed`, then asks for `navigation_token` (in-iframe page/dashboard navigation) and `api_token` (iframe Looker API calls — queries, data) via postMessage or the Embed SDK. Those two are independent short-lived JWTs, usually minted together, each with its own `exp`. `session:expired` is a session-level “I can’t keep working” event, not “nav died” or “api died.”

Server uses Python `looker-sdk` (same API as `@looker/sdk`). The browser uses `@looker/embed-sdk` 2.x.

## Process memory

HostSession is in-memory. Restarting `npm run dev` kills both layers. That is intentional.
