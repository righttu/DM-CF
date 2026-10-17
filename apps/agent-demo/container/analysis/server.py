import collections
import io
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY_BYTES = 64 * 1024
LOG_RING_LINES = 400
LOG_TAIL_LINES = 80

sys.path.insert(0, "/app")
from Manual_Analyst_Engine_final import ManualAnalystEngine  # noqa: E402


def _json_safe(obj):
    try:
        import numpy as np
        if isinstance(obj, np.generic):
            return obj.item()
        if isinstance(obj, np.ndarray):
            return obj.tolist()
    except ImportError:
        pass
    if isinstance(obj, dict):
        return {str(k): _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return str(obj)


class _Tee(io.TextIOBase):
    """Mirrors writes into a bounded ring buffer (for log_tail) and real stdout."""

    def __init__(self, wrapped, ring, lock):
        self._wrapped = wrapped
        self._ring = ring
        self._lock = lock
        self._buf = ""

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        self._wrapped.write(s)
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            with self._lock:
                self._ring.append(line)
        return len(s)

    def flush(self):
        self._wrapped.flush()


class Job:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "idle"          # idle|running|succeeded|failed
        self.phase = None
        self.ts_code = None
        self.started_at = None
        self.finished_at = None
        self.result = None
        self.error = None
        self.log = collections.deque(maxlen=LOG_RING_LINES)
        self.log_lock = threading.Lock()
        self.thread = None

    def snapshot(self):
        with self.lock:
            return {
                "state": self.state,
                "phase": self.phase,
                "ts_code": self.ts_code,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "result": self.result,
                "error": self.error,
            }

    def log_tail(self, n=LOG_TAIL_LINES):
        with self.log_lock:
            return list(self.log)[-n:]

    def _phase_from(self, line):
        if "[Step 3/3]" in line or "AnalystBrain" in line:
            return "ai"
        if "[Step 2/3]" in line or "KnowledgeMiner" in line:
            return "knowledge"
        if "开始对" in line or "初始化手动诊断引擎" in line:
            return "chip"
        return None

    def _watch(self, tee_out, tee_err):
        """Update phase from new log lines."""
        seen = 0
        while self.state == "running":
            with self.log_lock:
                lines = list(self.log)
            for line in lines[seen:]:
                p = self._phase_from(line)
                if p:
                    with self.lock:
                        self.phase = p
            seen = len(lines)
            time.sleep(0.5)

    def start(self, ts_code):
        with self.lock:
            if self.state == "running":
                return self.snapshot()
            self.state = "running"
            self.phase = "chip"
            self.ts_code = ts_code
            self.started_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            self.finished_at = None
            self.result = None
            self.error = None
            with self.log_lock:
                self.log.clear()
        tee_out = _Tee(sys.__stdout__, self.log, self.log_lock)
        tee_err = _Tee(sys.__stderr__, self.log, self.log_lock)
        watcher = threading.Thread(target=self._watch, args=(tee_out, tee_err), daemon=True)
        self.thread = threading.Thread(target=self._run, args=(ts_code, tee_out, tee_err), daemon=True)
        watcher.start()
        self.thread.start()
        return self.snapshot()

    def _run(self, ts_code, tee_out, tee_err):
        out, err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = tee_out, tee_err
        try:
            engine = ManualAnalystEngine()
            res = engine.run_diagnostic(ts_code)
            ok = isinstance(res, dict) and res.get("success") is True
            with self.lock:
                self.result = _json_safe(res)
                self.state = "succeeded" if ok else "failed"
                if not ok:
                    self.error = str((res or {}).get("error") or (res or {}).get("msg") or "engine_error")[:500]
        except Exception as e:  # noqa: BLE001
            with self.lock:
                self.state = "failed"
                self.error = f"{type(e).__name__}: {e}"[:500]
        finally:
            sys.stdout, sys.stderr = out, err
            with self.lock:
                self.phase = "done" if self.state == "succeeded" else self.phase
                self.finished_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")


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
            snap = JOB.snapshot()
            snap["log_tail"] = JOB.log_tail()
            reply(self, 200, snap)
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
        ts_code = payload.get("ts_code") if isinstance(payload, dict) else None
        if not isinstance(ts_code, str) or not ts_code.strip() or len(ts_code) > 20:
            reply(self, 400, {"error": "invalid_ts_code"})
            return
        snap = JOB.start(ts_code.strip())
        reply(self, 200, snap)


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
