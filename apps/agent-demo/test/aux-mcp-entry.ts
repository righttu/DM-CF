import provider from "../src/mcp/index.js";

export default {
  fetch(request: Request, env: never, ctx: ExecutionContext): Promise<Response> {
    if (!request.headers.get("host")) {
      const headers = new Headers(request.headers);
      headers.set("host", new URL(request.url).host);
      request = new Request(request, { headers });
    }
    return (
      provider as {
        fetch: (r: Request, e: never, c: ExecutionContext) => Promise<Response>;
      }
    ).fetch(request, env, ctx);
  }
};
