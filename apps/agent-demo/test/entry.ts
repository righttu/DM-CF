import agentWorker, { ResearchAgent } from "../src/agent/index.js";
import mcpWorker, { ConsentTransaction } from "../src/mcp/index.js";
import quantWorker, { QuantEmbeddingContainer } from "../src/quant/index.js";

export { ResearchAgent, ConsentTransaction, QuantEmbeddingContainer };

const MCP_PATHS = ["/mcp", "/authorize", "/token", "/register", "/.well-known"];
const QUANT_PREFIX = "/quant";

export default {
  fetch(request: Request, env: never, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === QUANT_PREFIX || url.pathname.startsWith(`${QUANT_PREFIX}/`)) {
      const inner = new URL(request.url);
      inner.pathname = inner.pathname.slice(QUANT_PREFIX.length) || "/";
      return (quantWorker as { fetch: (r: Request, e: never, c: ExecutionContext) => Promise<Response> }).fetch(
        new Request(inner.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "manual"
        }),
        env,
        ctx
      );
    }
    const isMcp = MCP_PATHS.some(
      (p) => url.pathname === p || url.pathname.startsWith(`${p}/`)
    );
    if (isMcp) {
      return (mcpWorker as { fetch: (r: Request, e: never, c: ExecutionContext) => Promise<Response> }).fetch(request, env, ctx);
    }
    return (agentWorker as { fetch: (r: Request, e: never, c: ExecutionContext) => Promise<Response> }).fetch(request, env, ctx);
  }
};
