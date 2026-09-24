# Cookieless Looker: briefing Q&A

This is the short briefing for the
[cookieless session lab](../README.md). See
[ARCHITECTURE.md](../ARCHITECTURE.md) for the design method. Exhaustive
token, storage, renew, User-Agent, logout, and embed-client detail lives in
[docs/agent/CONTEXT.md](agent/CONTEXT.md).

## Why does Looker need a cookieless mode?

An embedded Looker iframe is cross-site. Browsers may block or partition
Looker's third-party session cookie, so the iframe cannot reliably recover a
normal cookie-backed session.

Cookieless embed moves that responsibility to the embedding application. The
host server establishes the Looker session and supplies short-lived iframe
tokens without exposing the durable session reference.

## What are Layer A and Layer B?

| Layer | Responsibility | Durable server-side identity |
| --- | --- | --- |
| A — host | Auth0 login and access to the host API | `HostSession` |
| B — Looker | Embedded dashboard session | `session_reference_token` |

Layer A gates Layer B. A user can remain logged into the host after ending the
Looker session, but a missing or revoked host session must not acquire or renew
Looker tokens.

## Which tokens can reach the browser?

The browser receives an opaque `host_session_id` cookie, a short-lived
`host_access_token` in memory (host BFF JWT — not Auth0 access and not Looker's
`api_token`), a one-use `authentication_token`, and sibling `navigation_token` /
`api_token` JWTs for the iframe.

Auth0 refresh, access, and ID tokens stay on the server, as does
`session_reference_token`. `host_session_reference` is a lab-only observatory
id; it is not sent to Auth0 or Looker.

## Why are there two short-lived Looker tokens?

`navigation_token` authorizes movement inside the embed.
`api_token` authorizes Looker API work performed by the iframe. They are
siblings under the same session reference, are normally rotated together, and
have independent returned TTLs.

## How long are the four Looker tokens, and when do they refresh?

Looker chooses these TTLs. This lab sets only the session length (default 720
seconds). The full contract and the swimlane reading guide are in
[ARCHITECTURE.md](../ARCHITECTURE.md).

| Token | Usual lifetime | Refresh |
| --- | --- | --- |
| `authentication_token` | about 30 seconds, single use on `/login/embed` | Acquire mints it. `generate_tokens` leaves it unchanged. |
| `navigation_token` | about 10 minutes | Looker asks in the last 60 seconds of this JWT or of `api_token`. |
| `api_token` | about 10 minutes | Same ask. `generate_tokens` rotates both siblings. |
| `session_reference_token` | the session length, server only | `generate_tokens` returns the time remaining and leaves that countdown in place. |

The first `session:tokens` reply after the iframe loads reuses the acquire
tokens. Later replies call generate. The `/lab` swimlane draws each returned
window: a short authentication bar, stacked navigation and API generations with
a hatch on the last 60 seconds, and one session-reference bar across generate.

## Does renew mean login again?

No. Login proves identity; renewal rotates short-lived credentials while the
durable server-side session remains. Host refresh keeps Layer A callable.
Looker generate rotates iframe tokens under the stored session reference. If
Looker reports zero session-reference TTL, Layer B is dead and must be acquired
again — Layer A may still be valid.

## What does the iframe's `session:expired` event prove?

It says the iframe cannot keep working. It does not revoke the server's session
reference and does not rewrite the independent navigation/API expiry clocks.

## Why does User-Agent matter?

Looker binds cookieless calls to the client context. The lab forwards the
**current request** User-Agent. A normal browser keeps it stable; the mismatch
control substitutes a fake value on generate so the failure is visible. That is
not “always the original login UA.”

## What happens with two browsers?

Each callback creates a separate HostSession. Logging out in browser 1 deletes
only the session selected by browser 1's cookie. Browser 2 remains logged in.

Logout-everywhere requires a server-side index from Auth0 `sub` to every
HostSession, followed by revocation of each Auth0 refresh token and Looker
session. This lab intentionally does not implement that index.

## How do we decide whether the user is “logged in”?

There is no universal bit. Check the layer that matters:

| Question | Evidence |
| --- | --- |
| Host session exists? | Cookie resolves to a non-revoked HostSession |
| Host API access works? | Host JWT verifies and its `jti` is current |
| Auth0 can renew? | Auth0 accepts the server-held refresh token |
| Looker tokens are current? | Their individual returned TTLs have not elapsed |
| Looker session can renew? | Generate succeeds with nonzero session-reference TTL |
| Iframe is usable? | Token state plus the iframe session event |

## What should become modules in a real application?

Separate Auth0 identity, the host session repository, host-token minting,
Looker acquire/generate/end, the SDK or postMessage browser adapter, and
redacted observability.

Replace the lab's in-memory store with shared durable storage and add a user
index if logout-everywhere is required. Keep renewal credentials server-only.

## One-sentence takeaway

The server owns durable identity and renewal; the browser gets only an opaque
host handle and short-lived tokens; logout remains per HostSession unless the
application deliberately revokes every session for that user.
