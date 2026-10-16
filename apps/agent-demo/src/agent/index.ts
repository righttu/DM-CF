import { Agent, getAgentByName } from "agents";
import type { ElicitRequest, ElicitResult } from "agents/mcp/client";
import { wrapAISDK } from "agents/observability/ai";
import * as ai from "ai";
// import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createWorkersAI } from "workers-ai-provider";
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
import { captureDlpFromError, lastBlock, type DlpOutcome } from "./dlp.js";
import { renderPage, pageScriptHash } from "./ui.js";
import {
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARACTERS,
  MAX_TOOL_STEPS,
  SUGGESTED_PROMPTS,
  SYSTEM_PROMPT
} from "../research-policy.js";

interface AgentDemoEnv extends AccessEnv {
  ResearchAgent: DurableObjectNamespace<ResearchAgent>;
  CALLBACK_KV: KVNamespace;
  AGENT_ACCESS_AUD?: string;
  PUBLIC_ORIGIN?: string;
  MCP_SERVER_URL?: string;
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
// const DEFAULT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_MODEL_ID = "@cf/zai-org/glm-5.3-flash";

const MODEL_SETTINGS: Record<
  string,
  { reasoning_effort?: "low" | "medium" | "high" | null; chat_template_kwargs?: Record<string, unknown> }
> = {
  "@cf/zai-org/glm-5.3-flash": { reasoning_effort: "low" },
  "@cf/moonshotai/kimi-k2.6": { chat_template_kwargs: { thinking: false } }
};
const OAUTH_STATE_TTL = 1800;
const OAUTH_CALLBACK_PATH = "mcp-oauth-callback";

interface PendingPortal {
  id: string;
  url: string;
  message: string;
  expiresAt: number;
}

type ChatTurn = { role: "user" | "assistant"; content: string };

interface StoredSession {
  id: string;
  title: string;
  updatedAt: number;
  history: ChatTurn[];
}

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  current: boolean;
}

const MAX_SESSIONS = 20;
const MAX_STORED_MESSAGES = 60;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionTitle(history: ChatTurn[]): string {
  const first = history.find((m) => m.role === "user")?.content.trim() ?? "";
  if (!first) return "新会话";
  return first.length > 28 ? `${first.slice(0, 28)}…` : first;
}

interface AgentStateShape {
  history: ChatTurn[];
  conversationId: string;
  sessions?: StoredSession[];
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
  server?: string;
  tool?: string;
  status?: string;
  durationMs?: number;
}

const SERVER_LABELS: Record<string, string> = {
  "research-demo": "Research MCP-S",
  "abc-quant": "Quant MCP-S"
};

const PORTAL_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: unknown;
  server: string;
  label: string;
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
          const inputs = args[1] as { tools?: unknown[]; tool_choice?: unknown } | undefined;
          if (inputs && Array.isArray(inputs.tools) && inputs.tools.length === 0) {
            delete inputs.tools;
            delete inputs.tool_choice;
          }
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
        user: context.userEmail ?? context.actorId,
        conversation_id: conversationId,
        request_id: context.requestId,
        role: context.role,
        action
      }
    }
  });
  const modelId = env.MODEL_ID || DEFAULT_MODEL_ID;
  return workersai(modelId as never, (MODEL_SETTINGS[modelId] ?? {}) as never);
}

type ChatSignal =
  | { type: "step"; text: string; kind: ChatEvent["kind"] }
  | { type: "delta"; text: string };

interface ChatOutcome {
  reply: string;
  events: ChatEvent[];
  dlp?: DlpOutcome;
  mcpRequired?: boolean;
  stopped?: boolean;
}

const BLOCKED_REPLY = "该请求被 AI Gateway DLP 策略拦截（云端确认），未返回模型内容。";

function buildTools(
  agent: ResearchAgent,
  context: AuditContext,
  events: ChatEvent[],
  onEvent?: (event: ChatEvent) => void
): ai.ToolSet {
  const seen = new Map<string, unknown>();
  const record = (event: ChatEvent) => {
    events.push(event);
    onEvent?.(event);
  };
  const tools: ai.ToolSet = {};
  for (const tool of agent.discoveredTools()) {
    tools[tool.name] = ai.tool({
      description: tool.description || tool.name,
      inputSchema: ai.jsonSchema(
        (tool.inputSchema ?? { type: "object", properties: {} }) as Parameters<
          typeof ai.jsonSchema
        >[0]
      ),
      execute: async (args: Record<string, unknown>) => {
        const key = `${tool.name}:${JSON.stringify(args)}`;
        if (seen.has(key)) {
          return { already_retrieved: true, result: seen.get(key) };
        }
        const started = Date.now();
        record({ text: `工具调用 ${tool.name}`, kind: "", server: tool.server, tool: tool.name, status: "running" });
        const result = await agent.callPortalTool(tool.name, args, context);
        const durationMs = Date.now() - started;
        if (result.status === "ok") seen.set(key, result.payload);
        agent.audit(context, "tool-execute", tool.name, result.status);
        const kind = result.status === "ok" ? "ok" : "denied";
        record({
          text:
            result.status === "ok"
              ? `工具返回 ${tool.name}`
              : `工具${result.status === "denied" ? "被拒绝" : "不可用/出错"} ${tool.name}`,
          kind,
          server: tool.server,
          tool: tool.name,
          status: result.status,
          durationMs
        });
        return result.payload ?? { error: result.status };
      }
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
        sessions: [],
        lastRole: role,
        pendingPortal: null
      });
    }
  }

  private sessionSummaries(): SessionSummary[] {
    const current = this.state.history;
    const list: SessionSummary[] = (this.state.sessions ?? []).map((x) => ({
      id: x.id,
      title: x.title,
      updatedAt: x.updatedAt,
      messageCount: x.history.length,
      current: false
    }));
    list.push({
      id: this.ensureConversationId(),
      title: sessionTitle(current),
      updatedAt: Date.now(),
      messageCount: current.length,
      current: true
    });
    return list.sort((a, b) => (a.current ? -1 : b.current ? 1 : b.updatedAt - a.updatedAt));
  }

  private archiveCurrent(): StoredSession[] {
    const others = this.state.sessions ?? [];
    if (this.state.history.length === 0) return others;
    const archived: StoredSession = {
      id: this.ensureConversationId(),
      title: sessionTitle(this.state.history),
      updatedAt: Date.now(),
      history: this.state.history
    };
    return [archived, ...others].slice(0, MAX_SESSIONS - 1);
  }

  private sessionPayload() {
    return {
      history: this.state.history,
      conversationId: this.ensureConversationId(),
      sessions: this.sessionSummaries()
    };
  }

  async newSession(role: DemoRole): Promise<{ status: "ok" | "busy" } & Partial<ReturnType<ResearchAgent["sessionPayload"]>>> {
    this.syncRole(role);
    if (this.busy) return { status: "busy" };
    if (this.state.history.length > 0) {
      this.setState({
        ...this.state,
        sessions: this.archiveCurrent(),
        history: [],
        conversationId: crypto.randomUUID()
      });
    }
    return { status: "ok", ...this.sessionPayload() };
  }

  async switchSession(
    role: DemoRole,
    id: unknown
  ): Promise<{ status: "ok" | "busy" | "invalid" | "not_found" } & Partial<ReturnType<ResearchAgent["sessionPayload"]>>> {
    this.syncRole(role);
    if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) return { status: "invalid" };
    if (this.busy) return { status: "busy" };
    if (id === this.ensureConversationId()) return { status: "ok", ...this.sessionPayload() };
    const target = (this.state.sessions ?? []).find((x) => x.id === id);
    if (!target) return { status: "not_found" };
    const remaining = this.archiveCurrent().filter((x) => x.id !== id);
    this.setState({
      ...this.state,
      sessions: remaining,
      history: target.history,
      conversationId: target.id
    });
    return { status: "ok", ...this.sessionPayload() };
  }

  async deleteSession(
    role: DemoRole,
    id: unknown
  ): Promise<{ status: "ok" | "busy" | "invalid" | "not_found" } & Partial<ReturnType<ResearchAgent["sessionPayload"]>>> {
    this.syncRole(role);
    if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) return { status: "invalid" };
    if (this.busy) return { status: "busy" };
    const others = this.state.sessions ?? [];
    if (id === this.ensureConversationId()) {
      const [next, ...rest] = [...others].sort((a, b) => b.updatedAt - a.updatedAt);
      this.setState({
        ...this.state,
        sessions: rest,
        history: next ? next.history : [],
        conversationId: next ? next.id : crypto.randomUUID()
      });
      return { status: "ok", ...this.sessionPayload() };
    }
    if (!others.some((x) => x.id === id)) return { status: "not_found" };
    this.setState({ ...this.state, sessions: others.filter((x) => x.id !== id) });
    return { status: "ok", ...this.sessionPayload() };
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

  discoveredTools(): DiscoveredTool[] {
    const out: DiscoveredTool[] = [];
    for (const tool of this.mcp.listTools({ serverId: "research" })) {
      const name = typeof tool?.name === "string" ? tool.name : "";
      if (!PORTAL_TOOL_NAME.test(name) || name.startsWith("portal_")) continue;
      const server =
        Object.keys(SERVER_LABELS).find((id) => name.startsWith(`${id}_`)) ?? "";
      out.push({
        name,
        description: typeof tool?.description === "string" ? tool.description : "",
        inputSchema: tool?.inputSchema,
        server,
        label: server ? SERVER_LABELS[server] : "MCP"
      });
    }
    return out;
  }

  private discoveredServers(): { id: string; label: string; tools: string[] }[] {
    const groups = new Map<string, { id: string; label: string; tools: string[] }>();
    for (const t of this.discoveredTools()) {
      let g = groups.get(t.server);
      if (!g) {
        g = { id: t.server, label: t.label, tools: [] };
        groups.set(t.server, g);
      }
      g.tools.push(t.name);
    }
    return [...groups.values()];
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
      sessions: this.sessionSummaries(),
      mcp: {
        ...mcp,
        detail: mcp.detail ?? this.state.lastMcpFailure ?? null
      },
      servers: this.discoveredServers(),
      suggestions: SUGGESTED_PROMPTS[role],
      modelId: this.env.MODEL_ID || DEFAULT_MODEL_ID,
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

  async callPortalTool(
    name: string,
    args: Record<string, unknown>,
    context: AuditContext
  ): Promise<{ status: "ok" | "denied" | "unavailable" | "error"; detail?: string; payload?: unknown }> {
    const current = this.mcpStatus();
    if (!current.connected) {
      return {
        status: "unavailable",
        detail: `MCP 未连接或连接已过期（状态：${current.state}${current.detail ? "；" + current.detail : ""}）`
      };
    }
    if (
      !PORTAL_TOOL_NAME.test(name) ||
      name.startsWith("portal_") ||
      !this.discoveredRemoteNames().has(name)
    ) {
      return { status: "denied", detail: "工具未在已连接服务中公布" };
    }
    try {
      const result = (await this.mcp.callTool({
        serverId: "research",
        name,
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

  audit(
    context: AuditContext,
    action: string,
    tool: string,
    status: string,
    event: "tool_audit" | "mcp_audit" = "tool_audit"
  ): void {
    console.info(
      JSON.stringify({
        event,
        action,
        tool: typeof tool === "string" ? tool.slice(0, 64) : "unknown",
        status,
        role: context.role,
        actorId: context.actorId,
        requestId: context.requestId,
        identitySource: context.identitySource,
        conversationId: this.ensureConversationId()
      })
    );
  }

  private telemetry(context: AuditContext, action: string) {
    return {
      isEnabled: true,
      functionId: "abc-research-agent",
      metadata: {
        agentId: context.userEmail ?? context.actorId,
        "user.id": context.userEmail ?? context.actorId,
        conversationId: this.ensureConversationId(),
        role: context.role,
        action,
        actorId: context.actorId,
        userEmail: context.userEmail ?? "",
        requestId: context.requestId,
        identitySource: context.identitySource
      }
    };
  }

  async chat(message: string, context: AuditContext): Promise<ChatOutcome> {
    return this.runChat(message, context, () => undefined);
  }

  chatStream(message: string, context: AuditContext): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const abort = new AbortController();
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (value: unknown) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
          } catch {
          }
        };
        this.runChat(message, context, write, abort.signal)
          .then((outcome) =>
            write({
              type: "done",
              reply: outcome.reply,
              stopped: outcome.stopped === true,
              dlp: outcome.dlp,
              mcpRequired: outcome.mcpRequired === true,
              requestId: context.requestId
            })
          )
          .catch(() => write({ type: "error", requestId: context.requestId }))
          .finally(() => {
            try {
              controller.close();
            } catch {
            }
          });
      },
      cancel: () => {
        abort.abort();
      }
    });
  }

  private async runChat(
    message: string,
    context: AuditContext,
    emit: (signal: ChatSignal) => void,
    signal?: AbortSignal
  ): Promise<ChatOutcome> {
    await this.ensureMcpReady();
    this.syncRole(context.role);
    const events: ChatEvent[] = [];
    const record = (event: ChatEvent) => {
      events.push(event);
      emit({ type: "step", ...event });
    };
    if (this.busy) {
      record({ text: "上一次对话仍在进行中", kind: "denied" });
      return { reply: "", events };
    }
    if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE_CHARACTERS) {
      return { reply: "消息为空或超出长度限制。", events };
    }
    if (!this.mcpStatus().connected) {
      return { reply: "", events, mcpRequired: true };
    }
    this.busy = true;
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
      const telemetry = this.telemetry(context, "chat");
      const blockedOutcome = (): ChatOutcome | null => {
        const blocked = lastBlock(dlpSink);
        if (!blocked) return null;
        record({ text: "DLP 拦截（云端确认）", kind: "denied" });
        return { reply: BLOCKED_REPLY, events, dlp: blocked };
      };

      const tools = buildTools(this, context, events, (e) => emit({ type: "step", ...e }));
      const result = traced.streamText({
        model,
        system: SYSTEM_PROMPT,
        messages: [...history, userMessage],
        tools,
        stopWhen: ai.stepCountIs(MAX_TOOL_STEPS),
        prepareStep: ({
          stepNumber,
          steps
        }: {
          stepNumber: number;
          steps: { toolResults?: { output?: unknown }[] }[];
        }) => {
          const previous = steps[steps.length - 1]?.toolResults ?? [];
          const onlyRepeats =
            previous.length > 0 &&
            previous.every(
              (r) => (r.output as { already_retrieved?: boolean } | undefined)?.already_retrieved
            );
          return stepNumber >= MAX_TOOL_STEPS - 1 || onlyRepeats
            ? { activeTools: [] as never[] }
            : undefined;
        },
        maxRetries: 0,
        maxOutputTokens: 2048,
        experimental_telemetry: telemetry,
        abortSignal: signal,
        onError: () => undefined
      });
      let text = "";
      let errored = false;
      let stepHasText = false;
      try {
        for await (const part of result.fullStream as AsyncIterable<{
          type: string;
          text?: string;
        }>) {
          if (part.type === "start-step") {
            stepHasText = false;
          } else if (part.type === "text-delta" && typeof part.text === "string") {
            let delta = part.text;
            if (!stepHasText && text.length > 0) delta = `\n\n${delta}`;
            stepHasText = true;
            text += delta;
            emit({ type: "delta", text: delta });
          } else if (part.type === "error") {
            errored = true;
          }
        }
      } catch (streamError) {
        if (!signal?.aborted) throw streamError;
      }
      if (signal?.aborted) {
        const partial = text.trim();
        if (!partial) return { reply: "", events, stopped: true };
        const reply = `${partial}\n\n（已停止生成）`;
        this.persistTurn(userMessage, reply);
        record({ text: "已停止生成", kind: "denied" });
        return { reply, events, stopped: true };
      }
      const blocked = blockedOutcome();
      if (blocked) return blocked;
      if (errored && !text.trim()) {
        record({ text: "模型调用失败", kind: "denied" });
        return { reply: "模型调用失败，请稍后重试。", events };
      }
      const reply = text.trim();
      if (!reply) {
        record({ text: "模型未给出文字回答", kind: "denied" });
        return { reply: "模型没有给出回答，请换一种问法重试。", events };
      }
      const flag = [...dlpSink].reverse().find((o) => o.action === "FLAG");
      if (flag) record({ text: "DLP 标记（未拦截，云端确认）", kind: "denied" });
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
    ].slice(-MAX_STORED_MESSAGES);
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
    const traced = wrapAISDK(ai, { storeMessages: false, storeTools: false });
    try {
      const result = await traced.generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: "CF_DEMO_SECRET_9274",
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
    userEmail: identity.email,
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
          mcp: session.mcp,
          servers: session.servers,
          suggestions: session.suggestions,
          modelId: session.modelId,
          conversationId: session.conversationId,
          sessions: session.sessions,
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
          "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' 'sha256-${await pageScriptHash()}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
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
      sessions: session.sessions,
      mcp: session.mcp,
      servers: session.servers,
      suggestions: session.suggestions,
      modelId: session.modelId,
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

  if (url.pathname.startsWith("/api/sessions/") && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const action = url.pathname.slice("/api/sessions/".length);
    let result: { status: string };
    if (action === "new") {
      result = await stub.newSession(identity.role);
    } else if (action === "switch") {
      result = await stub.switchSession(identity.role, parsed.value.id);
    } else if (action === "delete") {
      if (parsed.value.confirm !== true) return json({ error: "confirmation_required" }, 400);
      result = await stub.deleteSession(identity.role, parsed.value.id);
    } else {
      return json({ error: "not_found" }, 404);
    }
    const status =
      result.status === "ok"
        ? 200
        : result.status === "busy"
          ? 409
          : result.status === "not_found"
            ? 404
            : 400;
    return json({ ...result, requestId: auditContext.requestId }, status);
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

  if (url.pathname === "/api/chat/stream" && request.method === "POST") {
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
    const stream = await stub.chatStream(message, auditContext);
    return new Response(stream, {
      headers: {
        ...SECURITY_HEADERS,
        "content-type": "application/x-ndjson; charset=utf-8"
      }
    });
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
