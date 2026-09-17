from __future__ import annotations

from fastapi import HTTPException, Request
from fastapi.responses import Response
from jwt import InvalidTokenError

from config import HOST_SESSION_COOKIE, cookie_secure
from services.host_tokens import verify_host_access_token
from services.session_store import HostSession, session_store

HOST_SESSION_COOKIE_MAX_AGE = 12 * 60 * 60


def request_user_agent(request: Request) -> str:
    return request.headers.get("user-agent") or "unknown-user-agent"


def set_host_session_cookie(response: Response, host_session_id: str) -> None:
    # TOKEN: host_session_id (opaque cookie handle, not a constellation token)
    # CREATED BY: GET /callback after Auth0 code exchange
    # CONSUMED BY: POST /api/host/bootstrap, POST /api/host/refresh, GET /logout
    # LIVES AT: HttpOnly, SameSite=Lax cookie. Secure=True only when APP_BASE_URL is https.
    # TTL: 12 hours or until logout. It does not authorize Looker; it only finds HostSession.
    # WHY: first-party handle the browser can present. High-privilege material stays on the server.
    response.set_cookie(
        key=HOST_SESSION_COOKIE,
        value=host_session_id,
        httponly=True,
        secure=cookie_secure(),
        samesite="lax",
        path="/",
        max_age=HOST_SESSION_COOKIE_MAX_AGE,
    )


def clear_host_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=HOST_SESSION_COOKIE,
        path="/",
        httponly=True,
        secure=cookie_secure(),
        samesite="lax",
    )


def session_from_cookie(request: Request) -> HostSession | None:
    return session_store.get(request.cookies.get(HOST_SESSION_COOKIE))


def require_cookie_session(request: Request) -> HostSession:
    session = session_from_cookie(request)
    if session is None or session.host_session_revoked:
        raise HTTPException(status_code=401, detail="No host session. Log in again.")
    return session


def require_bearer_session(request: Request) -> HostSession:
    header = request.headers.get("authorization") or ""
    if not header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing host_access_token bearer")
    token = header.split(" ", 1)[1].strip()
    try:
        claims = verify_host_access_token(token)
    except InvalidTokenError as error:
        raise HTTPException(status_code=401, detail=f"Invalid host_access_token: {error}") from error
    if claims.get("typ") != "host_access":
        raise HTTPException(status_code=401, detail="Wrong token type")
    session = session_store.get(str(claims.get("hsid") or ""))
    if session is None or session.host_session_revoked:
        raise HTTPException(status_code=401, detail="Host session is gone. Log in again.")
    if session.host_access_token_jti != claims.get("jti"):
        raise HTTPException(
            status_code=401,
            detail="host_access_token jti is stale (it was rotated). Call POST /api/host/refresh.",
        )
    return session
