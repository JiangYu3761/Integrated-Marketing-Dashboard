#!/usr/bin/env python3
"""Loopback-only server for the macOS app; no third-party dependencies."""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit

PROJECT = "JiangYu3761/Integrated-Marketing-Dashboard"
PORT = 18876  # Stable origin: changing this port would separate localStorage.
SITE_FILES = {
    "index.html": "text/html; charset=utf-8",
    "src/app.css": "text/css; charset=utf-8",
    "src/app.js": "application/javascript; charset=utf-8",
    "src/state.js": "application/javascript; charset=utf-8",
    "src/updates.js": "application/javascript; charset=utf-8",
}


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self.started = threading.Event()
        super().__init__(*args, **kwargs)

    def service_actions(self):
        self.started.set()


def read_site(site):
    return {name: (Path(site) / name).read_bytes() for name in SITE_FILES}


def site_version(files):
    digest = hashlib.sha256()
    for name in sorted(SITE_FILES):
        digest.update(name.encode("utf-8") + b"\0" + files[name] + b"\0")
    return digest.hexdigest()


def create_server(site, port=PORT):
    files = read_site(site)
    health = json.dumps({
        "project": PROJECT, "version": site_version(files), "pid": os.getpid(),
    }).encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.respond()

        def do_HEAD(self):
            self.respond(head=True)

        def respond(self, head=False):
            # Only the exact packaged assets are public. Never serve a checkout,
            # directory listing, configuration file, or arbitrary filesystem path.
            path = urlsplit(self.path).path
            if path == "/_desktop/health":
                body, mime = health, "application/json; charset=utf-8"
            elif path == "/favicon.ico":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            else:
                name = "index.html" if path == "/" else path.removeprefix("/")
                if name not in files:
                    self.send_error(404)
                    return
                body, mime = files[name], SITE_FILES[name]
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def log_message(self, *_args):
            pass  # No business data or browser requests in application logs.

    return LocalServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", type=Path, required=True)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args()
    with create_server(args.site, args.port) as server:
        if args.parent_pid is not None:
            def watch_parent():
                # Also exit if the app crashes or is force-quit. Never kill or
                # reuse another process to free the port.
                # shutdown() must follow serve_forever() initialization. A
                # ready event avoids a startup/shutdown race on newer Python.
                server.started.wait()
                while os.getppid() == args.parent_pid:
                    time.sleep(1)
                server.shutdown()

            threading.Thread(target=watch_parent, daemon=True).start()
        server.serve_forever(poll_interval=0.2)


if __name__ == "__main__":
    main()
