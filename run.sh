#!/usr/bin/env bash
# Fish Audio Drama 3 Studio launcher
set -e
cd "$(dirname "$0")"
PY="./.venv/Scripts/python.exe"
[ -x "$PY" ] || PY="./.venv/bin/python"
[ -x "$PY" ] || { echo "No venv found. Run: python -m venv .venv && ./.venv/Scripts/pip install fastapi 'uvicorn[standard]' httpx python-multipart msgpack"; exit 1; }
echo "Fish Audio Drama 3 Studio -> http://127.0.0.1:8756"
exec "$PY" -m uvicorn server.main:app --host 127.0.0.1 --port 8756 "$@"
