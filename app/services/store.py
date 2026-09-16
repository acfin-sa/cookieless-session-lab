from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(value: datetime | None) -> str | None:
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
            "timestamp": isoformat(self.timestamp),
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
    host_session_reference: str
    created_at: datetime
    user_agent: str
    auth0_claims: dict[str, Any]

    auth0_refresh_token: str | None = None
    auth0_access_token: str | None = None
    auth0_id_token: str | None = None
    auth0_access_issued_at: datetime | None = None
    auth0_access_expires_at: datetime | None = None
    auth0_id_issued_at: datetime | None = None
    auth0_id_expires_at: datetime | None = None

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
    looker_navigation_token: str | None = None
    looker_navigation_issued_at: datetime | None = None
    looker_navigation_expires_at: datetime | None = None
    looker_api_token: str | None = None
    looker_api_token_issued_at: datetime | None = None
    looker_api_token_expires_at: datetime | None = None

    freeze_token_refresh: bool = False
    force_user_agent_mismatch: bool = False
    session_reference_dropped: bool = False
    looker_session_revoked: bool = False
    looker_sdk_iframe_started: bool = False
    looker_sdk_iframe_started_at: datetime | None = None
    looker_sdk_iframe_expired: bool = False
    looker_sdk_iframe_expired_at: datetime | None = None
    looker_pm_iframe_started: bool = False
    looker_pm_iframe_started_at: datetime | None = None
    looker_pm_iframe_expired: bool = False
    looker_pm_iframe_expired_at: datetime | None = None
    host_revoked: bool = False

    events: list[LabEvent] = field(default_factory=list)
    refresh_markers: list[dict[str, Any]] = field(default_factory=list)

    def record_refresh_marker(self, process: str) -> None:
        self.refresh_markers.append({"at": utc_now(), "process": process})

    def iframe_session_expired(self) -> bool:
        return self.looker_sdk_iframe_expired or self.looker_pm_iframe_expired

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
            self.looker_pm_iframe_started = True
            if self.looker_pm_iframe_started_at is None:
                self.looker_pm_iframe_started_at = now
            self.looker_pm_iframe_expired = False
            self.looker_pm_iframe_expired_at = None

    def mark_iframe_expired(self, embed_client: str) -> bool:
        """Apply session:expired only to an iframe that was actually summoned.

        Returns True if the flag changed. Unborn iframes stay unborn.
        """
        now = utc_now()
        if embed_client == "sdk" and self.looker_sdk_iframe_started:
            self.looker_sdk_iframe_expired = True
            if self.looker_sdk_iframe_expired_at is None:
                self.looker_sdk_iframe_expired_at = now
            return True
        if embed_client == "postmessage" and self.looker_pm_iframe_started:
            self.looker_pm_iframe_expired = True
            if self.looker_pm_iframe_expired_at is None:
                self.looker_pm_iframe_expired_at = now
            return True
        return False

    def mark_iframe_alive(self, embed_client: str) -> None:
        if embed_client == "sdk" and self.looker_sdk_iframe_started:
            self.looker_sdk_iframe_expired = False
            self.looker_sdk_iframe_expired_at = None
            return
        if embed_client == "postmessage" and self.looker_pm_iframe_started:
            self.looker_pm_iframe_expired = False
            self.looker_pm_iframe_expired_at = None

    def clear_iframe_expired(self) -> None:
        self.looker_sdk_iframe_expired = False
        self.looker_sdk_iframe_expired_at = None
        self.looker_pm_iframe_expired = False
        self.looker_pm_iframe_expired_at = None

    def reset_iframe_clients(self) -> None:
        self.looker_sdk_iframe_started = False
        self.looker_sdk_iframe_started_at = None
        self.looker_pm_iframe_started = False
        self.looker_pm_iframe_started_at = None
        self.clear_iframe_expired()

    def append_event(self, event: LabEvent) -> LabEvent:
        self.events.append(event)
        if len(self.events) > 250:
            self.events = self.events[-250:]
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
        self._by_cookie: dict[str, HostSession] = {}

    def put(self, session: HostSession) -> HostSession:
        self._by_cookie[session.host_session_id] = session
        return session

    def get(self, host_session_id: str | None) -> HostSession | None:
        if not host_session_id:
            return None
        return self._by_cookie.get(host_session_id)

    def delete(self, host_session_id: str) -> HostSession | None:
        return self._by_cookie.pop(host_session_id, None)


store = SessionStore()
