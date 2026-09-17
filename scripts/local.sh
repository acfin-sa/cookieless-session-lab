#!/bin/sh
# Uvicorn only. Does not create .venv, install deps, or bundle JS.
# Prefer `npm run dev` unless the venv and `npm run build:js` output already exist.
cd "$(dirname "$0")/.."
.venv/bin/python -m uvicorn web:app --app-dir app --reload --host localhost --port 3000
