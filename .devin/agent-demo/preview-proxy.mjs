import http from "node:http";

const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = 8787;
const role = process.env.PREVIEW_ROLE === "viewer" ? "viewer" : "analyst";
const port = Number(process.env.PORT || 8790);

const server = http.createServer((req, res) => {
  const raw = req.url || "";
  if (!raw.startsWith("/") || raw.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("origin-form request target only");
    return;
  }
  const proxy = http.request(
    {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: raw,
      method: req.method,
      headers: {
        ...req.headers,
        host: "localhost:8787",
        "x-demo-local-role": role
      }
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  proxy.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`preview proxy error: ${String(err)}`);
  });
  req.pipe(proxy);
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `LOCAL preview proxy http://127.0.0.1:${port} -> http://${UPSTREAM_HOST}:${UPSTREAM_PORT} (simulated role=${role})`
  );
});
