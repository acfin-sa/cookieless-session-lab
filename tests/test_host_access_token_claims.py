from datetime import datetime, timedelta, timezone
from uuid import uuid4

import jwt
from jwt import InvalidTokenError
import pytest

from config import APP_KEY_SECRET, HOST_ACCESS_TOKEN_TTL_SECONDS
from services.host_tokens import (
    HOST_SESSION_ID_CLAIM,
    LEGACY_HOST_SESSION_ID_CLAIM,
    host_session_id_from_claims,
    verify_host_access_token,
)


def test_minted_host_access_token_uses_host_session_id_claim_not_hsid(host_session):
    claims = jwt.decode(host_session.host_access_token, options={"verify_signature": False})
    assert claims[HOST_SESSION_ID_CLAIM] == host_session.host_session_id
    assert LEGACY_HOST_SESSION_ID_CLAIM not in claims
    verified = verify_host_access_token(host_session.host_access_token)
    assert verified[HOST_SESSION_ID_CLAIM] == host_session.host_session_id


def test_host_session_id_from_claims_prefers_new_claim():
    assert (
        host_session_id_from_claims(
            {HOST_SESSION_ID_CLAIM: "current-id", LEGACY_HOST_SESSION_ID_CLAIM: "legacy-id"}
        )
        == "current-id"
    )
    assert host_session_id_from_claims({LEGACY_HOST_SESSION_ID_CLAIM: "legacy-id"}) == "legacy-id"
    assert host_session_id_from_claims({}) == ""


def _legacy_hsid_token(session, *, host_session_id=None, token_id=None):
    now = datetime.now(timezone.utc)
    token_id = token_id or session.host_access_token_jti or uuid4().hex
    expires = now + timedelta(seconds=HOST_ACCESS_TOKEN_TTL_SECONDS)
    payload = {
        "typ": "host_access",
        "sub": session.external_user_id(),
        LEGACY_HOST_SESSION_ID_CLAIM: host_session_id or session.host_session_id,
        "jti": token_id,
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
    }
    return jwt.encode(payload, APP_KEY_SECRET, algorithm="HS256"), token_id


def test_verify_accepts_legacy_hsid_claim_and_normalizes_it(host_session):
    token, token_id = _legacy_hsid_token(host_session)
    host_session.host_access_token = token
    host_session.host_access_token_jti = token_id
    claims = jwt.decode(token, options={"verify_signature": False})
    assert HOST_SESSION_ID_CLAIM not in claims
    assert claims[LEGACY_HOST_SESSION_ID_CLAIM] == host_session.host_session_id

    verified = verify_host_access_token(token)
    assert verified[HOST_SESSION_ID_CLAIM] == host_session.host_session_id
    assert verified[LEGACY_HOST_SESSION_ID_CLAIM] == host_session.host_session_id


def test_verify_rejects_token_with_neither_session_claim(host_session):
    now = datetime.now(timezone.utc)
    token = jwt.encode(
        {
            "typ": "host_access",
            "sub": host_session.external_user_id(),
            "jti": host_session.host_access_token_jti,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=HOST_ACCESS_TOKEN_TTL_SECONDS)).timestamp()),
        },
        APP_KEY_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(InvalidTokenError, match="missing host_session_id"):
        verify_host_access_token(token)


def test_bearer_routes_accept_legacy_hsid_token(host_session):
    from fastapi.testclient import TestClient
    from web import app

    token, token_id = _legacy_hsid_token(host_session)
    host_session.host_access_token = token
    host_session.host_access_token_jti = token_id
    client = TestClient(app)
    response = client.get(
        "/api/lab/snapshot",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["user"]["sub"] == "auth0|pytest"
