import { Agent, getAgentByName } from "agents";
import { wrapAISDK } from "agents/observability/ai";
import * as ai from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import {
  authenticate,
  checkBrowserOrigin,
  isLocalEnvironment,
  isLoopbackRequest,
  looksLikePlaceholder,
  sha256Hex,
  type AccessEnv,
  type AccessIdentity,
  type DemoRole
} from "../shared/access.js";
import { readBoundedText } from "../shared/body.js";
import { CANONICAL_TOOLS, type CanonicalTool } from "../shared/demo-tools.js";
import { captureDlpOutcome, lastBlock, type DlpOutcome } from "./dlp.js";
import { renderPage } from "./ui.js";
import {
  DEMO_SCENARIOS,
  DOCUMENT_IDS,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARACTERS,
  MAX_TOOL_STEPS,
  STOCK_IDS,
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
  DASHSCOPE_API_KEY?: string;
  CF_AIG_TOKEN?: string;
}

type ModelFetch = typeof fetch;

let modelFetchOverride: ModelFetch | undefined;

export function __setModelFetchForTests(impl: ModelFetch | undefined): void {
  modelFetchOverride = impl;
}

const DEFAULT_MODEL_ID = "qwen3.8-2.4t-a95b";
const OAUTH_STATE_TTL = 1800;
const OAUTH_CALLBACK_PATH = "mcp-oauth-callback";

interface AgentStateShape {
  history: { role: "user" | "assistant"; content: string }[];
  conversationId: string;
  lastRole?: DemoRole;
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

const SINGLE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function modelConfigured(env: AgentDemoEnv): boolean {
  const { ACCOUNT_ID, GATEWAY_ID, DASHSCOPE_API_KEY, CF_AIG_TOKEN } = env;
  if (!ACCOUNT_ID || !GATEWAY_ID || !DASHSCOPE_API_KEY || !CF_AIG_TOKEN) return false;
  if (
    [ACCOUNT_ID, GATEWAY_ID, DASHSCOPE_API_KEY, CF_AIG_TOKEN].some((v) =>
      looksLikePlaceholder(v)
    )
  ) {
    return false;
  }
  return SINGLE_SEGMENT.test(ACCOUNT_ID) && SINGLE_SEGMENT.test(GATEWAY_ID);
}

function buildChatModel(env: AgentDemoEnv, dlpSink: DlpOutcome[]) {
  if (!modelConfigured(env)) return null;
  const baseURL = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY_ID}/custom-dashscope/compatible-mode/v1`;
  const innerFetch: ModelFetch = modelFetchOverride ?? fetch.bind(globalThis);
  const provider = createOpenAICompatible({
    name: "dashscope",
    baseURL,
    apiKey: env.DASHSCOPE_API_KEY,
    headers: {
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
      "cf-aig-skip-cache": "true"
    },
    fetch: async (input, init) => {
      const resp = await innerFetch(input, init);
      try {
        await captureDlpOutcome(resp.clone(), dlpSink);
      } catch {
      }
      if (lastBlock(dlpSink)) {
        throw new Error("dlp_blocked");
      }
      return resp;
    }
  });
  return provider.chatModel((env.MODEL_ID || DEFAULT_MODEL_ID) as never);
}

function buildTools(
  agent: ResearchAgent,
  role: DemoRole,
  events: ChatEvent[]
): ai.ToolSet {
  const execute = (canonical: CanonicalTool) => async (args: Record<string, unknown>) => {
    events.push({ text: `工具调用 ${canonical}`, kind: "" });
    const result = await agent.callRemoteTool(canonical, args, role);
    agent.audit("tool-execute", canonical, result.status, role);
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
  const available = new Set(agent.availableCanonical(role));
  const tools: ai.ToolSet = {};
  if (available.has("list_demo_stocks")) {
    tools.list_demo_stocks = ai.tool({
      description: TOOL_DESCRIPTIONS.list_demo_stocks,
      inputSchema: z.object({}),
      execute: execute("list_demo_stocks")
    });
  }
  if (available.has("get_latest_analysis")) {
    tools.get_latest_analysis = ai.tool({
      description: TOOL_DESCRIPTIONS.get_latest_analysis,
      inputSchema: z.object({ stock_id: z.enum(STOCK_IDS) }),
      execute: async (args: { stock_id: string }) =>
        execute("get_latest_analysis")({ stock_id: args.stock_id })
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

  onStart(): void {
    const origin = configuredOrigin(this.env) ?? "";
    if (origin) {
      this.mcp.configureOAuthCallback({
        successRedirect: origin,
        errorRedirect: origin
      });
    }
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
      this.setState({
        history: [],
        conversationId: crypto.randomUUID(),
        lastRole: role
      });
    }
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

  mcpStatus(): { connected: boolean; state: string; error: string | null } {
    const entry = this.researchRegistration();
    const state = entry?.state != null ? String(entry.state) : "disconnected";
    const url = mcpServerUrlAllowed(this.env);
    const urlMatches = !!entry && !!url && entry.server_url === url;
    return {
      connected: state === "ready" && urlMatches,
      state: !entry || urlMatches ? state : "stale",
      error: entry?.error ? "mcp_error" : null
    };
  }

  availableCanonical(role: DemoRole): string[] {
    const allowed: CanonicalTool[] =
      role === "analyst" ? CANONICAL_TOOLS : ["list_demo_stocks", "get_latest_analysis"];
    const discovered = this.discoveredRemoteNames();
    if (discovered.size === 0) return [];
    return allowed.filter((c) => {
      const remote = remoteName(this.env, c);
      return remote !== null && discovered.has(remote);
    });
  }

  async getSessionData(role: DemoRole) {
    this.syncRole(role);
    return {
      history: this.state.history,
      conversationId: this.ensureConversationId(),
      mcp: this.mcpStatus(),
      tools: this.availableCanonical(role),
      expectedTools:
        role === "analyst" ? [...CANONICAL_TOOLS] : ["list_demo_stocks", "get_latest_analysis"]
    };
  }

  async connectMcp(): Promise<{ status: string; authUrl?: string; state?: string }> {
    const url = mcpServerUrlAllowed(this.env);
    if (!url) return { status: "unconfigured" };
    const origin = configuredOrigin(this.env);
    if (!origin && !(isLocalEnvironment(this.env))) {
      return { status: "unconfigured" };
    }
    const callbackHost =
      origin ??
      (isLocalEnvironment(this.env) ? "http://localhost:8787" : "");
    const existing = this.mcpStatus();
    if (existing.connected) return { status: "ready" };
    const registered = this.researchRegistration();
    if (registered && registered.server_url !== url) {
      await this.removeMcpServer("research");
    }
    const result = await this.addMcpServer("research", url, {
      id: "research",
      callbackHost,
      callbackPath: OAUTH_CALLBACK_PATH
    });
    if (result.state === "authenticating") {
      const authUrl = result.authUrl;
      let state: string | undefined;
      try {
        state = new URL(authUrl).searchParams.get("state") ?? undefined;
      } catch {
        state = undefined;
      }
      return { status: "authenticating", authUrl, state };
    }
    return { status: "ready" };
  }

  async callRemoteTool(
    canonical: CanonicalTool,
    args: Record<string, unknown>,
    role: DemoRole
  ): Promise<{ status: "ok" | "denied" | "unavailable" | "error"; detail?: string; payload?: unknown }> {
    if (role !== "analyst" && canonical === "read_research_document") {
      return { status: "denied", detail: "viewer 无权访问研究文档" };
    }
    if (!CANONICAL_TOOLS.includes(canonical)) {
      return { status: "denied", detail: "unknown_tool" };
    }
    if (!this.mcpStatus().connected) {
      return { status: "unavailable", detail: "MCP 未连接或连接已过期" };
    }
    const remote = remoteName(this.env, canonical);
    if (remote === null || !this.discoveredRemoteNames().has(remote)) {
      return { status: "unavailable", detail: "工具未在已连接服务中公布" };
    }
    try {
      const result = (await this.mcp.callTool({
        serverId: "research",
        name: remote,
        arguments: args
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
    } catch {
      return { status: "error", detail: "工具调用失败" };
    }
  }

  private validateToolArgs(
    tool: CanonicalTool,
    args: Record<string, unknown>
  ): Record<string, unknown> | null {
    const keys = Object.keys(args);
    if (tool === "list_demo_stocks") {
      return keys.length === 0 ? {} : null;
    }
    if (tool === "get_latest_analysis") {
      return keys.length === 1 &&
        typeof args.stock_id === "string" &&
        (STOCK_IDS as readonly string[]).includes(args.stock_id)
        ? { stock_id: args.stock_id }
        : null;
    }
    return keys.length === 1 &&
      typeof args.document_id === "string" &&
      (DOCUMENT_IDS as readonly string[]).includes(args.document_id)
      ? { document_id: args.document_id }
      : null;
  }

  audit(action: string, tool: string, status: string, role: DemoRole): void {
    const canonical = CANONICAL_TOOLS.includes(tool as CanonicalTool) ? tool : "unknown";
    console.info(
      JSON.stringify({
        event: "tool_audit",
        action,
        tool: canonical,
        status,
        role,
        conversationId: this.ensureConversationId()
      })
    );
  }

  async toolTest(
    tool: string,
    args: Record<string, unknown>,
    role: DemoRole
  ): Promise<{ status: string; detail?: string; result?: unknown }> {
    if (!CANONICAL_TOOLS.includes(tool as CanonicalTool)) {
      this.audit("tool-test", tool, "denied", role);
      return { status: "denied", detail: "unknown_tool" };
    }
    if ((tool as CanonicalTool) === "read_research_document" && role !== "analyst") {
      this.audit("tool-test", tool, "denied", role);
      return { status: "denied", detail: "viewer 无权访问研究文档" };
    }
    const validated = this.validateToolArgs(tool as CanonicalTool, args);
    if (validated === null) {
      this.audit("tool-test", tool, "invalid_args", role);
      return { status: "invalid_args", detail: "参数未通过本地校验" };
    }
    const outcome = await this.callRemoteTool(tool as CanonicalTool, validated, role);
    this.audit("tool-test", tool, outcome.status, role);
    if (outcome.status === "ok") return { status: "ok", result: outcome.payload };
    return { status: outcome.status, detail: outcome.detail };
  }

  private telemetry(role: DemoRole, action: string) {
    return {
      isEnabled: true,
      functionId: "stock-research-demo",
      metadata: {
        agentId: "research-agent",
        conversationId: this.ensureConversationId(),
        role,
        action
      }
    };
  }

  async chat(
    message: string,
    identity: AccessIdentity
  ): Promise<{ reply: string; events: ChatEvent[]; dlp?: DlpOutcome; mcpRequired?: boolean }> {
    this.syncRole(identity.role);
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
      const model = buildChatModel(this.env, dlpSink);
      if (!model) {
        return { reply: "模型网关未配置，演示无法调用模型。", events };
      }
      const history = this.state.history.slice(-MAX_HISTORY_MESSAGES);
      const userMessage = { role: "user" as const, content: message };
      const traced = wrapAISDK(ai, { storeMessages: false, storeTools: false });
      const tools = buildTools(this, identity.role, events);
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
          experimental_telemetry: this.telemetry(identity.role, "chat")
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
    role: DemoRole
  ): Promise<{ dlp?: DlpOutcome; reply?: string; error?: string }> {
    const dlpSink: DlpOutcome[] = [];
    const model = buildChatModel(this.env, dlpSink);
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
        experimental_telemetry: this.telemetry(role, "dlp-test")
      });
      const outcome =
        lastBlock(dlpSink) ??
        [...dlpSink].reverse().find((o) => o.action === "FLAG") ??
        { action: "NONE" as const, detail: "model_returned" };
      return { dlp: outcome, reply: outcome.action === "NONE" ? result.text : undefined };
    } catch {
      const blocked = lastBlock(dlpSink);
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
            localSimulation: identity.localSimulation
          },
          history: session.history,
          scenarios: DEMO_SCENARIOS,
          mcp: session.mcp,
          tools: session.tools,
          expectedTools: session.expectedTools,
          conversationId: session.conversationId,
          setup: {
            mcpConfigured: mcpServerUrlAllowed(env) !== null,
            modelConfigured: modelConfigured(env),
            tracingWrapped: true
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
        localSimulation: identity.localSimulation
      },
      history: session.history,
      conversationId: session.conversationId,
      mcp: session.mcp,
      tools: session.tools,
      expectedTools: session.expectedTools,
      setup: {
        mcpConfigured: mcpServerUrlAllowed(env) !== null,
        modelConfigured: modelConfigured(env),
        tracingWrapped: true
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
    const result = await stub.connectMcp();
    if (result.status === "authenticating" && result.state) {
      await env.CALLBACK_KV.put(`oauth-state:${result.state}`, doName, {
        expirationTtl: OAUTH_STATE_TTL
      });
    }
    return json({ status: result.status, authUrl: result.authUrl });
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
    const result = await stub.chat(message, identity);
    if (result.mcpRequired) {
      return json({ error: "mcp_not_connected", status: "requires_connect" }, 409);
    }
    return json(result);
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
      await stub.toolTest(tool, args, identity.role);
    if (result.status === "invalid_args") {
      return json(result, 400);
    }
    return json(result);
  }

  if (url.pathname === "/api/dlp-test" && request.method === "POST") {
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const result = await stub.dlpTest(identity.role);
    return json(result);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  fetch(request: Request, env: AgentDemoEnv, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  }
};
