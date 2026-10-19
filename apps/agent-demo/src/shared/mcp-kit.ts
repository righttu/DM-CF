import { DurableObject } from "cloudflare:workers";
import OAuthProvider, {
  getOAuthApi,
  insufficientScope,
  type OAuthHelpers,
  type OAuthProviderOptions
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import {
  authenticate,
  looksLikePlaceholder,
  resolveRole,
  sha256Hex,
  type AccessEnv,
  type DemoRole
} from "./access.js";
import { readBoundedText } from "./body.js";
import { recordAudit, sanitizeArgs, truncateSql, type AuditEvent } from "./audit.js";

export interface McpKitEnv extends AccessEnv {
  OAUTH_KV: KVNamespace;
  CONSENT_TRANSACTIONS: DurableObjectNamespace<ConsentTransaction>;
  MCP_AUTHORIZE_ACCESS_AUD?: string;
  PUBLIC_MCP_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
  AUDIT_DB?: D1Database;
  AUDIT_SERVICE_NAME?: string;
  AUDIT_D1_NAME?: string;
  AUDIT_VECTORIZE_NAME?: string;
  AUDIT_R2_NAME?: string;
}

export interface McpPrincipal {
  actorId: string;
  role: DemoRole;
}

export type ToolTextResult = {
  isError?: boolean;
  content: { type: "text"; text: string }[];
};

export type ToolAccessAudit = {
  access(ev: {
    tables: string[];
    sql?: string;
    rowCount?: number;
    status: string;
    reason?: string;
    // which store this access touched — decides the audit `target` label
    store?: "d1" | "vectorize" | "r2";
  }): void;
  job(id: string): void;
};

export type ToolCall = (
  toolName: string,
  ctx: unknown,
  run: (audit: ToolAccessAudit) => Promise<ToolTextResult>,
  details?: { args?: unknown }
) => Promise<ToolTextResult & { _meta?: Record<string, unknown> }>;

export interface McpKitConfig<E extends McpKitEnv> {
  serverName: string;
  serverVersion: string;
  auditServer: "research" | "abc-quant";
  consent: { title: string; resourceDescription: string };
  allowedRoles: readonly DemoRole[];
  registerTools(
    server: McpServer,
    ctx: {
      env: E;
      email: string;
      role: DemoRole | null;
      principal: McpPrincipal;
      call: ToolCall;
    }
  ): void;
}

const CONSENT_TTL_SECONDS = 600;
const DEMO_SCOPE = "mcp:read";
const MAX_HANDLE_LENGTH = 256;
const TXN_KEY = /^transaction:([a-f0-9]{64})$/;
const TXN_STORAGE_KEYS = ["blob", "expiresAt", "identity", "consumed", "resourceName"];

interface ConsentIdentity {
  sub: string;
  issuer: string;
  audience: string;
}

interface LocalConsentTxn {
  hash: string;
  storage: DurableObjectStorage;
}

async function txnGet(
  env: McpKitEnv,
  local: LocalConsentTxn | undefined,
  hash: string
): Promise<string | null> {
  if (local) {
    if (hash !== local.hash) return null;
    const blob = await local.storage.get<string>("blob");
    const expiresAt = await local.storage.get<number>("expiresAt");
    if (typeof blob !== "string" || typeof expiresAt !== "number") return null;
    return expiresAt > Date.now() ? blob : null;
  }
  return env.CONSENT_TRANSACTIONS.get(env.CONSENT_TRANSACTIONS.idFromName(hash)).readEncrypted();
}

async function txnPut(
  env: McpKitEnv,
  local: LocalConsentTxn | undefined,
  hash: string,
  value: string,
  options?: { expirationTtl?: number }
): Promise<void> {
  if (options?.expirationTtl !== CONSENT_TTL_SECONDS) {
    throw new Error("consent_txn_ttl");
  }
  if (local) {
    if (hash !== local.hash) throw new Error("consent_txn_wrong_owner");
    await local.storage.put({ blob: value, expiresAt: Date.now() + CONSENT_TTL_SECONDS * 1000 });
    return;
  }
  await env.CONSENT_TRANSACTIONS.get(env.CONSENT_TRANSACTIONS.idFromName(hash)).writeEncrypted(
    value,
    CONSENT_TTL_SECONDS
  );
}

async function txnDelete(
  env: McpKitEnv,
  local: LocalConsentTxn | undefined,
  hash: string
): Promise<void> {
  if (local) {
    if (hash !== local.hash) return;
    await local.storage.delete("blob");
    await local.storage.put("consumed", true);
    return;
  }
  await env.CONSENT_TRANSACTIONS.get(env.CONSENT_TRANSACTIONS.idFromName(hash)).deleteEncrypted();
}

function consentOAuthEnv<E extends McpKitEnv>(env: E, local?: LocalConsentTxn): E {
  const kv = env.OAUTH_KV;
  const proxied = new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return (key: string, options?: unknown) => {
          const m = TXN_KEY.exec(key);
          return m ? txnGet(env, local, m[1]) : target.get(key, options as never);
        };
      }
      if (prop === "put") {
        return (key: string, value: string, options?: unknown) => {
          const m = TXN_KEY.exec(key);
          return m
            ? txnPut(env, local, m[1], value, options as { expirationTtl?: number })
            : target.put(key, value, options as never);
        };
      }
      if (prop === "delete") {
        return (key: string) => {
          const m = TXN_KEY.exec(key);
          return m ? txnDelete(env, local, m[1]) : target.delete(key);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { ...env, OAUTH_KV: proxied as KVNamespace };
}

export class ConsentTransaction extends DurableObject<McpKitEnv> {
  async writeEncrypted(value: string, expirationTtl: number): Promise<void> {
    if (expirationTtl !== CONSENT_TTL_SECONDS) throw new Error("consent_txn_ttl");
    if ((await this.ctx.storage.get<boolean>("consumed")) === true) {
      throw new Error("consent_txn_consumed");
    }
    const expiresAt = Date.now() + expirationTtl * 1000;
    await this.ctx.storage.put({ blob: value, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt);
  }

  async readEncrypted(): Promise<string | null> {
    const blob = await this.ctx.storage.get<string>("blob");
    const expiresAt = await this.ctx.storage.get<number>("expiresAt");
    if (typeof blob !== "string" || typeof expiresAt !== "number") return null;
    return expiresAt > Date.now() ? blob : null;
  }

  async deleteEncrypted(): Promise<void> {
    await this.ctx.storage.delete("blob");
    await this.ctx.storage.put("consumed", true);
  }

  async bindIdentity(identity: ConsentIdentity, resourceName = "mcp"): Promise<void> {
    if (
      !identity ||
      typeof identity.sub !== "string" ||
      typeof identity.issuer !== "string" ||
      typeof identity.audience !== "string"
    ) {
      throw new Error("consent_txn_identity");
    }
    if ((await this.readEncrypted()) === null) throw new Error("consent_txn_expired");
    if ((await this.ctx.storage.get("identity")) !== undefined) {
      throw new Error("consent_txn_bound");
    }
    await this.ctx.storage.put("identity", {
      sub: identity.sub,
      issuer: identity.issuer,
      audience: identity.audience
    });
    await this.ctx.storage.put("resourceName", resourceName);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.delete(TXN_STORAGE_KEYS);
  }

  async fetch(request: Request): Promise<Response> {
    const env = this.env;
    const url = new URL(request.url);
    if (url.pathname !== "/authorize" || request.method !== "POST") {
      return jsonResponse({ error: "not_found" }, 404);
    }
    const canonical = env.PUBLIC_MCP_ORIGIN ?? "";
    try {
      if (new URL(request.url).origin !== new URL(canonical).origin) {
        return jsonResponse({ error: "host_not_allowed" }, 403);
      }
    } catch {
      return jsonResponse({ error: "host_not_allowed" }, 403);
    }
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
    if (
      typeof handle !== "string" ||
      handle.length === 0 ||
      handle.length > MAX_HANDLE_LENGTH
    ) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    if (decision !== "approve" && decision !== "deny") {
      return jsonResponse({ error: "invalid_decision" }, 400);
    }
    const hash = await sha256Hex(handle);
    if (
      env.CONSENT_TRANSACTIONS.idFromName(hash).toString() !== this.ctx.id.toString()
    ) {
      return jsonResponse({ error: "consent_expired_or_used" }, 403);
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const consumed = await this.ctx.storage.get<boolean>("consumed");
      const blob = await this.readEncrypted();
      const bound = await this.ctx.storage.get<ConsentIdentity>("identity");
      if (consumed === true || blob === null || !bound) {
        return jsonResponse({ error: "consent_expired_or_used" }, 403);
      }
      if (
        bound.sub !== identity.sub ||
        bound.issuer !== (env.TEAM_DOMAIN ?? "") ||
        bound.audience !== (env.MCP_AUTHORIZE_ACCESS_AUD ?? "")
      ) {
        return jsonResponse({ error: "consent_subject_mismatch" }, 403);
      }
      const resourceName =
        (await this.ctx.storage.get<string>("resourceName")) ?? "mcp";
      const localApi = getOAuthApi(
        providerOptions(env, {
          serverName: resourceName,
          serverVersion: "",
          auditServer: "research",
          consent: { title: "", resourceDescription: "" },
          allowedRoles: [],
          registerTools() {}
        }),
        consentOAuthEnv(env, { hash, storage: this.ctx.storage })
      );
      if (decision === "deny") {
        try {
          const denied = await localApi.denyConsent(request, handle, {
            description: "User denied the request"
          });
          return new Response(null, {
            status: 302,
            headers: mergeHeaders({ location: denied.redirectTo }, denied.headers)
          });
        } catch {
          return jsonResponse({ error: "consent_invalid_or_used" }, 403);
        }
      }
      let approved;
      try {
        approved = await localApi.approveConsent(request, handle, { scope: [DEMO_SCOPE] });
      } catch {
        return jsonResponse({ error: "consent_invalid_or_used" }, 403);
      }
      let redirectTo: string;
      try {
                ({ redirectTo } = await oauthApi(env, {
          serverName: resourceName,
          serverVersion: "",
          auditServer: "research",
          consent: { title: "", resourceDescription: "" },
          allowedRoles: [],
          registerTools() {}
        }).completeAuthorization({
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
    });
  }
}

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

function originAllowed(request: Request, env: McpKitEnv): boolean {
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

function providerOptions<E extends McpKitEnv>(
  env: E,
  config: McpKitConfig<E>
): OAuthProviderOptions<E> {
  const issuer = env.PUBLIC_MCP_ORIGIN ?? "";
  return {
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (request: Request, env: E, ctx: ExecutionContext) =>
        handleMcpApi(request, env, ctx, config)
    },
    defaultHandler: {
      fetch: (request: Request, env: E, ctx: ExecutionContext) =>
        handleDefault(request, env, ctx, config)
    },
    authorizeEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    clientRegistrationEndpoint: `${issuer}/register`,
    scopesSupported: [DEMO_SCOPE],
    requiredScopes: [DEMO_SCOPE],
    resourceMetadata: {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      resource_name: config.serverName
    }
  };
}

function oauthApi<E extends McpKitEnv>(env: E, config: McpKitConfig<E>): OAuthHelpers {
  return getOAuthApi(providerOptions(env, config), env);
}


async function handleDefault<E extends McpKitEnv>(
  request: Request,
  env: E,
  _ctx: ExecutionContext,
  config: McpKitConfig<E>
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/authorize") {
    if (request.method === "GET") return handleAuthorizeGet(request, env, config);
    if (request.method === "POST") return handleAuthorizePost(request, env, config);
    return new Response("Method Not Allowed", { status: 405 });
  }
  return jsonResponse({ error: "not_found" }, 404);
}

function consentPage(options: {
  title: string;
  resourceDescription: string;
  handle: string;
  clientName: string;
  redirectHost: string;
  scopes: string[];
  email: string;
  role: DemoRole;
}): string {
  const title = escapeHtml(options.title);
  const clientName = escapeHtml(options.clientName);
  const redirectHost = escapeHtml(options.redirectHost);
  const email = escapeHtml(options.email);
  const role = escapeHtml(options.role);
  const scopes = options.scopes
    .map((s) => (s === "mcp:read" ? "只读（mcp:read）" : escapeHtml(s)))
    .join("、");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;max-width:420px;width:90%}
h1{font-size:18px;margin:0}
.brand{display:flex;align-items:center;gap:12px;margin:0 0 16px}
.logo{width:44px;height:44px;min-width:44px;border-radius:50%;background:#1d4ed8;color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center}
p{font-size:14px;line-height:1.6;color:#cbd5e1}
.actions{display:flex;gap:12px;margin-top:20px}
button{flex:1;padding:10px 0;border-radius:8px;border:none;font-size:14px;cursor:pointer}
.approve{background:#2563eb;color:#fff}
.deny{background:#334155;color:#cbd5e1}
</style>
</head>
<body>
<div class="card">
<div class="brand"><div class="logo">ABC</div><h1>${title}</h1></div>
<p>应用 <strong>${clientName}</strong> ${escapeHtml(options.resourceDescription)}</p>
<p>授权账号：<strong>${email}</strong>（角色：${role}）</p>
<p>权限：${scopes}</p>
<p>授权结果返回给：<strong>${redirectHost}</strong>，由 ${clientName} 换取访问令牌，之后只用于访问本服务。</p>
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

async function handleAuthorizeGet<E extends McpKitEnv>(
  request: Request,
  env: E,
  config: McpKitConfig<E>
): Promise<Response> {
  const identity = await authenticate(request, env, env.MCP_AUTHORIZE_ACCESS_AUD);
  if (!identity) {
    return jsonResponse({ error: "access_denied", message: "未通过身份验证" }, 401);
  }
  if (!config.allowedRoles.includes(identity.role)) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  if (!env.CONSENT_TRANSACTIONS) {
    return jsonResponse({ error: "mcp_misconfigured" }, 503);
  }
  const api = getOAuthApi(providerOptions(env, config), consentOAuthEnv(env));
  let authRequest;
  try {
    authRequest = await api.parseAuthRequest(request);
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  const description = await api.describeConsent(authRequest);
  const transaction = await api.beginConsent(authRequest);
  const hash = await sha256Hex(transaction.handle);
  await env.CONSENT_TRANSACTIONS.get(env.CONSENT_TRANSACTIONS.idFromName(hash)).bindIdentity(
    {
      sub: identity.sub,
      issuer: env.TEAM_DOMAIN ?? "",
      audience: env.MCP_AUTHORIZE_ACCESS_AUD ?? ""
    },
    config.serverName
  );
  const headers = new Headers(transaction.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("referrer-policy", "same-origin");
  headers.set("content-security-policy", "frame-ancestors 'none'");
  return new Response(
    consentPage({
      title: config.consent.title,
      resourceDescription: config.consent.resourceDescription,
      handle: transaction.handle,
      clientName: description.clientName,
      redirectHost: description.redirectHost,
      scopes: description.scope,
      email: identity.email,
      role: identity.role
    }),
    { headers }
  );
}

async function handleAuthorizePost<E extends McpKitEnv>(
  request: Request,
  env: E,
  config: McpKitConfig<E>
): Promise<Response> {
  if (!originAllowed(request, env)) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }
  const identity = await authenticate(request, env, env.MCP_AUTHORIZE_ACCESS_AUD);
  if (!identity) {
    return jsonResponse({ error: "access_denied", message: "未通过身份验证" }, 401);
  }
  if (!config.allowedRoles.includes(identity.role)) {
    return jsonResponse({ error: "forbidden" }, 403);
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
  if (
    typeof handle !== "string" ||
    handle.length === 0 ||
    handle.length > MAX_HANDLE_LENGTH
  ) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  if (decision !== "approve" && decision !== "deny") {
    return jsonResponse({ error: "invalid_decision" }, 400);
  }
  if (!env.CONSENT_TRANSACTIONS) {
    return jsonResponse({ error: "mcp_misconfigured" }, 503);
  }
  const hash = await sha256Hex(handle);
  const stub = env.CONSENT_TRANSACTIONS.get(env.CONSENT_TRANSACTIONS.idFromName(hash));
  return stub.fetch(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: bounded.text,
      redirect: "manual"
    })
  );
}

function mergeHeaders(extra: Record<string, string>, base: Headers): Headers {
  const headers = new Headers(base);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

const AUDIT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function metaUuid(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== "object") return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && AUDIT_UUID_PATTERN.test(value) ? value : null;
}

// Reserved argument the Agent injects on behalf of a chat/poll tool call.
// The Portal drops _meta but forwards arguments verbatim, so this is the
// primary correlation channel; it is stripped here before the tool handler
// and before args are recorded, and never appears in the published schema
// (input schemas are loose objects, not an "_audit" property).
function extractAuditArg(args: unknown): {
  callId: string | null;
  requestId: string | null;
  conversationId: string | null;
} | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  if (!("_audit" in record)) return null;
  const raw = record._audit;
  delete record._audit;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const uuid = (v: unknown): string | null =>
    typeof v === "string" && AUDIT_UUID_PATTERN.test(v) ? v : null;
  return {
    callId: uuid(r.call_id),
    requestId: uuid(r.request_id),
    conversationId: uuid(r.conversation_id)
  };
}

function auditIds(
  meta: unknown,
  argIds?: ReturnType<typeof extractAuditArg>
): {
  requestId: string;
  conversationId: string | null;
  callId: string | null;
  correlationSource: "client_meta" | "server_generated";
} {
  const requestId =
    argIds?.requestId ?? metaUuid(meta, "uk.righttu.demo/request_id");
  return {
    requestId: requestId ?? crypto.randomUUID(),
    conversationId:
      argIds?.conversationId ??
      metaUuid(meta, "uk.righttu.demo/conversation_id"),
    callId: argIds?.callId ?? null,
    correlationSource: requestId ? "client_meta" : "server_generated"
  };
}

function mcpToolAudit(
  principal: McpPrincipal,
  tool: string,
  status: string,
  ids: ReturnType<typeof auditIds>
): void {
  console.info(
    JSON.stringify({
      event: "mcp_tool_audit",
      action: "tools/call",
      tool,
      status,
      actorId: principal.actorId,
      role: principal.role,
      requestId: ids.requestId,
      conversationId: ids.conversationId,
      correlationSource: ids.correlationSource
    })
  );
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

async function handleMcpApi<E extends McpKitEnv>(
  request: Request,
  env: E,
  ctx: ExecutionContext,
  config: McpKitConfig<E>
): Promise<Response> {
  const auth = (ctx as unknown as { auth?: McpAuthShape }).auth;
  const props = (ctx as unknown as { props?: { sub?: string; email?: string } }).props;
  const scopeFailure = checkMcpScope(auth);
  if (!auth || scopeFailure) return scopeFailure ?? jsonResponse({ error: "invalid_token" }, 401);
  if (!originAllowed(request, env)) {
    return jsonResponse({ error: "origin_not_allowed" }, 403);
  }
  const email = typeof props?.email === "string" ? props.email : "";
  const role = resolveRole(env, email);
  if (!role || !config.allowedRoles.includes(role)) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  const principal: McpPrincipal = {
    actorId: await sha256Hex(
      typeof props?.sub === "string" && props.sub.length > 0 ? props.sub : auth.userId
    ),
    role
  };
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
  const call: ToolCall = async (toolName, callCtx, run, details) => {
    const meta = (callCtx as { mcpReq?: { _meta?: unknown } } | undefined)?.mcpReq?._meta;
    // Strip _audit first: handlers and args_json must never see it.
    const ids = auditIds(meta, extractAuditArg(details?.args));
    const accesses: AuditEvent[] = [];
    let jobId: string | null = null;
    const mcpActor = env.AUDIT_SERVICE_NAME
      ? `mcp-server:${env.AUDIT_SERVICE_NAME}`
      : null;
    const storeTarget = (e: { store?: "d1" | "vectorize" | "r2" }): string | null => {
      const name =
        e.store === "d1"
          ? env.AUDIT_D1_NAME
          : e.store === "vectorize"
            ? env.AUDIT_VECTORIZE_NAME
            : e.store === "r2"
              ? env.AUDIT_R2_NAME
              : null;
      return e.store && name ? `${e.store}:${name}` : null;
    };
    const audit: ToolAccessAudit = {
      access: (e) =>
        accesses.push({
          source: config.auditServer === "research" ? "mcp-research" : "mcp-quant",
          event: "data_access",
          user_email: email || null,
          actor_id: principal.actorId,
          role: principal.role,
          conversation_id:
            ids.correlationSource === "client_meta" ? ids.conversationId : null,
          request_id: ids.correlationSource === "client_meta" ? ids.requestId : null,
          server: config.auditServer,
          tool: toolName,
          tables: e.tables.join(","),
          sql_text: e.sql ? truncateSql(e.sql) : null,
          row_count: e.rowCount ?? null,
          status: e.status,
          reason: e.reason ?? null,
          call_id: ids.callId,
          actor: mcpActor,
          target: storeTarget(e)
        }),
      job: (id) => {
        jobId = id;
      }
    };
    const started = Date.now();
    const toolRow = (status: string, reason?: string | null): AuditEvent => ({
      source: config.auditServer === "research" ? "mcp-research" : "mcp-quant",
      event: "tool_call",
      user_email: email || null,
      actor_id: principal.actorId,
      role: principal.role,
      conversation_id:
        ids.correlationSource === "client_meta" ? ids.conversationId : null,
      request_id: ids.correlationSource === "client_meta" ? ids.requestId : null,
      server: config.auditServer,
      tool: toolName,
      args_json: sanitizeArgs(details?.args),
      status,
      reason: reason ?? null,
      duration_ms: Date.now() - started,
      job_id: jobId,
      call_id: ids.callId,
      actor: mcpActor,
      target: null
    });
    const flush = (rows: AuditEvent[]) => {
      ctx.waitUntil(recordAudit(env.AUDIT_DB, rows));
    };
    const errorReason = (result: ToolTextResult): string | null => {
      try {
        const body = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
        const r = body.reason ?? body.error;
        return typeof r === "string" ? r.slice(0, 200) : null;
      } catch {
        return null;
      }
    };
    try {
      const result = await run(audit);
      const status = result.isError ? "denied" : "ok";
      flush([toolRow(status, status === "denied" ? errorReason(result) : null), ...accesses]);
      mcpToolAudit(principal, toolName, status, ids);
      return {
        ...result,
        _meta: {
          "uk.righttu.demo/audit": {
            actorId: principal.actorId,
            role: principal.role,
            requestId: ids.requestId,
            conversationId: ids.conversationId
          }
        }
      };
    } catch (error) {
      flush([toolRow("error"), ...accesses]);
      mcpToolAudit(principal, toolName, "error", ids);
      throw error;
    }
  };
  const handler = createMcpHandler(
    (mcpCtx) => {
      const server = new McpServer({
        name: config.serverName,
        version: config.serverVersion
      });
      const effectiveEmail =
        typeof mcpCtx.authInfo?.extra?.email === "string"
          ? mcpCtx.authInfo.extra.email
          : email;
      config.registerTools(server, {
        env,
        email: effectiveEmail,
        role: resolveRole(env, effectiveEmail),
        principal,
        call
      });
      return server;
    },
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

export function createMcpWorker<E extends McpKitEnv>(config: McpKitConfig<E>): {
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>;
} {
  return {
    fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
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
      return new OAuthProvider(providerOptions(env, config)).fetch(request, env, ctx);
    }
  };
}
