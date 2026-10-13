import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { __setModelFetchForTests } from "../src/agent/index.js";
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
});

describe("ResearchAgent chat and tools", () => {
  it("mocked Qwen invokes both report tools over real MCP then returns final text", async () => {
    const jwt = await signJwt({ sub: "sub-chat-1", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-chat-1", email: ANALYST_EMAIL });

    const requests: { url: string; body: { messages?: unknown[]; tools?: { function?: { name: string } }[] } }[] = [];
    let call = 0;
    __setModelFetchForTests(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
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
    };
    expect(data.reply).toBe("最终回答：两个模拟报告已比较。");
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
      expect(typeof rec.conversationId).toBe("string");
      const serialized = JSON.stringify(rec);
      expect(serialized).not.toContain(VIEWER_EMAIL);
      expect(serialized).not.toContain("research-note-a");
      expect(serialized).not.toContain("CF_DEMO_SECRET");
    } finally {
      spy.mockRestore();
    }
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
});
