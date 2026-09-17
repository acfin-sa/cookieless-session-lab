from __future__ import annotations

from typing import Any

from services.session_store import HostSession, LabEvent


def log_event(
    session: HostSession | None,
    *,
    method: str,
    actor: str,
    summary: str,
    tokens_in: list[str] | None = None,
    tokens_out: list[str] | None = None,
    ok: bool = True,
    status_code: int | None = None,
    error: str | None = None,
) -> LabEvent:
    event = LabEvent(
        method=method,
        actor=actor,
        summary=_safe_summary(summary),
        tokens_in=tokens_in or [],
        tokens_out=tokens_out or [],
        ok=ok,
        status_code=status_code,
        error=_safe_summary(error) if error else None,
    )
    if session is not None:
        session.append_event(event)
    return event


def _safe_summary(text: str | None) -> str:
    if not text:
        return ""
    # Lab logs must never echo full secrets even when Looker/Auth0 error bodies
    # accidentally contain tokens.
    trimmed = " ".join(str(text).split())
    return trimmed[:500]

