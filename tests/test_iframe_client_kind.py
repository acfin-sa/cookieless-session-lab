from fastapi.testclient import TestClient

from services.session_store import (
    IFRAME_CLIENT_KIND_EMBED_SDK,
    IFRAME_CLIENT_KIND_FIELD,
    IFRAME_CLIENT_KIND_RAW_POSTMESSAGE,
    LEGACY_IFRAME_CLIENT_KIND_FIELD,
    canonical_iframe_client_kind,
    iframe_client_kind_from_event_body,
)
from web import app


def test_canonical_iframe_client_kind_accepts_legacy_and_current_values():
    assert canonical_iframe_client_kind("sdk") == IFRAME_CLIENT_KIND_EMBED_SDK
    assert canonical_iframe_client_kind("embed_sdk") == IFRAME_CLIENT_KIND_EMBED_SDK
    assert canonical_iframe_client_kind("postmessage") == IFRAME_CLIENT_KIND_RAW_POSTMESSAGE
    assert canonical_iframe_client_kind("raw_postmessage") == IFRAME_CLIENT_KIND_RAW_POSTMESSAGE
    assert canonical_iframe_client_kind("unknown") == ""
    assert canonical_iframe_client_kind("") == ""


def test_iframe_client_kind_from_event_body_prefers_new_key():
    assert (
        iframe_client_kind_from_event_body(
            {
                IFRAME_CLIENT_KIND_FIELD: IFRAME_CLIENT_KIND_EMBED_SDK,
                LEGACY_IFRAME_CLIENT_KIND_FIELD: "postmessage",
            }
        )
        == IFRAME_CLIENT_KIND_EMBED_SDK
    )
    assert (
        iframe_client_kind_from_event_body({LEGACY_IFRAME_CLIENT_KIND_FIELD: "sdk"})
        == IFRAME_CLIENT_KIND_EMBED_SDK
    )
    assert iframe_client_kind_from_event_body({}) == ""


def test_mark_iframe_started_accepts_legacy_values(host_session):
    host_session.mark_iframe_started("sdk")
    assert host_session.looker_sdk_iframe_started is True
    host_session.mark_iframe_started("postmessage")
    assert host_session.looker_postmessage_iframe_started is True


def test_mark_iframe_started_accepts_current_values(host_session):
    host_session.mark_iframe_started(IFRAME_CLIENT_KIND_EMBED_SDK)
    host_session.mark_iframe_expired(IFRAME_CLIENT_KIND_EMBED_SDK)
    assert host_session.looker_sdk_iframe_expired is True
    host_session.mark_iframe_alive(IFRAME_CLIENT_KIND_RAW_POSTMESSAGE)
    assert host_session.looker_postmessage_iframe_started is False
    host_session.mark_iframe_started(IFRAME_CLIENT_KIND_RAW_POSTMESSAGE)
    host_session.mark_iframe_expired("postmessage")
    assert host_session.looker_postmessage_iframe_expired is True


def _bearer(session):
    return {"Authorization": f"Bearer {session.host_access_token}"}


def test_client_event_legacy_embed_client_sdk_starts_sdk_iframe(host_session):
    client = TestClient(app)
    response = client.post(
        "/api/lab/events",
        headers=_bearer(host_session),
        json={
            "method": "iframe navigation to embed login URL",
            "actor": "Browser",
            "summary": "legacy key and value",
            LEGACY_IFRAME_CLIENT_KIND_FIELD: "sdk",
        },
    )
    assert response.status_code == 200
    assert host_session.looker_sdk_iframe_started is True
    assert host_session.looker_postmessage_iframe_started is False
    assert host_session.looker_authentication_consumed is True


def test_client_event_new_iframe_client_kind_starts_and_expires_raw_tab(host_session):
    client = TestClient(app)
    start = client.post(
        "/api/lab/events",
        headers=_bearer(host_session),
        json={
            "method": "iframe navigation to embed login URL",
            "actor": "Browser",
            "summary": "current key and value",
            IFRAME_CLIENT_KIND_FIELD: IFRAME_CLIENT_KIND_RAW_POSTMESSAGE,
        },
    )
    assert start.status_code == 200
    assert host_session.looker_postmessage_iframe_started is True
    assert host_session.looker_sdk_iframe_started is False

    expired = client.post(
        "/api/lab/events",
        headers=_bearer(host_session),
        json={
            "method": "session:expired",
            "actor": "iframe postMessage",
            "summary": "raw iframe expired",
            "ok": False,
            "expired": True,
            IFRAME_CLIENT_KIND_FIELD: IFRAME_CLIENT_KIND_RAW_POSTMESSAGE,
        },
    )
    assert expired.status_code == 200
    assert host_session.looker_postmessage_iframe_expired is True
    assert host_session.looker_sdk_iframe_expired is False
