import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { Agent, getAgentByName } from "agents";
import { MCPClientManager } from "agents/mcp/client";
import { setModelFake as __setModelFetchForTests } from "./model-fake.js";
import { sha256Hex } from "../src/shared/access.js";
import { SYSTEM_PROMPT } from "../src/research-policy.js";
import { MODEL_SETTINGS } from "../src/agent/index.js";
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

type PortalCallable = {
  callPortalTool(
    name: string,
    args: Record<string, unknown>,
    context: {
      actorId: string;
      userEmail: string;
      role: "analyst" | "viewer";
      requestId: string;
      identitySource: string;
    }
  ): Promise<{ status: string; detail?: string; payload?: unknown }>;
};

function callPortalOn(
  stub: unknown,
  name: string,
  args: Record<string, unknown>,
  role: "analyst" | "viewer" = "analyst"
): Promise<{ status: string; detail?: string; payload?: unknown }> {
  return runInDurableObject(stub as never, (instance) =>
    (instance as unknown as PortalCallable).callPortalTool(name, args, {
      actorId: "actor-test",
      userEmail: "analyst@example.com",
      role,
      requestId: crypto.randomUUID(),
      identitySource: "local_jwt"
    })
  );
}

function flatTools(data: { servers?: { tools: string[] }[] }): string[] {
  return (data.servers ?? []).flatMap((g) => g.tools);
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
  it("mocked Workers AI invokes both report tools over real MCP then returns final text", async () => {
    const jwt = await signJwt({ sub: "sub-chat-1", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-chat-1", email: ANALYST_EMAIL });

    const requests: {
      url: string;
      body: { messages?: unknown[]; tools?: { function?: { name: string } }[] };
      metadata: string | null;
      gatewayId: string | null;
    }[] = [];
    let call = 0;
    __setModelFetchForTests(async (input, init) => {
      const url = input;
      requests.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")),
        metadata: metadataHeader(input, init),
        gatewayId: init.headers["x-gateway-id"] ?? null
      });
      call += 1;
      if (call === 1) {
        return toolCallResponse([
          { id: "c1", name: "get_latest_analysis", args: "{\"company_id\":\"DEMO001\"}" },
          { id: "c2", name: "get_latest_analysis", args: "{\"company_id\":\"DEMO002\"}" }
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
      ["action", "conversation_id", "request_id", "role", "user"].sort()
    );
    expect(meta.user).toBe(ANALYST_EMAIL);
    expect(meta.request_id).toBe(data.requestId);
    expect(meta.role).toBe("analyst");
    expect(meta.action).toBe("chat");
    expect(JSON.stringify(meta)).not.toContain("Bearer");
    expect(JSON.stringify(meta)).not.toContain("test-aig-token");
    expect(call).toBe(2);
    expect(requests[0].url).toBe("workers-ai://@cf/zai-org/glm-5.3-flash");
    expect(requests[0].gatewayId).toBe("test-gateway");
    const first = requests[0].body;
    expect((first.messages as { role: string; content?: unknown }[])[0].role).toBe("system");
    expect((first.messages as { role: string; content?: unknown }[])[0].content).toBe(SYSTEM_PROMPT);
    const offered = (first.tools ?? []).map((t) => t.function?.name);
    expect(offered).toContain("list_demo_companies");
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
      const resp = await authedFetch("/api/connect", {
        jwt: jwtA,
        method: "POST",
        body: {
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
        .filter((s) => s.includes("mcp_audit"))
        .map((s) => JSON.parse(s) as Record<string, unknown>);
      const rec = records.at(-1)!;
      expect(rec.actorId).toBe(await sha256Hex("sub-actor-a"));
      expect(rec.requestId).toBe(data.requestId);
      expect(rec.requestId).not.toBe("spoofed-request");
    } finally {
      spy.mockRestore();
    }
  });

  it("viewer never sees the document tool: unadvertised upstream and denied locally", async () => {
    const jwt = await signJwt({ sub: "sub-chat-v", email: VIEWER_EMAIL });
    await connectAgentMcp({ sub: "sub-chat-v", email: VIEWER_EMAIL });

    const requests: { body: { tools?: { function?: { name: string } }[] } }[] = [];
    __setModelFetchForTests(async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return textResponse("ok");
    });

    const session = (await (
      await authedFetch("/api/session", { jwt })
    ).json()) as { servers?: { tools: string[] }[] };
    const tools = flatTools(session);
    expect(tools).toContain("list_demo_companies");
    expect(tools).toContain("get_latest_analysis");
    expect(tools).not.toContain("read_research_document");

    const stub = await agentStub("sub-chat-v");
    const deny = await callPortalOn(
      stub,
      "read_research_document",
      { document_id: "research-note-a" },
      "viewer"
    );
    expect(deny.status).toBe("denied");

    const list = await callPortalOn(stub, "list_demo_companies", {}, "viewer");
    expect(list.status).toBe("ok");
    expect((list.payload as { companies?: unknown[] }).companies).toHaveLength(2);

    await authedFetch("/api/chat", { jwt, method: "POST", body: { message: "有哪些模拟公司" } });
    const offered = (requests[0]?.body.tools ?? []).map((t) => t.function?.name);
    expect(offered).not.toContain("read_research_document");
    expect(offered).toContain("list_demo_companies");
    expect(offered).toContain("get_latest_analysis");
  });

  it("chat returns 409 while MCP is disconnected", async () => {
    const jwt = await signJwt({ sub: "sub-disc", email: ANALYST_EMAIL });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "有哪些模拟公司" }
    });
    expect(resp.status).toBe(409);
    const data = (await resp.json()) as { error: string };
    expect(data.error).toBe("mcp_not_connected");
  });

  it("namespaced discovered names attribute to the right server and unknown names fail closed", async () => {
    const jwt = await signJwt({ sub: "sub-portal", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-portal", email: ANALYST_EMAIL });
    const origList = MCPClientManager.prototype.listTools;
    vi.spyOn(MCPClientManager.prototype, "listTools").mockImplementation(
      function (this: unknown, options: unknown) {
        const tools = (origList as (...a: unknown[]) => { name?: string }[]).call(
          this,
          options
        );
        return [
          ...tools.filter((t) => t.name !== "get_latest_analysis"),
          { name: "research-demo_get_latest_analysis", description: "via portal" },
          { name: "abc-quant_get_signals", description: "quant" },
          { name: "bad name!" },
          { name: "portal_hidden" }
        ];
      } as never
    );
    try {
      const session = (await (
        await authedFetch("/api/session", { jwt })
      ).json()) as {
        servers: { id: string; label: string; tools: string[] }[];
        suggestions: { title: string; message: string }[];
        modelId: string;
      };
      const research = session.servers.find((g) => g.id === "research-demo");
      expect(research?.label).toBe("Research MCP-S");
      expect(research?.tools).toContain("research-demo_get_latest_analysis");
      const quant = session.servers.find((g) => g.id === "abc-quant");
      expect(quant?.label).toBe("Quant MCP-S");
      expect(quant?.tools).toEqual(["abc-quant_get_signals"]);
      const generic = session.servers.find((g) => g.id === "");
      expect(generic?.label).toBe("MCP");
      expect(generic?.tools).toContain("list_demo_companies");
      expect(flatTools(session)).not.toContain("bad name!");
      expect(flatTools(session)).not.toContain("portal_hidden");
      expect(session.suggestions.length).toBeGreaterThan(0);
      expect(session.modelId).toContain("@cf/");

      const requests: { body: { tools?: { function?: { name: string } }[] } }[] = [];
      __setModelFetchForTests(async (_input, init) => {
        requests.push({ body: JSON.parse(String(init?.body ?? "{}")) });
        return textResponse("ok");
      });
      await authedFetch("/api/chat", { jwt, method: "POST", body: { message: "有哪些模拟公司" } });
      const offered = (requests[0]?.body.tools ?? []).map((t) => t.function?.name);
      expect(offered).toContain("research-demo_get_latest_analysis");
      expect(offered).toContain("abc-quant_get_signals");
      expect(offered).not.toContain("portal_hidden");
      expect(offered).not.toContain("bad name!");

      const stub = await agentStub("sub-portal");
      const unknown = await callPortalOn(stub, "portal.research.get_latest_analysis", {});
      expect(unknown.status).toBe("denied");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("enforces body bounds, content type, and JSON shape", async () => {
    const jwt = await signJwt({ sub: "sub-body", email: ANALYST_EMAIL });

    const declared = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      headers: { "content-length": "99999" },
      body: { message: "有哪些模拟公司" }
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
      body: { message: "有哪些模拟公司" } as unknown as BodyInit
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

  it("callPortalTool refuses names the upstream never advertised", async () => {
    const jwt = await signJwt({ sub: "sub-args", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-args", email: ANALYST_EMAIL });
    const stub = await agentStub("sub-args");

    for (const name of [
      "run_sql",
      "portal_list_servers",
      "portal_toggle_servers",
      "not a tool",
      "../escape",
      "list_demo_companies_extra"
    ]) {
      const out = await callPortalOn(stub, name, {});
      expect(out.status).toBe("denied");
    }

    const spy = vi.spyOn(MCPClientManager.prototype, "callTool");
    const denied = await callPortalOn(stub, "run_sql", {});
    expect(denied.status).toBe("denied");
    expect(spy).not.toHaveBeenCalled();

    const ok = await callPortalOn(stub, "list_demo_companies", {});
    expect(ok.status).toBe("ok");
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

      const viewerSess = (await (
        await authedFetch("/api/session", { jwt })
      ).json()) as {
        user: { role: string };
        suggestions: { title: string; message: string }[];
      };
      expect(viewerSess.user.role).toBe("viewer");
      expect(viewerSess.suggestions.length).toBeGreaterThan(0);

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

      const test = await authedFetch("/api/chat", {
        jwt,
        method: "POST",
        body: { message: "有哪些模拟公司" }
      });
      expect(test.status).toBe(409);
      expect(((await test.json()) as { error: string }).error).toBe("mcp_not_connected");

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

  it("emits structured server audit events for tool-execute without sensitive fields", async () => {
    const jwt = await signJwt({ sub: "sub-audit", email: VIEWER_EMAIL });
    await connectAgentMcp({ sub: "sub-audit", email: VIEWER_EMAIL });
    let call = 0;
    __setModelFetchForTests(async () => {
      call += 1;
      if (call === 1) {
        return toolCallResponse([
          { id: "a1", name: "list_demo_companies", args: "{}" },
          { id: "a2", name: "read_research_document", args: "{\"document_id\":\"research-note-a\"}" }
        ]);
      }
      return textResponse("完成。");
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const resp = await authedFetch("/api/chat", {
        jwt,
        method: "POST",
        body: { message: "CF_DEMO_SECRET_9274" }
      });
      expect(resp.status).toBe(200);
      const records = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("tool_audit"))
        .map((s) => JSON.parse(s) as Record<string, unknown>);
      expect(records.length).toBeGreaterThanOrEqual(1);
      const rec = records[0];
      expect(rec.action).toBe("tool-execute");
      expect(rec.tool).toBe("list_demo_companies");
      expect(rec.status).toBe("ok");
      expect(rec.role).toBe("viewer");
      expect(rec.actorId).toBe(await sha256Hex("sub-audit"));
      expect(rec.requestId).toMatch(UUID_RE);
      expect(rec.identitySource).toBe("local_jwt");
      expect(typeof rec.conversationId).toBe("string");
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain(VIEWER_EMAIL);
      expect(serialized).not.toContain("research-note-a");
      expect(serialized).not.toContain("CF_DEMO_SECRET");
      const denied = records.find((r) => r.tool === "read_research_document");
      expect(denied).toBeUndefined();
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
      body: { message: "有哪些模拟公司" }
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
      body: { message: "有哪些模拟公司" }
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
      servers?: { tools: string[] }[];
    };
    expect(dataA.mcp.connected).toBe(true);
    expect(flatTools(dataA)).toContain("list_demo_companies");

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
    await authedFetch("/api/chat", { jwt, method: "POST", body: { message: "有哪些模拟公司" } });
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

  it("caps a tool loop: withdraws tools on the last step, dedupes repeats, never stores an empty reply", async () => {
    const sub = "sub-loop";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const toolChoices: unknown[] = [];
    let lastHadTools = true;
    let calls = 0;
    __setModelFetchForTests(async (_input, init) => {
      calls += 1;
      const body = JSON.parse(init.body) as { tool_choice?: unknown; tools?: unknown[] };
      toolChoices.push(body.tool_choice);
      lastHadTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (!lastHadTools) return textResponse("");
      return toolCallResponse([{ id: `c${calls}`, name: "list_demo_companies", args: "{}" }]);
    });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "有哪些模拟公司" }
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      reply: string;
      events: { text: string }[];
    };
    expect(calls).toBeLessThanOrEqual(4);
    expect(toolChoices[toolChoices.length - 1]).toBeUndefined();
    expect(lastHadTools).toBe(false);
    expect(data.reply).toContain("没有给出回答");
    const started = data.events.filter((e) => e.text === "工具调用 list_demo_companies");
    expect(started).toHaveLength(1);
    const session = (await (await authedFetch("/api/session", { jwt })).json()) as {
      history: { role: string; content: string }[];
    };
    expect(session.history.some((m) => m.content.trim() === "")).toBe(false);
    expect(session.history).toHaveLength(0);
  });

  it("stops offering tools after repeated identical tool calls and uses the model's own judgement for small talk", async () => {
    const sub = "sub-repeat";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const seen: boolean[] = [];
    let call = 0;
    __setModelFetchForTests(async (_input, init) => {
      const body = JSON.parse(init.body) as { tools?: unknown[] };
      seen.push(Array.isArray(body.tools) && body.tools.length > 0);
      call += 1;
      if (call <= 2) {
        return toolCallResponse([{ id: `r${call}`, name: "list_demo_companies", args: "{}" }]);
      }
      return textResponse("最终回答");
    });
    const q = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "有哪些模拟公司" }
    });
    const qData = (await q.json()) as { reply: string };
    expect(qData.reply).toBe("最终回答");
    expect(seen).toEqual([true, true, false]);

    seen.length = 0;
    __setModelFetchForTests(async (_input, init) => {
      const body = JSON.parse(init.body) as { tools?: unknown[] };
      seen.push(Array.isArray(body.tools) && body.tools.length > 0);
      return textResponse("你好！");
    });
    const hi = await authedFetch("/api/chat", { jwt, method: "POST", body: { message: "hi" } });
    expect(((await hi.json()) as { reply: string }).reply).toBe("你好！");
    expect(seen).toEqual([true]);
  });

  it("passes per-model reasoning settings to the binding", async () => {
    const sub = "sub-settings";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const inputs: Record<string, unknown>[] = [];
    __setModelFetchForTests(async (_input, init) => {
      inputs.push(JSON.parse(init.body) as Record<string, unknown>);
      return textResponse("好的");
    });
    await authedFetch("/api/chat", { jwt, method: "POST", body: { message: "有哪些模拟公司" } });
    expect(inputs[0].reasoning_effort).toBe("low");
  });

  it("streams chat as NDJSON: step events, text deltas, then a done record", async () => {
    const sub = "sub-stream";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    let call = 0;
    __setModelFetchForTests(async () => {
      call += 1;
      if (call === 1) {
        return toolCallResponse([{ id: "s1", name: "list_demo_companies", args: "{}" }]);
      }
      return textResponse("两家模拟公司。");
    });
    const resp = await authedFetch("/api/chat/stream", {
      jwt,
      method: "POST",
      body: { message: "有哪些模拟公司" }
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await resp.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; text?: string; reply?: string; requestId?: string });
    const types = lines.map((l) => l.type);
    expect(types).toContain("step");
    expect(types).toContain("delta");
    expect(types[types.length - 1]).toBe("done");
    expect(lines.filter((l) => l.type === "delta").map((l) => l.text).join("")).toBe("两家模拟公司。");
    const done = lines[lines.length - 1];
    expect(done.reply).toBe("两家模拟公司。");
    expect(done.requestId).toMatch(/^[0-9a-f-]{36}$/i);

    const noConnect = await authedFetch("/api/chat/stream", {
      jwt: await signJwt({ sub: "sub-stream-none", email: ANALYST_EMAIL }),
      method: "POST",
      body: { message: "有哪些模拟公司" }
    });
    const last = (await noConnect.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).pop();
    expect(last.type).toBe("done");
    expect(last.mcpRequired).toBe(true);

    const bad = await authedFetch("/api/chat/stream", {
      jwt,
      method: "POST",
      body: { message: "" }
    });
    expect(bad.status).toBe(400);
  });

  it("manages chat sessions per user: new, switch, delete, with isolation and a busy guard", async () => {
    const jwtA = await signJwt({ sub: "sub-sess-a", email: ANALYST_EMAIL });
    const jwtB = await signJwt({ sub: "sub-sess-b", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-sess-a", email: ANALYST_EMAIL });
    __setModelFetchForTests(async () => textResponse("回复一"));
    const say = (jwt: string, message: string) =>
      authedFetch("/api/chat", { jwt, method: "POST", body: { message } });
    const post = (jwt: string, path: string, body: Record<string, unknown> = {}) =>
      authedFetch(path, { jwt, method: "POST", body });
    type Payload = {
      status: string;
      history: { role: string; content: string }[];
      conversationId: string;
      sessions: { id: string; title: string; messageCount: number; current: boolean }[];
    };

    await say(jwtA, "有哪些模拟公司");
    const first = (await (await authedFetch("/api/session", { jwt: jwtA })).json()) as Payload;
    const firstId = first.conversationId;
    expect(first.history).toHaveLength(2);
    expect(first.sessions).toHaveLength(1);

    const created = (await (await post(jwtA, "/api/sessions/new")).json()) as Payload;
    expect(created.status).toBe("ok");
    expect(created.history).toHaveLength(0);
    expect(created.conversationId).not.toBe(firstId);
    expect(created.sessions.map((x) => x.id)).toContain(firstId);
    expect(created.sessions.find((x) => x.id === firstId)?.title).toContain("有哪些模拟公司");

    const again = (await (await post(jwtA, "/api/sessions/new")).json()) as Payload;
    expect(again.conversationId).toBe(created.conversationId);
    expect(again.sessions).toHaveLength(2);

    const switched = (await (await post(jwtA, "/api/sessions/switch", { id: firstId })).json()) as Payload;
    expect(switched.history).toHaveLength(2);
    expect(switched.conversationId).toBe(firstId);

    const foreign = await post(jwtB, "/api/sessions/switch", { id: firstId });
    expect(foreign.status).toBe(404);
    const badId = await post(jwtA, "/api/sessions/switch", { id: "../x" });
    expect(badId.status).toBe(400);

    const noConfirm = await post(jwtA, "/api/sessions/delete", { id: firstId });
    expect(noConfirm.status).toBe(400);
    const deleted = (await (await post(jwtA, "/api/sessions/delete", { id: firstId, confirm: true })).json()) as Payload;
    expect(deleted.sessions.some((x) => x.id === firstId)).toBe(false);
    expect(deleted.history).toHaveLength(0);
    expect(deleted.sessions).toHaveLength(1);

    __setModelFetchForTests(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return textResponse("慢回复");
    });
    const slow = say(jwtA, "有哪些模拟公司");
    await new Promise((r) => setTimeout(r, 700));
    const busy = await post(jwtA, "/api/sessions/new");
    expect(busy.status).toBe(409);
    await slow;
  });

  it("tags Agent tracing with a shared agent name, per-user agent id and a readable user.id", async () => {
    const sub = "sub-trace-id";
    const stub = await agentStub(sub);
    const telemetry = await runInDurableObject(stub as never, (instance) =>
      (instance as unknown as {
        telemetry(
          context: { actorId: string; userEmail: string; role: string; requestId: string; identitySource: string },
          action: string
        ): { functionId: string; metadata: Record<string, string> };
      }).telemetry(
        {
          actorId: "hash-1",
          userEmail: ANALYST_EMAIL,
          role: "analyst",
          requestId: "00000000-0000-4000-8000-000000000000",
          identitySource: "access"
        },
        "chat"
      )
    );
    expect(telemetry.functionId).toBe("abc-research-agent");
    expect(telemetry.metadata.agentId).toBe(ANALYST_EMAIL);
    expect(telemetry.metadata["user.id"]).toBe(ANALYST_EMAIL);
    expect(telemetry.metadata.actorId).toBe("hash-1");
    expect(JSON.stringify(telemetry)).not.toMatch(/Bearer|token/i);
  });

  it("heals a woken connection that is connected but undiscovered without re-authorizing", async () => {
    const sub = "sub-heal";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stub = await agentStub(sub);
    const clientBefore = await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        mcp: {
          mcpConnections: Record<string, { connectionState: string }>;
          getServersFromStorage(): { id: string; client_id: string | null }[];
        };
      };
      inst.mcp.mcpConnections["research"].connectionState = "connected";
      return inst.mcp.getServersFromStorage().find((x) => x.id === "research")?.client_id;
    });
    const session = (await (await authedFetch("/api/session", { jwt })).json()) as {
      mcp: { connected: boolean; state: string };
      servers?: { tools: string[] }[];
    };
    expect(session.mcp.connected).toBe(true);
    expect(flatTools(session)).toContain("list_demo_companies");
    const test = await callPortalOn(stub, "list_demo_companies", {});
    expect(test.status).toBe("ok");
    const clientAfter = await runInDurableObject(stub as never, (instance) =>
      (instance as unknown as {
        mcp: { getServersFromStorage(): { id: string; client_id: string | null }[] };
      }).mcp.getServersFromStorage().find((x) => x.id === "research")?.client_id
    );
    expect(clientAfter).toBe(clientBefore);
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

  it("authenticating resumes via a fresh authUrl from connectToServer", async () => {
    const sub = "sub-reauth";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stub = await agentStub(sub);
    const storedUrl = "http://localhost/authorize?state=storedABC";
    await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        ctx: {
          storage: {
            sql: { exec: (q: string, ...args: unknown[]) => unknown };
          };
        };
        mcp: {
          mcpConnections: Record<
            string,
            { connectionState: string; connectionError?: string }
          >;
        };
      };
      inst.ctx.storage.sql.exec(
        "UPDATE cf_agents_mcp_servers SET auth_url = ? WHERE id = ?",
        storedUrl,
        "research"
      );
      const conn = inst.mcp.mcpConnections["research"];
      if (conn) {
        conn.connectionState = "authenticating";
        conn.connectionError = undefined;
      }
    });
    const addSpy = vi.spyOn(Agent.prototype, "addMcpServer");
    const reconnectSpy = vi.spyOn(
      MCPClientManager.prototype,
      "connectToServer"
    );
    reconnectSpy.mockImplementation(async function () {
      return {
        state: "authenticating",
        authUrl: "http://localhost/authorize?state=freshXYZ"
      };
    } as never);
    const resp = await authedFetch("/api/connect", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      status: string;
      authUrl?: string;
      state?: string;
    };
    expect(data.status).toBe("authenticating");
    expect(data.authUrl).toBe("http://localhost/authorize?state=freshXYZ");
    expect(data.state).toBe("freshXYZ");
    expect(data.authUrl).not.toBe(storedUrl);
    expect(reconnectSpy).toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        mcp: {
          mcpConnections: Record<string, unknown>;
        };
      };
      expect(inst.mcp.mcpConnections["research"]).toBeDefined();
    });
  });

  it("authenticating without a stored auth_url reconnects via connectToServer", async () => {
    const sub = "sub-reauth2";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stub = await agentStub(sub);
    await runInDurableObject(stub as never, (instance) => {
      const inst = instance as unknown as {
        ctx: {
          storage: {
            sql: { exec: (q: string, ...args: unknown[]) => unknown };
          };
        };
        mcp: {
          mcpConnections: Record<
            string,
            { connectionState: string; connectionError?: string }
          >;
        };
      };
      inst.ctx.storage.sql.exec(
        "UPDATE cf_agents_mcp_servers SET auth_url = NULL WHERE id = ?",
        "research"
      );
      const conn = inst.mcp.mcpConnections["research"];
      if (conn) {
        conn.connectionState = "authenticating";
        conn.connectionError = undefined;
      }
    });
    const addSpy = vi.spyOn(Agent.prototype, "addMcpServer");
    const reconnectSpy = vi.spyOn(
      MCPClientManager.prototype,
      "connectToServer"
    );
    reconnectSpy.mockImplementation(async function () {
      return {
        state: "authenticating",
        authUrl: "http://localhost/authorize?state=reconnZ"
      };
    } as never);
    const resp = await authedFetch("/api/connect", {
      jwt,
      method: "POST",
      body: {}
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      status: string;
      authUrl?: string;
      state?: string;
    };
    expect(data.status).toBe("authenticating");
    expect(data.authUrl).toBe("http://localhost/authorize?state=reconnZ");
    expect(data.state).toBe("reconnZ");
    expect(reconnectSpy).toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
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

  it("session payload exposes servers, role-shaped suggestions, and the model id", async () => {
    const jwtA = await signJwt({ sub: "sub-payload-a", email: ANALYST_EMAIL });
    const jwtV = await signJwt({ sub: "sub-payload-v", email: VIEWER_EMAIL });
    await connectAgentMcp({ sub: "sub-payload-a", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-payload-v", email: VIEWER_EMAIL });
    const a = (await (await authedFetch("/api/session", { jwt: jwtA })).json()) as {
      servers: { id: string; label: string; tools: string[] }[];
      suggestions: { title: string; message: string }[];
      modelId: string;
    };
    const v = (await (await authedFetch("/api/session", { jwt: jwtV })).json()) as {
      servers: { id: string; label: string; tools: string[] }[];
      suggestions: { title: string; message: string }[];
      modelId: string;
    };
    expect(a.servers.length).toBeGreaterThan(0);
    expect(flatTools(a)).toContain("read_research_document");
    expect(flatTools(v)).not.toContain("read_research_document");
    expect(a.suggestions.length).toBeGreaterThan(0);
    expect(v.suggestions.length).toBeGreaterThan(0);
    expect(a.suggestions.every((s) => typeof s.title === "string" && typeof s.message === "string")).toBe(true);
    expect(JSON.stringify(a.suggestions)).not.toEqual(JSON.stringify(v.suggestions));
    expect(a.modelId).toBe(v.modelId);
    expect(a.modelId).toContain("@cf/");
  });

  it("stopping a stream before any text persists nothing; after text keeps it with the stopped suffix", async () => {
    const sub = "sub-stop";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    const stub = await agentStub(sub);
    const ctxFor = () => ({
      actorId: "actor-stop",
      userEmail: ANALYST_EMAIL,
      role: "analyst" as const,
      requestId: crypto.randomUUID(),
      identitySource: "local_jwt"
    });

    __setModelFetchForTests(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return textResponse("不应到达");
    });
    const stream1 = await runInDurableObject(stub as never, (instance) =>
      (instance as unknown as {
        chatStream(m: string, c: ReturnType<typeof ctxFor>): ReadableStream<Uint8Array>;
      }).chatStream("空停止", ctxFor())
    );
    await new Promise((r) => setTimeout(r, 300));
    await stream1.cancel();
    await new Promise((r) => setTimeout(r, 1800));
    const afterEarly = (await (await authedFetch("/api/session", { jwt })).json()) as {
      history: unknown[];
    };
    expect(afterEarly.history).toHaveLength(0);

    let call = 0;
    __setModelFetchForTests(async () => {
      call += 1;
      if (call === 1) {
        return openAiResponse({
          id: "r1",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "前半截回答",
                tool_calls: [
                  { id: "s1", type: "function", function: { name: "list_demo_companies", arguments: "{}" } }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      }
      await new Promise((r) => setTimeout(r, 1500));
      return textResponse("不应到达的结尾");
    });
    const stream2 = await runInDurableObject(stub as never, (instance) =>
      (instance as unknown as {
        chatStream(m: string, c: ReturnType<typeof ctxFor>): ReadableStream<Uint8Array>;
      }).chatStream("中途停止", ctxFor())
    );
    const reader = stream2.getReader();
    let collected = "";
    const dec = new TextDecoder();
    const pump = (async () => {
      for (;;) {
        const c = await reader.read();
        if (c.done) break;
        collected += dec.decode(c.value, { stream: true });
      }
    })();
    await new Promise((r) => setTimeout(r, 800));
    await reader.cancel();
    await pump.catch(() => {});
    await new Promise((r) => setTimeout(r, 1800));
    const afterLate = (await (await authedFetch("/api/session", { jwt })).json()) as {
      history: { role: string; content: string }[];
    };
    expect(collected).toContain("前半截回答");
    expect(afterLate.history).toHaveLength(2);
    expect(afterLate.history[1].role).toBe("assistant");
    expect(afterLate.history[1].content).toContain("前半截回答");
    expect(afterLate.history[1].content).toContain("（已停止生成）");
    expect(afterLate.history[1].content).not.toContain("不应到达的结尾");
  });
});
describe("analysis status endpoint + run_analysis job card", () => {
  const JOB_ID = "600000.SH:20261017";

  function spyQuantTools(handlers: Record<string, () => Promise<unknown> | unknown>) {
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
          { name: "abc-quant_run_analysis" },
          { name: "abc-quant_get_analysis_status" }
        ];
      } as never
    );
    const callSpy = vi
      .spyOn(MCPClientManager.prototype, "callTool")
      .mockImplementation(function (this: unknown, params: { name: string }) {
        const h = handlers[params.name];
        if (h) return Promise.resolve(h()) as never;
        return (origCall as (...a: unknown[]) => Promise<unknown>).call(
          this,
          params
        ) as never;
      });
    return { callSpy };
  }

  const STATUS_PAYLOAD = {
    job_id: "600000.SH:20261017",
    status: "running",
    phase: "ai",
    timeline: [
      { label: "引擎初始化", started_at_bj: "18:31:02", duration_s: 1.2, secret: "drop" },
      { label: "AI 诊断", started_at_bj: "18:31:03", duration_s: 4.5 }
    ],
    total_s: 5.7,
    result_summary: { final_score: 88, target_price: 12.3, extra: "drop" },
    error: null,
    internal_note: "should be dropped"
  };

  function mcpText(payload: unknown) {
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  }

  it("requires auth, analyst role and a valid job_id", async () => {
    expect(
      (await authedFetch(`/api/analysis/status?job_id=${JOB_ID}`)).status
    ).toBe(401);
    const viewerJwt = await signJwt({ sub: "sub-ana-viewer", email: VIEWER_EMAIL });
    expect(
      (
        await authedFetch(`/api/analysis/status?job_id=${JOB_ID}`, {
          jwt: viewerJwt
        })
      ).status
    ).toBe(403);
    const jwt = await signJwt({ sub: "sub-ana-1", email: ANALYST_EMAIL });
    expect(
      (await authedFetch("/api/analysis/status?job_id=not-a-job", { jwt })).status
    ).toBe(400);
    expect(
      (await authedFetch("/api/analysis/status", { jwt })).status
    ).toBe(400);
  });

  it("returns 409 requires_connect when MCP is not connected", async () => {
    const jwt = await signJwt({ sub: "sub-ana-2", email: ANALYST_EMAIL });
    const resp = await authedFetch(`/api/analysis/status?job_id=${JOB_ID}`, { jwt });
    expect(resp.status).toBe(409);
    const data = (await resp.json()) as { status: string };
    expect(data.status).toBe("requires_connect");
  });

  it("calls the *_get_analysis_status tool and returns only sanitized fields", async () => {
    const jwt = await signJwt({ sub: "sub-ana-3", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-ana-3", email: ANALYST_EMAIL });
    const { callSpy } = spyQuantTools({
      "abc-quant_get_analysis_status": () => mcpText(STATUS_PAYLOAD)
    });
    const resp = await authedFetch(`/api/analysis/status?job_id=${JOB_ID}`, { jwt });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      status: string;
      data: Record<string, unknown>;
    };
    expect(data.status).toBe("ok");
    expect(data.data.job_id).toBe(JOB_ID);
    expect(data.data.status).toBe("running");
    expect(data.data.phase).toBe("ai");
    expect(data.data.total_s).toBe(5.7);
    expect(data.data.result_summary).toEqual({ final_score: 88, target_price: 12.3 });
    expect(data.data.timeline).toEqual([
      { label: "引擎初始化", started_at_bj: "18:31:02", duration_s: 1.2 },
      { label: "AI 诊断", started_at_bj: "18:31:03", duration_s: 4.5 }
    ]);
    expect(Object.keys(data.data).sort()).toEqual(
      ["error", "job_id", "phase", "result_summary", "status", "timeline", "total_s"].sort()
    );
    expect(JSON.stringify(data)).not.toContain("drop");
    expect(JSON.stringify(data)).not.toContain("internal_note");
    expect(
      callSpy.mock.calls.some(
        (c) => (c[0] as { name: string }).name === "abc-quant_get_analysis_status"
      )
    ).toBe(true);

    // 5s cache: a second request does not re-call the tool
    const callsBefore = callSpy.mock.calls.length;
    const resp2 = await authedFetch(`/api/analysis/status?job_id=${JOB_ID}`, { jwt });
    expect(resp2.status).toBe(200);
    expect(callSpy.mock.calls.length).toBe(callsBefore);
  });

  it("returns busy for a second job while another status call is in-flight", async () => {
    const jwt = await signJwt({ sub: "sub-ana-4", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-ana-4", email: ANALYST_EMAIL });
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    spyQuantTools({
      "abc-quant_get_analysis_status": () => gate.then(() => mcpText(STATUS_PAYLOAD))
    });
    const first = authedFetch(`/api/analysis/status?job_id=${JOB_ID}`, { jwt });
    await new Promise((r) => setTimeout(r, 300));
    const second = await authedFetch(
      "/api/analysis/status?job_id=600001.SZ:20261017",
      { jwt }
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status: string }).status).toBe("busy");
    release(undefined);
    expect((await first).status).toBe(200);
  });

  it("attaches job only to *_run_analysis steps and persists it in history", async () => {
    const jwt = await signJwt({ sub: "sub-ana-5", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-ana-5", email: ANALYST_EMAIL });
    spyQuantTools({
      "abc-quant_run_analysis": () =>
        mcpText({ status: "running", job_id: JOB_ID, secret: "drop" }),
      "abc-quant_get_signals": () => mcpText({ rows: [] })
    });
    let call = 0;
    __setModelFetchForTests(async () => {
      call += 1;
      if (call === 1) {
        return toolCallResponse([
          { id: "c1", name: "abc-quant_run_analysis", args: '{"ts_code":"600000.SH"}' },
          { id: "c2", name: "abc-quant_get_signals", args: "{}" }
        ]);
      }
      return textResponse("已发起深度诊断任务。");
    });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "帮我诊断 600000.SH" }
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      events: { tool?: string; job?: { job_id: string; status: string } }[];
    };
    const withJob = data.events.filter((e) => e.job !== undefined);
    expect(withJob).toHaveLength(1);
    expect(withJob[0].tool).toBe("abc-quant_run_analysis");
    expect(withJob[0].job).toEqual({ job_id: JOB_ID, status: "running" });
    const signalsDone = data.events.find((e) => e.tool === "abc-quant_get_signals");
    expect(signalsDone?.job).toBeUndefined();
    expect(JSON.stringify(withJob[0])).not.toContain("drop");

    // persisted: history assistant turn carries the step with job
    const session = (await (
      await authedFetch("/api/session", { jwt })
    ).json()) as {
      history: {
        role: string;
        content: string;
        steps?: { tool?: string; job?: { job_id: string } }[];
      }[];
    };
    const assistant = session.history.filter((m) => m.role === "assistant").pop();
    const persisted = (assistant?.steps ?? []).filter((s) => s.job !== undefined);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].job?.job_id).toBe(JOB_ID);
    expect(JSON.stringify(assistant?.steps)).not.toContain("secret");
  });
});

describe("dynamic-route model config", () => {
  it("dynamic/abc-agent carries the same reasoning settings as GLM", () => {
    expect(MODEL_SETTINGS["dynamic/abc-agent"]).toEqual({ reasoning_effort: "low" });
    expect(MODEL_SETTINGS["dynamic/abc-agent"]).toEqual(
      MODEL_SETTINGS["@cf/zai-org/glm-5.3-flash"]
    );
  });
});
