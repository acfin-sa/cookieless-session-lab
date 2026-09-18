"""
Auth0 OAuth routes — Layer A happy path:

  1. Browser GET /login
  2. Host redirects to Auth0 /authorize (PKCE S256 + offline_access)
  3. Auth0 Universal Login
  4. Auth0 redirects to http://localhost:3000/callback?code=
  5. Host exchanges the code. Auth0 refresh/access/id stay on HostSession.
  6. Browser only gets host_session_id (HttpOnly cookie) then host_access_token (JSON/memory).
"""
from __future__ import annotations

import asyncio
from urllib.parse import urlencode
from uuid import uuid4

from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import RedirectResponse

from config import (
    APP_BASE_URL,
    AUTH0_AUDIENCE,
    AUTH0_CLIENT_ID,
    AUTH0_CLIENT_SECRET,
    AUTH0_DOMAIN,
    public_url,
)
from services.auth0_client import revoke_auth0_refresh
from services.csrf import validate_csrf_token
from services.host_session_auth import (
    clear_host_session_cookie,
    request_user_agent,
    session_from_cookie,
    set_host_session_cookie,
)
from services.events import log_event
from services.host_tokens import apply_auth0_token_set, mint_host_access_token
from services.looker_client import LookerNotConfigured, end_embed_session
from services.session_store import HostSession, session_store, utc_now

oauth = OAuth()
oauth.register(
    name="auth0",
    client_id=AUTH0_CLIENT_ID,
    client_secret=AUTH0_CLIENT_SECRET,
    server_metadata_url=f"https://{AUTH0_DOMAIN}/.well-known/openid-configuration",
    client_kwargs={
        "scope": "openid profile email offline_access",
        "code_challenge_method": "S256",
        "token_endpoint_auth_method": "client_secret_post",
    },
)

auth0_router = APIRouter()


@auth0_router.get("/login")
async def login(request: Request):
    # TOKEN: authorization_code (ephemeral)
    # CREATED BY: Auth0 /authorize after the human signs in
    # CONSUMED BY: Auth0 /oauth/token (code exchange) on GET /callback
    # LIVES AT: query string on /callback for seconds
    # TTL: one-time, short
    # WHY: PKCE means the browser never holds a client secret. The code is useless
    #      without the verifier stored in the oauth_pkce_state cookie (Secure only on HTTPS).
    redirect_uri = public_url("/callback")
    authorize_kwargs = {"redirect_uri": redirect_uri}
    if AUTH0_AUDIENCE:
        authorize_kwargs["audience"] = AUTH0_AUDIENCE
    return await oauth.auth0.authorize_redirect(request, **authorize_kwargs)


@auth0_router.get("/callback")
async def callback(request: Request):
    oauth_error = request.query_params.get("error")
    if oauth_error:
        return await perform_logout(request)
    try:
        token_set = await oauth.auth0.authorize_access_token(request)
    except OAuthError:
        return await perform_logout(request)

    # TOKEN: auth0_refresh, auth0_access, host_session_reference
    # CREATED BY: Auth0 /oauth/token (code exchange)
    # CONSUMED BY: refresh/revoke (Auth0 tokens); host_session_reference stays server-only
    # LIVES AT: HostSession in process memory. Never in the browser, never in the cookie value.
    # TTL: access from JWT exp; refresh until revoke; host_session_reference until logout
    # WHY: long-lived high-privilege handles belong on the server. The cookie is only an opaque index.
    session = HostSession(
        host_session_id=uuid4().hex,
        host_session_reference=uuid4().hex,
        created_at=utc_now(),
        user_agent=request_user_agent(request),
        auth0_claims={},
    )
    apply_auth0_token_set(session, token_set)
    mint_host_access_token(session, process="Auth0 login — mint host_access_token")
    session_store.save(session)
    request.session.clear()
    log_event(
        session,
        method="Auth0 /oauth/token (code exchange)",
        actor="Auth0",
        summary="code exchanged; Auth0 tokens stored on HostSession; host_session_id cookie will be set",
        tokens_in=["authorization_code"],
        tokens_out=["auth0_refresh", "auth0_access", "host_session_reference"],
        ok=True,
        status_code=200,
    )
    response = RedirectResponse(url=public_url("/lab"), status_code=302)
    set_host_session_cookie(response, session.host_session_id)
    return response


async def perform_logout(request: Request) -> RedirectResponse:
    # TOKEN: host_session_id, auth0_refresh, session_reference_token
    # CREATED BY: login / acquire
    # CONSUMED BY: logout — revoke Auth0 refresh, delete Looker session, drop HostSession, clear cookie
    # LIVES AT: nowhere after this handler
    # TTL: immediate
    # WHY: nested sessions. Losing Layer A must refuse Layer B. We delete Looker first, then Auth0, then the cookie.
    session = session_from_cookie(request)
    if session is not None:
        try:
            await asyncio.to_thread(
                end_embed_session, session, request_user_agent(request)
            )
        except LookerNotConfigured:
            pass
        except Exception as error:
            log_event(
                session,
                method="logout",
                actor="Host API",
                summary=f"Looker end during logout failed: {error}",
                tokens_in=["session_reference_token"],
                tokens_out=[],
                ok=False,
                error=str(error),
            )
        await revoke_auth0_refresh(session)
        session.host_session_revoked = True
        log_event(
            session,
            method="logout",
            actor="Host API",
            summary="HostSession deleted; cookie will be cleared; Auth0 /v2/logout next",
            tokens_in=["host_session_id cookie", "auth0_refresh", "session_reference_token"],
            tokens_out=[],
            ok=True,
            status_code=302,
        )
        session_store.delete(session.host_session_id)

    request.session.clear()
    query = urlencode(
        {
            "client_id": AUTH0_CLIENT_ID,
            "returnTo": APP_BASE_URL,
        }
    )
    response = RedirectResponse(
        url=f"https://{AUTH0_DOMAIN}/v2/logout?{query}",
        status_code=302,
    )
    clear_host_session_cookie(response)
    return response


@auth0_router.post("/logout")
async def logout(request: Request, csrf_token: str = Form(...)):
    if not validate_csrf_token(request, csrf_token):
        raise HTTPException(status_code=403, detail="Invalid CSRF token")
    return await perform_logout(request)
