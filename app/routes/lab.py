from __future__ import annotations

from fastapi import APIRouter, Request
from services.deps import require_bearer_session
from services.events import log_event
from services.looker_client import drop_session_reference
from services.observatory import build_snapshot

lab_router = APIRouter(prefix="/api/lab", tags=["lab"])


@lab_router.get("/snapshot")
async def snapshot(request: Request):
    session = require_bearer_session(request)
    return build_snapshot(session)


@lab_router.post("/events")
async def client_event(request: Request):
    session = require_bearer_session(request)
    body = await request.json()
    method = str(body.get("method") or "client-event")
    actor = str(body.get("actor") or "Browser")
    summary = str(body.get("summary") or "")
    tokens_in = list(body.get("tokens_in") or [])
    tokens_out = list(body.get("tokens_out") or [])
    ok = bool(body.get("ok", True))
    expired = bool(body.get("expired", False))
    embed_client = str(body.get("embed_client") or "")
    if method == "iframe navigation to embed login URL":
        session.looker_authentication_consumed = True
        session.mark_iframe_started(embed_client)
    if method in {"session:status", "session:expired"} and (not ok or expired):
        # Session-level “I can’t keep working.” Not “nav died” or “api died.”
        # Do not smash each JWT’s exp — cards follow their own clocks.
        # Ignore expiry for an iframe that was never summoned (raw postMessage
        # stays unborn until that tab is opened).
        session.mark_iframe_expired(embed_client)
    elif method == "session:status" and ok and not expired:
        session.mark_iframe_alive(embed_client)
    event = log_event(
        session,
        method=method,
        actor=actor,
        summary=summary,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        ok=ok,
        status_code=int(body.get("status_code") or 200),
        error=body.get("error"),
    )
    return event.to_public_dict()


@lab_router.post("/controls")
async def controls(request: Request):
    session = require_bearer_session(request)
    body = await request.json()
    if "freeze_token_refresh" in body:
        session.freeze_token_refresh = bool(body["freeze_token_refresh"])
        log_event(
            session,
            method="Freeze token refresh",
            actor="Browser",
            summary=f"freeze_token_refresh={session.freeze_token_refresh}",
            tokens_in=["navigation_token", "api_token"],
            tokens_out=[],
            ok=True,
        )
    if "force_user_agent_mismatch" in body:
        session.force_user_agent_mismatch = bool(body["force_user_agent_mismatch"])
        log_event(
            session,
            method="Force User-Agent mismatch",
            actor="Browser",
            summary=f"force_user_agent_mismatch={session.force_user_agent_mismatch}",
            tokens_in=["session_reference_token"],
            tokens_out=[],
            ok=True,
        )
    return {
        "freeze_token_refresh": session.freeze_token_refresh,
        "force_user_agent_mismatch": session.force_user_agent_mismatch,
        "session_reference_dropped": session.session_reference_dropped,
    }


@lab_router.post("/drop-session-reference")
async def drop_reference(request: Request):
    session = require_bearer_session(request)
    drop_session_reference(session)
    return {"ok": True, "session_reference_dropped": True}
