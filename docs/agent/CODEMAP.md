# Code map

Index: [AGENTS.md](../../AGENTS.md). Invariants: [INVARIANTS.md](INVARIANTS.md).

## Directory map

| Path | Owns |
| --- | --- |
| `app/web.py` | FastAPI app, SessionMiddleware (`oauth_pkce_state`, `max_age=600`), `/health` (`health_check`) |
| `app/config.py` | Env + hardcoded `HOST_ACCESS_TOKEN_TTL_SECONDS`, `LOOKER_MISMATCH_USER_AGENT`, `APP_KEY_SECRET` |
| `app/routes/auth0.py` | `GET /login`, `/callback`, `POST /logout` |
| `app/routes/host.py` | `POST /api/host/bootstrap`, `/refresh` |
| `app/routes/looker.py` | Layer B HTTP: acquire / generate / end; `browser_safe_looker_payload` strip; generate freeze/failure logs |
| `app/routes/lab.py` | Observatory snapshot, events, controls, drop-reference |
| `app/routes/views.py` | `/`, `/lab`, `/architecture`, `/sequence` |
| `app/services/session_store.py` | `HostSession`, `LabEvent`, `SessionStore`, `session_store` |
| `app/services/csrf.py` | `csrf_token_for_request`, `validate_csrf_token` (SessionMiddleware) |
| `app/services/host_session_auth.py` | Cookie + bearer gates; `HOST_SESSION_COOKIE_MAX_AGE`; `request_user_agent` |
| `app/services/host_tokens.py` | `mint_host_access_token`, `verify_host_access_token`, `apply_auth0_token_set` |
| `app/services/auth0_client.py` | `refresh_auth0_tokens`, `revoke_auth0_refresh` |
| `app/services/looker_client.py` | `acquire_embed_session`, `generate_embed_tokens`, `end_embed_session`, `drop_session_reference` |
| `app/services/observatory.py` | `build_observatory_snapshot`, `load_method_map` |
| `app/services/events.py` | `log_event` (redacts summaries to 500 chars) |
| `app/static/js/src/host-client.js` | Memory host JWT; `fetchWithHostAccessToken`; bootstrap/refresh |
| `app/static/js/src/embed-sdk-tab.js` | Embed SDK tab |
| `app/static/js/src/postmessage-tab.js` | Raw postMessage tab |
| `app/static/js/src/lab.js` | Tab switch, controls, overlays |
| `app/static/js/src/observatory.js` | Poll `/api/lab/snapshot` |
| `docs/token-method-map.json` | Method catalog + token `badge` (Auth0 / Host / Looker) for constellation |
| `docs/sequence-happy-path.mmd` | Happy-path postMessage sequence |
| `scripts/dev.mjs` | venv check, esbuild, uvicorn `--reload` localhost:3000 |
| `scripts/local.sh` | uvicorn only (not `npm run dev`) |
| `tests/` | Pytest for token state, freeze, SESSION_DEAD 409, drop vs expire |
| `.env.example` | Placeholders; `LOOKER_EMBED_SESSION_LENGTH=720` |

## HTTP routes

Cookie auth (`require_cookie_session`) unless noted.

| Method | Path | Handler | Auth |
| --- | --- | --- | --- |
| GET | `/login` | `auth0.login` | none |
| GET | `/callback` | `auth0.callback` | Auth0 code |
| POST | `/logout` | `auth0.logout` | cookie + CSRF form token |
| POST | `/api/host/bootstrap` | `host.bootstrap_host_access_token` | cookie |
| POST | `/api/host/refresh` | `host.refresh_host_access_token` | cookie |
| POST | `/api/looker/acquire-embed-session` | `looker.acquire_embed_session` | bearer |
| PUT | `/api/looker/generate-embed-tokens` | `looker.generate_embed_tokens` | bearer |
| POST | `/api/looker/end-embed-session` | `looker.end_embed_session` | bearer |
| GET | `/api/lab/snapshot` | `lab.observatory_snapshot` | bearer |
| POST | `/api/lab/events` | `lab.record_client_event` | bearer |
| POST | `/api/lab/controls` | `lab.update_lab_controls` | bearer |
| POST | `/api/lab/drop-session-reference` | `lab.drop_session_reference` | bearer |
| GET | `/`, `/lab`, `/architecture`, `/sequence` | `views.*` | cookie for `/lab` gate |
| GET | `/health` | `web.health_check` | none |

Acquire / generate / end implementation: `app/routes/looker.py` + `app/services/looker_client.py`. Logout: `app/routes/auth0.py`.

## Store shape

`HostSession` keyed by `host_session_id`. `SessionStore._sessions_by_id`. Singleton `session_store`. Methods: `save`, `get`, `delete`. No `sub` index.

Relevant fields: Auth0 tokens + claims; host JWT + `jti`; Looker four tokens + TTLs; flags `freeze_token_refresh`, `force_user_agent_mismatch`, `session_reference_dropped`, `looker_session_revoked`, `host_session_revoked`; per-iframe SDK/postmessage started/expired; `user_agent` (login); `events`; `refresh_markers`.

## Config knobs

| Symbol | Where | Notes |
| --- | --- | --- |
| `LOOKER_EMBED_SESSION_LENGTH` | `.env` / `config.py` default 720 | Looker `session_length` at acquire |
| `LOOKER_EMBED_FILTER_PERIODO` / `GESTOR` | `.env` / `config.py` | Embed SDK cold-start `withFilters`; via `page_config.coldStartDashboardFilters` |
| `HOST_ACCESS_TOKEN_TTL_SECONDS` | `app/config.py` **hardcoded 200** | not `.env` |
| `APP_KEY_SECRET` | `.env` | HS256 host JWT + SessionMiddleware |
| `HOST_SESSION_COOKIE_MAX_AGE` | `host_session_auth.py` 12h | opaque cookie |
| `LOOKER_MISMATCH_USER_AGENT` | `config.py` | generate-only teaching UA |
| `APP_BASE_URL` | `.env` | callbacks, `embed_domain`, cookie Secure |
| `MERMAID_MODULE_URL` | `.env` / `config.py` default pinned 11.17.2 | `/sequence` ESM import; not a floating `@11` tag |

Auth0 token TTLs are tenant settings, not lab env.

## JS tabs

| Tab | Module | Start | Host calls |
| --- | --- | --- | --- |
| Embed SDK | `embed-sdk-tab.js` | `startEmbedSdkTab` | acquire + generate via SDK callbacks |
| Raw postMessage | `postmessage-tab.js` | `startPostMessageTab` | acquire; first `session:tokens` reuses acquire; later generate |

`lab.js` constants: `EMBED_SDK_TAB = "embed-sdk"`, `POSTMESSAGE_TAB = "postmessage"`. Controls: `#toggle-freeze`, `#toggle-user-agent-mismatch`, `#btn-drop-session-reference`, `#btn-end-looker`.
