#!/usr/bin/env python3
"""Tiny static server for the GeoJSON viewer.

Serves the viewer UI at / and every *.geojson found under DATA_DIR at
/data/<relative path>.  /api/files returns the index the UI reads.

No dependencies beyond the Python standard library.
"""
import json
import os
import posixpath
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(HERE, "..", "..", "data"))
DATA_DIR = os.path.abspath(DATA_DIR)
PORT = int(os.environ.get("PORT", "8899"))


def index_files():
    out = []
    for root, dirs, files in os.walk(DATA_DIR):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
        for fn in files:
            if not fn.lower().endswith((".geojson", ".json")):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, DATA_DIR).replace(os.sep, "/")
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if fn.lower().endswith(".json"):
                # only include .json that actually looks like GeoJSON
                try:
                    with open(full, "rb") as fh:
                        head = fh.read(4096).decode("utf-8", "replace")
                    if "FeatureCollection" not in head and "\"features\"" not in head:
                        continue
                except OSError:
                    continue
            out.append({"path": rel, "size": size})
    out.sort(key=lambda x: x["path"])
    return out


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/files":
            return self._json(index_files())
        if path.startswith("/data/"):
            rel = posixpath.normpath(path[len("/data/"):])
            if rel.startswith("..") or rel.startswith("/"):
                return self._json({"error": "bad path"}, 400)
            full = os.path.join(DATA_DIR, rel)
            if not os.path.isfile(full):
                return self._json({"error": "not found"}, 404)
            with open(full, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/geo+json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # static assets: index.html and vendor/* only -- nothing else in this
        # directory is web-reachable (server.py included).
        rel = posixpath.normpath(path).lstrip("/")
        if rel in ("", ".", "index.html"):
            rel = "index.html"
        elif not rel.startswith("vendor/"):
            return self._json({"error": "not found"}, 404)
        full = os.path.join(HERE, rel)
        if not os.path.isfile(full):
            return self._json({"error": "not found"}, 404)
        self.path = "/" + rel
        return SimpleHTTPRequestHandler.do_GET(self)

    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        rel = posixpath.normpath(path).lstrip("/")
        return os.path.join(HERE, rel)


if __name__ == "__main__":
    print("GeoJSON viewer")
    print("  data dir : %s" % DATA_DIR)
    print("  files    : %d" % len(index_files()))
    print("  open     : http://localhost:%d/" % PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
