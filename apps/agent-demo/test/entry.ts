import agentWorker, { ResearchAgent } from "../src/agent/index.js";
import mcpWorker, { ConsentTransaction } from "../src/mcp/index.js";

export { ResearchAgent, ConsentTransaction };

const MCP_PATHS = ["/mcp", "/authorize", "/token", "/register", "/.well-known"];

export default {
  fetch(request: Request, env: never, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isMcp = MCP_PATHS.some(
      (p) => url.pathname === p || url.pathname.startsWith(`${p}/`)
    );
    if (isMcp) {
      return (mcpWorker as { fetch: (r: Request, e: never, c: ExecutionContext) => Promise<Response> }).fetch(request, env, ctx);
    }
    return (agentWorker as { fetch: (r: Request, e: never, c: ExecutionContext) => Promise<Response> }).fetch(request, env, ctx);
  }
};
