# Change playbook

Invariants first: [INVARIANTS.md](INVARIANTS.md). Map: [CODEMAP.md](CODEMAP.md).
Lifecycle / boundaries: [CONTEXT.md](CONTEXT.md).

## Agent sources of truth

When routes, tokens, or token-moving methods change, update these so they match
`app/` (and `app/static/js/src/` when the browser contract changes):

| File | Owns |
| --- | --- |
| [`docs/token-method-map.json`](../token-method-map.json) | Method catalog + token `badge` |
| [INVARIANTS.md](INVARIANTS.md) | MUST / MUST NOT |
| [CODEMAP.md](CODEMAP.md) | Files, routes, symbols, config knobs |
| [CONTEXT.md](CONTEXT.md) | Trust boundaries, token lifecycle, storage, renew, UA, logout, embed clients |

Human docs (`README.md`, `ARCHITECTURE.md`, `docs/cookieless-brief.md`) teach
the model. After a surface change, fix a sentence, trade-off, or demo step if
the teaching became wrong. Do not re-copy the full inventory into those files.

## Docs match code

1. `token-method-map.json` if the method moves tokens or badges change.
2. INVARIANTS if a MUST / MUST NOT changes.
3. CODEMAP for paths, handlers, store fields, and knobs.
4. CONTEXT for lifecycle, boundaries, storage, renew, UA, logout, or embed clients.
5. Human docs only as teaching — not as a second full inventory.

## Safe edit zones

| Zone | Typical edits |
| --- | --- |
| `app/templates/*`, `app/static/css/lab.css` | observatory layout/copy |
| `app/static/js/src/observatory.js` | render-only (do not smash token clocks) |
| `docs/token-method-map.json` | catalog rows when methods/tokens change |
| Human docs (`README.md`, `ARCHITECTURE.md`, `docs/cookieless-brief.md`) | teaching prose; not a second inventory |
| Agent docs (`docs/agent/*`, `AGENTS.md`) | contracts; must match code |

## Never “simplify away”

- Server-only Auth0 tokens and `session_reference_token`.
- Cookie vs bearer split (host refresh vs Looker routes).
- Strip of `session_reference_token` in `app/routes/looker.py`.
- Generate identity from `HostSession`, not iframe body.
- Independent nav/api JWT clocks vs iframe `session:expired`.
- Looker cookieless lifetimes and the 60s nav/api ask (`EXPIRING_WINDOW_SECONDS`). `authentication_token` stays outside that window. `generate_tokens` leaves the session-reference countdown in place. Do not treat generate or reattach as a session-length refresh.
- `.env` over the `LOOKER_EMBED_SESSION_LENGTH` fallback. The swimlane follows Looker's returned TTL.
- Host JWT refresh as a success-chained timeout in `host-client.js`, plus one 401 retry. A failed refresh is not an interval. Embed death can happen while Looker TTLs remain. Host-JWT expiry alone does not tear down the page; see CONTEXT for which surface fails how.
- Browser `Date.now()` as display and refresh scheduling only. Do not add a clock-speed control and expect Looker or the host JWT to expire early.
- Navigation and API TTLs as Looker response fields. Do not add request fields for them. A shorter `session_length` is the cap.
- The split between Looker's autonomous `session:tokens:request` and the host-written generate callback. Do not echo acquire TTLs on a later ask. The SDK generates only when `Date.now() > generateTokensTime`. On the first ask it sets that gate to the cached TTL minus 120s, and Looker's ask lands on that instant, so the iframe dies near page time 8:38 while the session reference remains. Keep `armIframeTokenRotation`: pin the gate to 150s before nav/api expiry during acquire, before that first ask, and re-pin after the SDK rewrites it.
- `looker_token_spans` and a swimlane that draws those returned windows. Do not clip Looker bars to now+60s.
- Two embed tabs as separate clients.
- In-memory store (do not pretend durability or logout-everywhere).
- `HOST_ACCESS_TOKEN_TTL_SECONDS` remaining a Python constant (not silently moved to `.env` without docs + config update).

## Add a token

1. Add `HostSession` fields in `app/services/session_store.py`.
2. Create/consume in the owning service (`host_tokens.py` or `looker_client.py`) with a `TOKEN:` comment.
3. Update JSON filter if the token is server-only (`looker.py`).
4. Add `docs/token-method-map.json` `tokens[]` (`layer`, `badge`, `purpose`) + method `tokens_in`/`tokens_out`.
5. Wire `observatory.py` `TOKEN_VALUE_FROM_SESSION` / `_token_times` / flags.
6. Update CONTEXT, INVARIANTS, and CODEMAP. Do not add a duplicate token matrix to human docs.

## Add an event

1. Prefer `log_event` (`app/services/events.py`); never log raw secrets.
2. Browser-originated: `POST /api/lab/events` via `reportEvent` in `host-client.js`.
3. Iframe expiry must keep calling `mark_iframe_expired` without revoking Layer B identity.
4. Catalog only if the event moves tokens (`token-method-map.json`).

## Add a lab control

1. Flag on `HostSession`.
2. `POST /api/lab/controls` in `app/routes/lab.py`.
3. Checkbox in `app/templates/lab.html` + handler in `lab.js`.
4. Snapshot `flags` in `build_observatory_snapshot`.
5. Document the failure mode in INVARIANTS. Add a README demo step only if the teaching path changed.

## Verify

```bash
npm run build:js
.venv/bin/python -m compileall -q app
```

`scripts/local.sh` starts uvicorn only; it does not install deps or bundle JS. Use `npm run dev` for the full lab.

Manual `/lab` checks:

1. Login → `/lab`; constellation shows Layer A; acquire fills Layer B without `session_reference_token` in network JSON.
2. Embed SDK tab and Raw postMessage tab both load the dashboard.
3. Freeze on → generate 200 `frozen: true`; nav/api clocks continue.
4. UA mismatch on → next generate Looker 400 in event log; acquire still uses request UA.
5. Drop session_reference → later generate 409 `SESSION_DEAD`.
6. End Looker → Layer A remains; Layer B cleared.
7. Logout → this cookie/session gone; do not expect other browsers’ HostSessions gone.
8. `/sequence` still matches `docs/sequence-happy-path.mmd` (happy-path postMessage).
9. If token-moving methods changed, `/lab` catalog matches `docs/token-method-map.json`.
10. If routes, tokens, or token-moving methods changed: token-method-map, INVARIANTS, CODEMAP, and CONTEXT match the code. Human docs were not used as a second full inventory.
11. Swimlane: `authentication_token` is its returned single-use window (~30s) with a tick at `/login/embed`; each `navigation_token` and `api_token` generation keeps its returned window and a hatch on the last 60s; `session_reference_token` stays one bar from acquire through `generate_tokens`.

## Architecture page live TTLs

`ARCHITECTURE.md` keeps the repository defaults (host TTL 200 s, Looker session
length 720 s). `/architecture` renders that file as-is and prints this process's
live `HOST_ACCESS_TOKEN_TTL_SECONDS` and `LOOKER_EMBED_SESSION_LENGTH` beside
the article. Do not string-replace the markdown.
