# Agent entry point

## Purpose

Pedagogical FastAPI + Auth0 + Looker cookieless embed lab. Preserve the
two-layer session model and token ownership boundaries. This is not a production
session store.

Human onboarding: [README.md](README.md). Human design rationale:
[ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

- Python: FastAPI, Authlib, PyJWT, `looker-sdk`
- Browser: JavaScript modules, `@looker/embed-sdk`, esbuild
- State: process-local `SessionStore` in `app/services/session_store.py` (keyed only by `host_session_id`)
- Templates: Jinja2

## Read first

1. [docs/agent/CONTEXT.md](docs/agent/CONTEXT.md) — trust boundaries and token lifecycle
2. [docs/agent/INVARIANTS.md](docs/agent/INVARIANTS.md) — non-negotiable rules
3. [docs/agent/CODEMAP.md](docs/agent/CODEMAP.md) — file-to-symbol and route map
4. [docs/agent/CHANGEPLAYBOOK.md](docs/agent/CHANGEPLAYBOOK.md) — safe changes and verification

The runtime method catalog is
[`docs/token-method-map.json`](docs/token-method-map.json). Keep it synchronized
when token-moving methods change.

## Commands

```bash
npm install
npm run build:js
.venv/bin/python -m compileall -q app
npm run dev
```

There is no automated test suite. Verify with compileall and the manual `/lab`
checks in the change playbook.

## Scope rules

- MUST preserve server-only Auth0 tokens and Looker `session_reference_token`.
- MUST keep Layer A authorization in front of Layer B routes.
- MUST treat SDK and raw postMessage tabs as two clients of the same host contract.
- MUST NOT commit `.env`, generated secrets, or real token values.
- MUST NOT infer production durability or logout-everywhere from the current
  in-memory store.
