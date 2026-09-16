from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from config import APP_BASE_URL, APP_KEY_SECRET, OAUTH_STATE_COOKIE, cookie_secure
from routes.auth0 import auth0_router
from routes.host import host_router
from routes.lab import lab_router
from routes.looker import looker_router
from routes.views import views_router

if not APP_KEY_SECRET:
    raise RuntimeError(
        "APP_KEY_SECRET is empty. Copy .env.example to .env and set a long random secret."
    )

app = FastAPI(
    title="cookieless-session-lab",
    description="Pedagogical two-layer cookieless session observatory. Open http://localhost:3000",
    servers=[{"url": APP_BASE_URL, "description": "local lab"}],
)

# oauth_pkce_state is only for the Auth0 dance (state + PKCE verifier).
# Secure=True only when APP_BASE_URL is https. http://localhost must be Secure=False.
app.add_middleware(
    SessionMiddleware,
    secret_key=APP_KEY_SECRET,
    session_cookie=OAUTH_STATE_COOKIE,
    same_site="lax",
    https_only=cookie_secure(),
    max_age=600,
)

static_directory = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=str(static_directory)), name="static")

app.include_router(views_router)
app.include_router(auth0_router)
app.include_router(host_router)
app.include_router(looker_router)
app.include_router(lab_router)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "app": "cookieless-session-lab",
        "app_base_url": APP_BASE_URL,
        "cookie_secure": cookie_secure(),
    }
