from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from routes.looker import browser_safe_looker_payload
from services.looker_client import LookerSessionDead, generate_embed_tokens
from services import looker_client
from web import app


def test_browser_safe_looker_payload_strips_session_reference_only():
    payload = browser_safe_looker_payload(
        {
            "session_reference_token": "secret-ref",
            "api_token": "api",
            "navigation_token": "nav",
            "frozen": True,
        }
    )
    assert "session_reference_token" not in payload
    assert payload["api_token"] == "api"
    assert payload["navigation_token"] == "nav"
    assert payload["frozen"] is True


def test_generate_freeze_returns_existing_tokens_without_looker_or_rotation_log(host_session):
    host_session.freeze_token_refresh = True
    host_session.looker_session_reference_token = "session-ref"
    host_session.looker_navigation_token = "nav-token"
    host_session.looker_api_token = "api-token"
    events_before = len(host_session.events)

    payload = generate_embed_tokens(host_session, "pytest-agent")

    assert payload["frozen"] is True
    assert payload["navigation_token"] == "nav-token"
    assert payload["api_token"] == "api-token"
    assert len(host_session.events) == events_before
    summaries = [event.summary for event in host_session.events]
    assert not any("Rotated" in summary for summary in summaries)


def test_generate_without_reference_raises_looker_session_dead(host_session):
    host_session.looker_session_reference_token = None
    with pytest.raises(LookerSessionDead):
        generate_embed_tokens(host_session, "pytest-agent")
    summaries = [event.summary for event in host_session.events]
    assert not any("Rotated" in summary for summary in summaries)


def test_generate_ttl_zero_raises_dead_without_logging_http_200(host_session, monkeypatch):
    host_session.looker_session_reference_token = "session-ref"
    host_session.looker_navigation_token = "nav-token"
    host_session.looker_api_token = "api-token"

    class FakeSdk:
        def generate_tokens_for_cookieless_session(self, body, transport_options):
            return SimpleNamespace(
                session_reference_token_ttl=0,
                session_reference_token="session-ref",
                navigation_token="nav-token",
                api_token="api-token",
                navigation_token_ttl=0,
                api_token_ttl=0,
            )

    monkeypatch.setattr(looker_client, "get_looker_sdk", lambda: FakeSdk())
    events_before = len(host_session.events)
    with pytest.raises(LookerSessionDead):
        generate_embed_tokens(host_session, "pytest-agent")
    assert host_session.looker_session_revoked is True
    new_events = host_session.events[events_before:]
    assert new_events == []


def _bearer(session):
    return {"Authorization": f"Bearer {session.host_access_token}"}


def test_http_generate_dead_session_is_409_once(host_session):
    host_session.looker_session_reference_token = None
    client = TestClient(app)
    response = client.put("/api/looker/generate-embed-tokens", headers=_bearer(host_session))
    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "SESSION_DEAD"
    generate_events = [
        event
        for event in host_session.events
        if event.method == "PUT /api/looker/generate-embed-tokens"
    ]
    assert len(generate_events) == 1
    assert generate_events[0].status_code == 409
    assert generate_events[0].ok is False


def test_http_generate_freeze_logs_once_without_claiming_rotation(host_session):
    host_session.freeze_token_refresh = True
    host_session.force_user_agent_mismatch = True
    host_session.looker_session_reference_token = "session-ref"
    host_session.looker_navigation_token = "nav-token"
    host_session.looker_api_token = "api-token"
    client = TestClient(app)
    response = client.put("/api/looker/generate-embed-tokens", headers=_bearer(host_session))
    assert response.status_code == 200
    body = response.json()
    assert body["frozen"] is True
    assert "session_reference_token" not in body
    generate_events = [
        event
        for event in host_session.events
        if "generate" in event.method.lower() or "Rotated" in event.summary
    ]
    assert len(generate_events) == 1
    assert generate_events[0].status_code == 200
    assert generate_events[0].ok is True
    assert "Looker was not called" in generate_events[0].summary
    assert "freeze wins" in generate_events[0].summary
    assert "Rotated" not in generate_events[0].summary
    assert "Sending" not in generate_events[0].summary


def test_unknown_client_event_does_not_expire_iframe(host_session):
    host_session.looker_session_reference_token = "session-ref"
    host_session.mark_iframe_started("sdk")
    client = TestClient(app)
    response = client.post(
        "/api/lab/events",
        headers=_bearer(host_session),
        json={
            "method": "not-a-catalog-method",
            "actor": "Browser",
            "summary": "should log but not mutate",
            "expired": True,
            "ok": False,
            "embed_client": "sdk",
        },
    )
    assert response.status_code == 200
    assert host_session.looker_sdk_iframe_expired is False
    assert host_session.looker_session_reference_token == "session-ref"
