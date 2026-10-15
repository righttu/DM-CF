import { Agent, getAgentByName } from "agents";
import type { ElicitRequest, ElicitResult } from "agents/mcp/client";
import { wrapAISDK } from "agents/observability/ai";
import * as ai from "ai";
// import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
  authenticate,
  checkBrowserOrigin,
  isLocalEnvironment,
  isLoopbackRequest,
  looksLikePlaceholder,
  sanitizeDiagnostic,
  sha256Hex,
  type AccessEnv,
  type AuditContext,
  type DemoRole
} from "../shared/access.js";
import { readBoundedText } from "../shared/body.js";
import { CANONICAL_TOOLS, type CanonicalTool } from "../shared/demo-tools.js";
import { captureDlpFromError, lastBlock, type DlpOutcome } from "./dlp.js";
import { renderPage } from "./ui.js";
import {
  DEMO_SCENARIOS,
  DOCUMENT_IDS,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARACTERS,
  MAX_TOOL_STEPS,
  COMPANY_IDS,
  SYSTEM_PROMPT,
  TOOL_DESCRIPTIONS
} from "../research-policy.js";

interface AgentDemoEnv extends AccessEnv {
  ResearchAgent: DurableObjectNamespace<ResearchAgent>;
  CALLBACK_KV: KVNamespace;
  AGENT_ACCESS_AUD?: string;
  PUBLIC_ORIGIN?: string;
  MCP_SERVER_URL?: string;
  MCP_TOOL_NAMES_JSON?: string;
  ACCOUNT_ID?: string;
  GATEWAY_ID?: string;
  MODEL_ID?: string;
  AI?: Ai;
  DASHSCOPE_API_KEY?: string;
  CF_AIG_TOKEN?: string;
}

type ModelBinding = { run: (...args: unknown[]) => Promise<unknown> };

let modelBindingOverride: ModelBinding | undefined;

export function __setModelBindingForTests(impl: ModelBinding | undefined): void {
  modelBindingOverride = impl;
}

// const DEFAULT_MODEL_ID = "qwen3.8-2.4t-a95b";
const DEFAULT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const OAUTH_STATE_TTL = 1800;
const OAUTH_CALLBACK_PATH = "mcp-oauth-callback";

interface PendingPortal {
  id: string;
  url: string;
  message: string;
  expiresAt: number;
}

interface AgentStateShape {
  history: { role: "user" | "assistant"; content: string }[];
  conversationId: string;
  lastRole?: DemoRole;
  pendingPortal?: PendingPortal | null;
  lastMcpFailure?: string | null;
}

interface PortalServerRow {
  id: string;
  name: string;
  enabled: boolean | null;
}

interface ChatEvent {
  text: string;
  kind: "" | "ok" | "denied";
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer"
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS }
  });
}

async function readJsonObject(
  request: Request
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: string }
> {
  const bounded = await readBoundedText(request);
  if (bounded.status !== 200) return { ok: false, status: 413, error: "body_too_large" };
  if (!bounded.text.trim()) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded.text);
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function configuredOrigin(env: AgentDemoEnv): string | undefined {
  if (!env.PUBLIC_ORIGIN || looksLikePlaceholder(env.PUBLIC_ORIGIN)) return undefined;
  return env.PUBLIC_ORIGIN;
}

function accessLogoutUrl(env: AgentDemoEnv): string | null {
  if (isLocalEnvironment(env)) return null;
  const origin = configuredOrigin(env);
  return origin ? `${origin}/cdn-cgi/access/logout` : null;
}

function requestHostAllowed(request: Request, env: AgentDemoEnv): boolean {
  if (isLocalEnvironment(env) && isLoopbackRequest(request)) return true;
  const origin = configuredOrigin(env);
  if (!origin) return false;
  try {
    return new URL(request.url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function mcpServerUrlAllowed(env: AgentDemoEnv): string | null {
  const raw = env.MCP_SERVER_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (looksLikePlaceholder(url.hostname)) return null;
    if (url.protocol === "https:") return raw;
    if (
      isLocalEnvironment(env) &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

function toolNameMap(env: AgentDemoEnv): Record<string, string> | null {
  if (!env.MCP_TOOL_NAMES_JSON) return {};
  try {
    const parsed = JSON.parse(env.MCP_TOOL_NAMES_JSON) as Record<string, unknown>;
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (CANONICAL_TOOLS.includes(key as CanonicalTool) && typeof value === "string") {
        map[key] = value;
      }
    }
    return map;
  } catch {
    return null;
  }
}

function remoteName(env: AgentDemoEnv, canonical: CanonicalTool): string | null {
  const map = toolNameMap(env);
  if (map === null) return null;
  return map[canonical] ?? canonical;
}

const REQUEST_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstTextBlock(result: unknown): string | null {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  const block = content.find(
    (c) => (c as { type?: string } | null)?.type === "text"
  ) as { text?: unknown } | undefined;
  return typeof block?.text === "string" ? block.text : null;
}

function decodePortalServers(
  result: unknown
): { servers: PortalServerRow[]; truncated: boolean } | { error: "invalid_catalog" } {
  let root: unknown = (result as { structuredContent?: unknown })
    ?.structuredContent;
  if (root === undefined) {
    const text = firstTextBlock(result);
    if (text === null) return { error: "invalid_catalog" };
    try {
      root = JSON.parse(text);
    } catch {
      return { error: "invalid_catalog" };
    }
  }
  const list = Array.isArray(root)
    ? root
    : root && typeof root === "object"
      ? (root as { servers?: unknown }).servers
      : undefined;
  if (!Array.isArray(list)) return { error: "invalid_catalog" };
  const rows: PortalServerRow[] = [];
  for (const entry of list.slice(0, 100)) {
    if (!entry || typeof entry !== "object") return { error: "invalid_catalog" };
    const e = entry as {
      id?: unknown;
      server_id?: unknown;
      name?: unknown;
      toggled?: unknown;
      enabled?: unknown;
    };
    const id =
      typeof e.id === "string" && e.id.length > 0
        ? e.id
        : typeof e.server_id === "string" && e.server_id.length > 0
          ? e.server_id
          : null;
    if (!id || id.length > 128) return { error: "invalid_catalog" };
    if (typeof e.name !== "string" || e.name.length === 0 || e.name.length > 200) {
      return { error: "invalid_catalog" };
    }
    const enabled =
      typeof e.toggled === "boolean"
        ? e.toggled
        : typeof e.enabled === "boolean"
          ? e.enabled
          : null;
    rows.push({ id, name: e.name, enabled });
  }
  return { servers: rows, truncated: list.length > 100 };
}

function validatePortalManageUrl(raw: string, env: AgentDemoEnv): string | null {
  if (raw.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const server = mcpServerUrlAllowed(env);
  if (!server) return null;
  let serverOrigin: string;
  try {
    serverOrigin = new URL(server).origin;
  } catch {
    return null;
  }
  if (url.origin !== serverOrigin) return null;
  if (url.pathname !== "/authorize") return null;
  if (url.protocol === "https:") return url.toString();
  if (
    url.protocol === "http:" &&
    isLocalEnvironment(env) &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  ) {
    return url.toString();
  }
  return null;
}

function decodePortalAuthorizationUrl(
  result: unknown,
  env: AgentDemoEnv
): string | null {
  const sc = result as {
    structuredContent?: { url?: unknown; authorization_url?: unknown };
  };
  let candidate: unknown =
    sc?.structuredContent?.url ?? sc?.structuredContent?.authorization_url;
  if (typeof candidate !== "string") {
    const text = firstTextBlock(result);
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as {
          url?: unknown;
          authorization_url?: unknown;
        };
        candidate = parsed?.url ?? parsed?.authorization_url;
      } catch {
      }
      if (typeof candidate !== "string") {
        const match = /https?:\/\/[^\s<>"'`)\]]+/.exec(text);
        if (match) candidate = match[0].replace(/[>*_.,;!?'"`]+$/u, "");
      }
    }
  }
  return typeof candidate === "string"
    ? validatePortalManageUrl(candidate, env)
    : null;
}

const SINGLE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// function modelConfigured(env: AgentDemoEnv): boolean {
//   const { ACCOUNT_ID, GATEWAY_ID, DASHSCOPE_API_KEY, CF_AIG_TOKEN } = env;
//   if (!ACCOUNT_ID || !GATEWAY_ID || !DASHSCOPE_API_KEY || !CF_AIG_TOKEN) return false;
//   if (
//     [ACCOUNT_ID, GATEWAY_ID, DASHSCOPE_API_KEY, CF_AIG_TOKEN].some((v) =>
//       looksLikePlaceholder(v)
//     )
//   ) {
//     return false;
//   }
//   return SINGLE_SEGMENT.test(ACCOUNT_ID) && SINGLE_SEGMENT.test(GATEWAY_ID);
// }

function modelConfigured(env: AgentDemoEnv): boolean {
  const { GATEWAY_ID } = env;
  if (!modelBindingOverride && !env.AI) return false;
  if (!GATEWAY_ID || looksLikePlaceholder(GATEWAY_ID)) return false;
  return SINGLE_SEGMENT.test(GATEWAY_ID);
}

// function buildChatModel(
//   env: AgentDemoEnv,
//   dlpSink: DlpOutcome[],
//   context: AuditContext,
//   conversationId: string,
//   action: "chat" | "dlp-test"
// ) {
//   if (!modelConfigured(env)) return null;
//   const baseURL = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY_ID}/custom-dashscope/compatible-mode/v1`;
//   const innerFetch: ModelFetch = modelFetchOverride ?? fetch.bind(globalThis);
//   const provider = createOpenAICompatible({
//     name: "dashscope",
//     baseURL,
//     apiKey: env.DASHSCOPE_API_KEY,
//     headers: {
//       "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
//       "cf-aig-skip-cache": "true",
//       "cf-aig-metadata": JSON.stringify({
//         actor_id: context.actorId,
//         conversation_id: conversationId,
//         request_id: context.requestId,
//         role: context.role,
//         action
//       })
//     },
//     fetch: async (input, init) => {
//       const resp = await innerFetch(input, init);
//       try {
//         await captureDlpOutcome(resp.clone(), dlpSink);
//       } catch {
//       }
//       if (lastBlock(dlpSink)) {
//         throw new Error("dlp_blocked");
//       }
//       return resp;
//     }
//   });
//   return provider.chatModel((env.MODEL_ID || DEFAULT_MODEL_ID) as never);
// }

function buildChatModel(
  env: AgentDemoEnv,
  dlpSink: DlpOutcome[],
  context: AuditContext,
  conversationId: string,
  action: "chat" | "dlp-test"
) {
  if (!modelConfigured(env)) return null;
  const base = (modelBindingOverride ?? env.AI) as unknown as ModelBinding;
  const binding = new Proxy(base, {
    get(target, prop) {
      if (prop === "run") {
        return async (...args: unknown[]) => {
          try {
            return await target.run(...args);
          } catch (error) {
            captureDlpFromError(
              error,
              dlpSink,
              (target as { aiGatewayLogId?: string | null }).aiGatewayLogId
            );
            if (lastBlock(dlpSink)) throw new Error("dlp_blocked");
            throw error;
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as unknown as Ai;
  const workersai = createWorkersAI({
    binding,
    gateway: {
      id: env.GATEWAY_ID as string,
      skipCache: true,
      metadata: {
        actor_id: context.actorId,
        conversation_id: conversationId,
        request_id: context.requestId,
        role: context.role,
        action
      }
    }
  });
  return workersai((env.MODEL_ID || DEFAULT_MODEL_ID) as never);
}

function buildTools(
  agent: ResearchAgent,
  context: AuditContext,
  events: ChatEvent[]
): ai.ToolSet {
  const execute = (canonical: CanonicalTool) => async (args: Record<string, unknown>) => {
    events.push({ text: `工具调用 ${canonical}`, kind: "" });
    const result = await agent.callRemoteTool(canonical, args, context);
    agent.audit(context, "tool-execute", canonical, result.status);
    if (result.status === "ok") {
      events.push({ text: `工具返回 ${canonical}`, kind: "ok" });
    } else {
      events.push({
        text: `工具${result.status === "denied" ? "被拒绝" : "不可用/出错"} ${canonical}`,
        kind: "denied"
      });
    }
    return result.payload ?? { error: result.status };
  };
  const available = new Set(agent.availableCanonical(context.role));
  const tools: ai.ToolSet = {};
  if (available.has("list_demo_companies")) {
    tools.list_demo_companies = ai.tool({
      description: TOOL_DESCRIPTIONS.list_demo_companies,
      inputSchema: z.object({}),
      execute: execute("list_demo_companies")
    });
  }
  if (available.has("get_latest_analysis")) {
    tools.get_latest_analysis = ai.tool({
      description: TOOL_DESCRIPTIONS.get_latest_analysis,
      inputSchema: z.object({ company_id: z.enum(COMPANY_IDS) }),
      execute: async (args: { company_id: string }) =>
        execute("get_latest_analysis")({ company_id: args.company_id })
    });
  }
  if (available.has("read_research_document")) {
    tools.read_research_document = ai.tool({
      description: TOOL_DESCRIPTIONS.read_research_document,
      inputSchema: z.object({ document_id: z.enum(DOCUMENT_IDS) }),
      execute: async (args: { document_id: string }) =>
        execute("read_research_document")({ document_id: args.document_id })
    });
  }
  return tools;
}

export class ResearchAgent extends Agent<AgentDemoEnv, AgentStateShape> {
  initialState: AgentStateShape = { history: [], conversationId: "" };
  private busy = false;
  private portalElicits = new Map<
    string,
    {
      finish: (result: ElicitResult) => void;
      timer: ReturnType<typeof setTimeout>;
      abort: () => void;
      signal?: AbortSignal;
    }
  >();

  private livePending(): PendingPortal | null {
    const pending = this.state.pendingPortal ?? null;
    if (!pending) return null;
    if (pending.expiresAt <= Date.now()) {
      this.portalElicits
        .get(pending.id)
        ?.finish({ action: "cancel" } as ElicitResult);
      if (this.state.pendingPortal) {
        this.setState({ ...this.state, pendingPortal: null });
      }
      return null;
    }
    if (!this.portalElicits.has(pending.id)) {
      this.setState({ ...this.state, pendingPortal: null });
      return null;
    }
    return pending;
  }

  private cancelOwnPending(): void {
    const pending = this.state.pendingPortal;
    if (!pending) return;
    const entry = this.portalElicits.get(pending.id);
    if (entry) {
      entry.finish({ action: "cancel" } as ElicitResult);
    }
    if (this.state.pendingPortal) {
      this.setState({ ...this.state, pendingPortal: null });
    }
  }

  onStart(): void {
    const origin = configuredOrigin(this.env) ?? "";
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (!result.authSuccess) {
          this.setState({
            ...this.state,
            lastMcpFailure: this.diagnostic(result.authError)
          });
          console.info(
            JSON.stringify({
              event: "mcp_audit",
              action: "connect",
              tool: "unknown",
              status: "oauth_callback_failed",
              actorId: this.name ?? "unknown"
            })
          );
        }
        if (!origin) {
          return json({ error: "oauth_callback_failed" }, 400);
        }
        return new Response(null, {
          status: 302,
          headers: { location: origin }
        });
      }
    });
    this.mcp.configureElicitationHandlers({
      url: (request, serverId, signal) =>
        this.queuePortalUrl(request, serverId, signal)
    });
    const pending = this.state.pendingPortal;
    if (
      pending &&
      (pending.expiresAt <= Date.now() || !this.portalElicits.has(pending.id))
    ) {
      this.setState({ ...this.state, pendingPortal: null });
    }
  }

  private queuePortalUrl(
    request: ElicitRequest,
    serverId: string,
    signal?: AbortSignal
  ): Promise<ElicitResult> {
    const declined = Promise.resolve({ action: "decline" } as ElicitResult);
    if (signal?.aborted) {
      return Promise.resolve({ action: "cancel" } as ElicitResult);
    }
    if (serverId !== "research") return declined;
    const params = (request as {
      params?: { mode?: string; url?: unknown; message?: unknown };
    })?.params;
    if (params?.mode !== "url" || typeof params.url !== "string") return declined;
    const url = validatePortalManageUrl(params.url, this.env);
    if (!url) return declined;
    if (this.state.pendingPortal) return declined;
    const id = crypto.randomUUID();
    const message =
      typeof params.message === "string" && params.message.length > 0
        ? params.message.slice(0, 400)
        : "Portal 请求授权";
    this.setState({
      ...this.state,
      pendingPortal: { id, url, message, expiresAt: Date.now() + 55_000 }
    });
    return new Promise<ElicitResult>((resolve) => {
      const finish = (result: ElicitResult) => {
        const entry = this.portalElicits.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener("abort", entry.abort);
        this.portalElicits.delete(id);
        if (this.state.pendingPortal?.id === id) {
          this.setState({ ...this.state, pendingPortal: null });
        }
        resolve(result);
      };
      const abort = () => finish({ action: "cancel" } as ElicitResult);
      const timer = setTimeout(abort, 55_000);
      this.portalElicits.set(id, { finish, timer, abort, signal });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === `/${OAUTH_CALLBACK_PATH}`) {
      if (this.mcp.isCallbackRequest(request)) {
        const result = await this.mcp.handleCallbackRequest(request);
        const origin = configuredOrigin(this.env);
        if (result.authSuccess && origin) {
          return new Response(null, { status: 302, headers: { location: origin } });
        }
        return json({ error: "oauth_callback_failed" }, 400);
      }
      return json({ error: "invalid_callback" }, 400);
    }
    return json({ error: "not_found" }, 404);
  }

  private ensureConversationId(): string {
    if (!this.state.conversationId) {
      this.setState({ ...this.state, conversationId: crypto.randomUUID() });
    }
    return this.state.conversationId;
  }

  private syncRole(role: DemoRole): void {
    if (this.state.lastRole !== role) {
      if (this.state.lastRole !== undefined) this.cancelOwnPending();
      this.setState({
        history: [],
        conversationId: crypto.randomUUID(),
        lastRole: role,
        pendingPortal: null
      });
    }
  }

  private healing: Promise<boolean> | null = null;

  private async healMcp(): Promise<boolean> {
    const conn = this.mcp.mcpConnections["research"];
    if (!conn) return false;
    let step = "reconnect";
    try {
      conn.clearResumedSession();
      const reconnect = (await this.mcp.connectToServer("research")) as {
        state: string;
        error?: unknown;
      };
      if (reconnect.state !== "connected") {
        return this.healFailed(step, `state=${reconnect.state}${reconnect.error ? " " + this.diagnostic(reconnect.error) : ""}`);
      }
      step = "discover";
      const discovered = (await this.mcp.discoverIfConnected("research")) as
        | { success?: boolean; error?: unknown }
        | undefined;
      if (discovered?.success === true) {
        this.clearMcpFailure();
        return true;
      }
      return this.healFailed(step, this.diagnostic(discovered?.error ?? "no_result"));
    } catch (e) {
      return this.healFailed(step, this.diagnostic(e));
    }
  }

  private healFailed(step: string, detail: string): false {
    const text = `自愈失败（${step}）：${detail}`;
    console.error(JSON.stringify({ event: "mcp_heal_failed", step, detail }));
    this.setState({ ...this.state, lastMcpFailure: text.slice(0, 400) });
    return false;
  }

  private async ensureMcpReady(): Promise<void> {
    await this.mcp.waitForConnections({ timeout: 10000 });
    const entry = this.researchRegistration();
    const url = mcpServerUrlAllowed(this.env);
    if (!entry || !url || entry.server_url !== url || String(entry.state) !== "connected") return;
    this.healing ??= this.healMcp().finally(() => {
      this.healing = null;
    });
    await this.healing;
  }

  private discoveredRemoteNames(): Set<string> {
    const names = new Set<string>();
    for (const tool of this.mcp.listTools({ serverId: "research" })) {
      if (tool?.name) names.add(tool.name);
    }
    return names;
  }

  private researchRegistration() {
    return this.getMcpServers().servers?.["research"];
  }

  async diagnoseMcp(): Promise<Record<string, unknown>> {
    const target = mcpServerUrlAllowed(this.env);
    if (!target) return { error: "unconfigured" };
    const secrets = [this.env.DASHSCOPE_API_KEY, this.env.CF_AIG_TOKEN];
    const keys = [
      ...(await this.ctx.storage.list({ prefix: `/${this.name}/research/` })).keys()
    ];
    const tokenKey = keys.find((k) => k.endsWith("/token"));
    const stored = tokenKey
      ? await this.ctx.storage.get<{ access_token?: string }>(tokenKey)
      : undefined;
    const accessToken = stored?.access_token;
    const summary = {
      storedKeys: keys.length,
      hasToken: !!accessToken,
      hasClientInfo: keys.some((k) => k.includes("/client_info/")),
      registration: this.researchRegistration()?.state ?? null
    };
    if (!accessToken) return { ...summary, steps: [] };
    secrets.push(accessToken);
    const base: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`
    };
    const steps: unknown[] = [];
    let sessionId: string | null = null;
    const send = async (label: string, body: unknown) => {
      try {
        const headers = { ...base, ...(sessionId ? { "mcp-session-id": sessionId } : {}) };
        const resp = await fetch(target, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "manual",
          signal: AbortSignal.timeout(10000)
        });
        sessionId = resp.headers.get("mcp-session-id") ?? sessionId;
        const text = (await resp.text()).slice(0, label === "portal_list_servers" ? 700 : 300);
        steps.push({
          label,
          status: resp.status,
          contentType: resp.headers.get("content-type"),
          body: sanitizeDiagnostic(text, secrets)
        });
        return resp.status;
      } catch (e) {
        steps.push({ label, error: sanitizeDiagnostic(e, secrets) });
        return 0;
      }
    };
    const ok = await send("initialize", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "diag", version: "1" }
      }
    });
    if (ok >= 200 && ok < 300) {
      await send("initialized", { jsonrpc: "2.0", method: "notifications/initialized" });
      await send("tools/list", { jsonrpc: "2.0", id: 2, method: "tools/list" });
      await send("portal_list_servers", {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "portal_list_servers", arguments: {} }
      });
    }
    return { ...summary, steps };
  }

  mcpStatus(): {
    connected: boolean;
    state: string;
    error: string | null;
    detail: string | null;
  } {
    const entry = this.researchRegistration();
    const state = entry?.state != null ? String(entry.state) : "disconnected";
    const url = mcpServerUrlAllowed(this.env);
    const urlMatches = !!entry && !!url && entry.server_url === url;
    return {
      connected: state === "ready" && urlMatches,
      state: !entry || urlMatches ? state : "stale",
      error: entry?.error ? "mcp_error" : null,
      detail: entry?.error ? this.diagnostic(entry.error) : null
    };
  }

  private diagnostic(cause: unknown): string {
    const rec = (cause && typeof cause === "object" ? cause : {}) as {
      code?: unknown;
      status?: unknown;
    };
    const status =
      typeof rec.code === "number" ? rec.code : typeof rec.status === "number" ? rec.status : null;
    const text = sanitizeDiagnostic(cause, [
      this.env.DASHSCOPE_API_KEY,
      this.env.CF_AIG_TOKEN
    ]);
    return status === null ? text : `[HTTP ${status}] ${text}`;
  }

  availableCanonical(role: DemoRole): string[] {
    const allowed: CanonicalTool[] =
      role === "analyst" ? CANONICAL_TOOLS : ["list_demo_companies", "get_latest_analysis"];
    const discovered = this.discoveredRemoteNames();
    if (discovered.size === 0) return [];
    return allowed.filter((c) => {
      const remote = remoteName(this.env, c);
      return remote !== null && discovered.has(remote);
    });
  }

  async getSessionData(role: DemoRole) {
    await this.ensureMcpReady();
    this.syncRole(role);
    const names = this.discoveredRemoteNames();
    const mcp = this.mcpStatus();
    const connected = mcp.connected;
    return {
      history: this.state.history,
      conversationId: this.ensureConversationId(),
      mcp: {
        ...mcp,
        detail: mcp.detail ?? this.state.lastMcpFailure ?? null
      },
      tools: this.availableCanonical(role),
      expectedTools:
        role === "analyst" ? [...CANONICAL_TOOLS] : ["list_demo_companies", "get_latest_analysis"],
      portal: {
        listAvailable: connected && names.has("portal_list_servers"),
        manageAvailable: connected && names.has("portal_toggle_servers"),
        pending: this.livePending()
      }
    };
  }

  private clearMcpFailure(): void {
    if (this.state.lastMcpFailure) {
      this.setState({ ...this.state, lastMcpFailure: null });
    }
  }

  async connectMcp(
    context: AuditContext
  ): Promise<{
    status: string;
    authUrl?: string;
    state?: string;
    error?: string;
    detail?: string;
  }> {
    this.syncRole(context.role);
    const finish = <T extends { status: string }>(result: T): T => {
      this.audit(context, "connect", "research", result.status, "mcp_audit");
      return result;
    };
    const failedResult = (cause: unknown) =>
      finish({
        status: "failed",
        error: "mcp_connect_failed",
        detail: this.diagnostic(cause)
      });
    const authResult = (authUrl: string | undefined) => {
      let state: string | undefined;
      try {
        state = authUrl
          ? (new URL(authUrl).searchParams.get("state") ?? undefined)
          : undefined;
      } catch {
        state = undefined;
      }
      if (!authUrl || !state) {
        return failedResult("missing_authorization_url");
      }
      return finish({ status: "authenticating", authUrl, state });
    };
    const url = mcpServerUrlAllowed(this.env);
    if (!url) return finish({ status: "unconfigured" });
    const origin = configuredOrigin(this.env);
    if (!origin && !(isLocalEnvironment(this.env))) {
      return finish({ status: "unconfigured" });
    }
    const callbackHost =
      origin ??
      (isLocalEnvironment(this.env) ? "http://localhost:8787" : "");
    const existing = this.mcpStatus();
    if (existing.connected) {
      this.clearMcpFailure();
      return finish({ status: "ready" });
    }
    const registered = this.researchRegistration();
    if (registered && registered.server_url === url) {
      switch (existing.state) {
        case "connecting":
        case "discovering":
          return finish({ status: "connecting" });
        case "connected":
          if (await this.healMcp()) {
            this.clearMcpFailure();
            return finish({ status: "ready" });
          }
          return failedResult("session_recovery_failed");
        case "failed":
          try {
            const reconnect = (await this.mcp.connectToServer("research")) as {
              state: string;
              authUrl?: string;
              error?: string;
            };
            if (reconnect.state === "authenticating" && reconnect.authUrl) {
              return authResult(reconnect.authUrl);
            }
            if (reconnect.state === "connected") {
              let discovered: { success?: boolean; error?: unknown } | undefined;
              try {
                discovered = (await this.mcp.discoverIfConnected(
                  "research"
                )) as { success?: boolean; error?: unknown } | undefined;
              } catch (e) {
                return failedResult(e);
              }
              if (discovered?.success) {
                this.clearMcpFailure();
                return finish({ status: "ready" });
              }
              return failedResult(discovered?.error);
            }
            if (
              reconnect.state === "connecting" ||
              reconnect.state === "discovering"
            ) {
              return finish({ status: "connecting" });
            }
            return failedResult(reconnect.error);
          } catch (e) {
            return failedResult(e);
          }
      }
    }
    if (registered && registered.server_url !== url) {
      await this.removeMcpServer("research");
    }
    try {
      const result = await this.addMcpServer("research", url, {
        id: "research",
        callbackHost,
        callbackPath: OAUTH_CALLBACK_PATH
      });
      if (result.state === "authenticating") {
        return authResult(result.authUrl);
      }
      this.clearMcpFailure();
      return finish({ status: "ready" });
    } catch (e) {
      return failedResult(e);
    }
  }

  async disconnectMcp(
    context: AuditContext
  ): Promise<{ status: "disconnected" }> {
    this.cancelOwnPending();
    if (this.researchRegistration()) {
      await this.removeMcpServer("research");
    }
    this.audit(context, "disconnect", "research", "disconnected", "mcp_audit");
    return { status: "disconnected" };
  }

  private portalMeta(context: AuditContext): Record<string, string> {
    return {
      "uk.righttu.demo/request_id": context.requestId,
      "uk.righttu.demo/conversation_id": this.ensureConversationId()
    };
  }

  async listPortalServers(context: AuditContext): Promise<
    | { status: "requires_connect" | "unsupported" | "error" }
    | { status: "ok"; servers: PortalServerRow[]; truncated: boolean }
  > {
    await this.ensureMcpReady();
    if (!this.mcpStatus().connected) return { status: "requires_connect" };
    if (!this.discoveredRemoteNames().has("portal_list_servers")) {
      return { status: "unsupported" };
    }
    let result: unknown;
    try {
      result = await this.mcp.callTool({
        serverId: "research",
        name: "portal_list_servers",
        arguments: {},
        _meta: this.portalMeta(context)
      });
    } catch {
      this.audit(context, "portal-list", "research", "error", "mcp_audit");
      return { status: "error" };
    }
    let decoded: ReturnType<typeof decodePortalServers>;
    try {
      decoded = (result as { isError?: boolean })?.isError
        ? { error: "invalid_catalog" }
        : decodePortalServers(result);
    } catch {
      decoded = { error: "invalid_catalog" };
    }
    if ("error" in decoded) {
      this.audit(context, "portal-list", "research", "error", "mcp_audit");
      return { status: "error" };
    }
    this.audit(context, "portal-list", "research", "ok", "mcp_audit");
    return {
      status: "ok",
      servers: decoded.servers,
      truncated: decoded.truncated
    };
  }

  async managePortalServers(context: AuditContext): Promise<
    | { status: "requires_connect" | "unsupported" | "error" }
    | { status: "ok"; authorizationUrl: string }
  > {
    await this.ensureMcpReady();
    this.syncRole(context.role);
    if (!this.mcpStatus().connected) return { status: "requires_connect" };
    if (!this.discoveredRemoteNames().has("portal_toggle_servers")) {
      return { status: "unsupported" };
    }
    let result: unknown;
    try {
      result = await this.mcp.callTool({
        serverId: "research",
        name: "portal_toggle_servers",
        arguments: {},
        _meta: this.portalMeta(context)
      });
    } catch {
      this.audit(context, "portal-manage", "research", "error", "mcp_audit");
      return { status: "error" };
    }
    const url = (result as { isError?: boolean })?.isError
      ? null
      : decodePortalAuthorizationUrl(result, this.env);
    if (!url) {
      this.audit(context, "portal-manage", "research", "error", "mcp_audit");
      return { status: "error" };
    }
    this.audit(context, "portal-manage", "research", "ok", "mcp_audit");
    return { status: "ok", authorizationUrl: url };
  }

  async refreshPortal(context: AuditContext): Promise<
    | { status: "requires_connect" | "unsupported" | "error" }
    | { status: "ok"; servers: PortalServerRow[]; truncated: boolean }
  > {
    if (!this.mcpStatus().connected) return { status: "requires_connect" };
    let discovered: { success?: boolean; error?: unknown } | undefined;
    try {
      discovered = (await this.mcp.discoverIfConnected("research")) as
        | { success?: boolean; error?: unknown }
        | undefined;
    } catch {
      this.audit(context, "portal-refresh", "research", "error", "mcp_audit");
      return { status: "error" };
    }
    if (!discovered?.success) {
      this.audit(context, "portal-refresh", "research", "error", "mcp_audit");
      return { status: "error" };
    }
    const listed = await this.listPortalServers(context);
    this.audit(
      context,
      "portal-refresh",
      "research",
      listed.status,
      "mcp_audit"
    );
    return listed;
  }

  async respondPortalRequest(
    id: unknown,
    action: unknown,
    context: AuditContext
  ): Promise<{ status: "resolved" | "invalid" | "not_found" }> {
    if (
      typeof action !== "string" ||
      !["accept", "decline", "cancel"].includes(action) ||
      typeof id !== "string" ||
      !REQUEST_UUID_PATTERN.test(id)
    ) {
      return { status: "invalid" };
    }
    const pending = this.livePending();
    const entry = pending ? this.portalElicits.get(pending.id) : undefined;
    if (!pending || pending.id !== id || !entry) {
      return { status: "not_found" };
    }
    entry.finish({ action } as ElicitResult);
    this.audit(context, "portal-respond", "research", action, "mcp_audit");
    return { status: "resolved" };
  }

  async callRemoteTool(
    canonical: CanonicalTool,
    args: Record<string, unknown>,
    context: AuditContext
  ): Promise<{ status: "ok" | "denied" | "unavailable" | "error"; detail?: string; payload?: unknown }> {
    if (context.role !== "analyst" && canonical === "read_research_document") {
      return { status: "denied", detail: "viewer 无权访问研究文档" };
    }
    if (!CANONICAL_TOOLS.includes(canonical)) {
      return { status: "denied", detail: "unknown_tool" };
    }
    const current = this.mcpStatus();
    if (!current.connected) {
      return {
        status: "unavailable",
        detail: `MCP 未连接或连接已过期（状态：${current.state}${current.detail ? "；" + current.detail : ""}）`
      };
    }
    const remote = remoteName(this.env, canonical);
    if (remote === null || !this.discoveredRemoteNames().has(remote)) {
      return { status: "unavailable", detail: "工具未在已连接服务中公布" };
    }
    try {
      const result = (await this.mcp.callTool({
        serverId: "research",
        name: remote,
        arguments: args,
        _meta: this.portalMeta(context)
      })) as {
        isError?: boolean;
        structuredContent?: unknown;
        content?: { type?: string; text?: string }[];
      };
      const textBlock = result?.content?.find((c) => c?.type === "text")?.text;
      let payload: unknown = result?.structuredContent;
      if (payload === undefined && typeof textBlock === "string") {
        try {
          payload = JSON.parse(textBlock);
        } catch {
          payload = { text: textBlock };
        }
      }
      if (result?.isError) {
        return { status: "error", detail: "远端工具执行失败", payload };
      }
      return { status: "ok", payload };
    } catch (e) {
      return { status: "error", detail: `工具调用失败：${this.diagnostic(e)}` };
    }
  }

  private validateToolArgs(
    tool: CanonicalTool,
    args: Record<string, unknown>
  ): Record<string, unknown> | null {
    const keys = Object.keys(args);
    if (tool === "list_demo_companies") {
      return keys.length === 0 ? {} : null;
    }
    if (tool === "get_latest_analysis") {
      return keys.length === 1 &&
        typeof args.company_id === "string" &&
        (COMPANY_IDS as readonly string[]).includes(args.company_id)
        ? { company_id: args.company_id }
        : null;
    }
    return keys.length === 1 &&
      typeof args.document_id === "string" &&
      (DOCUMENT_IDS as readonly string[]).includes(args.document_id)
      ? { document_id: args.document_id }
      : null;
  }

  audit(
    context: AuditContext,
    action: string,
    tool: string,
    status: string,
    event: "tool_audit" | "mcp_audit" = "tool_audit"
  ): void {
    const canonical = CANONICAL_TOOLS.includes(tool as CanonicalTool) ? tool : "unknown";
    console.info(
      JSON.stringify({
        event,
        action,
        tool: canonical,
        status,
        role: context.role,
        actorId: context.actorId,
        requestId: context.requestId,
        identitySource: context.identitySource,
        conversationId: this.ensureConversationId()
      })
    );
  }

  async toolTest(
    tool: string,
    args: Record<string, unknown>,
    context: AuditContext
  ): Promise<{ status: string; detail?: string; result?: unknown }> {
    await this.ensureMcpReady();
    if (!CANONICAL_TOOLS.includes(tool as CanonicalTool)) {
      this.audit(context, "tool-test", tool, "denied");
      return { status: "denied", detail: "unknown_tool" };
    }
    if ((tool as CanonicalTool) === "read_research_document" && context.role !== "analyst") {
      this.audit(context, "tool-test", tool, "denied");
      return { status: "denied", detail: "viewer 无权访问研究文档" };
    }
    const validated = this.validateToolArgs(tool as CanonicalTool, args);
    if (validated === null) {
      this.audit(context, "tool-test", tool, "invalid_args");
      return { status: "invalid_args", detail: "参数未通过本地校验" };
    }
    const outcome = await this.callRemoteTool(tool as CanonicalTool, validated, context);
    this.audit(context, "tool-test", tool, outcome.status);
    if (outcome.status === "ok") return { status: "ok", result: outcome.payload };
    return { status: outcome.status, detail: outcome.detail };
  }

  private telemetry(context: AuditContext, action: string) {
    return {
      isEnabled: true,
      functionId: "research-demo",
      metadata: {
        agentId: "research-agent",
        conversationId: this.ensureConversationId(),
        role: context.role,
        action,
        actorId: context.actorId,
        requestId: context.requestId,
        identitySource: context.identitySource
      }
    };
  }

  async chat(
    message: string,
    context: AuditContext
  ): Promise<{ reply: string; events: ChatEvent[]; dlp?: DlpOutcome; mcpRequired?: boolean }> {
    await this.ensureMcpReady();
    this.syncRole(context.role);
    if (this.busy) {
      return { reply: "", events: [{ text: "上一次对话仍在进行中", kind: "denied" }] };
    }
    if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE_CHARACTERS) {
      return { reply: "消息为空或超出长度限制。", events: [] };
    }
    if (!this.mcpStatus().connected) {
      return { reply: "", events: [], mcpRequired: true };
    }
    this.busy = true;
    const events: ChatEvent[] = [];
    const dlpSink: DlpOutcome[] = [];
    try {
      const model = buildChatModel(
        this.env,
        dlpSink,
        context,
        this.ensureConversationId(),
        "chat"
      );
      if (!model) {
        return { reply: "模型网关未配置，演示无法调用模型。", events };
      }
      const history = this.state.history.slice(-MAX_HISTORY_MESSAGES);
      const userMessage = { role: "user" as const, content: message };
      const traced = wrapAISDK(ai, { storeMessages: false, storeTools: false });
      const tools = buildTools(this, context, events);
      const blockedReply =
        "该请求被 AI Gateway DLP 策略拦截（云端确认），未返回模型内容。";
      let reply: string;
      try {
        const result = await traced.generateText({
          model,
          system: SYSTEM_PROMPT,
          messages: [...history, userMessage],
          tools,
          stopWhen: ai.stepCountIs(MAX_TOOL_STEPS),
          maxRetries: 0,
          maxOutputTokens: 2048,
          experimental_telemetry: this.telemetry(context, "chat")
        });
        const blocked = lastBlock(dlpSink);
        if (blocked) {
          events.push({ text: "DLP 拦截（云端确认）", kind: "denied" });
          return { reply: blockedReply, events, dlp: blocked };
        }
        reply = result.text;
      } catch {
        const blocked = lastBlock(dlpSink);
        if (blocked) {
          events.push({ text: "DLP 拦截（云端确认）", kind: "denied" });
          return { reply: blockedReply, events, dlp: blocked };
        }
        events.push({ text: "模型调用失败", kind: "denied" });
        return { reply: "模型调用失败，请稍后重试。", events };
      }
      const flag = [...dlpSink].reverse().find((o) => o.action === "FLAG");
      if (flag) events.push({ text: "DLP 标记（未拦截，云端确认）", kind: "denied" });
      this.persistTurn(userMessage, reply);
      return { reply, events, dlp: flag };
    } finally {
      this.busy = false;
    }
  }

  private persistTurn(
    userMessage: { role: "user"; content: string },
    reply: string
  ): void {
    const next = [
      ...this.state.history,
      userMessage,
      { role: "assistant" as const, content: reply }
    ].slice(-MAX_HISTORY_MESSAGES);
    this.setState({ ...this.state, history: next });
  }

  async dlpTest(
    context: AuditContext
  ): Promise<{ dlp?: DlpOutcome; reply?: string; error?: string }> {
    const dlpSink: DlpOutcome[] = [];
    const model = buildChatModel(
      this.env,
      dlpSink,
      context,
      this.ensureConversationId(),
      "dlp-test"
    );
    if (!model) return { error: "模型网关未配置" };
    const scenario = DEMO_SCENARIOS.find((s) => s.id === "dlp");
    const traced = wrapAISDK(ai, { storeMessages: false, storeTools: false });
    try {
      const result = await traced.generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: scenario?.message ?? "CF_DEMO_SECRET_9274",
        maxRetries: 0,
        maxOutputTokens: 2048,
        experimental_telemetry: this.telemetry(context, "dlp-test")
      });
      const outcome =
        lastBlock(dlpSink) ??
        [...dlpSink].reverse().find((o) => o.action === "FLAG") ??
        { action: "NONE" as const, detail: "model_returned" };
      this.audit(
        context,
        "dlp-test",
        "dlp-test",
        outcome.action === "BLOCK" ? "block" : outcome.action === "FLAG" ? "flag" : "none"
      );
      return { dlp: outcome, reply: outcome.action === "NONE" ? result.text : undefined };
    } catch {
      const blocked = lastBlock(dlpSink);
      this.audit(context, "dlp-test", "dlp-test", blocked ? "block" : "error");
      if (blocked) return { dlp: blocked };
      return { error: "模型调用失败（未识别为 DLP 事件）" };
    }
  }
}

async function handleRequest(
  request: Request,
  env: AgentDemoEnv
): Promise<Response> {
  const url = new URL(request.url);

  if (!requestHostAllowed(request, env)) {
    return json({ error: "host_not_allowed" }, 403);
  }
  const identity = await authenticate(request, env, env.AGENT_ACCESS_AUD);
  if (!identity) {
    return json({ error: "unauthorized" }, 401);
  }
  const doName = await sha256Hex(identity.sub);
  const auditContext: AuditContext = {
    actorId: doName,
    role: identity.role,
    requestId: crypto.randomUUID(),
    identitySource: identity.localSimulation
      ? "local_simulation"
      : isLocalEnvironment(env)
        ? "local_jwt"
        : "access"
  };

  if (url.pathname === `/${OAUTH_CALLBACK_PATH}` && request.method === "GET") {
    const state = url.searchParams.get("state") ?? "";
    if (!state) return json({ error: "missing_state" }, 400);
    const owner = await env.CALLBACK_KV.get(`oauth-state:${state}`);
    if (!owner) return json({ error: "unknown_oauth_state" }, 404);
    if (owner !== doName) return json({ error: "callback_owner_mismatch" }, 403);
    const stub = await getAgentByName(env.ResearchAgent, doName);
    return stub.fetch(request);
  }

  const stub = await getAgentByName(env.ResearchAgent, doName);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const session = await stub.getSessionData(identity.role);
    const nonce = crypto.randomUUID();
    return new Response(
      renderPage(
        {
          user: {
            email: identity.email,
            role: identity.role,
            localSimulation: identity.localSimulation,
            actorId: doName
          },
          history: session.history,
          scenarios: DEMO_SCENARIOS,
          mcp: session.mcp,
          tools: session.tools,
          expectedTools: session.expectedTools,
          conversationId: session.conversationId,
          portal: session.portal,
          setup: {
            mcpConfigured: mcpServerUrlAllowed(env) !== null,
            modelConfigured: modelConfigured(env),
            tracingWrapped: true,
            accessLogoutUrl: accessLogoutUrl(env)
          }
        },
        nonce
      ),
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...SECURITY_HEADERS,
          "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
        }
      }
    );
  }

  if (url.pathname === "/api/session" && request.method === "GET") {
    const session = await stub.getSessionData(identity.role);
    return json({
      user: {
        email: identity.email,
        role: identity.role,
        localSimulation: identity.localSimulation,
        actorId: doName
      },
      history: session.history,
      conversationId: session.conversationId,
      mcp: session.mcp,
      tools: session.tools,
      expectedTools: session.expectedTools,
      portal: session.portal,
      setup: {
        mcpConfigured: mcpServerUrlAllowed(env) !== null,
        modelConfigured: modelConfigured(env),
        tracingWrapped: true,
        accessLogoutUrl: accessLogoutUrl(env)
      }
    });
  }

  if (["POST", "PUT", "DELETE", "PATCH"].includes(request.method)) {
    if (!checkBrowserOrigin(request, configuredOrigin(env) ?? undefined)) {
      return json({ error: "origin_not_allowed" }, 403);
    }
  }

  if (["POST", "PUT", "DELETE", "PATCH"].includes(request.method)) {
    const contentType = (request.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (url.pathname.startsWith("/api/") && contentType !== "application/json") {
      return json({ error: "unsupported_media_type" }, 415);
    }
  }

  if (url.pathname === "/api/diag/portal" && request.method === "POST") {
    const target = mcpServerUrlAllowed(env);
    if (!target) return json({ error: "unconfigured" }, 400);
    if (new URL(request.url).searchParams.get("mode") === "stored") {
      return json(await stub.diagnoseMcp());
    }
    try {
      const resp = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "diag", version: "1" }
          }
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(10000)
      });
      const text = (await resp.text()).slice(0, 300);
      return json({
        status: resp.status,
        contentType: resp.headers.get("content-type"),
        location: resp.headers.get("location"),
        wwwAuthenticate: resp.headers.get("www-authenticate"),
        body: sanitizeDiagnostic(text, [env.DASHSCOPE_API_KEY, env.CF_AIG_TOKEN])
      });
    } catch (e) {
      return json({ error: "fetch_failed", detail: sanitizeDiagnostic(e, [env.DASHSCOPE_API_KEY, env.CF_AIG_TOKEN]) }, 502);
    }
  }

  if (url.pathname === "/api/connect" && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const result = await stub.connectMcp(auditContext);
    if (result.status === "authenticating" && result.state) {
      await env.CALLBACK_KV.put(`oauth-state:${result.state}`, doName, {
        expirationTtl: OAUTH_STATE_TTL
      });
    }
    return json(
      { ...result, requestId: auditContext.requestId },
      result.status === "failed" ? 502 : 200
    );
  }

  if (url.pathname === "/api/disconnect" && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    if (parsed.value.confirm !== true) {
      return json({ error: "confirmation_required" }, 400);
    }
    const result = await stub.disconnectMcp(auditContext);
    return json({ ...result, requestId: auditContext.requestId });
  }

  if (url.pathname === "/api/portal/list" && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const result = await stub.listPortalServers(auditContext);
    return portalResultJson(result, auditContext.requestId);
  }

  if (url.pathname === "/api/portal/manage" && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const result = await stub.managePortalServers(auditContext);
    return portalResultJson(result, auditContext.requestId);
  }

  if (url.pathname === "/api/portal/refresh" && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const result = await stub.refreshPortal(auditContext);
    return portalResultJson(result, auditContext.requestId);
  }

  if (url.pathname === "/api/portal/respond" && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const result = await stub.respondPortalRequest(
      parsed.value.id,
      parsed.value.action,
      auditContext
    );
    if (result.status === "invalid") {
      return json({ ...result, requestId: auditContext.requestId }, 400);
    }
    if (result.status === "not_found") {
      return json({ ...result, requestId: auditContext.requestId }, 404);
    }
    return json({ ...result, requestId: auditContext.requestId });
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const message = parsed.value.message;
    if (
      typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > MAX_MESSAGE_CHARACTERS
    ) {
      return json({ error: "invalid_message" }, 400);
    }
    const result = await stub.chat(message, auditContext);
    if (result.mcpRequired) {
      return json(
        {
          error: "mcp_not_connected",
          status: "requires_connect",
          requestId: auditContext.requestId
        },
        409
      );
    }
    return json({ ...result, requestId: auditContext.requestId });
  }

  if (url.pathname === "/api/tool-test" && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const tool = parsed.value.tool;
    if (typeof tool !== "string" || tool.length > 64) {
      return json({ error: "invalid_tool" }, 400);
    }
    const rawArgs = parsed.value.args;
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : rawArgs === undefined
          ? {}
          : null;
    if (args === null) return json({ error: "invalid_args" }, 400);
    const result: { status: string; detail?: string; result?: unknown } =
      await stub.toolTest(tool, args, auditContext);
    if (result.status === "invalid_args") {
      return json({ ...result, requestId: auditContext.requestId }, 400);
    }
    return json({ ...result, requestId: auditContext.requestId });
  }

  if (url.pathname === "/api/dlp-test" && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const result = await stub.dlpTest(auditContext);
    return json({ ...result, requestId: auditContext.requestId });
  }

  return json({ error: "not_found" }, 404);
}

function portalResultJson(
  result: { status: string },
  requestId: string
): Response {
  const status =
    result.status === "requires_connect"
      ? 409
      : result.status === "unsupported"
        ? 404
        : result.status === "error"
          ? 502
          : 200;
  return json({ ...result, requestId }, status);
}

export default {
  fetch(request: Request, env: AgentDemoEnv, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  }
};
