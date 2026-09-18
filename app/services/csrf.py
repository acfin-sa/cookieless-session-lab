from __future__ import annotations

import secrets

from starlette.requests import Request

CSRF_SESSION_KEY = "csrf_token"


def csrf_token_for_request(request: Request) -> str:
    token = request.session.get(CSRF_SESSION_KEY)
    if not token:
        token = secrets.token_urlsafe(32)
        request.session[CSRF_SESSION_KEY] = token
    return token


def validate_csrf_token(request: Request, submitted: str) -> bool:
    expected = request.session.get(CSRF_SESSION_KEY)
    if not expected or not submitted:
        return False
    return secrets.compare_digest(expected, submitted)
