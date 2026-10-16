import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_AUD,
  ANALYST_EMAIL,
  authedFetch,
  connectAgentMcp,
  signJwt
} from "./helpers.js";
import { setModelFake } from "./model-fake.js";

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
    model: "m",
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
    model: "m",
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
  setModelFake(undefined);
});

describe("end-to-end connect flow", () => {
  it("connect -> OAuth consent -> callback -> discovered tools callable over real MCP transport", async () => {
    const agentJwt = await signJwt({ sub: "sub-e2e", email: ANALYST_EMAIL, aud: AGENT_AUD });
    await connectAgentMcp({ sub: "sub-e2e", email: ANALYST_EMAIL });

    const session = await authedFetch("/api/session", { jwt: agentJwt });
    const sessionData = (await session.json()) as {
      mcp: { connected: boolean; state: string };
      servers: { id: string; label: string; tools: string[] }[];
    };
    expect(sessionData.mcp.connected).toBe(true);
    const tools = sessionData.servers.flatMap((g) => g.tools);
    expect(tools).toContain("list_demo_companies");
    expect(tools).toContain("get_latest_analysis");
    expect(tools).toContain("read_research_document");

    const requests: { tools?: { function?: { name: string } }[] }[] = [];
    let call = 0;
    setModelFake(async (_input, init) => {
      requests.push(JSON.parse(init.body));
      call += 1;
      if (call === 1) {
        return toolCallResponse([
          { id: "e1", name: "get_latest_analysis", args: "{\"company_id\":\"DEMO001\"}" },
          { id: "e2", name: "read_research_document", args: "{\"document_id\":\"research-note-a\"}" }
        ]);
      }
      return textResponse("端到端完成。");
    });
    const chat = await authedFetch("/api/chat", {
      jwt: agentJwt,
      method: "POST",
      body: { message: "读取 DEMO001 报告与文档" }
    });
    expect(chat.status).toBe(200);
    const data = (await chat.json()) as {
      reply: string;
      events: { text: string; kind: string; tool?: string; status?: string }[];
    };
    expect(data.reply).toBe("端到端完成。");
    const okTools = data.events.filter((e) => e.status === "ok").map((e) => e.tool);
    expect(okTools).toContain("get_latest_analysis");
    expect(okTools).toContain("read_research_document");
    const secondCall = requests.length > 1 ? JSON.stringify(requests[1]) : "";
    expect(secondCall).toContain("demo-report-a-20261012");
  });
});
