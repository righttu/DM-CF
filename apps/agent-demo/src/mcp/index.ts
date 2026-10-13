import OAuthProvider, {
  getOAuthApi,
  insufficientScope,
  type OAuthHelpers,
  type OAuthProviderOptions
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  authenticate,
  looksLikePlaceholder,
  resolveRole,
  sha256Hex,
  type AccessEnv
} from "../shared/access.js";
import { readBoundedText } from "../shared/body.js";
import {
  getLatestAnalysis,
  listDemoStocks,
  readResearchDocument,
  type DemoDb
} from "../shared/demo-tools.js";
import { DOCUMENT_IDS, STOCK_IDS, TOOL_DESCRIPTIONS } from "../research-policy.js";

interface McpEnv extends AccessEnv {
  DEMO_DB: D1Database;
  OAUTH_KV: KVNamespace;
  CONSENT_KV: KVNamespace;
  MCP_AUTHORIZE_ACCESS_AUD?: string;
  PUBLIC_MCP_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
}

const CONSENT_TTL_SECONDS = 600;
const DEMO_SCOPE = "mcp:read";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer"
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS }
  });
}

function originAllowed(request: Request, env: McpEnv): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const allowed = new Set<string>();
  for (const raw of [env.PUBLIC_MCP_ORIGIN, ...(env.ALLOWED_ORIGINS ?? "").split(",")]) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed || looksLikePlaceholder(trimmed)) continue;
    try {
      allowed.add(new URL(trimmed).origin);
    } catch {
    }
  }
  try {
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function providerOptions(env: McpEnv): OAuthProviderOptions<McpEnv> {
  const issuer = env.PUBLIC_MCP_ORIGIN ?? "";
  return {
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (request: Request, env: McpEnv, ctx: ExecutionContext) =>
        handleMcpApi(request, env, ctx)
    },
    defaultHandler: {
      fetch: (request: Request, env: McpEnv, ctx: ExecutionContext) =>
        handleDefault(request, env, ctx)
    },
    authorizeEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    clientRegistrationEndpoint: `${issuer}/register`,
    scopesSupported: [DEMO_SCOPE],
    requiredScopes: [DEMO_SCOPE],
    resourceMetadata: {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      resource_name: "demo-research-mcp"
    }
  };
}

function oauthApi(env: McpEnv): OAuthHelpers {
  return getOAuthApi(providerOptions(env), env);
}

async function handleDefault(
  request: Request,
  env: McpEnv,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/authorize") {
    if (request.method === "GET") return handleAuthorizeGet(request, env);
    if (request.method === "POST") return handleAuthorizePost(request, env);
    return new Response("Method Not Allowed", { status: 405 });
  }
  return jsonResponse({ error: "not_found" }, 404);
}

function consentPage(options: {
  handle: string;
  clientName: string;
  redirectHost: string;
  scopes: string[];
}): string {
  const clientName = escapeHtml(options.clientName);
  const redirectHost = escapeHtml(options.redirectHost);
  const scopes = options.scopes.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>授权确认</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;max-width:420px;width:90%}
h1{font-size:18px;margin:0 0 16px}
p{font-size:14px;line-height:1.6;color:#cbd5e1}
ul{background:#0f172a;border-radius:8px;padding:12px 12px 12px 28px;font-size:13px}
.actions{display:flex;gap:12px;margin-top:20px}
button{flex:1;padding:10px 0;border-radius:8px;border:none;font-size:14px;cursor:pointer}
.approve{background:#2563eb;color:#fff}
.deny{background:#334155;color:#cbd5e1}
</style>
</head>
<body>
<div class="card">
<h1>MCP 访问授权（演示环境）</h1>
<p>应用 <strong>${clientName}</strong> 请求访问隔离的模拟研究数据。</p>
<p>令牌将发送到：<strong>${redirectHost}</strong></p>
<p>请求的权限范围：</p>
<ul>${scopes}</ul>
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(options.handle)}">
<div class="actions">
<button class="approve" name="decision" value="approve" type="submit">授权</button>
<button class="deny" name="decision" value="deny" type="submit">拒绝</button>
</div>
</form>
</div>
</body>
</html>`;
}

async function handleAuthorizeGet(request: Request, env: McpEnv): Promise<Response> {
  const identity = await authenticate(request, env, env.MCP_AUTHORIZE_ACCESS_AUD);
  if (!identity) {
    return jsonResponse({ error: "access_denied", message: "未通过身份验证" }, 401);
  }
  const api = oauthApi(env);
  let authRequest;
  try {
    authRequest = await api.parseAuthRequest(request);
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  const description = await api.describeConsent(authRequest);
  const transaction = await api.beginConsent(authRequest);
  const handleKey = `consent:${await sha256Hex(transaction.handle)}`;
  await env.CONSENT_KV.put(handleKey, identity.sub, {
    expirationTtl: CONSENT_TTL_SECONDS
  });
  const headers = new Headers(transaction.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("content-security-policy", "frame-ancestors 'none'");
  return new Response(
    consentPage({
      handle: transaction.handle,
      clientName: description.clientName,
      redirectHost: description.redirectHost,
      scopes: description.scope
    }),
    { headers }
  );
}

async function handleAuthorizePost(request: Request, env: McpEnv): Promise<Response> {
  if (!originAllowed(request, env)) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }
  const identity = await authenticate(request, env, env.MCP_AUTHORIZE_ACCESS_AUD);
  if (!identity) {
    return jsonResponse({ error: "access_denied", message: "未通过身份验证" }, 401);
  }
  const contentType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return jsonResponse({ error: "unsupported_media_type" }, 415);
  }
  const bounded = await readBoundedText(request);
  if (bounded.status !== 200) {
    return jsonResponse({ error: "body_too_large" }, 413);
  }
  const form = new URLSearchParams(bounded.text);
  const handle = form.get("handle");
  const decision = form.get("decision");
  if (typeof handle !== "string" || handle.length === 0) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  if (decision !== "approve" && decision !== "deny") {
    return jsonResponse({ error: "invalid_decision" }, 400);
  }
  const api = oauthApi(env);
  const handleKey = `consent:${await sha256Hex(handle)}`;
  const boundSubject = await env.CONSENT_KV.get(handleKey);
  if (boundSubject === null || boundSubject !== identity.sub) {
    return jsonResponse({ error: "consent_subject_mismatch" }, 403);
  }
  await env.CONSENT_KV.delete(handleKey);
  if (decision === "deny") {
    const denied = await api.denyConsent(request, handle, {
      description: "User denied the request"
    });
    return new Response(null, {
      status: 302,
      headers: mergeHeaders({ location: denied.redirectTo }, denied.headers)
    });
  }
  let approved;
  try {
    approved = await api.approveConsent(request, handle, { scope: [DEMO_SCOPE] });
  } catch {
    return jsonResponse({ error: "consent_invalid_or_used" }, 403);
  }
  let redirectTo: string;
  try {
    ({ redirectTo } = await api.completeAuthorization({
      request: approved.request,
      userId: encodeURIComponent(identity.sub),
      scope: [DEMO_SCOPE],
      props: { sub: identity.sub, email: identity.email },
      metadata: { demo: true }
    }));
  } catch {
    return jsonResponse({ error: "authorization_failed" }, 400);
  }
  return new Response(null, {
    status: 302,
    headers: mergeHeaders({ location: redirectTo }, approved.headers)
  });
}

function mergeHeaders(
  extra: Record<string, string>,
  base: Headers
): Headers {
  const headers = new Headers(base);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

function buildMcpServer(env: McpEnv, email: string): McpServer {
  const db: DemoDb = env.DEMO_DB;
  const server = new McpServer({
    name: "demo-research-mcp",
    version: "0.1.0"
  });

  const text = (value: unknown) =>
    ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

  server.registerTool(
    "list_demo_stocks",
    {
      description: TOOL_DESCRIPTIONS.list_demo_stocks,
      inputSchema: z.object({})
    },
    async () => {
      if (!resolveRole(env, email)) {
        return { isError: true, ...text({ error: "permission_denied" }) };
      }
      return text(await listDemoStocks(db));
    }
  );

  server.registerTool(
    "get_latest_analysis",
    {
      description: TOOL_DESCRIPTIONS.get_latest_analysis,
      inputSchema: z.object({ stock_id: z.enum(STOCK_IDS) })
    },
    async ({ stock_id }) => {
      if (!resolveRole(env, email)) {
        return { isError: true, ...text({ error: "permission_denied" }) };
      }
      return text(await getLatestAnalysis(db, stock_id));
    }
  );

  if (resolveRole(env, email) === "analyst") {
    server.registerTool(
      "read_research_document",
      {
        description: TOOL_DESCRIPTIONS.read_research_document,
        inputSchema: z.object({ document_id: z.enum(DOCUMENT_IDS) })
      },
      async ({ document_id }) => {
        if (resolveRole(env, email) !== "analyst") {
          return { isError: true, ...text({ error: "permission_denied" }) };
        }
        return text(await readResearchDocument(db, document_id));
      }
    );
  }

  return server;
}

export interface McpAuthShape {
  token: string;
  clientId: string;
  scope: string[];
  expiresAt: number;
  userId: string;
  audience?: string | string[];
}

export function checkMcpScope(auth: McpAuthShape | undefined): Response | null {
  if (!auth) {
    return jsonResponse({ error: "invalid_token" }, 401);
  }
  if (!Array.isArray(auth.scope) || !auth.scope.includes(DEMO_SCOPE)) {
    return insufficientScope(auth as never, [DEMO_SCOPE]);
  }
  return null;
}

async function handleMcpApi(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const auth = (ctx as unknown as { auth?: McpAuthShape }).auth;
  const props = (ctx as unknown as { props?: { sub?: string; email?: string } }).props;
  const scopeFailure = checkMcpScope(auth);
  if (!auth || scopeFailure) return scopeFailure ?? jsonResponse({ error: "invalid_token" }, 401);
  if (!originAllowed(request, env)) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }
  const email = typeof props?.email === "string" ? props.email : "";
  if (!resolveRole(env, email)) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  const allowedOriginHostnames = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .map((o) => {
      try {
        return new URL(o).hostname;
      } catch {
        return null;
      }
    })
    .filter((h): h is string => h !== null);
  const allowedHostnames: string[] = [];
  if (env.PUBLIC_MCP_ORIGIN) {
    try {
      allowedHostnames.push(new URL(env.PUBLIC_MCP_ORIGIN).hostname);
    } catch {
    }
  }
  const handler = createMcpHandler(
    (mcpCtx) =>
      buildMcpServer(
        env,
        typeof mcpCtx.authInfo?.extra?.email === "string"
          ? mcpCtx.authInfo.extra.email
          : email
      ),
    {
      route: "/mcp",
      allowedHostnames,
      allowedOriginHostnames,
      corsOptions: false
    }
  );
  return handler.fetch(request, {
    authInfo: {
      token: auth.token,
      clientId: auth.clientId,
      scopes: auth.scope,
      expiresAt: auth.expiresAt,
      extra: { sub: props?.sub ?? auth.userId, email }
    }
  });
}

const provider = {
  fetch(request: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response> {
    const canonical = env.PUBLIC_MCP_ORIGIN ?? "";
    if (!canonical || looksLikePlaceholder(canonical)) {
      return Promise.resolve(jsonResponse({ error: "mcp_misconfigured" }, 503));
    }
    try {
      if (new URL(request.url).origin !== new URL(canonical).origin) {
        return Promise.resolve(jsonResponse({ error: "host_not_allowed" }, 403));
      }
    } catch {
      return Promise.resolve(jsonResponse({ error: "mcp_misconfigured" }, 503));
    }
    return new OAuthProvider(providerOptions(env)).fetch(request, env, ctx);
  }
};

export default provider;
