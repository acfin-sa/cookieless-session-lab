from __future__ import annotations

from typing import Any

import httpx

from config import AUTH0_AUDIENCE, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_DOMAIN
from services.events import log_event
from services.host_tokens import apply_auth0_token_set
from services.session_store import HostSession


class Auth0RefreshError(Exception):
    pass


async def refresh_auth0_tokens(session: HostSession) -> dict[str, Any]:
    # TOKEN: auth0_refresh → new auth0_access (+ rotating auth0_refresh)
    # CREATED BY: Auth0 POST /oauth/token grant_type=refresh_token
    # CONSUMED BY: stored on HostSession; never returned to the browser
    # LIVES AT: server only
    # TTL: access from exp; refresh until Auth0 revokes
    # WHY: Layer A refresh is a separate method from login. The browser only gets a new host_access_token.
    if not session.auth0_refresh_token:
        raise Auth0RefreshError("No Auth0 refresh token on the HostSession. Enable offline_access.")
    payload = {
        "grant_type": "refresh_token",
        "client_id": AUTH0_CLIENT_ID,
        "client_secret": AUTH0_CLIENT_SECRET,
        "refresh_token": session.auth0_refresh_token,
    }
    if AUTH0_AUDIENCE:
        payload["audience"] = AUTH0_AUDIENCE
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(
            f"https://{AUTH0_DOMAIN}/oauth/token",
            data=payload,
        )
    if response.status_code >= 400:
        log_event(
            session,
            method="Auth0 /oauth/token (refresh)",
            actor="Auth0",
            summary=f"refresh failed HTTP {response.status_code}",
            tokens_in=["auth0_refresh"],
            tokens_out=[],
            ok=False,
            status_code=response.status_code,
            error=response.text[:300],
        )
        raise Auth0RefreshError(f"Auth0 refresh failed ({response.status_code})")
    token_set = response.json()
    apply_auth0_token_set(session, token_set)
    log_event(
        session,
        method="Auth0 /oauth/token (refresh)",
        actor="Auth0",
        summary="Auth0 rotated access token; refresh stays on the server",
        tokens_in=["auth0_refresh"],
        tokens_out=["auth0_refresh", "auth0_access"],
        ok=True,
        status_code=200,
    )
    return token_set


async def revoke_auth0_refresh(session: HostSession) -> None:
    # TOKEN: auth0_refresh
    # CREATED BY: code exchange
    # CONSUMED BY: Auth0 POST /oauth/revoke on logout
    # LIVES AT: server, then discarded
    # TTL: until revoke
    # WHY: losing the outer IdP layer must kill the ability to mint new host_access_tokens.
    if not session.auth0_refresh_token:
        return
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(
            f"https://{AUTH0_DOMAIN}/oauth/revoke",
            data={
                "client_id": AUTH0_CLIENT_ID,
                "client_secret": AUTH0_CLIENT_SECRET,
                "token": session.auth0_refresh_token,
            },
        )
    log_event(
        session,
        method="Auth0 /oauth/revoke",
        actor="Auth0",
        summary="refresh token revoke attempted",
        tokens_in=["auth0_refresh"],
        tokens_out=[],
        ok=response.status_code < 400,
        status_code=response.status_code,
        error=None if response.status_code < 400 else response.text[:300],
    )
