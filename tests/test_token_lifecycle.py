from datetime import timedelta

from services.looker_client import drop_session_reference
from services.observatory import build_observatory_snapshot, compute_token_lifecycle_state
from services.session_store import utc_now


def test_compute_token_lifecycle_state_consumed_wins_over_revoked():
    assert (
        compute_token_lifecycle_state(
            present=False,
            consumed=True,
            revoked=True,
            expires_at=None,
            now=utc_now(),
            revoked_when_absent=True,
        )
        == "consumed"
    )


def test_compute_token_lifecycle_state_revoked_when_absent():
    assert (
        compute_token_lifecycle_state(
            present=False,
            consumed=False,
            revoked=True,
            expires_at=None,
            now=utc_now(),
            revoked_when_absent=True,
        )
        == "revoked"
    )


def test_compute_token_lifecycle_state_unborn_when_absent_and_not_revoked():
    assert (
        compute_token_lifecycle_state(
            present=False,
            consumed=False,
            revoked=False,
            expires_at=None,
            now=utc_now(),
        )
        == "unborn"
    )


def test_compute_token_lifecycle_state_expired_expiring_alive():
    now = utc_now()
    assert (
        compute_token_lifecycle_state(
            present=True,
            consumed=False,
            revoked=False,
            expires_at=now - timedelta(seconds=1),
            now=now,
        )
        == "expired"
    )
    assert (
        compute_token_lifecycle_state(
            present=True,
            consumed=False,
            revoked=False,
            expires_at=now + timedelta(seconds=30),
            now=now,
        )
        == "expiring"
    )
    assert (
        compute_token_lifecycle_state(
            present=True,
            consumed=False,
            revoked=False,
            expires_at=now + timedelta(seconds=120),
            now=now,
        )
        == "alive"
    )


def _token_by_id(snapshot, token_id):
    return next(token for token in snapshot["tokens"] if token["id"] == token_id)


def test_iframe_expire_does_not_revoke_session_reference_or_smash_jwt_clocks(host_session):
    future = utc_now() + timedelta(minutes=8)
    host_session.looker_session_reference_token = "session-ref"
    host_session.looker_session_reference_issued_at = host_session.created_at
    host_session.looker_session_reference_expires_at = future
    host_session.looker_navigation_token = "nav"
    host_session.looker_navigation_issued_at = host_session.created_at
    host_session.looker_navigation_expires_at = future
    host_session.looker_api_token = "api"
    host_session.looker_api_token_issued_at = host_session.created_at
    host_session.looker_api_token_expires_at = future
    host_session.mark_iframe_started("sdk")
    host_session.mark_iframe_expired("sdk")

    assert host_session.looker_session_reference_token == "session-ref"
    assert host_session.looker_navigation_expires_at == future
    assert host_session.looker_api_token_expires_at == future
    assert host_session.session_reference_dropped is False
    assert host_session.looker_session_revoked is False

    snapshot = build_observatory_snapshot(host_session)
    assert _token_by_id(snapshot, "session_reference_token")["state"] == "alive"
    assert _token_by_id(snapshot, "navigation_token")["state"] == "alive"
    assert _token_by_id(snapshot, "api_token")["state"] == "alive"


def test_drop_clears_host_reference_without_ending_looker_session_flag(host_session):
    future = utc_now() + timedelta(minutes=8)
    host_session.looker_session_reference_token = "session-ref"
    host_session.looker_session_reference_issued_at = host_session.created_at
    host_session.looker_session_reference_expires_at = future
    drop_session_reference(host_session)

    assert host_session.looker_session_reference_token is None
    assert host_session.session_reference_dropped is True
    assert host_session.looker_session_revoked is False

    snapshot = build_observatory_snapshot(host_session)
    reference = _token_by_id(snapshot, "session_reference_token")
    assert reference["state"] == "revoked"
    assert "dropped" in reference["state_reason"]
