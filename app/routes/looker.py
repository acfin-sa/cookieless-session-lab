from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from looker_sdk.error import SDKError

from config import LOOKER_MISMATCH_USER_AGENT
from services.deps import require_bearer_session, request_user_agent
from services.events import log_event
from services.looker_client import (
    LookerNotConfigured,
    LookerSessionDead,
    acquire_embed_session,
    end_embed_session,
    generate_embed_tokens,
    looker_configured,
)

looker_router = APIRouter(prefix="/api/looker", tags=["looker"])


def _looker_unreachable(error: Exception) -> bool:
    text = str(getattr(error, "message", None) or error)
    return any(
        token in text
        for token in ("ConnectTimeout", "Max retries exceeded", "Connection refused", "NewConnectionError")
    )


def _looker_http_error(session, method: str, error: Exception) -> JSONResponse:
    if _looker_unreachable(error):
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
async def acquire(request: Request):
    # TOKEN: authentication_token, navigation_token, api_token (to browser)
    #        session_reference_token (server only — stripped before this response)
    # CREATED BY: Looker POST /embed/cookieless_session/acquire
    # CONSUMED BY: iframe login URL (authentication_token once); generate_tokens; postMessage session:tokens
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
        payload = await asyncio.to_thread(acquire_embed_session, session, user_agent)
    except LookerNotConfigured as error:
        return JSONResponse({"detail": str(error)}, status_code=503)
    except SDKError as error:
        return _looker_http_error(session, "Looker POST /embed/cookieless_session/acquire", error)
    except Exception as error:
        if _looker_unreachable(error):
            return _looker_http_error(session, "Looker POST /embed/cookieless_session/acquire", error)
        return JSONResponse({"detail": str(error)}, status_code=502)
    if "session_reference_token" in payload:
        payload = {key: value for key, value in payload.items() if key != "session_reference_token"}
    return payload


@looker_router.put("/generate-embed-tokens")
async def generate(request: Request):
    # TOKEN: navigation_token, api_token
    # CREATED BY: Looker PUT /embed/cookieless_session/generate_tokens
    # CONSUMED BY: postMessage session:tokens
    # LIVES AT: JSON to browser, then iframe. session_reference_token is loaded from HostSession, not from the body.
    # TTL: ~10 minutes. Looker asks inside the last 60 seconds.
    # WHY: the iframe is an untrusted peer. It may ask for tokens; it may not mint them
    #      or tell us which session_reference to use. Body nav/api are ignored for identity.
    session = require_bearer_session(request)
    if session.force_user_agent_mismatch:
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
        payload = await asyncio.to_thread(generate_embed_tokens, session, user_agent)
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
        return _looker_http_error(
            session,
            "Looker PUT /embed/cookieless_session/generate_tokens",
            error,
        )
    except Exception as error:
        if _looker_unreachable(error):
            return _looker_http_error(
                session,
                "Looker PUT /embed/cookieless_session/generate_tokens",
                error,
            )
        return JSONResponse({"detail": str(error)}, status_code=502)
    if "session_reference_token" in payload:
        payload = {key: value for key, value in payload.items() if key != "session_reference_token"}
    log_event(
        session,
        method="PUT /api/looker/generate-embed-tokens",
        actor="Host API",
        summary="returned rotated nav/api tokens; session_reference_token omitted",
        tokens_in=["host_access_token"],
        tokens_out=["navigation_token", "api_token"],
        ok=True,
        status_code=200,
    )
    return payload


@looker_router.post("/end-embed-session")
async def end_session(request: Request):
    # TOKEN: session_reference_token
    # CREATED BY: acquire
    # CONSUMED BY: Looker DELETE then host copy cleared
    # LIVES AT: nowhere after success. Layer A remains.
    # TTL: immediate
    # WHY: you can kill Layer B without logging the human out of the host app.
    session = require_bearer_session(request)
    try:
        await asyncio.to_thread(end_embed_session, session, request_user_agent(request))
    except LookerNotConfigured:
        pass
    except SDKError as error:
        return _looker_http_error(
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
