#!/bin/sh
# Same as `npm run dev` if you already have .venv and a JS bundle.
cd "$(dirname "$0")/.."
.venv/bin/python -m uvicorn web:app --app-dir app --reload --host localhost --port 3000
