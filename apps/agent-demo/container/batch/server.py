import collections
import io
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY_BYTES = 16 * 1024
LOG_RING_LINES = 400
LOG_TAIL_LINES = 80

# Allowlisted script name -> file under /app. Nothing else can be run.
SCRIPTS = {
    "fundamentals": "fetch_full_basic_data_multipthre_final.py",
    "chip_hunter": "chip_hunter_db_final.py",
    "alpha_hunter": "alpha_hunter_db_final.py",
    "hotspot_registry": "hotspot_registry_final.py",
    "registry_auditor": "hotspot_registry_Auditor_final.py",
    "hotspot_hunter": "hotspot_hunter_final.py",
    "knowledge_miner": "knowledge_miner_final.py",
    "ai_brain": "ai_analyst_Brain_final.py",
}


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


class Job:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "idle"  # idle|running|finished
        self.script = None
        self.started_at = None
        self.finished_at = None
        self.exit_code = None
        self.log = collections.deque(maxlen=LOG_RING_LINES)
        self.proc = None

    def snapshot(self):
        with self.lock:
            tail = list(self.log)[-LOG_TAIL_LINES:]
            return {
                "state": self.state,
                "script": self.script,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "exit_code": self.exit_code,
                "log_tail": tail,
                "error_tail": tail if self.exit_code not in (None, 0) else [],
            }

    def start(self, script):
        with self.lock:
            if self.state == "running":
                return self.snapshot()
            self.state = "running"
            self.script = script
            self.started_at = _iso(time.time())
            self.finished_at = None
            self.exit_code = None
            self.log.clear()
            self.proc = subprocess.Popen(
                [sys.executable, f"/app/{SCRIPTS[script]}"],
                cwd="/app",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._wait, daemon=True).start()
        return self.snapshot()

    def _pump(self):
        try:
            for line in self.proc.stdout:
                line = line.rstrip("\n")
                with self.lock:
                    self.log.append(line)
                print(line, flush=True)
        except Exception as e:  # noqa: BLE001
            with self.lock:
                self.log.append(f"[log pump error] {e}")

    def _wait(self):
        code = self.proc.wait()
        with self.lock:
            self.exit_code = code
            self.state = "finished"
            self.finished_at = _iso(time.time())


JOB = Job()


def reply(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            reply(self, 200, {"ok": True})
            return
        if self.path == "/status":
            reply(self, 200, JOB.snapshot())
            return
        reply(self, 404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/run":
            reply(self, 404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            reply(self, 400, {"error": "bad_request"})
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            reply(self, 413, {"error": "body_too_large"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            reply(self, 400, {"error": "bad_json"})
            return
        script = payload.get("script") if isinstance(payload, dict) else None
        if not isinstance(script, str) or script not in SCRIPTS:
            reply(self, 400, {"error": "invalid_script"})
            return
        reply(self, 200, JOB.start(script))


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
