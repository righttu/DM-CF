import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sentence_transformers import SentenceTransformer

MODEL_NAME = "bge-small-zh-v1.5"
MAX_BODY_BYTES = 256 * 1024
MAX_TEXTS = 32
MAX_TEXT_CHARS = 2000

model = SentenceTransformer("/model", device="cpu")
DIM = int(model.get_sentence_embedding_dimension())


def reply(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
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
            reply(self, 200, {"ok": True, "model": MODEL_NAME, "dim": DIM})
        else:
            reply(self, 404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/embed":
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
        texts = payload.get("texts") if isinstance(payload, dict) else None
        if (
            not isinstance(texts, list)
            or not 1 <= len(texts) <= MAX_TEXTS
            or not all(isinstance(t, str) and 0 < len(t) <= MAX_TEXT_CHARS for t in texts)
        ):
            reply(self, 400, {"error": "invalid_texts"})
            return
        vectors = model.encode(texts, normalize_embeddings=True).tolist()
        reply(self, 200, {"vectors": vectors, "dim": DIM, "model": MODEL_NAME})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
