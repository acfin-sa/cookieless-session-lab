from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")


def parse_bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def parse_csv_env(name: str, default: str = "") -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


def parse_csv_int_env(name: str, default: str = "") -> list[int]:
    values: list[int] = []
    for item in parse_csv_env(name, default):
        values.append(int(item))
    return values


def _normalize_looker_base_url(raw: str) -> str:
    """Looker Cloud serves the API on 443. :19999 is the self-hosted API port and times out on *.cloud.looker.com."""
    value = (raw or "").strip().rstrip("/")
    if not value:
        return ""
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if host.endswith(".cloud.looker.com") and parsed.port == 19999:
        netloc = parsed.hostname or host
        return urlunparse((parsed.scheme or "https", netloc, parsed.path.rstrip("/"), "", "", ""))
    return value


# Browser-facing origin is always APP_BASE_URL. Normalize 127.0.0.1 so generated
# Auth0 callbacks, embed_domain, and redirects never send the browser there.
_raw_base_url = os.getenv("APP_BASE_URL", "http://localhost:3000").rstrip("/")
APP_BASE_URL = _raw_base_url.replace("://127.0.0.1", "://localhost")
APP_KEY_SECRET = os.getenv("APP_KEY_SECRET", "")

AUTH0_DOMAIN = os.getenv("AUTH0_DOMAIN", "")
AUTH0_CLIENT_ID = os.getenv("AUTH0_CLIENT_ID", "")
AUTH0_CLIENT_SECRET = os.getenv("AUTH0_CLIENT_SECRET", "")
AUTH0_AUDIENCE = os.getenv("AUTH0_AUDIENCE", "").strip()

LOOKER_BASE_URL = _normalize_looker_base_url(os.getenv("LOOKER_BASE_URL", ""))
LOOKER_CLIENT_ID = os.getenv("LOOKER_CLIENT_ID", "")
LOOKER_CLIENT_SECRET = os.getenv("LOOKER_CLIENT_SECRET", "")
LOOKER_VERIFY_SSL = parse_bool_env("LOOKER_VERIFY_SSL", True)
LOOKER_EMBED_HOST = os.getenv("LOOKER_EMBED_HOST", "").rstrip("/")
LOOKER_EMBED_DASHBOARD_ID = os.getenv("LOOKER_EMBED_DASHBOARD_ID", "").strip()

LOOKER_EMBED_SESSION_LENGTH = int(os.getenv("LOOKER_EMBED_SESSION_LENGTH", "720"))
LOOKER_EMBED_FORCE_LOGOUT_LOGIN = parse_bool_env("LOOKER_EMBED_FORCE_LOGOUT_LOGIN", True)
LOOKER_EMBED_GROUP_IDS = parse_csv_int_env("LOOKER_EMBED_GROUP_IDS", "1")
LOOKER_EMBED_EXTERNAL_GROUP_ID = os.getenv("LOOKER_EMBED_EXTERNAL_GROUP_ID", "cookieless-lab")
LOOKER_EMBED_MODELS = parse_csv_env("LOOKER_EMBED_MODELS", "dw_v3")
LOOKER_EMBED_PERMISSIONS = parse_csv_env(
    "LOOKER_EMBED_PERMISSIONS",
    "access_data,see_looks,see_user_dashboards",
)

HOST_ACCESS_TOKEN_TTL_SECONDS = 200
HOST_SESSION_COOKIE = "host_session_id"
OAUTH_STATE_COOKIE = "oauth_pkce_state"
LOOKER_MISMATCH_USER_AGENT = "CookielessLab/ua-mismatch"

TOKEN_METHOD_MAP_PATH = ROOT_DIR / "docs" / "token-method-map.json"
SEQUENCE_DIAGRAM_PATH = ROOT_DIR / "docs" / "sequence-happy-path.mmd"
ARCHITECTURE_PATH = ROOT_DIR / "ARCHITECTURE.md"


def cookie_secure() -> bool:
    """Secure cookies only on HTTPS. http://localhost must use Secure=False."""
    return APP_BASE_URL.lower().startswith("https://")


def public_url(path: str = "") -> str:
    if not path:
        return APP_BASE_URL
    if not path.startswith("/"):
        path = "/" + path
    return APP_BASE_URL + path
