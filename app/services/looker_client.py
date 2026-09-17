from __future__ import annotations

import os
from datetime import timedelta
from typing import Any

from looker_sdk import error as looker_error
from looker_sdk import init40
from looker_sdk import models40 as models

from config import (
    APP_BASE_URL,
    LOOKER_BASE_URL,
    LOOKER_CLIENT_ID,
    LOOKER_CLIENT_SECRET,
    LOOKER_EMBED_EXTERNAL_GROUP_ID,
    LOOKER_EMBED_FORCE_LOGOUT_LOGIN,
    LOOKER_EMBED_GROUP_IDS,
    LOOKER_EMBED_MODELS,
    LOOKER_EMBED_PERMISSIONS,
    LOOKER_EMBED_SESSION_LENGTH,
    LOOKER_VERIFY_SSL,
)
from services.events import log_event
from services.session_store import HostSession, utc_now

_looker_sdk_client = None


class LookerSessionDead(Exception):
    """Looker returned session_reference_token_ttl == 0 or there is no session_reference_token on the server.
    Raised in: app/routes/looker.py — generate_embed_tokens"""


class LookerNotConfigured(Exception):
    """ Raised in: get_looker_sdk() when LOOKER_BASE_URL, LOOKER_CLIENT_ID,
    or LOOKER_CLIENT_SECRET are missing.
    """
    pass


def looker_configured() -> bool:
    return bool(LOOKER_BASE_URL and LOOKER_CLIENT_ID and LOOKER_CLIENT_SECRET)


def get_looker_sdk():
    global _looker_sdk_client
    if not looker_configured():
        raise LookerNotConfigured(
            "LOOKER_BASE_URL / LOOKER_CLIENT_ID / LOOKER_CLIENT_SECRET are missing from .env"
        )
    if _looker_sdk_client is None:
        os.environ["LOOKERSDK_BASE_URL"] = LOOKER_BASE_URL
        os.environ["LOOKERSDK_CLIENT_ID"] = LOOKER_CLIENT_ID
        os.environ["LOOKERSDK_CLIENT_SECRET"] = LOOKER_CLIENT_SECRET
        os.environ["LOOKERSDK_VERIFY_SSL"] = "true" if LOOKER_VERIFY_SSL else "false"
        _looker_sdk_client = init40()
    return _looker_sdk_client


def embed_user_from_session(session: HostSession) -> dict[str, Any]:
    claims = session.auth0_claims or {}
    full_name = str(claims.get("name") or "").strip()
    parts = full_name.split(None, 1) if full_name else []
    first_name = parts[0] if parts else str(claims.get("nickname") or "Lab")
    last_name = parts[1] if len(parts) > 1 else "User"
    return {
        "external_user_id": session.external_user_id(),
        "first_name": first_name,
        "last_name": last_name,
        "permissions": list(LOOKER_EMBED_PERMISSIONS),
        "models": list(LOOKER_EMBED_MODELS),
        "group_ids": list(LOOKER_EMBED_GROUP_IDS),
        "external_group_id": LOOKER_EMBED_EXTERNAL_GROUP_ID,
        "user_attributes": {
            "email": session.email(),
        },
        "session_length": LOOKER_EMBED_SESSION_LENGTH,
        "force_logout_login": LOOKER_EMBED_FORCE_LOGOUT_LOGIN,
        "embed_domain": APP_BASE_URL,
    }


def expiration_from_ttl_seconds(ttl: int | None):
    if ttl is None:
        return None
    return utc_now() + timedelta(seconds=int(ttl))


def _looker_error_detail(exc: Exception) -> str:
    if isinstance(exc, looker_error.SDKError):
        message = getattr(exc, "message", None) or str(exc)
        return str(message)
    return str(exc)


def acquire_embed_session(session: HostSession, user_agent: str) -> dict[str, Any]:
    # TOKEN: session_reference_token, authentication_token, navigation_token, api_token
    # CREATED BY: Looker POST /embed/cookieless_session/acquire
    # CONSUMED BY: generate_tokens (reference + nav + api); iframe login URL (authentication_token once)
    # LIVES AT: session_reference_token → HostSession only. The other three → JSON to the browser.
    # TTL: reference = remaining Looker session; authentication ~30s single-use;
    #      navigation_token and api_token ~10 min each, independent exp (nav = in-iframe
    #      navigation; api = iframe Looker API calls). Minted together, not the same JWT.
    # WHY: acquire creates or reattaches identity. Passing the stored reference attaches a new
    #      iframe to the same session. Never return the reference.
    sdk = get_looker_sdk()
    embed_user = embed_user_from_session(session)
    existing_reference = session.looker_session_reference_token
    body = models.EmbedCookielessSessionAcquire(
        session_length=int(embed_user["session_length"]),
        force_logout_login=bool(embed_user["force_logout_login"]),
        external_user_id=str(embed_user["external_user_id"]),
        first_name=embed_user["first_name"],
        last_name=embed_user["last_name"],
        permissions=list(embed_user["permissions"]),
        models=list(embed_user["models"]),
        group_ids=list(embed_user["group_ids"]) or None,
        external_group_id=embed_user["external_group_id"],
        user_attributes=dict(embed_user["user_attributes"]),
        embed_domain=embed_user["embed_domain"],
        session_reference_token=existing_reference,
    )
    try:
        response = sdk.acquire_embed_cookieless_session(
            body=body,
            transport_options={"headers": {"User-Agent": user_agent}},
        )
    except Exception as exc:
        log_event(
            session,
            method="Looker POST /embed/cookieless_session/acquire",
            actor="Looker API",
            summary=f"acquire failed: {_looker_error_detail(exc)}",
            tokens_in=["session_reference_token"] if existing_reference else [],
            tokens_out=[],
            ok=False,
            status_code=getattr(exc, "status", None) or 400,
            error=_looker_error_detail(exc),
        )
        raise

    now = utc_now()
    session.looker_session_reference_token = response.session_reference_token
    session.looker_session_reference_issued_at = now
    session.looker_session_reference_expires_at = expiration_from_ttl_seconds(response.session_reference_token_ttl)
    session.looker_authentication_token = response.authentication_token
    session.looker_authentication_issued_at = now
    session.looker_authentication_expires_at = expiration_from_ttl_seconds(response.authentication_token_ttl)
    session.looker_authentication_consumed = False
    session.looker_authentication_consumed_at = None
    session.looker_navigation_token = response.navigation_token
    session.looker_navigation_issued_at = now
    session.looker_navigation_expires_at = expiration_from_ttl_seconds(response.navigation_token_ttl)
    session.looker_api_token = response.api_token
    session.looker_api_token_issued_at = now
    session.looker_api_token_expires_at = expiration_from_ttl_seconds(response.api_token_ttl)
    session.session_reference_dropped = False
    session.session_reference_dropped_at = None
    session.clear_looker_session_revoked()
    session.record_refresh_marker("Looker acquire")

    browser_payload = {
        "authentication_token": response.authentication_token,
        "authentication_token_ttl": response.authentication_token_ttl,
        "navigation_token": response.navigation_token,
        "navigation_token_ttl": response.navigation_token_ttl,
        "api_token": response.api_token,
        "api_token_ttl": response.api_token_ttl,
        "session_reference_token_ttl": response.session_reference_token_ttl,
    }
    log_event(
        session,
        method="Looker POST /embed/cookieless_session/acquire",
        actor="Looker API",
        summary="acquire returned browser-safe tokens; session_reference_token stored on server",
        tokens_in=["session_reference_token"] if existing_reference else [],
        tokens_out=[
            "session_reference_token",
            "authentication_token",
            "navigation_token",
            "api_token",
        ],
        ok=True,
        status_code=200,
    )
    return browser_payload


def generate_embed_tokens(session: HostSession, user_agent: str) -> dict[str, Any]:
    # TOKEN: navigation_token, api_token (rotate). session_reference_token (input, server-only)
    # CREATED BY: Looker PUT /embed/cookieless_session/generate_tokens
    # CONSUMED BY: postMessage session:tokens; next generate_tokens call
    # LIVES AT: nav/api → browser then iframe. session_reference_token never leaves the server.
    # TTL: ~10 minutes each, independent exp. navigation_token = in-iframe navigation;
    #      api_token = iframe Looker API calls (queries, data). Minted together, not aliases.
    # WHY: refresh is a different method from acquire. We rotate short-lived material
    #      without creating a new embed identity. iframe may ASK; it may not mint.
    if session.freeze_token_refresh:
        log_event(
            session,
            method="PUT /api/looker/generate-embed-tokens",
            actor="Host API",
            summary="freeze_token_refresh is on — refusing to rotate nav/api tokens",
            tokens_in=["host_access_token", "session_reference_token"],
            tokens_out=[],
            ok=True,
            status_code=200,
        )
        ttl_nav = None
        ttl_api = None
        if session.looker_navigation_expires_at:
            ttl_nav = max(0, int((session.looker_navigation_expires_at - utc_now()).total_seconds()))
        if session.looker_api_token_expires_at:
            ttl_api = max(0, int((session.looker_api_token_expires_at - utc_now()).total_seconds()))
        session_ttl = None
        if session.looker_session_reference_expires_at:
            session_ttl = max(
                0,
                int((session.looker_session_reference_expires_at - utc_now()).total_seconds()),
            )
        return {
            "navigation_token": session.looker_navigation_token,
            "navigation_token_ttl": ttl_nav,
            "api_token": session.looker_api_token,
            "api_token_ttl": ttl_api,
            "session_reference_token_ttl": session_ttl,
            "frozen": True,
        }

    if not session.looker_session_reference_token:
        raise LookerSessionDead(
            "No session_reference_token on the server. Acquire again, or you dropped it."
        )

    sdk = get_looker_sdk()
    body = models.EmbedCookielessSessionGenerateTokens(
        session_reference_token=session.looker_session_reference_token,
        navigation_token=session.looker_navigation_token,
        api_token=session.looker_api_token,
    )
    try:
        response = sdk.generate_tokens_for_cookieless_session(
            body=body,
            transport_options={"headers": {"User-Agent": user_agent}},
        )
    except Exception as exc:
        log_event(
            session,
            method="Looker PUT /embed/cookieless_session/generate_tokens",
            actor="Looker API",
            summary=f"generate_tokens failed: {_looker_error_detail(exc)}",
            tokens_in=["session_reference_token", "navigation_token", "api_token"],
            tokens_out=[],
            ok=False,
            status_code=getattr(exc, "status", None) or 400,
            error=_looker_error_detail(exc),
        )
        raise

    session_ttl = int(response.session_reference_token_ttl or 0)
    if session_ttl == 0:
        session.mark_looker_session_revoked()
        log_event(
            session,
            method="Looker PUT /embed/cookieless_session/generate_tokens",
            actor="Looker API",
            summary="session_reference_token_ttl == 0 — Looker session is dead; re-acquire required",
            tokens_in=["session_reference_token", "navigation_token", "api_token"],
            tokens_out=[],
            ok=False,
            status_code=200,
        )
        raise LookerSessionDead("Looker cookieless session expired (session_reference_token_ttl == 0)")

    now = utc_now()
    if response.session_reference_token:
        session.looker_session_reference_token = response.session_reference_token
    session.looker_session_reference_expires_at = expiration_from_ttl_seconds(session_ttl)
    session.looker_navigation_token = response.navigation_token
    session.looker_navigation_issued_at = now
    session.looker_navigation_expires_at = expiration_from_ttl_seconds(response.navigation_token_ttl)
    session.looker_api_token = response.api_token
    session.looker_api_token_issued_at = now
    session.looker_api_token_expires_at = expiration_from_ttl_seconds(response.api_token_ttl)
    session.record_refresh_marker("Looker generate_tokens")

    browser_payload = {
        "navigation_token": response.navigation_token,
        "navigation_token_ttl": response.navigation_token_ttl,
        "api_token": response.api_token,
        "api_token_ttl": response.api_token_ttl,
        "session_reference_token_ttl": session_ttl,
    }
    log_event(
        session,
        method="Looker PUT /embed/cookieless_session/generate_tokens",
        actor="Looker API",
        summary="rotated navigation_token and api_token; session_reference_token not returned to browser",
        tokens_in=["session_reference_token", "navigation_token", "api_token"],
        tokens_out=["navigation_token", "api_token", "session_reference_token"],
        ok=True,
        status_code=200,
    )
    return browser_payload


def end_embed_session(session: HostSession, user_agent: str) -> None:
    # TOKEN: session_reference_token
    # CREATED BY: acquire
    # CONSUMED BY: Looker DELETE /embed/cookieless_session/{session_reference_token}
    # LIVES AT: server only, then deleted
    # TTL: remaining session; delete is immediate
    # WHY: nested sessions — ending Layer B must not require ending Layer A, but
    #      losing the reference must kill the iframe identity.
    reference = session.looker_session_reference_token
    if not reference:
        session.mark_looker_session_revoked()
        return
    sdk = get_looker_sdk()
    try:
        sdk.delete_embed_cookieless_session(
            session_reference_token=reference,
            transport_options={"headers": {"User-Agent": user_agent}},
        )
        log_event(
            session,
            method="Looker DELETE /embed/cookieless_session/{session_reference_token}",
            actor="Looker API",
            summary="Looker cookieless session deleted",
            tokens_in=["session_reference_token"],
            tokens_out=[],
            ok=True,
            status_code=204,
        )
    except Exception as exc:
        detail = _looker_error_detail(exc)
        status = getattr(exc, "status", None) or 400
        if status not in {404, 400}:
            log_event(
                session,
                method="Looker DELETE /embed/cookieless_session/{session_reference_token}",
                actor="Looker API",
                summary=f"delete failed: {detail}",
                tokens_in=["session_reference_token"],
                tokens_out=[],
                ok=False,
                status_code=status,
                error=detail,
            )
            raise
        log_event(
            session,
            method="Looker DELETE /embed/cookieless_session/{session_reference_token}",
            actor="Looker API",
            summary=f"delete treated as already gone ({status}): {detail}",
            tokens_in=["session_reference_token"],
            tokens_out=[],
            ok=True,
            status_code=status,
        )
    session.mark_looker_session_revoked()
    session.reset_iframe_clients()
    clear_looker_tokens(session)


def clear_looker_tokens(session: HostSession) -> None:
    # Preserve looker_authentication_consumed so a consumed auth card stays consumed
    # after End Looker; nav/api show revoked via looker_session_revoked when cleared.
    session.looker_session_reference_token = None
    session.looker_session_reference_issued_at = None
    session.looker_session_reference_expires_at = None
    session.looker_authentication_token = None
    session.looker_authentication_issued_at = None
    session.looker_authentication_expires_at = None
    session.looker_navigation_token = None
    session.looker_navigation_issued_at = None
    session.looker_navigation_expires_at = None
    session.looker_api_token = None
    session.looker_api_token_issued_at = None
    session.looker_api_token_expires_at = None


def drop_session_reference(session: HostSession) -> None:
    # TOKEN: session_reference_token
    # CREATED BY: acquire
    # CONSUMED BY: this lab control (simulates lost server state)
    # LIVES AT: forgotten on purpose; Looker still has the real session until TTL
    # TTL: n/a after drop
    # WHY: if the host loses the high-privilege handle, generate_tokens cannot run.
    #      The iframe still looks fine until nav/api expire — then it cannot refresh.
    session.mark_session_reference_dropped()
    log_event(
        session,
        method="Drop session_reference on server",
        actor="Host API",
        summary="host forgot session_reference_token. Looker session still exists until TTL, but this BFF cannot refresh it.",
        tokens_in=["session_reference_token"],
        tokens_out=[],
        ok=True,
        status_code=200,
    )
