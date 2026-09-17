# Cookieless Looker session lab

This repository is a teaching lab, not a production application. It shows how an
Auth0 host session can safely support a Looker embed when third-party Looker
cookies are unavailable.

It is for developers evaluating cookieless embed, debugging token renewal, or
extracting the pattern into an existing application.

## The idea

An embedded Looker iframe is cross-site, so browsers may block its session
cookie. Cookieless embed replaces that cookie dependency with short-lived tokens
issued through the host server.

- **Layer A — host:** Auth0 proves the user and the host creates a server-side
  `HostSession`.
- **Layer B — Looker:** the authenticated host acquires a Looker cookieless
  session and renews its iframe tokens.

Long-lived and identity-bearing tokens stay on the server. The browser receives
an opaque `HttpOnly` cookie, a short-lived host JWT in memory, and only the
Looker tokens needed by the iframe.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the design method and
[the cookieless brief](docs/cookieless-brief.md) for a concise Q&A. Coding tools
should start at [AGENTS.md](AGENTS.md).

## Quick start

Requirements: Python 3, Node.js, npm, an Auth0 Regular Web Application, and a
Looker instance with Cookieless Embed enabled.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm install
cp .env.example .env
npm run dev
```

`npm install` also creates `.venv` and installs Python requirements when needed,
so the first two commands are optional if you prefer the automated setup. Fill
`.env` before logging in; never commit it.

Required values:

| Area | Values |
| --- | --- |
| Host | `APP_BASE_URL`, a long random `APP_KEY_SECRET` |
| Auth0 | `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` |
| Looker API | `LOOKER_BASE_URL`, `LOOKER_CLIENT_ID`, `LOOKER_CLIENT_SECRET` |
| Embed | `LOOKER_EMBED_HOST`, `LOOKER_EMBED_DASHBOARD_ID` |

For Looker Cloud, use `https://<instance>.cloud.looker.com` without port `19999`.
The remaining embed grants and the 720-second demo session are documented in
`.env.example`.

Configure Auth0 with:

- callback URL `http://localhost:3000/callback`
- logout URL and web origin `http://localhost:3000`
- Authorization Code + PKCE, Refresh Token grant, and `offline_access`

In Looker Admin, enable Embed SSO Authentication and Cookieless Embed, configure
an Embed JWT Secret, allow `http://localhost:3000`, and grant the API user access
to acquire, generate, and delete cookieless sessions. Do not reset the Embed JWT
Secret merely to run this lab; doing so invalidates live sessions.

## Open these URLs

| URL | Purpose |
| --- | --- |
| `http://localhost:3000` | Sign in |
| `http://localhost:3000/lab` | Interactive session observatory |
| `http://localhost:3000/architecture` | Rendered architecture guide |
| `http://localhost:3000/sequence` | Happy-path raw `postMessage` sequence |
| `http://localhost:3000/health` | Local health and origin check |

The sequence is intentionally a happy path for the raw `postMessage` protocol.
It is not the complete Embed SDK flow or a failure matrix.

## Ten-minute demo

1. Keep `LOOKER_EMBED_SESSION_LENGTH=720` for a viewable 12-minute session.
2. Log in and compare the **Embed SDK** and **Raw postMessage** tabs.
3. Watch the host token renew independently from Looker navigation/API tokens.
4. Turn on **Freeze token refresh** and let the short-lived Looker tokens age.
5. Turn freeze off, reacquire if needed, then enable **Force User-Agent
   mismatch** to make the next Looker generate call fail.
6. Use **Drop session_reference on server** to simulate lost BFF state.
7. Use **End Looker session** to end Layer B while Layer A remains logged in.
8. Log out to delete the current browser's HostSession and clear its cookie.

The method catalog in `/lab` comes from
[`docs/token-method-map.json`](docs/token-method-map.json). Host sessions are
in process memory, so restarting the app intentionally clears both layers.
