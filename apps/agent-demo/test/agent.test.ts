import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { Agent, getAgentByName } from "agents";
import { MCPClientManager } from "agents/mcp/client";
import { __setModelFetchForTests } from "../src/agent/index.js";
import { sha256Hex } from "../src/shared/access.js";
import { SYSTEM_PROMPT } from "../src/research-policy.js";
import {
  ANALYST_EMAIL,
  VIEWER_EMAIL,
  authedFetch,
  connectAgentMcp,
  signJwt
} from "./helpers.js";

function openAiResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function toolCallResponse(calls: { id: string; name: string; args: string }[]) {
  return openAiResponse({
    id: "r1",
    object: "chat.completion",
    created: 0,
    model: "qwen3.8-2.4t-a95b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args }
          }))
        },
        finish_reason: "tool_calls"
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  });
}

function textResponse(text: string) {
  return openAiResponse({
    id: "r2",
    object: "chat.completion",
    created: 0,
    model: "qwen3.8-2.4t-a95b",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  });
}

afterEach(() => {
  __setModelFetchForTests(undefined);
  vi.restoreAllMocks();
});

function spyNativeTools(native: { list?: unknown; manage?: unknown }) {
  const origList = MCPClientManager.prototype.listTools;
  const origCall = MCPClientManager.prototype.callTool;
  vi.spyOn(MCPClientManager.prototype, "listTools").mockImplementation(
    function (this: unknown, options: unknown) {
      const tools = (origList as (...a: unknown[]) => { name?: string }[]).call(
        this,
        options
      );
      return [
        ...tools,
        { name: "portal_list_servers" },
        { name: "portal_toggle_servers" }
      ];
    } as never
  );
  const callSpy = vi.spyOn(MCPClientManager.prototype, "callTool").mockImplementation(
    function (this: unknown, params: { name: string }) {
      if (params.name === "portal_list_servers") {
        return Promise.resolve(native.list);
      }
      if (params.name === "portal_toggle_servers") {
        return Promise.resolve(native.manage);
      }
      return (origCall as (...a: unknown[]) => Promise<unknown>).call(this, params);
    } as never
  );
  return { callSpy };
}

function spyNoNativeTools() {
  const origList = MCPClientManager.prototype.listTools;
  vi.spyOn(MCPClientManager.prototype, "listTools").mockImplementation(
    function (this: unknown, options: unknown) {
      return (origList as (...a: unknown[]) => { name?: string }[]).call(
        this,
        options
      );
    } as never
  );
}

type QueuedAgent = {
  queuePortalUrl(
    request: unknown,
    serverId: string,
    signal?: AbortSignal
  ): Promise<{ action: string }>;
};

async function agentStub(sub: string) {
  return getAgentByName(
    (env as unknown as { ResearchAgent: never }).ResearchAgent,
    await sha256Hex(sub)
  );
}

function queuePortalOn(
  stub: unknown,
  request: unknown,
  signal?: AbortSignal
): Promise<{ action: string }> {
  return runInDurableObject(stub as never, (instance) =>
    (instance as unknown as QueuedAgent).queuePortalUrl(
      request,
      "research",
      signal
    )
  );
}

async function sessionPortal(jwt: string) {
  const resp = await authedFetch("/api/session", { jwt });
  const data = (await resp.json()) as {
    portal?: { pending?: { id: string; url: string; message: string } | null };
    history?: unknown[];
  };
  return data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function metadataHeader(input: unknown, init: unknown): string | null {
  const headers = (init as { headers?: HeadersInit } | undefined)?.headers;
  const fromInit = headers ? new Headers(headers).get("cf-aig-metadata") : null;
  if (fromInit) return fromInit;
  return input instanceof Request ? input.headers.get("cf-aig-metadata") : null;
}

describe("ResearchAgent chat and tools", () => {
  it("mocked Qwen invokes both report tools over real MCP then returns final text", async () => {
    const jwt = await signJwt({ sub: "sub-chat-1", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-chat-1", email: ANALYST_EMAIL });

    const requests: {
      url: string;
      body: { messages?: unknown[]; tools?: { function?: { name: string } }[] };
      metadata: string | null;
    }[] = [];
    let call = 0;
    __setModelFetchForTests(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      requests.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")),
        metadata: metadataHeader(input, init)
      });
      call += 1;
      if (call === 1) {
        return toolCallResponse([
          { id: "c1", name: "get_latest_analysis", args: "{\"stock_id\":\"DEMO001\"}" },
          { id: "c2", name: "get_latest_analysis", args: "{\"stock_id\":\"DEMO002\"}" }
        ]);
      }
      return textResponse("最终回答：两个模拟报告已比较。");
    });

    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "比较 DEMO001 与 DEMO002" }
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      reply: string;
      events: { text: string; kind: string }[];
      requestId: string;
    };
    expect(data.reply).toBe("最终回答：两个模拟报告已比较。");
    expect(data.requestId).toMatch(UUID_RE);
    const meta = JSON.parse(requests[0].metadata!) as Record<string, string>;
    expect(Object.keys(meta).sort()).toEqual(
      ["action", "actor_id", "conversation_id", "request_id", "role"].sort()
    );
    expect(meta.actor_id).toBe(await sha256Hex("sub-chat-1"));
    expect(meta.request_id).toBe(data.requestId);
    expect(meta.role).toBe("analyst");
    expect(meta.action).toBe("chat");
    expect(JSON.stringify(meta)).not.toContain("@");
    expect(JSON.stringify(meta)).not.toContain("Bearer");
    expect(JSON.stringify(meta)).not.toContain("test-aig-token");
    expect(call).toBe(2);
    expect(requests[0].url).toContain("gateway.ai.cloudflare.com");
    expect(requests[0].url).toContain("custom-dashscope");
    const first = requests[0].body;
    expect((first.messages as { role: string; content?: unknown }[])[0].role).toBe("system");
    expect((first.messages as { role: string; content?: unknown }[])[0].content).toBe(SYSTEM_PROMPT);
    const offered = (first.tools ?? []).map((t) => t.function?.name);
    expect(offered).toContain("list_demo_stocks");
    expect(offered).toContain("get_latest_analysis");
    expect(offered).toContain("read_research_document");

    const second = JSON.stringify(requests[1].body.messages);
    expect(second).toContain("demo-report-a-20261012");
    expect(second).toContain("demo-report-b-20261012");
    expect(second).toContain("2026-10-12");
    expect(second).not.toContain("permission_denied");
    expect(second).not.toContain("unavailable");

    const okEvents = data.events.filter((e) => e.kind === "ok");
    const deniedEvents = data.events.filter((e) => e.kind === "denied");
    expect(okEvents.length).toBeGreaterThanOrEqual(2);
    expect(deniedEvents).toHaveLength(0);

    const session = await authedFetch("/api/session", { jwt });
    const sessionData = (await session.json()) as {
      conversationId: string;
      user: { actorId: string };
    };
    expect(meta.conversation_id).toBe(sessionData.conversationId);
    expect(sessionData.user.actorId).toBe(await sha256Hex("sub-chat-1"));
  });

  it("actor identity is server-derived per sub and ignores spoofed body fields", async () => {
    const jwtA = await signJwt({ sub: "sub-actor-a", email: ANALYST_EMAIL });
    const jwtB = await signJwt({ sub: "sub-actor-b", email: ANALYST_EMAIL });
    const sessionA1 = (await (
      await authedFetch("/api/session", { jwt: jwtA })
    ).json()) as { user: { actorId: string } };
    const sessionA2 = (await (
      await authedFetch("/api/session", { jwt: jwtA })
    ).json()) as { user: { actorId: string } };
    const sessionB = (await (
      await authedFetch("/api/session", { jwt: jwtB })
    ).json()) as { user: { actorId: string } };
    expect(sessionA1.user.actorId).toBe(sessionA2.user.actorId);
    expect(sessionA1.user.actorId).not.toBe(sessionB.user.actorId);
    expect(sessionA1.user.actorId).toBe(await sha256Hex("sub-actor-a"));

    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const resp = await authedFetch("/api/tool-test", {
        jwt: jwtA,
        method: "POST",
        body: {
          tool: "list_demo_stocks",
          args: {},
          actorId: "spoofed-actor",
          requestId: "spoofed-request",
          role: "admin"
        }
      });
      const data = (await resp.json()) as { requestId: string };
      expect(data.requestId).toMatch(UUID_RE);
      expect(data.requestId).not.toBe("spoofed-request");
      const records = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("tool_audit"))
        .map((s) => JSON.parse(s) as Record<string, unknown>);
      const rec = records.at(-1)!;
      expect(rec.actorId).toBe(await sha256Hex("sub-actor-a"));
      expect(rec.requestId).toBe(data.requestId);
      expect(rec.requestId).not.toBe("spoofed-request");
    } finally {
      spy.mockRestore();
    }
  });

  it("viewer is denied the document tool while connected, and never offered it", async () => {
    const jwt = await signJwt({ sub: "sub-chat-v", email: VIEWER_EMAIL });
    await connectAgentMcp({ sub: "sub-chat-v", email: VIEWER_EMAIL });

    const requests: { body: { tools?: { function?: { name: string } }[] } }[] = [];
    __setModelFetchForTests(async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return textResponse("ok");
    });

    const deny = await authedFetch("/api/tool-test", {
      jwt,
      method: "POST",
      body: { tool: "read_research_document", args: { document_id: "research-note-a" } }
    });
    const denyData = (await deny.json()) as { status: string };
    expect(denyData.status).toBe("denied");

    const list = await authedFetch("/api/tool-test", {
      jwt,
      method: "POST",
      body: { tool: "list_demo_stocks", args: {} }
    });
    const listData = (await list.json()) as { status: string; result?: { stocks?: unknown[] } };
    expect(listData.status).toBe("ok");
    expect(listData.result?.stocks).toHaveLength(2);

    await authedFetch("/api/chat", { jwt, method: "POST", body: { message: "hi" } });
    const offered = (requests[0]?.body.tools ?? []).map((t) => t.function?.name);
    expect(offered).not.toContain("read_research_document");
    expect(offered).toContain("list_demo_stocks");
    expect(offered).toContain("get_latest_analysis");
  });

  it("chat returns 409 while MCP is disconnected", async () => {
    const jwt = await signJwt({ sub: "sub-disc", email: ANALYST_EMAIL });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "hi" }
    });
    expect(resp.status).toBe(409);
    const data = (await resp.json()) as { error: string };
    expect(data.error).toBe("mcp_not_connected");
  });

  it("portal-namespaced mapping with absent remote names fails closed", async () => {
    const jwt = await signJwt({ sub: "sub-portal", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-portal", email: ANALYST_EMAIL });
    const e = env as { MCP_TOOL_NAMES_JSON?: string };
    const original = e.MCP_TOOL_NAMES_JSON;
    e.MCP_TOOL_NAMES_JSON = JSON.stringify({
      get_latest_analysis: "portal.research.get_latest_analysis"
    });
    try {
      const test = await authedFetch("/api/tool-test", {
        jwt,
        method: "POST",
        body: { tool: "get_latest_analysis", args: { stock_id: "DEMO001" } }
      });
      const testData = (await test.json()) as { status: string };
      expect(testData.status).toBe("unavailable");

      const session = await authedFetch("/api/session", { jwt });
      const sessionData = (await session.json()) as { tools: string[] };
      expect(sessionData.tools).not.toContain("get_latest_analysis");
      expect(sessionData.tools).toContain("list_demo_stocks");
    } finally {
      e.MCP_TOOL_NAMES_JSON = original;
    }
  });

  it("enforces body bounds, content type, and JSON shape", async () => {
    const jwt = await signJwt({ sub: "sub-body", email: ANALYST_EMAIL });

    const declared = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      headers: { "content-length": "99999" },
      body: { message: "hi" }
    });
    expect(declared.status).toBe(413);

    const oversized = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "x".repeat(20000) }
    });
    expect(oversized.status).toBe(413);

    const wrongType = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: { message: "hi" } as unknown as BodyInit
    });
    expect(wrongType.status).toBe(415);

    const arrayBody = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: [1, 2, 3] as unknown as BodyInit
    });
    expect(arrayBody.status).toBe(400);

    const blank = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "   " }
    });
    expect(blank.status).toBe(400);
  });

  it("validates tool-test args locally before any remote call", async () => {
    const jwt = await signJwt({ sub: "sub-args", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-args", email: ANALYST_EMAIL });

    const injected = await authedFetch("/api/tool-test", {
      jwt,
      method: "POST",
      body: { tool: "get_latest_analysis", args: { stock_id: "DEMO001' OR '1'='1" } }
    });
    expect(injected.status).toBe(400);
    const injectedData = (await injected.json()) as { status: string };
    expect(injectedData.status).toBe("invalid_args");

    const extra = await authedFetch("/api/tool-test", {
      jwt,
      method: "POST",
      body: { tool: "get_latest_analysis", args: { stock_id: "DEMO001", extra: "x" } }
    });
    expect(extra.status).toBe(400);

    const unknownId = await authedFetch("/api/tool-test", {
      jwt,
      method: "POST",
      body: { tool: "read_research_document", args: { document_id: "../../etc/passwd" } }
    });
    expect(unknownId.status).toBe(400);

    const unknownTool = await authedFetch("/api/tool-test", {
      jwt,
      method: "POST",
      body: { tool: "run_sql", args: {} }
    });
    const unknownData = (await unknownTool.json()) as { status: string };
    expect(unknownData.status).toBe("denied");
  });

  it("clears history and rotates conversationId on role downgrade", async () => {
    const jwt = await signJwt({ sub: "sub-rbac", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-rbac", email: ANALYST_EMAIL });
    __setModelFetchForTests(async () => textResponse("CANARY_ANALYST_REPLY_9931"));
    const chatResp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "分析 DEMO001" }
    });
    expect(chatResp.status).toBe(200);
    const before = await authedFetch("/api/session", { jwt });
    const beforeData = (await before.json()) as {
      history: { content: string }[];
      conversationId: string;
    };
    expect(beforeData.history.map((h) => h.content)).toContain("CANARY_ANALYST_REPLY_9931");
    const oldConversation = beforeData.conversationId;

    const e = env as { ANALYST_EMAILS?: string; VIEWER_EMAILS?: string };
    const origAnalyst = e.ANALYST_EMAILS;
    const origViewer = e.VIEWER_EMAILS;
    e.ANALYST_EMAILS = "other@example.com";
    e.VIEWER_EMAILS = `${VIEWER_EMAIL},${ANALYST_EMAIL}`;
    try {
      const after = await authedFetch("/api/session", { jwt });
      const afterData = (await after.json()) as {
        user: { role: string };
        history: { content: string }[];
        conversationId: string;
      };
      expect(afterData.user.role).toBe("viewer");
      expect(afterData.history).toHaveLength(0);
      expect(afterData.conversationId).not.toBe(oldConversation);

      const page = await authedFetch("/", { jwt });
      const html = await page.text();
      expect(html).not.toContain("CANARY_ANALYST_REPLY_9931");

      const doc = await authedFetch("/api/tool-test", {
        jwt,
        method: "POST",
        body: { tool: "read_research_document", args: { document_id: "research-note-a" } }
      });
      const docData = (await doc.json()) as { status: string };
      expect(docData.status).toBe("denied");

      const requests: { body: { messages?: unknown[] } }[] = [];
      __setModelFetchForTests(async (_input, init) => {
        requests.push({ body: JSON.parse(String(init?.body ?? "{}")) });
        return textResponse("viewer reply");
      });
      const chatResp2 = await authedFetch("/api/chat", {
        jwt,
        method: "POST",
        body: { message: "viewer question" }
      });
      expect(chatResp2.status).toBe(200);
      expect(JSON.stringify(requests[0]?.body.messages)).not.toContain("CANARY_ANALYST_REPLY_9931");
    } finally {
      e.ANALYST_EMAILS = origAnalyst;
      e.VIEWER_EMAILS = origViewer;
    }
  });

  it("stale connector is not reused after MCP_SERVER_URL changes", async () => {
    const jwt = await signJwt({ sub: "sub-stale", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-stale", email: ANALYST_EMAIL });
    const before = await authedFetch("/api/session", { jwt });
    expect(((await before.json()) as { mcp: { connected: boolean } }).mcp.connected).toBe(true);

    const e = env as { MCP_SERVER_URL?: string };
    const original = e.MCP_SERVER_URL;
    e.MCP_SERVER_URL = "http://localhost/mcp?portal=1";
    try {
      const session = await authedFetch("/api/session", { jwt });
      const sessionData = (await session.json()) as {
        mcp: { connected: boolean; state: string };
      };
      expect(sessionData.mcp.connected).toBe(false);
      expect(sessionData.mcp.state).toBe("stale");

      const test = await authedFetch("/api/tool-test", {
        jwt,
        method: "POST",
        body: { tool: "get_latest_analysis", args: { stock_id: "DEMO001" } }
      });
      const testData = (await test.json()) as { status: string };
      expect(testData.status).toBe("unavailable");

      const reconnect = await authedFetch("/api/connect", {
        jwt,
        method: "POST",
        body: {}
      });
      const reconnectData = (await reconnect.json()) as {
        status: string;
        authUrl?: string;
      };
      expect(reconnectData.status).toBe("authenticating");
      expect(reconnectData.authUrl).toContain("/authorize");
    } finally {
      e.MCP_SERVER_URL = original;
    }
  });

  it("emits structured server audit events for tool-test without sensitive fields", async () => {
    const jwt = await signJwt({ sub: "sub-audit", email: VIEWER_EMAIL });
    await connectAgentMcp({ sub: "sub-audit", email: VIEWER_EMAIL });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const resp = await authedFetch("/api/tool-test", {
        jwt,
        method: "POST",
        body: {
          tool: "read_research_document",
          args: { document_id: "research-note-a" }
        }
      });
      const data = (await resp.json()) as { status: string };
      expect(data.status).toBe("denied");
      const records = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("tool_audit"))
        .map((s) => JSON.parse(s) as Record<string, unknown>);
      expect(records).toHaveLength(1);
      const rec = records[0];
      expect(rec.action).toBe("tool-test");
      expect(rec.tool).toBe("read_research_document");
      expect(rec.status).toBe("denied");
      expect(rec.role).toBe("viewer");
      expect(rec.actorId).toBe(await sha256Hex("sub-audit"));
      expect(rec.requestId).toMatch(UUID_RE);
      expect(rec.identitySource).toBe("local_jwt");
      expect(typeof rec.conversationId).toBe("string");
      const serialized = JSON.stringify(rec);
      expect(serialized).not.toContain(VIEWER_EMAIL);
      expect(serialized).not.toContain("research-note-a");
      expect(serialized).not.toContain("CF_DEMO_SECRET");
    } finally {
      spy.mockRestore();
    }
  });

  it("disconnect requires auth, matching origin, and explicit confirm", async () => {
    const jwt = await signJwt({ sub: "sub-dc-sec", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-dc-sec", email: ANALYST_EMAIL });

    const noJwt = await authedFetch("/api/disconnect", {
      method: "POST",
      body: { confirm: true }
    });
    expect(noJwt.status).toBe(401);

    const foreign = await authedFetch("/api/disconnect", {
      jwt,
      method: "POST",
      body: { confirm: true },
      headers: { origin: "https://evil.example" }
    });
    expect(foreign.status).toBe(403);

    const missing = await authedFetch("/api/disconnect", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe(
      "confirmation_required"
    );

    const falseConfirm = await authedFetch("/api/disconnect", {
      jwt,
      method: "POST",
      body: { confirm: false }
    });
    expect(falseConfirm.status).toBe(400);

    const still = await authedFetch("/api/session", { jwt });
    expect(
      ((await still.json()) as { mcp: { connected: boolean } }).mcp.connected
    ).toBe(true);
  });

  it("confirmed disconnect removes only the registration and keeps history", async () => {
    const jwt = await signJwt({ sub: "sub-dc-keep", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-dc-keep", email: ANALYST_EMAIL });
    __setModelFetchForTests(async () => textResponse("KEEP_HISTORY_CANARY"));
    const chat = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "hi" }
    });
    expect(chat.status).toBe(200);
    const before = await authedFetch("/api/session", { jwt });
    const beforeData = (await before.json()) as { conversationId: string };

    const resp = await authedFetch("/api/disconnect", {
      jwt,
      method: "POST",
      body: { confirm: true }
    });
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { status: string }).status).toBe(
      "disconnected"
    );

    const after = await authedFetch("/api/session", { jwt });
    const afterData = (await after.json()) as {
      mcp: { connected: boolean };
      history: { content: string }[];
      conversationId: string;
    };
    expect(afterData.mcp.connected).toBe(false);
    expect(afterData.history.map((h) => h.content)).toContain(
      "KEEP_HISTORY_CANARY"
    );
    expect(afterData.conversationId).toBe(beforeData.conversationId);

    const chatAfter = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "hi" }
    });
    expect(chatAfter.status).toBe(409);
  });

  it("disconnecting user B never affects user A's connection", async () => {
    const jwtA = await signJwt({ sub: "sub-dc-a", email: ANALYST_EMAIL });
    const jwtB = await signJwt({ sub: "sub-dc-b", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-dc-a", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-dc-b", email: ANALYST_EMAIL });

    const dc = await authedFetch("/api/disconnect", {
      jwt: jwtB,
      method: "POST",
      body: { confirm: true }
    });
    expect(dc.status).toBe(200);

    const sessA = await authedFetch("/api/session", { jwt: jwtA });
    const dataA = (await sessA.json()) as {
      mcp: { connected: boolean };
      tools: string[];
    };
    expect(dataA.mcp.connected).toBe(true);
    expect(dataA.tools).toContain("list_demo_stocks");

    const sessB = await authedFetch("/api/session", { jwt: jwtB });
    const dataB = (await sessB.json()) as { mcp: { connected: boolean } };
    expect(dataB.mcp.connected).toBe(false);
  });

  it("portal list projects an honest native roster only", async () => {
    const jwt = await signJwt({ sub: "sub-portal-list", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-portal-list", email: ANALYST_EMAIL });
    spyNativeTools({
      list: {
        structuredContent: {
          servers: [
            { id: "demo-research", name: "Research <b>demo</b>", toggled: true },
            { server_id: "docs", name: "Docs", enabled: false },
            { id: "unknown", name: "Unknown" }
          ]
        }
      }
    });
    const resp = await authedFetch("/api/portal/list", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      status: string;
      servers: Record<string, unknown>[];
      requestId: string;
    };
    expect(data.status).toBe("ok");
    expect(data.requestId).toMatch(UUID_RE);
    expect(data.servers).toHaveLength(3);
    expect(data.servers.map((s) => s.id)).toEqual([
      "demo-research",
      "docs",
      "unknown"
    ]);
    expect(data.servers.map((s) => s.enabled)).toEqual([true, false, null]);
    for (const row of data.servers) {
      expect(Object.keys(row).sort()).toEqual(["enabled", "id", "name"]);
    }
    expect(data.servers[0].name).toBe("Research <b>demo</b>");

    const requests: { body: { tools?: { function?: { name: string } }[] } }[] = [];
    __setModelFetchForTests(async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return textResponse("ok");
    });
    await authedFetch("/api/chat", { jwt, method: "POST", body: { message: "hi" } });
    const offered = (requests[0]?.body.tools ?? []).map((t) => t.function?.name);
    expect(offered).not.toContain("portal_list_servers");
    expect(offered).not.toContain("portal_toggle_servers");
  });

  it("portal list fails closed: malformed roster is an error, absent tools unsupported", async () => {
    const jwt = await signJwt({ sub: "sub-portal-bad", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-portal-bad", email: ANALYST_EMAIL });
    spyNativeTools({ list: { structuredContent: { unexpected: 1 } } });
    const malformed = await authedFetch("/api/portal/list", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(malformed.status).toBe(502);
    const malformedData = (await malformed.json()) as { status: string };
    expect(malformedData.status).toBe("error");
    vi.restoreAllMocks();

    spyNoNativeTools();
    const unsupported = await authedFetch("/api/portal/list", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(unsupported.status).toBe(404);
    const unsupportedData = (await unsupported.json()) as { status: string };
    expect(unsupportedData.status).toBe("unsupported");

    const disconnected = await authedFetch("/api/portal/list", {
      jwt: await signJwt({ sub: "sub-portal-none", email: ANALYST_EMAIL }),
      method: "POST",
      body: {}
    });
    expect(disconnected.status).toBe(409);
    const disconnectedData = (await disconnected.json()) as { status: string };
    expect(disconnectedData.status).toBe("requires_connect");
  });

  it("manage validates authorization URLs and ignores caller-supplied fields", async () => {
    const jwt = await signJwt({ sub: "sub-portal-mgr", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-portal-mgr", email: ANALYST_EMAIL });
    const { callSpy } = spyNativeTools({ manage: undefined });

    const seen: { name: string; args: unknown }[] = [];
    const origCall = MCPClientManager.prototype.callTool;
    callSpy.mockImplementation(function (this: unknown, params: { name: string; arguments?: unknown }) {
      seen.push({ name: params.name, args: params.arguments });
      if (params.name === "portal_toggle_servers") {
        return Promise.resolve(current);
      }
      return (origCall as never as (...a: unknown[]) => Promise<unknown>).call(this, params);
    } as never);

    let current: unknown = { structuredContent: { url: "http://localhost/authorize?elicitationId=fx" } };
    const ok = await authedFetch("/api/portal/manage", {
      jwt,
      method: "POST",
      body: { tool: "arbitrary", url: "https://evil.example/authorize", serverId: "x" }
    });
    expect(ok.status).toBe(200);
    const okData = (await ok.json()) as { status: string; authorizationUrl?: string };
    expect(okData.status).toBe("ok");
    expect(okData.authorizationUrl).toBe("http://localhost/authorize?elicitationId=fx");
    const nativeCalls = seen.filter((c) => c.name === "portal_toggle_servers");
    expect(nativeCalls.length).toBeGreaterThan(0);
    expect(nativeCalls.at(-1)!.args).toEqual({});

    const rejections = [
      "javascript:alert(1)",
      "data:text/html,x",
      "https://evil.example/authorize",
      "http://localhost:9999/authorize",
      "http://user:pass@localhost/authorize",
      "http://localhost/mcp-oauth-callback?x=1",
      "http://169.254.169.254/authorize"
    ];
    for (const bad of rejections) {
      current = { structuredContent: { url: bad } };
      const resp = await authedFetch("/api/portal/manage", {
        jwt,
        method: "POST",
        body: {}
      });
      expect(resp.status).toBe(502);
      const data = (await resp.json()) as { status: string; authorizationUrl?: string };
      expect(data.status).toBe("error");
      expect(data.authorizationUrl).toBeUndefined();
    }

    current = {
      content: [
        { type: "text", text: "请打开 http://localhost/authorize?elicitationId=t1 完成授权" }
      ]
    };
    const fromText = await authedFetch("/api/portal/manage", {
      jwt,
      method: "POST",
      body: {}
    });
    const textData = (await fromText.json()) as { authorizationUrl?: string };
    expect(textData.authorizationUrl).toBe(
      "http://localhost/authorize?elicitationId=t1"
    );
  });

  it("URL elicitation pending is strictly owned by the actor DO", async () => {
    const jwtA = await signJwt({ sub: "sub-elicit-a", email: ANALYST_EMAIL });
    const jwtB = await signJwt({ sub: "sub-elicit-b", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-elicit-a", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-elicit-b", email: ANALYST_EMAIL });
    const stubA = await agentStub("sub-elicit-a");
    const stubB = await agentStub("sub-elicit-b");

    const foreign = await queuePortalOn(stubB, {
      params: { mode: "url", url: "https://evil.example/authorize" }
    });
    expect(foreign.action).toBe("decline");

    const pB = queuePortalOn(stubB, {
      params: {
        mode: "url",
        url: "http://localhost/authorize?e=b",
        message: "b-approve"
      }
    });
    const sessAbeforeB = await sessionPortal(jwtA);
    expect(sessAbeforeB.portal?.pending).toBeNull();
    const sessB = await sessionPortal(jwtB);
    const pendingB = sessB.portal!.pending!;
    expect(pendingB.url).toBe("http://localhost/authorize?e=b");
    expect(pendingB.message).toBe("b-approve");

    const secondOnB = await queuePortalOn(stubB, {
      params: { mode: "url", url: "http://localhost/authorize?e=b2" }
    });
    expect(secondOnB.action).toBe("decline");

    const respAonB = await authedFetch("/api/portal/respond", {
      jwt: jwtA,
      method: "POST",
      body: { id: pendingB.id, action: "accept" }
    });
    expect(respAonB.status).toBe(404);

    const badAction = await authedFetch("/api/portal/respond", {
      jwt: jwtB,
      method: "POST",
      body: { id: pendingB.id, action: "maybe" }
    });
    expect(badAction.status).toBe(400);

    const respB = await authedFetch("/api/portal/respond", {
      jwt: jwtB,
      method: "POST",
      body: { id: pendingB.id, action: "accept" }
    });
    expect(respB.status).toBe(200);
    expect((await pB).action).toBe("accept");
    const replayB = await authedFetch("/api/portal/respond", {
      jwt: jwtB,
      method: "POST",
      body: { id: pendingB.id, action: "accept" }
    });
    expect(replayB.status).toBe(404);

    const pA = queuePortalOn(stubA, {
      params: {
        mode: "url",
        url: "http://localhost/authorize?e=a",
        message: "a-approve"
      }
    });
    const sessBafterA = await sessionPortal(jwtB);
    expect(sessBafterA.portal?.pending).toBeNull();
    const sessA = await sessionPortal(jwtA);
    const pendingA = sessA.portal!.pending!;
    expect(pendingA.url).toBe("http://localhost/authorize?e=a");

    const respBonA = await authedFetch("/api/portal/respond", {
      jwt: jwtB,
      method: "POST",
      body: { id: pendingA.id, action: "accept" }
    });
    expect(respBonA.status).toBe(404);
    const respA = await authedFetch("/api/portal/respond", {
      jwt: jwtA,
      method: "POST",
      body: { id: pendingA.id, action: "accept" }
    });
    expect(respA.status).toBe(200);
    expect((await pA).action).toBe("accept");
    const replayA = await authedFetch("/api/portal/respond", {
      jwt: jwtA,
      method: "POST",
      body: { id: pendingA.id, action: "accept" }
    });
    expect(replayA.status).toBe(404);
    expect((await sessionPortal(jwtA)).portal?.pending).toBeNull();
  });

  it("decline/cancel/abort/disconnect/ttl/role-change resolve only own pending", async () => {
    const sub = "sub-elicit-c";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stubC = await agentStub(sub);

    const preAborted = new AbortController();
    preAborted.abort();
    const early = await queuePortalOn(
      stubC,
      { params: { mode: "url", url: "http://localhost/authorize?e=0" } },
      preAborted.signal
    );
    expect(early.action).toBe("cancel");
    expect((await sessionPortal(jwt)).portal?.pending).toBeNull();

    const p1 = queuePortalOn(stubC, {
      params: { mode: "url", url: "http://localhost/authorize?e=a" }
    });
    const s1 = await sessionPortal(jwt);
    const declined = await authedFetch("/api/portal/respond", {
      jwt,
      method: "POST",
      body: { id: s1.portal!.pending!.id, action: "decline" }
    });
    expect(declined.status).toBe(200);
    expect((await p1).action).toBe("decline");

    const p2 = queuePortalOn(stubC, {
      params: { mode: "url", url: "http://localhost/authorize?e=c" }
    });
    const s2 = await sessionPortal(jwt);
    const cancelled = await authedFetch("/api/portal/respond", {
      jwt,
      method: "POST",
      body: { id: s2.portal!.pending!.id, action: "cancel" }
    });
    expect(cancelled.status).toBe(200);
    expect((await p2).action).toBe("cancel");

    const ctl = new AbortController();
    const p3 = queuePortalOn(
      stubC,
      { params: { mode: "url", url: "http://localhost/authorize?e=b" } },
      ctl.signal
    );
    ctl.abort();
    expect((await p3).action).toBe("cancel");
    expect((await sessionPortal(jwt)).portal?.pending).toBeNull();

    const subD = "sub-elicit-d";
    const jwtD = await signJwt({ sub: subD, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: subD, email: ANALYST_EMAIL });
    const stubD = await agentStub(subD);
    const pD = queuePortalOn(stubD, {
      params: { mode: "url", url: "http://localhost/authorize?e=d" }
    });
    const pC = queuePortalOn(stubC, {
      params: { mode: "url", url: "http://localhost/authorize?e=c2" }
    });
    const histBefore = (await sessionPortal(jwt)).history;
    const dc = await authedFetch("/api/disconnect", {
      jwt,
      method: "POST",
      body: { confirm: true }
    });
    expect(dc.status).toBe(200);
    expect((await pC).action).toBe("cancel");
    const sessD = await sessionPortal(jwtD);
    const pendingD = sessD.portal!.pending!;
    expect(pendingD.url).toBe("http://localhost/authorize?e=d");
    const respD = await authedFetch("/api/portal/respond", {
      jwt: jwtD,
      method: "POST",
      body: { id: pendingD.id, action: "accept" }
    });
    expect(respD.status).toBe(200);
    expect((await pD).action).toBe("accept");
    const sessCAfter = await sessionPortal(jwt);
    expect(sessCAfter.portal?.pending).toBeNull();
    expect(sessCAfter.history).toEqual(histBefore);

    const pTtl = queuePortalOn(stubC, {
      params: { mode: "url", url: "http://localhost/authorize?e=ttl" }
    });
    expect((await sessionPortal(jwt)).portal?.pending).not.toBeNull();
    await runInDurableObject(stubC as never, (instance) => {
      const inst = instance as unknown as {
        state: { pendingPortal?: { expiresAt: number } | null };
        setState(state: unknown): void;
      };
      inst.setState({
        ...inst.state,
        pendingPortal: {
          ...inst.state.pendingPortal!,
          expiresAt: Date.now() - 1
        }
      });
    });
    expect((await sessionPortal(jwt)).portal?.pending).toBeNull();
    expect((await pTtl).action).toBe("cancel");

    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const pRole = queuePortalOn(stubC, {
      params: { mode: "url", url: "http://localhost/authorize?e=role" }
    });
    expect((await sessionPortal(jwt)).portal?.pending).not.toBeNull();
    const jwtViewer = await signJwt({ sub, email: VIEWER_EMAIL });
    await sessionPortal(jwtViewer);
    expect((await pRole).action).toBe("cancel");
    expect((await sessionPortal(jwtViewer)).portal?.pending).toBeNull();
  });

  it("portal management endpoints enforce auth, origin, and JSON shape", async () => {
    const jwt = await signJwt({ sub: "sub-portal-sec", email: ANALYST_EMAIL });
    for (const path of [
      "/api/portal/list",
      "/api/portal/manage",
      "/api/portal/refresh",
      "/api/portal/respond"
    ]) {
      const noJwt = await authedFetch(path, { method: "POST", body: {} });
      expect(noJwt.status).toBe(401);
      const foreign = await authedFetch(path, {
        jwt,
        method: "POST",
        body: {},
        headers: { origin: "https://evil.example" }
      });
      expect(foreign.status).toBe(403);
    }
    const arrayBody = await authedFetch("/api/portal/respond", {
      jwt,
      method: "POST",
      body: [1] as unknown as BodyInit
    });
    expect(arrayBody.status).toBe(400);
    const missing = await authedFetch("/api/portal/respond", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(missing.status).toBe(400);
  });

  it("connect reports unconfigured for a non-HTTPS non-loopback MCP URL", async () => {
    const jwt = await signJwt({ sub: "sub-conn", email: ANALYST_EMAIL });
    const e = env as { MCP_SERVER_URL?: string };
    const original = e.MCP_SERVER_URL;
    e.MCP_SERVER_URL = "http://evil.example/mcp";
    try {
      const resp = await authedFetch("/api/connect", { jwt, method: "POST", body: {} });
      const data = (await resp.json()) as { status: string };
      expect(data.status).toBe("unconfigured");
    } finally {
      e.MCP_SERVER_URL = original;
    }
  });

  it("failed connection reconnects via connectToServer keeping grant and history", async () => {
    const sub = "sub-reconnect";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stub = await agentStub(sub);
    __setModelFetchForTests(async () =>
      textResponse("canary-reply-42")
    );
    const chat = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "canary-question" }
    });
    expect(chat.status).toBe(200);
    const sessBefore = (await (
      await authedFetch("/api/session", { jwt })
    ).json()) as {
      history: { role: string; content: string }[];
      conversationId: string;
    };
    expect(
      sessBefore.history.some((m) => m.content === "canary-reply-42")
    ).toBe(true);
    const clientIdBefore = await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        mcp: {
          getServersFromStorage(): { id: string; client_id: string | null }[];
        };
      };
      return inst.mcp
        .getServersFromStorage()
        .find((s) => s.id === "research")?.client_id;
    });
    await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        ctx: { storage: { sql: { exec(query: string): void } } };
        mcp: {
          mcpConnections: Record<
            string,
            { connectionState: string; connectionError?: string }
          >;
        };
      };
      const conn = inst.mcp.mcpConnections["research"];
      if (conn) {
        conn.connectionState = "failed";
        conn.connectionError = "fixturetransient";
      }
    });
    const reconnectSpy = vi.spyOn(MCPClientManager.prototype, "connectToServer");
    const removeSpy = vi.spyOn(MCPClientManager.prototype, "removeServer");
    const resp = await authedFetch("/api/connect", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { status: string };
    expect(data.status).toBe("ready");
    expect(reconnectSpy).toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    const sessAfter = (await (
      await authedFetch("/api/session", { jwt })
    ).json()) as {
      history: { role: string; content: string }[];
      conversationId: string;
      mcp: { connected: boolean };
    };
    expect(sessAfter.history).toEqual(sessBefore.history);
    expect(sessAfter.conversationId).toBe(sessBefore.conversationId);
    expect(sessAfter.mcp.connected).toBe(true);
    const clientIdAfter = await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        mcp: {
          getServersFromStorage(): { id: string; client_id: string | null }[];
        };
      };
      return inst.mcp
        .getServersFromStorage()
        .find((s) => s.id === "research")?.client_id;
    });
    expect(clientIdAfter).toBe(clientIdBefore);
  });

  it("failed reconnect surfaces 502 sanitized detail and keeps the grant row", async () => {
    const sub = "sub-refail";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stub = await agentStub(sub);
    await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        mcp: {
          mcpConnections: Record<
            string,
            { connectionState: string; connectionError?: string }
          >;
        };
      };
      const conn = inst.mcp.mcpConnections["research"];
      if (conn) {
        conn.connectionState = "failed";
        conn.connectionError = "fixturetransient";
      }
    });
    vi.spyOn(MCPClientManager.prototype, "connectToServer").mockImplementation(
      async function () {
        return {
          state: "failed",
          error:
            "Bearer AAA.BBB.CCC https://portal-demo.righttu.uk/authorize?state=verysecretstate123 token=abcd123 user@corp.example"
        };
      } as never
    );
    const resp = await authedFetch("/api/connect", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(resp.status).toBe(502);
    const data = (await resp.json()) as {
      status: string;
      error?: string;
      detail?: string;
    };
    expect(data.status).toBe("failed");
    expect(data.error).toBe("mcp_connect_failed");
    expect(data.detail).toBeTruthy();
    expect(data.detail).not.toContain("AAA.BBB.CCC");
    expect(data.detail).not.toContain("abcd123");
    expect(data.detail).not.toContain("verysecretstate123");
    expect(data.detail).not.toContain("user@corp.example");
    expect(data.detail).not.toContain("Bearer");
    const sess = (await (
      await authedFetch("/api/session", { jwt })
    ).json()) as { mcp: { state: string } };
    expect(sess.mcp.state).toBe("failed");
  });

  it("authenticating and connecting reconnect states stay honest", async () => {
    const sub = "sub-restates";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stub = await agentStub(sub);
    await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        mcp: {
          mcpConnections: Record<
            string,
            { connectionState: string; connectionError?: string }
          >;
        };
      };
      const conn = inst.mcp.mcpConnections["research"];
      if (conn) {
        conn.connectionState = "failed";
        conn.connectionError = "fixturetransient";
      }
    });
    const spy = vi.spyOn(MCPClientManager.prototype, "connectToServer");
    spy.mockImplementation(async function () {
      return {
        state: "authenticating",
        authUrl: "http://localhost/authorize?state=stateXYZ"
      };
    } as never);
    const auth = await authedFetch("/api/connect", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(auth.status).toBe(200);
    const authData = (await auth.json()) as {
      status: string;
      authUrl?: string;
      state?: string;
    };
    expect(authData.status).toBe("authenticating");
    expect(authData.authUrl).toBe("http://localhost/authorize?state=stateXYZ");
    expect(authData.state).toBe("stateXYZ");
    spy.mockImplementation(async function () {
      return { state: "connecting" };
    } as never);
    const connecting = await authedFetch("/api/connect", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(connecting.status).toBe(200);
    expect(
      ((await connecting.json()) as { status: string }).status
    ).toBe("connecting");
  });

  it("stored authenticating delegates to addMcpServer, never blind-returns old URL", async () => {
    const sub = "sub-reauth";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stub = await agentStub(sub);
    await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        mcp: {
          mcpConnections: Record<
            string,
            { connectionState: string; connectionError?: string }
          >;
        };
      };
      const conn = inst.mcp.mcpConnections["research"];
      if (conn) {
        conn.connectionState = "authenticating";
        conn.connectionError = undefined;
      }
    });
    const addSpy = vi.spyOn(Agent.prototype, "addMcpServer");
    const resp = await authedFetch("/api/connect", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(resp.status).toBe(200);
    expect(addSpy).toHaveBeenCalled();
    const data = (await resp.json()) as {
      status: string;
      authUrl?: string;
      state?: string;
      detail?: string;
    };
    if (data.status === "authenticating") {
      expect(data.authUrl).toBeTruthy();
      expect(data.state).toBeTruthy();
      expect(() => new URL(data.authUrl!)).not.toThrow();
    } else {
      expect(["ready", "connecting", "failed"]).toContain(data.status);
    }
  });

  it("diagnostics redact configured env secrets, not only label-shaped values", async () => {
    const sub = "sub-secret-leak";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stub = await agentStub(sub);
    const e = env as { DASHSCOPE_API_KEY?: string; CF_AIG_TOKEN?: string };
    const oldDash = e.DASHSCOPE_API_KEY;
    const oldAig = e.CF_AIG_TOKEN;
    e.DASHSCOPE_API_KEY = "test-dashscope-key";
    e.CF_AIG_TOKEN = "test-aig-token";
    try {
      await runInDurableObject(stub as never, (instance) => {
        const inst = instance as unknown as {
          mcp: {
            mcpConnections: Record<
              string,
              { connectionState: string; connectionError?: string }
            >;
          };
        };
        const conn = inst.mcp.mcpConnections["research"];
        if (conn) {
          conn.connectionState = "failed";
          conn.connectionError = "fixturetransient";
        }
      });
      vi.spyOn(
        MCPClientManager.prototype,
        "connectToServer"
      ).mockImplementation(async function () {
        return {
          state: "failed",
          error: "upstream rejected test-dashscope-key and test-aig-token"
        };
      } as never);
      const resp = await authedFetch("/api/connect", {
        jwt,
        method: "POST",
        body: {}
      });
      expect(resp.status).toBe(502);
      const data = (await resp.json()) as { detail?: string };
      expect(data.detail).toBeTruthy();
      expect(data.detail).not.toContain("test-dashscope-key");
      expect(data.detail).not.toContain("test-aig-token");
      const sess = (await (
        await authedFetch("/api/session", { jwt })
      ).json()) as { mcp: { detail: string | null } };
      expect(sess.mcp.detail ?? "").not.toContain("test-dashscope-key");
      expect(sess.mcp.detail ?? "").not.toContain("test-aig-token");
    } finally {
      e.DASHSCOPE_API_KEY = oldDash;
      e.CF_AIG_TOKEN = oldAig;
    }
  });

  it("oauth callback custom handler redirects without raw error query", async () => {
    const sub = "sub-cb-safe";
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stub = await agentStub(sub);
    const out = await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        mcp: {
          getOAuthCallbackConfig(): {
            customHandler?: (result: unknown) => Response;
          };
        };
      };
      const handler = inst.mcp.getOAuthCallbackConfig()?.customHandler;
      const resp = handler?.({
        serverId: "research",
        authSuccess: false,
        authError: "Bearer AAA.BBB.CCC https://evil.example/cb?code=shh123"
      });
      return {
        status: resp?.status,
        location: resp?.headers.get("location")
      };
    });
    expect(out.status).toBe(302);
    expect(out.location).toBe("http://localhost");
    expect(out.location).not.toContain("error");
    expect(out.location).not.toContain("AAA.BBB.CCC");
    expect(out.location).not.toContain("shh123");
  });
});
