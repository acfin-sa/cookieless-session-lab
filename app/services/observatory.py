from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from config import TOKEN_METHOD_MAP_PATH
from services.host_session_auth import HOST_SESSION_COOKIE_MAX_AGE
from services.session_store import HostSession, utc_isoformat, utc_now

EXPIRING_WINDOW_SECONDS = 60

TOKEN_VALUE_FROM_SESSION = {
    "auth0_refresh": lambda session: session.auth0_refresh_token,
    "auth0_access": lambda session: session.auth0_access_token,
    "host_session_reference": lambda session: session.host_session_reference,
    "host_access_token": lambda session: session.host_access_token,
    "session_reference_token": lambda session: session.looker_session_reference_token,
    "authentication_token": lambda session: session.looker_authentication_token,
    "navigation_token": lambda session: session.looker_navigation_token,
    "api_token": lambda session: session.looker_api_token,
}


def load_method_map() -> dict[str, Any]:
    return json.loads(TOKEN_METHOD_MAP_PATH.read_text(encoding="utf-8"))


def _methods_for_token(
    method_map: dict[str, Any], token_id: str
) -> tuple[list[str], list[str], list[str]]:
    created_by: list[str] = []
    renewed_by: list[str] = []
    consumed_by: list[str] = []
    for method in method_map.get("methods", []):
        kind = method.get("kind")
        if token_id in method.get("tokens_out", []):
            if kind == "create":
                created_by.append(method["method"])
            elif kind == "renew":
                renewed_by.append(method["method"])
        if token_id in method.get("tokens_in", []):
            consumed_by.append(method["method"])
    return created_by, renewed_by, consumed_by


def _token_times(session: HostSession, token_id: str) -> tuple[datetime | None, datetime | None]:
    issued = {
        "auth0_refresh": session.auth0_refresh_issued_at or session.created_at,
        "auth0_access": session.auth0_access_issued_at,
        "host_session_reference": session.created_at,
        "host_access_token": session.host_access_token_issued_at,
        "session_reference_token": session.looker_session_reference_issued_at,
        "authentication_token": session.looker_authentication_issued_at,
        "navigation_token": session.looker_navigation_issued_at,
        "api_token": session.looker_api_token_issued_at,
    }[token_id]
    expires = {
        "auth0_refresh": None,
        "auth0_access": session.auth0_access_expires_at,
        "host_session_reference": None,
        "host_access_token": session.host_access_token_expires_at,
        "session_reference_token": session.looker_session_reference_expires_at,
        "authentication_token": session.looker_authentication_expires_at,
        "navigation_token": session.looker_navigation_expires_at,
        "api_token": session.looker_api_token_expires_at,
    }[token_id]
    return issued, expires


def compute_token_lifecycle_state(
    *,
    present: bool,
    consumed: bool,
    revoked: bool,
    expires_at: datetime | None,
    now: datetime,
    revoked_when_absent: bool = False,
) -> str:
    """Per-token state. One Layer B flag must not paint every card.

    ``revoked`` = true session teardown (End Looker, ttl==0, logout, drop).
    ``expired`` = this JWT's own clock elapsed.
    iframe ``session:expired`` is not a per-token flag — see ``iframe_client_snapshot``.
    """
    if consumed:
        return "consumed"
    if revoked and (present or revoked_when_absent):
        return "revoked"
    if not present and not revoked:
        return "unborn"
    if expires_at is not None:
        remaining = (expires_at - now).total_seconds()
        if remaining <= 0:
            return "expired"
        if remaining < EXPIRING_WINDOW_SECONDS:
            return "expiring"
        return "alive"
    if revoked:
        return "revoked"
    return "alive"


def _layer_b_token_flags(session: HostSession, token_id: str) -> tuple[bool, bool, bool]:
    """Return (consumed, revoked, revoked_when_absent).

    session_reference dies on ttl==0, End Looker, or drop — not on session:expired.
    nav/api follow their own JWT exp; revoked only on full Layer B teardown.
    authentication_token stays consumed after /login/embed.
    """
    if token_id == "authentication_token":
        consumed = session.looker_authentication_consumed
        revoked = session.looker_session_revoked and not consumed
        return consumed, revoked, True
    if token_id == "session_reference_token":
        revoked = session.looker_session_revoked or session.session_reference_dropped
        return False, revoked, True
    if token_id in {"navigation_token", "api_token"}:
        return False, session.looker_session_revoked, True
    return False, False, False


def _host_session_envelope_end(session: HostSession) -> datetime:
    return session.created_at + timedelta(seconds=HOST_SESSION_COOKIE_MAX_AGE)


def _iframe_planned_expires_at(session: HostSession) -> datetime | None:
    """Alive iframe bar end: a planned clock, never snapshot `now`.

    generate_tokens is what keeps the iframe working past the current nav/api
    JWTs. Freeze skips Looker rotate; User-Agent mismatch makes the next
    generate fail. Either way the usable envelope is the current nav/api exp.
    Otherwise the ceiling is Layer B identity (session_reference_token TTL).
    """
    refresh_blocked = session.freeze_token_refresh or session.force_user_agent_mismatch
    if refresh_blocked:
        jwt_ends = [
            moment
            for moment in (
                session.looker_navigation_expires_at,
                session.looker_api_token_expires_at,
            )
            if moment is not None
        ]
        if jwt_ends:
            return min(jwt_ends)
    return session.looker_session_reference_expires_at


IFRAME_CLIENT_SPECS = (
    {
        "id": "iframe_session_sdk",
        "name": "Embed SDK iframe",
        "started_attr": "looker_sdk_iframe_started",
        "started_at_attr": "looker_sdk_iframe_started_at",
        "expired_attr": "looker_sdk_iframe_expired",
        "expired_at_attr": "looker_sdk_iframe_expired_at",
        "unborn_reason": "unborn — Embed SDK iframe has not connected yet",
        "purpose": "Session-level signal for the Embed SDK dashboard iframe.",
    },
    {
        "id": "iframe_session_postmessage",
        "name": "Raw postMessage iframe",
        "started_attr": "looker_postmessage_iframe_started",
        "started_at_attr": "looker_postmessage_iframe_started_at",
        "expired_attr": "looker_postmessage_iframe_expired",
        "expired_at_attr": "looker_postmessage_iframe_expired_at",
        "unborn_reason": "unborn — Raw postMessage tab has not been opened",
        "purpose": "Session-level signal for the raw postMessage dashboard iframe. Stays unborn until that tab is opened.",
    },
)


def iframe_client_snapshot(session: HostSession, _now: datetime, spec: dict[str, str]) -> dict[str, Any]:
    """Per-iframe Layer B row for the 'I can't keep working' signal.

    This is not navigation_token and not api_token. Those cards keep their own exp.
    An iframe that was never summoned stays unborn even if another iframe expired.
    """
    started = bool(getattr(session, spec["started_attr"]))
    expired = bool(getattr(session, spec["expired_attr"]))
    started_at = getattr(session, spec["started_at_attr"])
    expired_at = getattr(session, spec["expired_at_attr"])
    planned_expires_at = None
    if not started:
        state = "unborn"
        expires_at = None
        issued_at = None
        reason = spec["unborn_reason"]
    elif expired:
        state = "expired"
        issued_at = started_at
        expires_at = expired_at
        reason = (
            "iframe session expired — embed cannot keep working "
            "(session:expired / expired session:status)."
        )
    elif session.looker_session_revoked:
        state = "revoked"
        issued_at = started_at
        expires_at = session.looker_session_revoked_at
        reason = "Layer B identity ended (ttl==0 or End Looker)."
    else:
        state = "alive"
        issued_at = started_at
        expires_at = None
        planned_expires_at = _iframe_planned_expires_at(session)
        if session.freeze_token_refresh or session.force_user_agent_mismatch:
            reason = (
                "iframe has not reported session:expired. "
                "generate_tokens cannot rotate. "
                "This row ends when the current JWTs expire."
            )
        else:
            reason = (
                "iframe has not reported session:expired. "
                "envelope (session_reference_token TTL)"
            )
    return {
        "id": spec["id"],
        "name": spec["name"],
        "layer": "B",
        "storage": "iframe event (session:expired)",
        "state": state,
        "state_reason": reason,
        "present": state != "unborn",
        "issued_at": utc_isoformat(issued_at),
        "expires_at": utc_isoformat(expires_at),
        "planned_expires_at": utc_isoformat(planned_expires_at),
        "purpose": spec["purpose"],
    }


def _state_reason(
    token_id: str,
    state: str,
    session: HostSession,
) -> str:
    if state == "consumed":
        if token_id == "authentication_token":
            window = _looker_span_window_seconds(session, token_id)
            if window is not None:
                return f"used once on /login/embed. Single-use window {window}s."
        return "used once on /login/embed — not revoked"
    if token_id in {"navigation_token", "api_token"} and state == "expiring":
        return (
            f"Looker asks for a new token in this last {EXPIRING_WINDOW_SECONDS}s "
            "(session:tokens:request). Each JWT keeps its own exp."
        )
    if token_id == "session_reference_token" and state == "expiring":
        return (
            f"under {EXPIRING_WINDOW_SECONDS}s left on the session. "
            "generate_tokens leaves this expiry on its original countdown."
        )
    if token_id == "session_reference_token" and state == "alive":
        if session.any_iframe_session_expired() and session.looker_session_reference_token:
            return "iframe session expired does not revoke this reference — generate_tokens or re-acquire"
    if token_id == "session_reference_token" and state == "revoked":
        if session.session_reference_dropped:
            return "dropped on the host — Looker session may still exist until TTL"
        return "Looker session identity ended (ttl==0 or End Looker)"
    if token_id == "navigation_token" and state == "expired":
        return "this navigation_token JWT's exp elapsed — independent of api_token and of iframe session:expired"
    if token_id == "api_token" and state == "expired":
        return "this api_token JWT's exp elapsed — independent of navigation_token and of iframe session:expired"
    if token_id in {"navigation_token", "api_token"} and state == "revoked":
        return "Layer B torn down (End Looker, ttl==0, or logout)"
    if token_id == "authentication_token" and state == "revoked":
        return "Layer B torn down before authentication_token was consumed"
    if state == "expiring":
        return f"inside the last {EXPIRING_WINDOW_SECONDS}s"
    if state == "revoked" and token_id in {
        "auth0_refresh",
        "auth0_access",
        "host_session_reference",
        "host_access_token",
    }:
        return "host session revoked (logout)"
    return ""


def _looker_span_window_seconds(session: HostSession, token_id: str) -> int | None:
    for span in reversed(session.looker_token_spans):
        if span.get("token_id") != token_id:
            continue
        issued_at = span.get("issued_at")
        expires_at = span.get("expires_at")
        if issued_at is None or expires_at is None:
            return None
        return max(0, int((expires_at - issued_at).total_seconds()))
    return None


def _public_looker_spans(session: HostSession, token_id: str) -> list[dict[str, Any]]:
    public: list[dict[str, Any]] = []
    for span in session.looker_token_spans:
        if span.get("token_id") != token_id:
            continue
        public.append(
            {
                "issued_at": utc_isoformat(span.get("issued_at")),
                "expires_at": utc_isoformat(span.get("expires_at")),
                "closed_at": utc_isoformat(span.get("closed_at")),
                "close_reason": span.get("close_reason"),
            }
        )
    return public


def build_observatory_snapshot(session: HostSession) -> dict[str, Any]:
    method_map = load_method_map()
    now = utc_now()
    tokens = []
    for spec in method_map.get("tokens", []):
        token_id = spec["id"]
        value = TOKEN_VALUE_FROM_SESSION[token_id](session)
        issued_at, expires_at = _token_times(session, token_id)
        consumed = False
        revoked = False
        revoked_when_absent = False
        if token_id in {"auth0_refresh", "auth0_access", "host_session_reference", "host_access_token"}:
            revoked = session.host_session_revoked
            revoked_when_absent = True
        else:
            consumed, revoked, revoked_when_absent = _layer_b_token_flags(session, token_id)
        if token_id == "session_reference_token" and session.session_reference_dropped:
            value = None
        created_by, renewed_by, consumed_by = _methods_for_token(method_map, token_id)
        state = compute_token_lifecycle_state(
            present=bool(value),
            consumed=consumed,
            revoked=revoked,
            expires_at=expires_at,
            now=now,
            revoked_when_absent=revoked_when_absent,
        )
        # authentication_token's whole life is ~30s, inside the 60s nav/api ask
        # window. That window is not an authentication refresh.
        if token_id == "authentication_token" and state == "expiring":
            state = "alive"
        display_expires_at = expires_at
        planned_expires_at = None
        if (
            token_id == "authentication_token"
            and consumed
            and session.looker_authentication_consumed_at is not None
        ):
            display_expires_at = session.looker_authentication_consumed_at
        if (
            token_id == "session_reference_token"
            and session.session_reference_dropped
            and session.session_reference_dropped_at is not None
        ):
            display_expires_at = session.session_reference_dropped_at
        if (
            display_expires_at is None
            and token_id in {"auth0_refresh", "host_session_reference"}
            and value
        ):
            planned_expires_at = _host_session_envelope_end(session)
        lifetime_end = display_expires_at or planned_expires_at
        ttl_seconds = None
        if issued_at is not None and lifetime_end is not None:
            ttl_seconds = max(0, int((lifetime_end - issued_at).total_seconds()))
        card = {
            "id": token_id,
            "name": spec["name"],
            "layer": spec["layer"],
            "badge": spec.get("badge") or ("Looker" if spec.get("layer") == "B" else "Host"),
            "storage": spec["storage"],
            "purpose": spec.get("purpose") or "",
            "state": state,
            "state_reason": _state_reason(token_id, state, session),
            "present": bool(value),
            "issued_at": utc_isoformat(issued_at),
            "expires_at": utc_isoformat(display_expires_at),
            "planned_expires_at": utc_isoformat(planned_expires_at),
            "ttl_seconds": ttl_seconds,
            "created_by": created_by,
            "renewed_by": renewed_by,
            "consumed_by": consumed_by,
            "spans": _public_looker_spans(session, token_id),
        }
        tokens.append(card)
    return {
        "login_started_at": utc_isoformat(session.created_at),
        "now": utc_isoformat(now),
        "user": {
            "name": session.display_name(),
            "email": session.email(),
            "sub": session.external_user_id(),
        },
        "flags": {
            "freeze_token_refresh": session.freeze_token_refresh,
            "force_user_agent_mismatch": session.force_user_agent_mismatch,
            "session_reference_dropped": session.session_reference_dropped,
            "looker_session_revoked": session.looker_session_revoked,
            "any_iframe_session_expired": session.any_iframe_session_expired(),
        },
        "iframe_sessions": [iframe_client_snapshot(session, now, spec) for spec in IFRAME_CLIENT_SPECS],
        "tokens": tokens,
        "events": [event.to_public_dict() for event in session.events[-120:]],
        "looker_refresh_window_seconds": EXPIRING_WINDOW_SECONDS,
        "refresh_markers": [
            {
                "at": utc_isoformat(marker["at"] if isinstance(marker, dict) else marker),
                "process": marker["process"] if isinstance(marker, dict) else "token renew",
            }
            for marker in session.refresh_markers
        ],
        "looker_bound_user_agent": session.user_agent,
    }
