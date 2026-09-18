import os
from uuid import uuid4

os.environ.setdefault("APP_KEY_SECRET", "pytest-host-jwt-secret-not-for-production")

import pytest

from services.host_tokens import mint_host_access_token
from services.session_store import HostSession, session_store, utc_now


@pytest.fixture
def host_session():
    session = HostSession(
        host_session_id=uuid4().hex,
        host_session_reference=uuid4().hex,
        created_at=utc_now(),
        user_agent="pytest-agent",
        auth0_claims={
            "sub": "auth0|pytest",
            "email": "lab@example.com",
            "name": "Lab User",
        },
    )
    mint_host_access_token(session, process="pytest mint")
    session_store.save(session)
    yield session
    session_store.delete(session.host_session_id)
