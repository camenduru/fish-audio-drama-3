"""
Wire-level probe: a fake 'api.fish.audio' that records the `model` header the
studio actually sends upstream, then returns a tiny valid-ish audio body.

Run alongside the app with FISH_API_BASE=http://127.0.0.1:8758
"""
from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOG = Path(__file__).resolve().parent.parent / "data" / "echo_log.jsonl"
PORT = 8758

# Minimal MP3 frame header so the frontend accepts the body as audio.
FAKE_MP3 = b"\xff\xfb\x90\x64" + b"\x00" * 400


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _record(self, body: bytes) -> None:
        entry = {
            "method": self.command,
            "path": self.path,
            "model_header": self.headers.get("model"),
            "content_type": self.headers.get("content-type"),
            "body_len": len(body),
            "body_head": body[:300].decode("utf-8", "replace"),
        }
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    def _respond(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        self._record(body)

        if self.path.endswith("/with-timestamp"):
            payload = b'{"type":"audio","audio":""}\n'
            ctype = "application/x-ndjson"
        elif self.path.endswith("/agents"):
            payload = b'{"agents":[],"has_more":false}'
            ctype = "application/json"
        else:
            payload = FAKE_MP3
            ctype = "audio/mpeg"

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _respond

    def log_message(self, *args):  # keep the console quiet
        pass


if __name__ == "__main__":
    LOG.parent.mkdir(exist_ok=True)
    LOG.write_text("", encoding="utf-8")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"echo upstream on http://127.0.0.1:{PORT} -> {LOG}", file=sys.stderr, flush=True)
    srv.serve_forever()
