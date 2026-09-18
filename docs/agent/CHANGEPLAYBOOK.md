# Change playbook

Invariants first: [INVARIANTS.md](INVARIANTS.md). Map: [CODEMAP.md](CODEMAP.md).

## Safe edit zones

| Zone | Typical edits |
| --- | --- |
| `app/templates/*`, `app/static/css/lab.css` | observatory layout/copy |
| `app/static/js/src/observatory.js` | render-only (do not smash token clocks) |
| `docs/token-method-map.json` | catalog rows when methods/tokens change |
| Human docs (`README.md`, `ARCHITECTURE.md`, `docs/cookieless-brief.md`) | teaching prose |
| Agent docs (`docs/agent/*`, `AGENTS.md`) | contracts; must match code |

## Never “simplify away”

- Server-only Auth0 tokens and `session_reference_token`.
- Cookie vs bearer split (host refresh vs Looker routes).
- Strip of `session_reference_token` in `app/routes/looker.py`.
- Generate identity from `HostSession`, not iframe body.
- Independent nav/api JWT clocks vs iframe `session:expired`.
- Two embed tabs as separate clients.
- In-memory store (do not pretend durability or logout-everywhere).
- `HOST_ACCESS_TOKEN_TTL_SECONDS` remaining a Python constant (not silently moved to `.env` without docs + config update).

## Add a token

1. Add `HostSession` fields in `app/services/session_store.py`.
2. Create/consume in the owning service (`host_tokens.py` or `looker_client.py`) with a `TOKEN:` comment.
3. Update JSON filter if the token is server-only (`looker.py`).
4. Add `docs/token-method-map.json` `tokens[]` (`layer`, `badge`, `purpose`) + method `tokens_in`/`tokens_out`.
5. Wire `observatory.py` `TOKEN_VALUE_FROM_SESSION` / `_token_times` / flags.
6. Update CONTEXT + INVARIANTS.

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
5. Document failure mode in INVARIANTS / README demo.

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

## Architecture page live TTLs

`ARCHITECTURE.md` keeps the repository defaults (host TTL 200 s, Looker session
length 720 s). `/architecture` renders that file as-is and prints this process's
live `HOST_ACCESS_TOKEN_TTL_SECONDS` and `LOOKER_EMBED_SESSION_LENGTH` beside
the article. Do not string-replace the markdown.
