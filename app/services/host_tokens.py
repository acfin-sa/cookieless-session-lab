from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import jwt
from jwt import InvalidTokenError

from config import APP_KEY_SECRET, HOST_ACCESS_TOKEN_TTL_SECONDS
from services.session_store import HostSession, utc_now

HOST_ACCESS_TOKEN_TYPE = "host_access"
HOST_SESSION_ID_CLAIM = "host_session_id"
LEGACY_HOST_SESSION_ID_CLAIM = "hsid"


def host_session_id_from_claims(claims: dict[str, Any]) -> str:
    """Read the HostSession key from a host JWT.

    New tokens use ``host_session_id``. Tokens minted before the naming
    cutover used ``hsid``. Callers must not restate that fallback.
    """
    return str(
        claims.get(HOST_SESSION_ID_CLAIM)
        or claims.get(LEGACY_HOST_SESSION_ID_CLAIM)
        or ""
    )


def _timestamp_to_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if numeric > 1e12:
        numeric = numeric / 1000.0
    return datetime.fromtimestamp(numeric, tz=timezone.utc)


def decode_jwt_unverified(token: str | None) -> dict[str, Any]:
    if not token:
        return {}
    try:
        return jwt.decode(token, options={"verify_signature": False})
    except Exception:
        return {}


def mint_host_access_token(session: HostSession, process: str = "mint host_access_token") -> str:
    # TOKEN: host_access_token
    # CREATED BY: POST /api/host/bootstrap, POST /api/host/refresh
    # CONSUMED BY: Authorization: Bearer on /api/looker/* and /api/lab/*
    # LIVES AT: browser memory (JSON). Also remembered on HostSession so the observatory can show TTL.
    # TTL: HOST_ACCESS_TOKEN_TTL_SECONDS. Previous jti is dead after a refresh.
    # WHY: short-lived, low-privilege handle. The cookie only identifies the record;
    #      this JWT is what authorizes the BFF. Claim host_session_id is the same
    #      opaque key as the cookie. Analogous to Looker's api_token, not to
    #      session_reference_token.
    now = utc_now()
    token_id = uuid4().hex
    payload = {
        "typ": HOST_ACCESS_TOKEN_TYPE,
        "sub": session.external_user_id(),
        HOST_SESSION_ID_CLAIM: session.host_session_id,
        "jti": token_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=HOST_ACCESS_TOKEN_TTL_SECONDS)).timestamp()),
    }
    token = jwt.encode(payload, APP_KEY_SECRET, algorithm="HS256")
    session.host_access_token = token
    session.host_access_token_jti = token_id
    session.host_access_token_issued_at = now
    session.host_access_token_expires_at = now + timedelta(seconds=HOST_ACCESS_TOKEN_TTL_SECONDS)
    session.record_refresh_marker(process)
    return token


def verify_host_access_token(token: str) -> dict[str, Any]:
    # TOKEN: host_access_token
    # CREATED BY: mint_host_access_token
    # CONSUMED BY: require_bearer_session
    # LIVES AT: verified in memory on the host; never written to localStorage
    # TTL: HOST_ACCESS_TOKEN_TTL_SECONDS (exp claim)
    # WHY: cryptographic proof the browser recently talked to Layer A. We still
    #      load HostSession from claim host_session_id (legacy: hsid) and check
    #      jti so a refreshed token kills the old one.
    if not APP_KEY_SECRET:
        raise InvalidTokenError("APP_KEY_SECRET is not configured")
    claims = jwt.decode(
        token,
        APP_KEY_SECRET,
        algorithms=["HS256"],
        options={"require": ["exp", "iat", "jti", "typ"]},
    )
    host_session_id = host_session_id_from_claims(claims)
    if not host_session_id:
        raise InvalidTokenError("host_access_token is missing host_session_id")
    claims[HOST_SESSION_ID_CLAIM] = host_session_id
    return claims


def apply_auth0_token_set(session: HostSession, token_set: dict[str, Any]) -> None:
    # TOKEN: auth0_refresh, auth0_access
    # CREATED BY: Auth0 /oauth/token (code exchange or refresh)
    # CONSUMED BY: Auth0 /oauth/token (refresh) and /oauth/revoke; never sent to the browser
    # LIVES AT: HostSession on the server
    # TTL: access from exp; refresh until Auth0 revokes / rotation reuses
    # WHY: long-lived high-privilege (refresh) and short-lived IdP access stay behind the BFF.
    now = utc_now()
    refresh_token = token_set.get("refresh_token")
    if refresh_token:
        session.auth0_refresh_token = refresh_token
        session.auth0_refresh_issued_at = now
    access_token = token_set.get("access_token")
    if access_token:
        session.auth0_access_token = access_token
        access_claims = decode_jwt_unverified(access_token)
        session.auth0_access_issued_at = _timestamp_to_datetime(access_claims.get("iat")) or now
        expires_at = _timestamp_to_datetime(access_claims.get("exp"))
        if expires_at is None and token_set.get("expires_in"):
            expires_at = now + timedelta(seconds=int(token_set["expires_in"]))
        session.auth0_access_expires_at = expires_at
    id_token = token_set.get("id_token")
    if id_token:
        id_claims = decode_jwt_unverified(id_token)
        session.auth0_claims = {
            **id_claims,
            **(token_set.get("userinfo") or {}),
        }

