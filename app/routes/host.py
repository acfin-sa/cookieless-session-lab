from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from services.auth0_client import Auth0RefreshError, refresh_auth0_tokens
from services.deps import require_cookie_session
from services.events import log_event
from services.host_tokens import mint_host_access_token
from services.store import isoformat, utc_now

host_router = APIRouter(prefix="/api/host", tags=["host"])


def _token_payload(session) -> dict:
    return {
        "host_access_token": session.host_access_token,
        "expires_at": isoformat(session.host_access_token_expires_at),
        "user": {
            "name": session.display_name(),
            "email": session.email(),
            "sub": session.external_user_id(),
        },
    }


@host_router.post("/bootstrap")
async def bootstrap(request: Request):
    # TOKEN: host_access_token
    # CREATED BY: mint_host_access_token if the current one is missing or <30s from expiry
    # CONSUMED BY: browser memory; Authorization bearer on later /api calls
    # LIVES AT: JSON response → JavaScript memory. Not localStorage. Not the cookie.
    # TTL: HOST_ACCESS_TOKEN_TTL_SECONDS
    # WHY: page load recovers the short-lived handle from the server record identified
    #      by the opaque cookie. The cookie alone cannot call Looker.
    session = require_cookie_session(request)
    needs_mint = (
        not session.host_access_token
        or session.host_access_token_expires_at is None
        or session.host_access_token_expires_at <= utc_now() + timedelta(seconds=30)
    )
    if needs_mint:
        mint_host_access_token(session, process="POST /api/host/bootstrap — mint host_access_token")
        summary = "minted a new host_access_token"
    else:
        summary = "returned the still-valid host_access_token"
    log_event(
        session,
        method="POST /api/host/bootstrap",
        actor="Host API",
        summary=summary,
        tokens_in=["host_session_id cookie"],
        tokens_out=["host_access_token"],
        ok=True,
        status_code=200,
    )
    return _token_payload(session)


@host_router.post("/refresh")
async def refresh(request: Request):
    # TOKEN: host_access_token (out). auth0_refresh (in, server-only)
    # CREATED BY: Auth0 /oauth/token (refresh) then mint_host_access_token
    # CONSUMED BY: previous host_access_token jti is dead
    # LIVES AT: JSON → browser memory
    # TTL: HOST_ACCESS_TOKEN_TTL_SECONDS
    # WHY: same split as Looker generate_tokens — rotate short-lived material
    #      using a long-lived server handle. Cookie finds the record; refresh token mints.
    session = require_cookie_session(request)
    if session.auth0_refresh_token:
        try:
            await refresh_auth0_tokens(session)
        except Auth0RefreshError as error:
            log_event(
                session,
                method="POST /api/host/refresh",
                actor="Host API",
                summary=str(error),
                tokens_in=["host_session_id cookie", "auth0_refresh"],
                tokens_out=[],
                ok=False,
                status_code=401,
                error=str(error),
            )
            return JSONResponse({"detail": str(error)}, status_code=401)
    else:
        log_event(
            session,
            method="POST /api/host/refresh",
            actor="Host API",
            summary="no Auth0 refresh token (enable offline_access). Minting host_access_token from HostSession anyway.",
            tokens_in=["host_session_id cookie"],
            tokens_out=["host_access_token"],
            ok=True,
            status_code=200,
        )
    mint_host_access_token(session, process="POST /api/host/refresh — mint host_access_token")
    log_event(
        session,
        method="POST /api/host/refresh",
        actor="Host API",
        summary="new host_access_token; previous jti will 401",
        tokens_in=["host_session_id cookie", "auth0_refresh"],
        tokens_out=["host_access_token"],
        ok=True,
        status_code=200,
    )
    return _token_payload(session)
