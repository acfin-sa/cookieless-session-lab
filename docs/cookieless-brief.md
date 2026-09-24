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
`session_reference_token`.

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

## What runs by itself, and what must the host write?

Looker asks on its own. It sends `session:tokens:request` when the iframe
loads, and again when either navigation or API token is inside its last 60
seconds. It also shows "session interrupted" if the answer is missing or
claims a longer TTL than the JWT still has.

The host writes the answer. The first answer returns the tokens from acquire.
Every later answer must call `generate_tokens` and return the new navigation
and API tokens with the seconds they actually have left. The Embed SDK will
not call Looker's generate API unless your callback does. The raw postMessage
tab is the same contract without the SDK.

Do not echo the original 10-minute TTL on a later ask. The Embed SDK will
skip generate when Looker's ask arrives on its gate, described next.

## What is the Embed SDK generate gate?

`@looker/embed-sdk` caches the acquire TTLs and sets `generateTokensTime` to
120 seconds before that cached number. It calls your generate callback only
when the clock is already past that time. An ask that lands on the gate is
answered with the original 10-minute TTL.

That reply is the session-interrupted error. Generate never ran. On the page
timer the gate reads as the first token request plus 8:00, about **8:39** when
the iframe first asked roughly 39 seconds after load. The session reference
still has time. The swimlane shows no new navigation or API bar and no amber
line.

Send the seconds still left, or generate and push new tokens before the gate.
This lab does both: it rewrites the cached TTLs every second, and with 180
seconds left it calls generate and pushes `session:tokens` into the iframe.

## Can the session reference be refreshed?

No. Generate may replace the secret string. It does not extend the lifetime.
Reattach ignores a new `session_length`. When the countdown hits zero, acquire
a new Looker session.

The length of a new session is `LOOKER_EMBED_SESSION_LENGTH` in `.env`. That
file overrides the fallback in `app/config.py`. Restart, end the current Looker
session, and acquire again before the swimlane can show the new length. The bar
is the TTL Looker returned.

## Can navigation and API lifetimes be shortened?

Not on their own. Acquire and generate have no field for those TTLs. Looker
returns about 10 minutes when the session is longer than that. Those tokens
cannot outlive the session, so a `LOOKER_EMBED_SESSION_LENGTH` below 10 minutes
caps them. Restart, end Looker, and acquire again. Later generate calls stay
inside the time still left on the session reference.

## Can the browser clock be sped up to simulate expiry?

No. Expiry is an absolute time checked by the host and by Looker. The page uses
its clock only to draw countdowns and to decide when to refresh the host JWT.
Moving that clock makes the swimlane look expired and can fire host refresh
early. It does not make the server reject the host JWT, and it does not make
Looker expire navigation, API, or session-reference tokens. Shorten the
lifetimes above instead.

## Why can the embed die while Looker tokens are still valid?

`host_access_token` is the browser's pass to the host API. The page refreshes
it on a timer, and each success schedules the next refresh. A failed refresh
does not. Nothing on the page breaks at the moment that JWT expires. The break
shows up on the next call that needs it, and only if refresh fails too.

The dashboard keeps running on the navigation and API tokens it already holds.
The next time Looker asks for new ones, generate fails: the Embed SDK surfaces
Looker's interrupted state, and the raw postMessage tab tells the iframe the
session TTL is 0. The swimlane, cards, and event log stay on the last snapshot.
Freeze, User-Agent mismatch, Drop session reference, and End Looker show an
error banner. The page does not send you back to login.

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
