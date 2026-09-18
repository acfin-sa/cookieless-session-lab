from __future__ import annotations

import re
from pathlib import Path

import markdown
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from config import (
    APP_BASE_URL,
    ARCHITECTURE_PATH,
    HOST_ACCESS_TOKEN_TTL_SECONDS,
    LOOKER_EMBED_DASHBOARD_ID,
    LOOKER_EMBED_HOST,
    LOOKER_EMBED_SESSION_LENGTH,
    MERMAID_MODULE_URL,
    SEQUENCE_DIAGRAM_PATH,
    looker_embed_cold_start_filters,
    public_url,
)
from services.csrf import csrf_token_for_request
from services.host_session_auth import session_from_cookie
from services.observatory import load_method_map

templates = Jinja2Templates(
    directory=str(Path(__file__).resolve().parent.parent / "templates")
)
views_router = APIRouter()


def template_context(request: Request, **context) -> dict:
    return {"csrf_token": csrf_token_for_request(request), **context}


def _render_architecture_html() -> str:
    source = ARCHITECTURE_PATH.read_text(encoding="utf-8")
    html = markdown.markdown(
        source,
        extensions=["tables", "fenced_code", "sane_lists"],
    )
    # Template header already shows the document title.
    return re.sub(r"^<h1>.*?</h1>\s*", "", html, count=1)


def looker_embed_page_config() -> dict:
    return {
        "lookerEmbedHost": LOOKER_EMBED_HOST,
        "lookerDashboardId": LOOKER_EMBED_DASHBOARD_ID,
        "embedDomain": APP_BASE_URL,
        "coldStartDashboardFilters": looker_embed_cold_start_filters(),
    }


@views_router.get("/", response_class=HTMLResponse)
async def home(request: Request):
    session = session_from_cookie(request)
    if session is not None and not session.host_session_revoked:
        return RedirectResponse(url=public_url("/lab"), status_code=302)
    return templates.TemplateResponse(
        request=request,
        name="home.html",
        context={},
    )


@views_router.get("/architecture", response_class=HTMLResponse)
async def architecture(request: Request):
    session = session_from_cookie(request)
    return templates.TemplateResponse(
        request=request,
        name="architecture.html",
        context=template_context(
            request,
            architecture_html=_render_architecture_html(),
            host_access_token_ttl_seconds=HOST_ACCESS_TOKEN_TTL_SECONDS,
            looker_embed_session_length=LOOKER_EMBED_SESSION_LENGTH,
            logged_in=session is not None and not session.host_session_revoked,
            user_name=session.display_name() if session else None,
            user_email=session.email() if session else None,
        ),
    )


@views_router.get("/lab", response_class=HTMLResponse)
async def lab(request: Request):
    session = session_from_cookie(request)
    if session is None or session.host_session_revoked:
        return RedirectResponse(url=public_url("/"), status_code=302)
    return templates.TemplateResponse(
        request=request,
        name="lab.html",
        context=template_context(
            request,
            page_config=looker_embed_page_config(),
            method_map=load_method_map(),
            user_name=session.display_name(),
            user_email=session.email(),
        ),
    )


@views_router.get("/sequence", response_class=HTMLResponse)
async def sequence(request: Request):
    session = session_from_cookie(request)
    mermaid_source = SEQUENCE_DIAGRAM_PATH.read_text(encoding="utf-8")
    return templates.TemplateResponse(
        request=request,
        name="sequence.html",
        context=template_context(
            request,
            mermaid_source=mermaid_source,
            mermaid_module_url=MERMAID_MODULE_URL,
            logged_in=session is not None and not session.host_session_revoked,
            user_name=session.display_name() if session else None,
            user_email=session.email() if session else None,
        ),
    )
