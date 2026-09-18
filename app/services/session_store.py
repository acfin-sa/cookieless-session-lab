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


IFRAME_CLIENT_KIND_FIELD = "iframe_client_kind"
LEGACY_IFRAME_CLIENT_KIND_FIELD = "embed_client"
IFRAME_CLIENT_KIND_EMBED_SDK = "embed_sdk"
IFRAME_CLIENT_KIND_RAW_POSTMESSAGE = "raw_postmessage"

_IFRAME_CLIENT_KIND_ALIASES = {
    "sdk": IFRAME_CLIENT_KIND_EMBED_SDK,
    IFRAME_CLIENT_KIND_EMBED_SDK: IFRAME_CLIENT_KIND_EMBED_SDK,
    "postmessage": IFRAME_CLIENT_KIND_RAW_POSTMESSAGE,
    IFRAME_CLIENT_KIND_RAW_POSTMESSAGE: IFRAME_CLIENT_KIND_RAW_POSTMESSAGE,
}


def canonical_iframe_client_kind(raw: str | None) -> str:
    """Map a client event discriminator to the current iframe kind.

    Writers emit ``embed_sdk`` / ``raw_postmessage``. Readers still accept
    the pre-cutover values ``sdk`` / ``postmessage``.
    """
    return _IFRAME_CLIENT_KIND_ALIASES.get(str(raw or "").strip(), "")


def iframe_client_kind_from_event_body(body: dict[str, Any]) -> str:
    """Read the iframe discriminator from a client event body.

    Prefer ``iframe_client_kind``. Fall back to the pre-cutover ``embed_client``
    key. Callers must not restate that fallback.
    """
    raw = body.get(IFRAME_CLIENT_KIND_FIELD)
    if raw in (None, ""):
        raw = body.get(LEGACY_IFRAME_CLIENT_KIND_FIELD)
    if raw is None:
        return ""
    return canonical_iframe_client_kind(raw if isinstance(raw, str) else str(raw))


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
    host_session_reference: str
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

    def record_refresh_marker(self, process: str) -> None:
        self.refresh_markers.append({"at": utc_now(), "process": process})
        if len(self.refresh_markers) > HISTORY_LIMIT:
            self.refresh_markers = self.refresh_markers[-HISTORY_LIMIT:]

    def mark_looker_session_revoked(self) -> None:
        self.looker_session_revoked = True
        if self.looker_session_revoked_at is None:
            self.looker_session_revoked_at = utc_now()

    def clear_looker_session_revoked(self) -> None:
        self.looker_session_revoked = False
        self.looker_session_revoked_at = None

    def mark_session_reference_dropped(self) -> None:
        self.looker_session_reference_token = None
        self.session_reference_dropped = True
        if self.session_reference_dropped_at is None:
            self.session_reference_dropped_at = utc_now()

    def mark_authentication_consumed(self) -> None:
        self.looker_authentication_consumed = True
        if self.looker_authentication_consumed_at is None:
            self.looker_authentication_consumed_at = utc_now()

    def any_iframe_session_expired(self) -> bool:
        return self.looker_sdk_iframe_expired or self.looker_postmessage_iframe_expired

    def mark_iframe_started(self, iframe_client_kind: str) -> None:
        now = utc_now()
        kind = canonical_iframe_client_kind(iframe_client_kind)
        if kind == IFRAME_CLIENT_KIND_EMBED_SDK:
            self.looker_sdk_iframe_started = True
            if self.looker_sdk_iframe_started_at is None:
                self.looker_sdk_iframe_started_at = now
            self.looker_sdk_iframe_expired = False
            self.looker_sdk_iframe_expired_at = None
            return
        if kind == IFRAME_CLIENT_KIND_RAW_POSTMESSAGE:
            self.looker_postmessage_iframe_started = True
            if self.looker_postmessage_iframe_started_at is None:
                self.looker_postmessage_iframe_started_at = now
            self.looker_postmessage_iframe_expired = False
            self.looker_postmessage_iframe_expired_at = None

    def mark_iframe_expired(self, iframe_client_kind: str) -> bool:
        """Apply session:expired only to an iframe that was actually started.

        Returns True if the flag changed. Unborn iframes stay unborn.
        """
        now = utc_now()
        kind = canonical_iframe_client_kind(iframe_client_kind)
        if kind == IFRAME_CLIENT_KIND_EMBED_SDK and self.looker_sdk_iframe_started:
            self.looker_sdk_iframe_expired = True
            if self.looker_sdk_iframe_expired_at is None:
                self.looker_sdk_iframe_expired_at = now
            return True
        if kind == IFRAME_CLIENT_KIND_RAW_POSTMESSAGE and self.looker_postmessage_iframe_started:
            self.looker_postmessage_iframe_expired = True
            if self.looker_postmessage_iframe_expired_at is None:
                self.looker_postmessage_iframe_expired_at = now
            return True
        return False

    def mark_iframe_alive(self, iframe_client_kind: str) -> None:
        kind = canonical_iframe_client_kind(iframe_client_kind)
        if kind == IFRAME_CLIENT_KIND_EMBED_SDK and self.looker_sdk_iframe_started:
            self.looker_sdk_iframe_expired = False
            self.looker_sdk_iframe_expired_at = None
            return
        if kind == IFRAME_CLIENT_KIND_RAW_POSTMESSAGE and self.looker_postmessage_iframe_started:
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
