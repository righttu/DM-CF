import { afterEach, describe, expect, it } from "vitest";
import { captureDlpOutcome, type DlpOutcome } from "../src/agent/dlp.js";
import { __setModelFetchForTests } from "../src/agent/index.js";
import { sha256Hex } from "../src/shared/access.js";
import { ANALYST_EMAIL, authedFetch, connectAgentMcp, signJwt } from "./helpers.js";

function metadataHeader(input: unknown, init: unknown): string | null {
  const headers = (init as { headers?: HeadersInit } | undefined)?.headers;
  const fromInit = headers ? new Headers(headers).get("cf-aig-metadata") : null;
  if (fromInit) return fromInit;
  return input instanceof Request ? input.headers.get("cf-aig-metadata") : null;
}

async function collect(resp: Response): Promise<DlpOutcome[]> {
  const sink: DlpOutcome[] = [];
  await captureDlpOutcome(resp, sink);
  return sink;
}

afterEach(() => {
  __setModelFetchForTests(undefined);
});

describe("DLP outcome classification", () => {
  it("recognizes cf-aig-dlp BLOCK header", async () => {
    const resp = new Response("{}", {
      headers: { "cf-aig-dlp": JSON.stringify({ action: "BLOCK", findings: [{ rule: "x" }] }) }
    });
    const sink = await collect(resp);
    expect(sink[0].action).toBe("BLOCK");
    expect(sink[0].findings).toBe(1);
  });

  it("recognizes FLAG without treating it as a block", async () => {
    const resp = new Response("{}", {
      headers: { "cf-aig-dlp": JSON.stringify({ action: "FLAG", findings: [{ rule: "x" }] }) }
    });
    const sink = await collect(resp);
    expect(sink[0].action).toBe("FLAG");
  });

  it("recognizes 2029/2030 error codes as BLOCK", async () => {
    const resp = new Response(JSON.stringify({ errors: [{ code: 2029 }] }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
    const sink = await collect(resp);
    expect(sink[0].action).toBe("BLOCK");
    const resp2030 = new Response(JSON.stringify({ errors: [{ code: 2030 }] }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
    const sink2030 = await collect(resp2030);
    expect(sink2030[0].action).toBe("BLOCK");
  });

  it("malformed or unknown cf-aig-dlp header still allows 2029/2030 body recognition", async () => {
    const malformed = new Response(JSON.stringify({ errors: [{ code: 2029 }] }), {
      status: 400,
      headers: { "content-type": "application/json", "cf-aig-dlp": "not-json{{{" }
    });
    const sink = await collect(malformed);
    expect(sink[0].action).toBe("BLOCK");
    expect(sink[0].detail).toBe("error_2029_request");

    const unknownAction = new Response(JSON.stringify({ errors: [{ code: 2030 }] }), {
      status: 400,
      headers: {
        "content-type": "application/json",
        "cf-aig-dlp": JSON.stringify({ action: "SOMETHING_ELSE" })
      }
    });
    const sink2 = await collect(unknownAction);
    expect(sink2[0].action).toBe("BLOCK");
    expect(sink2[0].detail).toBe("error_2030_response");
  });

  it("recognizes documented 2030 inside a 424 AiGatewayError body (observed live shape)", async () => {
    const body = {
      success: false,
      result: [],
      messages: [],
      error: [{ code: 2030, message: "Request content blocked due to DLP policy violations" }],
      name: "AiGatewayError",
      httpCode: 424,
      internalCode: 2030,
      message: "Request content blocked due to DLP policy violations",
      description: "Request content blocked due to DLP policy violations"
    };
    const resp = new Response(JSON.stringify(body), {
      status: 424,
      headers: { "content-type": "application/json", "cf-aig-log-id": "log-live-424" }
    });
    const sink = await collect(resp);
    expect(sink).toHaveLength(1);
    expect(sink[0].action).toBe("BLOCK");
    expect(sink[0].logId).toBe("log-live-424");
    expect(sink[0].detail).toBe("error_2030_gateway");
  });

  it("recognizes a 424 singular error array without internalCode/name", async () => {
    const resp = new Response(JSON.stringify({ error: [{ code: 2030 }] }), {
      status: 424,
      headers: { "content-type": "application/json" }
    });
    const sink = await collect(resp);
    expect(sink[0].action).toBe("BLOCK");
    expect(sink[0].detail).toBe("error_2030_gateway");
  });

  it("recognizes internalCode only inside an AiGatewayError envelope", async () => {
    const resp = new Response(
      JSON.stringify({ name: "AiGatewayError", internalCode: 2030 }),
      { status: 424, headers: { "content-type": "application/json" } }
    );
    const sink = await collect(resp);
    expect(sink[0].action).toBe("BLOCK");
    expect(sink[0].detail).toBe("error_2030_gateway");
  });

  it("does not classify bare or non-DLP 424s", async () => {
    const bare = await collect(new Response("not json", { status: 424 }));
    expect(bare).toHaveLength(0);
    const otherCodes = await collect(
      new Response(
        JSON.stringify({ name: "AiGatewayError", internalCode: 2000, error: [{ code: 2000 }] }),
        { status: 424, headers: { "content-type": "application/json" } }
      )
    );
    expect(otherCodes).toHaveLength(0);
    const nonGateway = await collect(
      new Response(JSON.stringify({ name: "ProviderError", internalCode: 2030 }), {
        status: 424,
        headers: { "content-type": "application/json" }
      })
    );
    expect(nonGateway).toHaveLength(0);
  });

  it("does not classify a 200 body containing error codes without a DLP header", async () => {
    const resp = new Response(JSON.stringify({ errors: [{ code: 2030 }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    expect(await collect(resp)).toHaveLength(0);
  });

  it("does not label generic 400/404 as DLP", async () => {
    const resp400 = new Response(JSON.stringify({ error: { message: "bad request" } }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
    expect(await collect(resp400)).toHaveLength(0);
    const resp404 = new Response("not found", { status: 404 });
    expect(await collect(resp404)).toHaveLength(0);
  });

  it("chat reports cloud-confirmed DLP block without model content", async () => {
    __setModelFetchForTests(async () => {
      return new Response(JSON.stringify({ errors: [{ code: 2029, message: "dlp" }] }), {
        status: 400,
        headers: { "content-type": "application/json", "cf-aig-log-id": "log-123" }
      });
    });
    const jwt = await signJwt({ sub: "sub-dlp", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-dlp", email: ANALYST_EMAIL });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "test CF_DEMO_SECRET_9274" }
    });
    const data = (await resp.json()) as { reply: string; dlp?: { action: string; logId?: string } };
    expect(data.dlp?.action).toBe("BLOCK");
    expect(data.dlp?.logId).toBe("log-123");
    expect(data.reply).toContain("DLP");
    expect(data.reply).not.toContain("CF_DEMO_SECRET_9274");
  });

  it("withholds model content and prompt on DLP BLOCK header over a 200 completion, history unchanged", async () => {
    const canary = "CANARY_MODEL_TEXT_7721";
    const promptCanary = "CANARY_PROMPT_8834";
    let call = 0;
    const bodies: { messages?: unknown[] }[] = [];
    __setModelFetchForTests(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            id: "r1",
            object: "chat.completion",
            created: 0,
            model: "qwen3.8-2.4t-a95b",
            choices: [
              { index: 0, message: { role: "assistant", content: canary }, finish_reason: "stop" }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cf-aig-dlp": JSON.stringify({ action: "BLOCK", findings: [{ rule: "marker" }] }),
              "cf-aig-log-id": "log-block-200"
            }
          }
        );
      }
      return new Response(
        JSON.stringify({
          id: "r2",
          object: "chat.completion",
          created: 0,
          model: "qwen3.8-2.4t-a95b",
          choices: [
            { index: 0, message: { role: "assistant", content: "正常回复" }, finish_reason: "stop" }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const jwt = await signJwt({ sub: "sub-dlp200", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-dlp200", email: ANALYST_EMAIL });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: promptCanary }
    });
    const data = (await resp.json()) as { reply: string; dlp?: { action: string; logId?: string } };
    expect(data.dlp?.action).toBe("BLOCK");
    expect(data.reply).not.toContain(canary);
    expect(data.reply).not.toContain(promptCanary);

    const session = await authedFetch("/api/session", { jwt });
    const sessionData = (await session.json()) as { history: { content: string }[] };
    expect(sessionData.history).toHaveLength(0);

    const resp2 = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "后续正常问题" }
    });
    const data2 = (await resp2.json()) as { reply: string };
    expect(data2.reply).toBe("正常回复");
    expect(JSON.stringify(bodies[1]?.messages)).not.toContain(promptCanary);
  });

  it("BLOCK header on a 200 tool_calls response prevents tool execution and extra model calls", async () => {
    let call = 0;
    __setModelFetchForTests(async () => {
      call += 1;
      return new Response(
        JSON.stringify({
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
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: {
                      name: "get_latest_analysis",
                      arguments: "{\"company_id\":\"DEMO001\"}"
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cf-aig-dlp": JSON.stringify({ action: "BLOCK", findings: [{ rule: "marker" }] })
          }
        }
      );
    });
    const jwt = await signJwt({ sub: "sub-dlp-tc", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-dlp-tc", email: ANALYST_EMAIL });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "查询 DEMO001" }
    });
    const data = (await resp.json()) as {
      reply: string;
      dlp?: { action: string };
      events: { text: string; kind: string }[];
    };
    expect(data.dlp?.action).toBe("BLOCK");
    expect(call).toBe(1);
    expect(data.events.some((e) => e.text.includes("工具调用"))).toBe(false);
    expect(data.events.some((e) => e.text.includes("DLP"))).toBe(true);
    const session = await authedFetch("/api/session", { jwt });
    const sessionData = (await session.json()) as { history: unknown[] };
    expect(sessionData.history).toHaveLength(0);
  });

  it("app-level: observed 424 AiGatewayError blocks chat and dlp-test without echoing the marker", async () => {
    const body = {
      success: false,
      result: [],
      messages: [],
      error: [{ code: 2030, message: "Request content blocked due to DLP policy violations" }],
      name: "AiGatewayError",
      httpCode: 424,
      internalCode: 2030,
      message: "Request content blocked due to DLP policy violations",
      description: "Request content blocked due to DLP policy violations"
    };
    const metaCalls: (string | null)[] = [];
    __setModelFetchForTests(async (input, init) => {
      metaCalls.push(metadataHeader(input, init));
      return new Response(JSON.stringify(body), {
        status: 424,
        headers: { "content-type": "application/json", "cf-aig-log-id": "log-live-424" }
      });
    });
    const jwt = await signJwt({ sub: "sub-dlp-424", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-dlp-424", email: ANALYST_EMAIL });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "CF_DEMO_SECRET_9274" }
    });
    const data = (await resp.json()) as {
      reply: string;
      dlp?: { action: string; logId?: string; detail?: string };
    };
    expect(data.dlp?.action).toBe("BLOCK");
    expect(data.dlp?.logId).toBe("log-live-424");
    expect(data.dlp?.detail).toBe("error_2030_gateway");
    expect(data.reply).not.toContain("CF_DEMO_SECRET_9274");

    const session = await authedFetch("/api/session", { jwt });
    const sessionData = (await session.json()) as { history: unknown[] };
    expect(sessionData.history).toHaveLength(0);

    const dlpTest = await authedFetch("/api/dlp-test", { jwt, method: "POST", body: {} });
    const dlpData = (await dlpTest.json()) as { dlp?: { action: string }; error?: string; requestId?: string };
    expect(dlpData.dlp?.action).toBe("BLOCK");
    expect(dlpData.error).toBeUndefined();
    expect(dlpData.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const dlpMeta = JSON.parse(metaCalls[1]!) as Record<string, string>;
    expect(Object.keys(dlpMeta).sort()).toEqual(
      ["action", "actor_id", "conversation_id", "request_id", "role"].sort()
    );
    expect(dlpMeta.action).toBe("dlp-test");
    expect(dlpMeta.actor_id).toBe(await sha256Hex("sub-dlp-424"));
    expect(dlpMeta.request_id).toBe(dlpData.requestId);
    expect(JSON.stringify(dlpMeta)).not.toContain("CF_DEMO_SECRET");
    expect(JSON.stringify(dlpMeta)).not.toContain("@");
    expect(JSON.stringify(dlpMeta)).not.toContain("test-aig-token");
  });

  it("generic gateway errors are not labelled DLP", async () => {
    __setModelFetchForTests(async () => {
      return new Response(JSON.stringify({ error: { message: "provider exploded" } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    });
    const jwt = await signJwt({ sub: "sub-dlp-err", email: ANALYST_EMAIL });
    await connectAgentMcp({ sub: "sub-dlp-err", email: ANALYST_EMAIL });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "hello" }
    });
    const data = (await resp.json()) as { reply: string; dlp?: unknown };
    expect(data.dlp).toBeUndefined();
    expect(data.reply).not.toContain("DLP");
  });
});
