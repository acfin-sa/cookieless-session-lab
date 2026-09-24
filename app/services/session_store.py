from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

HISTORY_LIMIT = 250


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat()


@dataclass
class LabEvent:
    method: str
    actor: str
    summary: str
    tokens_in: list[str] = field(default_factory=list)
    tokens_out: list[str] = field(default_factory=list)
    ok: bool = True
    status_code: int | None = None
    error: str | None = None
    id: str = field(default_factory=lambda: uuid4().hex[:10])
    timestamp: datetime = field(default_factory=utc_now)

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "timestamp": utc_isoformat(self.timestamp),
            "actor": self.actor,
            "method": self.method,
            "tokens_in": list(self.tokens_in),
            "tokens_out": list(self.tokens_out),
            "summary": self.summary,
            "ok": self.ok,
            "status_code": self.status_code,
            "error": self.error,
        }


@dataclass
class HostSession:
    """Server-side Layer A record. Analogous to Looker's embed session.

    The browser never stores this object. It only presents host_session_id
    (cookie) and host_access_token (memory JWT).
    """

    host_session_id: str
    created_at: datetime
    user_agent: str
    auth0_claims: dict[str, Any]

    auth0_refresh_token: str | None = None
    auth0_refresh_issued_at: datetime | None = None
    auth0_access_token: str | None = None
    auth0_access_issued_at: datetime | None = None
    auth0_access_expires_at: datetime | None = None

    host_access_token: str | None = None
    host_access_token_jti: str | None = None
    host_access_token_issued_at: datetime | None = None
    host_access_token_expires_at: datetime | None = None

    looker_session_reference_token: str | None = None
    looker_session_reference_issued_at: datetime | None = None
    looker_session_reference_expires_at: datetime | None = None
    looker_authentication_token: str | None = None
    looker_authentication_issued_at: datetime | None = None
    looker_authentication_expires_at: datetime | None = None
    looker_authentication_consumed: bool = False
    looker_authentication_consumed_at: datetime | None = None
    looker_navigation_token: str | None = None
    looker_navigation_issued_at: datetime | None = None
    looker_navigation_expires_at: datetime | None = None
    looker_api_token: str | None = None
    looker_api_token_issued_at: datetime | None = None
    looker_api_token_expires_at: datetime | None = None

    freeze_token_refresh: bool = False
    force_user_agent_mismatch: bool = False
    session_reference_dropped: bool = False
    session_reference_dropped_at: datetime | None = None
    looker_session_revoked: bool = False
    looker_session_revoked_at: datetime | None = None
    looker_sdk_iframe_started: bool = False
    looker_sdk_iframe_started_at: datetime | None = None
    looker_sdk_iframe_expired: bool = False
    looker_sdk_iframe_expired_at: datetime | None = None
    looker_postmessage_iframe_started: bool = False
    looker_postmessage_iframe_started_at: datetime | None = None
    looker_postmessage_iframe_expired: bool = False
    looker_postmessage_iframe_expired_at: datetime | None = None
    host_session_revoked: bool = False

    events: list[LabEvent] = field(default_factory=list)
    refresh_markers: list[dict[str, Any]] = field(default_factory=list)
    # Lifetime intervals for the four Looker embed tokens. No token secrets.
    # Each generate_tokens call closes the previous navigation/api interval and
    # opens a new one; session_reference stays one interval unless the session
    # itself is replaced. The swimlane reads this so a refresh does not erase
    # the short JWT window it just replaced.
    looker_token_spans: list[dict[str, Any]] = field(default_factory=list)

    def record_refresh_marker(self, process: str, at: datetime | None = None) -> None:
        self.refresh_markers.append({"at": at or utc_now(), "process": process})
        if len(self.refresh_markers) > HISTORY_LIMIT:
            self.refresh_markers = self.refresh_markers[-HISTORY_LIMIT:]

    def open_looker_token_span(
        self,
        token_id: str,
        issued_at: datetime,
        expires_at: datetime | None,
        close_reason: str = "replaced",
    ) -> None:
        self.close_looker_token_span(token_id, issued_at, close_reason)
        self.looker_token_spans.append(
            {
                "token_id": token_id,
                "issued_at": issued_at,
                "expires_at": expires_at,
                "closed_at": None,
                "close_reason": None,
            }
        )
        if len(self.looker_token_spans) > HISTORY_LIMIT:
            self.looker_token_spans = self.looker_token_spans[-HISTORY_LIMIT:]

    def close_looker_token_span(self, token_id: str, closed_at: datetime, reason: str) -> None:
        for span in reversed(self.looker_token_spans):
            if span["token_id"] == token_id and span["closed_at"] is None:
                span["closed_at"] = closed_at
                span["close_reason"] = reason
                return

    def close_open_looker_spans(self, closed_at: datetime, reason: str) -> None:
        for token_id in (
            "session_reference_token",
            "authentication_token",
            "navigation_token",
            "api_token",
        ):
            self.close_looker_token_span(token_id, closed_at, reason)

    def set_open_looker_span_expiry(self, token_id: str, expires_at: datetime | None) -> bool:
        for span in reversed(self.looker_token_spans):
            if span["token_id"] == token_id and span["closed_at"] is None:
                span["expires_at"] = expires_at
                return True
        return False

    def note_session_reference_window(
        self,
        *,
        had_reference: bool,
        now: datetime,
        expires_at: datetime | None,
    ) -> None:
        """Keep one session_reference bar across generate and reattach.

        Looker does not extend the session on generate_tokens, and reattach
        ignores session_length. A later absolute expiry within 15 seconds is
        clock drift, not a new session. A meaningfully later expiry is a new
        session and starts a new bar.
        """
        previous_issued = self.looker_session_reference_issued_at
        previous_expires = self.looker_session_reference_expires_at
        same_session = False
        if (
            had_reference
            and previous_issued is not None
            and previous_expires is not None
            and expires_at is not None
        ):
            same_session = (expires_at - previous_expires).total_seconds() <= 15
        if same_session:
            self.looker_session_reference_issued_at = previous_issued
            self.looker_session_reference_expires_at = expires_at
            if not self.set_open_looker_span_expiry("session_reference_token", expires_at):
                self.open_looker_token_span("session_reference_token", previous_issued, expires_at)
            return
        self.looker_session_reference_issued_at = now
        self.looker_session_reference_expires_at = expires_at
        self.open_looker_token_span("session_reference_token", now, expires_at)

    def mark_looker_session_revoked(self) -> None:
        self.looker_session_revoked = True
        if self.looker_session_revoked_at is None:
            self.looker_session_revoked_at = utc_now()

    def clear_looker_session_revoked(self) -> None:
        self.looker_session_revoked = False
        self.looker_session_revoked_at = None

    def mark_session_reference_dropped(self) -> None:
        now = utc_now()
        self.looker_session_reference_token = None
        self.session_reference_dropped = True
        if self.session_reference_dropped_at is None:
            self.session_reference_dropped_at = now
        self.close_looker_token_span(
            "session_reference_token",
            self.session_reference_dropped_at,
            "dropped",
        )

    def mark_authentication_consumed(self) -> None:
        self.looker_authentication_consumed = True
        if self.looker_authentication_consumed_at is None:
            self.looker_authentication_consumed_at = utc_now()
        self.close_looker_token_span(
            "authentication_token",
            self.looker_authentication_consumed_at,
            "consumed",
        )

    def any_iframe_session_expired(self) -> bool:
        return self.looker_sdk_iframe_expired or self.looker_postmessage_iframe_expired

    def mark_iframe_started(self, embed_client: str) -> None:
        now = utc_now()
        if embed_client == "sdk":
            self.looker_sdk_iframe_started = True
            if self.looker_sdk_iframe_started_at is None:
                self.looker_sdk_iframe_started_at = now
            self.looker_sdk_iframe_expired = False
            self.looker_sdk_iframe_expired_at = None
            return
        if embed_client == "postmessage":
            self.looker_postmessage_iframe_started = True
            if self.looker_postmessage_iframe_started_at is None:
                self.looker_postmessage_iframe_started_at = now
            self.looker_postmessage_iframe_expired = False
            self.looker_postmessage_iframe_expired_at = None

    def mark_iframe_expired(self, embed_client: str) -> bool:
        """Apply session:expired only to an iframe that was actually started.

        Returns True if the flag changed. Unborn iframes stay unborn.
        """
        now = utc_now()
        if embed_client == "sdk" and self.looker_sdk_iframe_started:
            self.looker_sdk_iframe_expired = True
            if self.looker_sdk_iframe_expired_at is None:
                self.looker_sdk_iframe_expired_at = now
            return True
        if embed_client == "postmessage" and self.looker_postmessage_iframe_started:
            self.looker_postmessage_iframe_expired = True
            if self.looker_postmessage_iframe_expired_at is None:
                self.looker_postmessage_iframe_expired_at = now
            return True
        return False

    def mark_iframe_alive(self, embed_client: str) -> None:
        if embed_client == "sdk" and self.looker_sdk_iframe_started:
            self.looker_sdk_iframe_expired = False
            self.looker_sdk_iframe_expired_at = None
            return
        if embed_client == "postmessage" and self.looker_postmessage_iframe_started:
            self.looker_postmessage_iframe_expired = False
            self.looker_postmessage_iframe_expired_at = None

    def clear_iframe_expired(self) -> None:
        self.looker_sdk_iframe_expired = False
        self.looker_sdk_iframe_expired_at = None
        self.looker_postmessage_iframe_expired = False
        self.looker_postmessage_iframe_expired_at = None

    def reset_iframe_clients(self) -> None:
        self.looker_sdk_iframe_started = False
        self.looker_sdk_iframe_started_at = None
        self.looker_postmessage_iframe_started = False
        self.looker_postmessage_iframe_started_at = None
        self.clear_iframe_expired()

    def append_event(self, event: LabEvent) -> LabEvent:
        self.events.append(event)
        if len(self.events) > HISTORY_LIMIT:
            self.events = self.events[-HISTORY_LIMIT:]
        return event

    def display_name(self) -> str:
        claims = self.auth0_claims or {}
        return str(claims.get("name") or claims.get("email") or claims.get("sub") or "unknown")

    def email(self) -> str:
        return str((self.auth0_claims or {}).get("email") or "")

    def external_user_id(self) -> str:
        return str((self.auth0_claims or {}).get("sub") or "")


class SessionStore:
    def __init__(self) -> None:
        self._sessions_by_id: dict[str, HostSession] = {}

    def save(self, session: HostSession) -> HostSession:
        self._sessions_by_id[session.host_session_id] = session
        return session

    def get(self, host_session_id: str | None) -> HostSession | None:
        if not host_session_id:
            return None
        return self._sessions_by_id.get(host_session_id)

    def delete(self, host_session_id: str) -> HostSession | None:
        return self._sessions_by_id.pop(host_session_id, None)


session_store = SessionStore()
