from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from looker_sdk.error import SDKError

from config import LOOKER_MISMATCH_USER_AGENT
from services.host_session_auth import require_bearer_session, request_user_agent
from services.events import log_event
from services import looker_client
from services.looker_client import LookerNotConfigured, LookerSessionDead, looker_configured

looker_router = APIRouter(prefix="/api/looker", tags=["looker"])


def browser_safe_looker_payload(payload: dict) -> dict:
    """Last-line strip: session_reference_token must never leave the host JSON."""
    return {key: value for key, value in payload.items() if key != "session_reference_token"}


def log_generate_http_result(session, payload: dict) -> None:
    """Host-boundary generate log. Looker rotation is logged in looker_client.

    Frozen generate never calls Looker, so this is the only observatory row.
    It must not claim that nav/api tokens rotated.
    """
    if not payload.get("frozen"):
        return
    summary = (
        "freeze_token_refresh is on — returned existing nav/api tokens; Looker was not called"
    )
    if session.force_user_agent_mismatch:
        summary += " (User-Agent mismatch was not sent; freeze wins)"
    log_event(
        session,
        method="PUT /api/looker/generate-embed-tokens",
        actor="Host API",
        summary=summary,
        tokens_in=["host_access_token", "session_reference_token"],
        tokens_out=[],
        ok=True,
        status_code=200,
    )


def log_unexpected_looker_failure(session, method: str, error: Exception) -> JSONResponse:
    detail = str(error)
    log_event(
        session,
        method=method,
        actor="Host API",
        summary=detail,
        tokens_in=["host_access_token"],
        tokens_out=[],
        ok=False,
        status_code=502,
        error=detail,
    )
    return JSONResponse({"detail": detail}, status_code=502)


def is_looker_unreachable(error: Exception) -> bool:
    text = str(getattr(error, "message", None) or error)
    return any(
        token in text
        for token in ("ConnectTimeout", "Max retries exceeded", "Connection refused", "NewConnectionError")
    )


def looker_http_error_response(session, method: str, error: Exception) -> JSONResponse:
    if is_looker_unreachable(error):
        detail = str(getattr(error, "message", None) or error)
        log_event(
            session,
            method=method,
            actor="Looker API",
            summary=detail,
            tokens_in=["session_reference_token"],
            tokens_out=[],
            ok=False,
            status_code=502,
            error=detail,
        )
        return JSONResponse(
            {
                "detail": detail,
                "looker_status": 502,
                "teaching": "Could not reach the Looker API. For Looker Cloud, LOOKER_BASE_URL must be https://<instance>.cloud.looker.com (port 443), not :19999.",
            },
            status_code=502,
        )
    status = getattr(error, "status", None) or 400
    detail = str(getattr(error, "message", None) or error)
    log_event(
        session,
        method=method,
        actor="Looker API",
        summary=detail,
        tokens_in=["session_reference_token"],
        tokens_out=[],
        ok=False,
        status_code=int(status),
        error=detail,
    )
    return JSONResponse(
        {
            "detail": detail,
            "looker_status": status,
            "teaching": "Looker 400s are often User-Agent mismatch, dead tokens, or embed_domain.",
        },
        status_code=400 if int(status) == 400 else int(status) if int(status) < 500 else 502,
    )


@looker_router.post("/acquire-embed-session")
async def acquire_embed_session(request: Request):
    # TOKEN: authentication_token, navigation_token, api_token (to browser)
    #        session_reference_token (server only — stripped before this response)
    # CREATED BY: Looker POST /embed/cookieless_session/acquire
    # CONSUMED BY: iframe login URL (authentication_token once); generate_tokens; Embed SDK session:tokens
    # LIVES AT: JSON to browser memory except session_reference_token
    # TTL: auth ~30s; nav/api ~10 min; reference = remaining Looker session
    # WHY: Layer B is only reachable if Layer A bearer is valid. Optional stored
    #      session_reference_token reattaches a new iframe to the same identity.
    session = require_bearer_session(request)
    if not looker_configured():
        log_event(
            session,
            method="POST /api/looker/acquire-embed-session",
            actor="Host API",
            summary="Looker env vars missing",
            tokens_in=["host_access_token"],
            tokens_out=[],
            ok=False,
            status_code=503,
            error="Looker is not configured in .env",
        )
        return JSONResponse({"detail": "Looker is not configured in .env"}, status_code=503)
    user_agent = request_user_agent(request)
    try:
        payload = await asyncio.to_thread(looker_client.acquire_embed_session, session, user_agent)
    except LookerNotConfigured as error:
        return JSONResponse({"detail": str(error)}, status_code=503)
    except SDKError as error:
        return looker_http_error_response(session, "Looker POST /embed/cookieless_session/acquire", error)
    except Exception as error:
        if is_looker_unreachable(error):
            return looker_http_error_response(session, "Looker POST /embed/cookieless_session/acquire", error)
        return log_unexpected_looker_failure(
            session, "POST /api/looker/acquire-embed-session", error
        )
    return browser_safe_looker_payload(payload)


@looker_router.put("/generate-embed-tokens")
async def generate_embed_tokens(request: Request):
    # TOKEN: navigation_token, api_token
    # CREATED BY: Looker PUT /embed/cookieless_session/generate_tokens
    # CONSUMED BY: Embed SDK session:tokens
    # LIVES AT: JSON to browser, then iframe. session_reference_token is loaded from HostSession, not from the body.
    # TTL: ~10 minutes. Looker asks inside the last 60 seconds.
    # WHY: the iframe is an untrusted peer. It may ask for tokens; it may not mint them
    #      or tell us which session_reference to use. Body nav/api are ignored for identity.
    session = require_bearer_session(request)
    # Freeze wins: generate returns stored JWTs and never calls Looker, so a
    # mismatch UA must not be sent or logged as if it were about to fire.
    if session.freeze_token_refresh:
        user_agent = request_user_agent(request)
    elif session.force_user_agent_mismatch:
        user_agent = LOOKER_MISMATCH_USER_AGENT
        log_event(
            session,
            method="PUT /api/looker/generate-embed-tokens",
            actor="Host API",
            summary=f"Force User-Agent mismatch is on. Sending {LOOKER_MISMATCH_USER_AGENT!r} instead of the browser UA.",
            tokens_in=["host_access_token"],
            tokens_out=[],
            ok=True,
            status_code=200,
        )
    else:
        user_agent = request_user_agent(request)
    try:
        payload = await asyncio.to_thread(looker_client.generate_embed_tokens, session, user_agent)
    except LookerSessionDead as error:
        log_event(
            session,
            method="PUT /api/looker/generate-embed-tokens",
            actor="Host API",
            summary=str(error),
            tokens_in=["host_access_token", "session_reference_token"],
            tokens_out=[],
            ok=False,
            status_code=409,
            error=str(error),
        )
        return JSONResponse(
            {
                "detail": str(error),
                "code": "SESSION_DEAD",
                "session_reference_token_ttl": 0,
            },
            status_code=409,
        )
    except SDKError as error:
        return looker_http_error_response(
            session,
            "Looker PUT /embed/cookieless_session/generate_tokens",
            error,
        )
    except Exception as error:
        if is_looker_unreachable(error):
            return looker_http_error_response(
                session,
                "Looker PUT /embed/cookieless_session/generate_tokens",
                error,
            )
        return log_unexpected_looker_failure(
            session, "PUT /api/looker/generate-embed-tokens", error
        )
    payload = browser_safe_looker_payload(payload)
    log_generate_http_result(session, payload)
    return payload


@looker_router.post("/end-embed-session")
async def end_embed_session(request: Request):
    # TOKEN: session_reference_token
    # CREATED BY: acquire
    # CONSUMED BY: Looker DELETE then host copy cleared
    # LIVES AT: nowhere after success. Layer A remains.
    # TTL: immediate
    # WHY: you can kill Layer B without logging the human out of the host app.
    session = require_bearer_session(request)
    try:
        await asyncio.to_thread(looker_client.end_embed_session, session, request_user_agent(request))
    except LookerNotConfigured:
        pass
    except SDKError as error:
        return looker_http_error_response(
            session,
            "Looker DELETE /embed/cookieless_session/{session_reference_token}",
            error,
        )
    log_event(
        session,
        method="POST /api/looker/end-embed-session",
        actor="Host API",
        summary="Layer B cleared; Layer A still valid",
        tokens_in=["host_access_token", "session_reference_token"],
        tokens_out=[],
        ok=True,
        status_code=200,
    )
    return {"ok": True}
