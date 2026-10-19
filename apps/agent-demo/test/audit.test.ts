import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { MCPClientManager } from "agents/mcp/client";
import { setModelFake } from "./model-fake.js";
import {
  extractTables,
  recordAudit,
  sanitizeArgs
} from "../src/shared/audit.js";
import {
  analysisAiOutboundHandler,
  quantOutboundHandler
} from "../src/quant/analysis.js";
import auditMigration from "../migrations/audit/0001_audit.sql?raw";
import auditMigration2 from "../migrations/audit/0002_call_id.sql?raw";
import {
  AGENT_AUD,
  ANALYST_EMAIL,
  MCP_AUD,
  VIEWER_EMAIL,
  authedFetch,
  connectAgentMcp,
  getSetCookies,
  mergeCookieHeader,
  mcpFetch,
  signJwt
} from "./helpers.js";

const ADMIN_EMAIL = "audit-admin@example.com";
const QUANT = "/quant";

const AUDIT_DB = () => (env as { AUDIT_DB: D1Database }).AUDIT_DB;
const QUANT_DB = () => (env as { QUANT_DB: D1Database }).QUANT_DB;

type AuditRow = Record<string, unknown>;

async function auditRows(where: string, binds: unknown[]): Promise<AuditRow[]> {
  const { results } = await AUDIT_DB()
    .prepare(`SELECT * FROM audit_events WHERE ${where}`)
    .bind(...binds)
    .all();
  return (results ?? []) as AuditRow[];
}

// DO/Worker audit writes run under waitUntil — poll briefly.
async function waitForRows(where: string, binds: unknown[], min = 1): Promise<AuditRow[]> {
  for (let i = 0; i < 40; i++) {
    const rows = await auditRows(where, binds);
    if (rows.length >= min) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return auditRows(where, binds);
}

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
    model: "x",
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
    usage: {}
  });
}

function textResponse(text: string) {
  return openAiResponse({
    id: "r2",
    object: "chat.completion",
    created: 0,
    model: "x",
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }
    ],
    usage: {}
  });
}

beforeAll(async () => {
  for (const mig of [auditMigration, auditMigration2]) {
    for (const stmt of mig.split(";")) {
      const sql = stmt.trim();
      if (sql) await AUDIT_DB().prepare(sql).run();
    }
  }
  await QUANT_DB()
    .prepare(
      `CREATE TABLE IF NOT EXISTS stock_basic (
        ts_code TEXT PRIMARY KEY, symbol TEXT, name TEXT, fullname TEXT, cnspell TEXT,
        area TEXT, industry TEXT, market TEXT, exchange TEXT, list_status TEXT,
        list_date TEXT, delist_date TEXT, is_hs TEXT, update_time TEXT
      )`
    )
    .run();
  await QUANT_DB()
    .prepare(
      "INSERT OR IGNORE INTO stock_basic (ts_code, symbol, name, cnspell, industry, market, exchange, list_status, list_date) " +
        "VALUES ('600519.SH','600519','贵州茅台','GZMT','白酒','主板','SSE','L','20010827')"
    )
    .run();
});

afterEach(() => {
  setModelFake(undefined);
  vi.restoreAllMocks();
});

// ---------- shared writer ----------

describe("recordAudit", () => {
  it("writes a batch of events and never throws", async () => {
    const marker = `unit-${crypto.randomUUID()}`;
    await recordAudit(AUDIT_DB(), [
      { source: "agent", event: "question", request_id: marker, text_excerpt: "你好" },
      { source: "agent", event: "reply", request_id: marker, status: "ok", text_excerpt: "答" }
    ]);
    const rows = await auditRows("request_id = ?", [marker]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.event).sort()).toEqual(["question", "reply"]);
    expect(typeof rows[0].id).toBe("string");
    expect(typeof rows[0].ts).toBe("number");
    // missing db -> no-op, throwing db -> swallowed + one warn line
    await recordAudit(undefined, { source: "agent", event: "question" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = { batch: () => Promise.reject(new Error("d1 down")) } as unknown as D1Database;
    await recordAudit(bad, { source: "agent", event: "question" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("audit_write_failed");
    expect(warn.mock.calls[0][0]).not.toContain("你好");
  });

  it("sanitizeArgs drops secret-like keys and truncates", () => {
    const out = sanitizeArgs({
      query: "茅台",
      api_key: "SECRET",
      nested: { authorization: "Bearer x", ok: 1 },
      long: "y".repeat(600)
    })!;
    expect(out).toContain("query");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("api_key");
    expect(out).not.toContain("Bearer x");
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(sanitizeArgs(undefined)).toBeNull();
  });

  it("extractTables pulls FROM/JOIN identifiers conservatively", () => {
    expect(extractTables("SELECT * FROM stock_basic WHERE ts_code='1'")).toEqual(["stock_basic"]);
    expect(extractTables("select a.* from chip_hunter a join alpha_hunter b on 1=1").sort()).toEqual(
      ["alpha_hunter", "chip_hunter"]
    );
    expect(extractTables("SELECT 1")).toEqual([]);
  });
});

// ---------- agent (ResearchAgent DO) ----------

describe("agent chat audit trail", () => {
  it("writes question, tool_call and reply rows for a turn", async () => {
    const sub = "sub-audit-1";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    // Capture the exact arguments the Agent sends to the Portal.
    const portalArgs: Record<string, unknown>[] = [];
    const origCall = MCPClientManager.prototype.callTool;
    const callSpy = vi
      .spyOn(MCPClientManager.prototype, "callTool")
      .mockImplementation(function (
        this: unknown,
        params: { arguments?: Record<string, unknown> }
      ) {
        portalArgs.push(params.arguments ?? {});
        return (origCall as never as (...a: unknown[]) => Promise<unknown>).call(
          this,
          params as never
        );
      } as never);
    let call = 0;
    setModelFake(async () => {
      call += 1;
      if (call === 1) {
        return toolCallResponse([{ id: "c1", name: "list_demo_companies", args: "{}" }]);
      }
      return textResponse("演示公司列表如上。");
    });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "有哪些模拟公司？" }
    });
    expect(resp.status).toBe(200);
    const rows = await waitForRows("user_email = ?", [ANALYST_EMAIL], 3);
    const byReq = rows.filter((r) => r.source === "agent");
    const question = byReq.find((r) => r.event === "question");
    const reply = byReq.find((r) => r.event === "reply");
    const toolCall = byReq.find((r) => r.event === "tool_call");
    expect(question?.text_excerpt).toBe("有哪些模拟公司？");
    expect(reply?.status).toBe("ok");
    expect(reply?.text_excerpt).toBe("演示公司列表如上。");
    expect(toolCall?.tool).toBe("list_demo_companies");
    expect(toolCall?.status).toBe("ok");
    expect(toolCall?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(question?.request_id).toBeTruthy();
    expect(question?.request_id).toBe(reply?.request_id);
    expect(question?.conversation_id).toBe(reply?.conversation_id);
    // MCP side of the same tool call (request id forwarded through _meta)
    const mcpRows = rows.filter((r) => r.source === "mcp-research");
    const mcpCall = mcpRows.find(
      (r) => r.event === "tool_call" && r.tool === "list_demo_companies"
    );
    expect(mcpCall).toBeTruthy();
    expect(mcpCall?.request_id).toBe(question?.request_id);
    expect(mcpCall?.user_email).toBe(ANALYST_EMAIL);
    const access = mcpRows.find((r) => r.event === "data_access");
    expect(access?.tables).toBe("demo_reports");
    expect(access?.status).toBe("ok");
    // _audit argument: injected into the Portal call, stripped before the
    // handler/args_json, and carries the exact call_id + request ids.
    callSpy.mockRestore();
    const sent = portalArgs.find((a) => a._audit) as
      | { _audit?: { call_id?: string; request_id?: string; conversation_id?: string } }
      | undefined;
    expect(sent?._audit?.call_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(sent?._audit?.request_id).toBe(question?.request_id);
    expect(toolCall?.call_id).toBe(sent?._audit?.call_id);
    expect(mcpCall?.call_id).toBe(sent?._audit?.call_id);
    expect(access?.call_id).toBe(sent?._audit?.call_id);
    // The model-chosen args recorded on the agent side stay clean.
    expect(toolCall?.args_json ?? "").not.toContain("_audit");
    expect(mcpCall?.args_json ?? "").not.toContain("_audit");
  });

  it("DLP-blocked turns store no content and a dlp_block row", async () => {
    const sub = "sub-audit-dlp";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    setModelFake(
      async () =>
        new Response(
          JSON.stringify({ name: "AiGatewayError", internalCode: 2030, error: [] }),
          { status: 424, headers: { "content-type": "application/json" } }
        )
    );
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "CF_DEMO_SECRET_9274" }
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { reply: string };
    expect(data.reply).toContain("DLP");
    const rows = await waitForRows(
      "user_email = ? AND event = 'dlp_block'",
      [ANALYST_EMAIL],
      1
    );
    expect(rows[0].reason).toBe("error_2030_gateway");
    const q = await auditRows(
      "user_email = ? AND event = 'question' AND request_id = ?",
      [ANALYST_EMAIL, rows[0].request_id]
    );
    expect(q[0].text_excerpt).toBeNull();
    expect(q[0].reason).toBe("dlp_blocked");
    expect(JSON.stringify(rows)).not.toContain("CF_DEMO_SECRET_9274");
  });

  it("records one model_call row per model step (finish reason, tools, tokens, aig log id)", async () => {
    const sub = "sub-audit-model";
    const jwt = await signJwt({ sub, email: ANALYST_EMAIL });
    await connectAgentMcp({ sub, email: ANALYST_EMAIL });
    let call = 0;
    setModelFake(async () => {
      call += 1;
      if (call === 1) {
        const r = toolCallResponse([
          { id: "c1", name: "list_demo_companies", args: "{}" }
        ]) as Response & { headers: Headers };
        const body = (await r.json()) as Record<string, unknown>;
        body.usage = { prompt_tokens: 123, completion_tokens: 45 };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cf-aig-log-id": "aig-log-step-1"
          }
        });
      }
      const body = {
        id: "r2",
        object: "chat.completion",
        created: 0,
        model: "x",
        choices: [
          { index: 0, message: { role: "assistant", content: "好的。" }, finish_reason: "stop" }
        ],
        usage: { prompt_tokens: 200, completion_tokens: 30 }
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "cf-aig-log-id": "aig-log-step-2" }
      });
    });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "列出公司" }
    });
    expect(resp.status).toBe(200);
    const questions = await waitForRows(
      "user_email = ? AND event = 'question' AND text_excerpt = ?",
      [ANALYST_EMAIL, "列出公司"],
      1
    );
    const rid = questions[questions.length - 1].request_id;
    const rows = await waitForRows(
      "request_id = ? AND event = 'model_call'",
      [rid],
      2
    );
    const steps = rows
      .filter((r) => r.source === "agent")
      .sort((a, b) => (a.ts as number) - (b.ts as number));
    expect(steps).toHaveLength(2);
    const a1 = JSON.parse(steps[0].args_json as string) as Record<string, unknown>;
    const a2 = JSON.parse(steps[1].args_json as string) as Record<string, unknown>;
    expect(a1.step).toBe(1);
    expect(a2.step).toBe(2);
    // step 1 chose the tool, step 2 produced the reply
    expect(steps[0].reason).toBe("tool-calls");
    expect(steps[1].reason).toBe("stop");
    expect(a1.tools).toEqual(["list_demo_companies"]);
    expect(a2.tools).toEqual([]);
    // model + gateway id, tokens, ordered AI Gateway log ids
    expect(steps[0].tool).toBe("@cf/zai-org/glm-5.3-flash");
    expect(steps[0].server).toBe("test-gateway");
    expect(steps[0].status).toBe("ok");
    expect(typeof steps[0].duration_ms).toBe("number");
    expect(a1.aig_log_id).toBe("aig-log-step-1");
    expect(a2.aig_log_id).toBe("aig-log-step-2");
    // same request/conversation as the rest of the turn
    const turn = await auditRows(
      "user_email = ? AND event = 'question' AND request_id = ?",
      [ANALYST_EMAIL, steps[0].request_id]
    );
    expect(turn).toHaveLength(1);
    // no prompt/response text leaks into model_call rows
    expect(JSON.stringify(steps)).not.toContain("列出公司");
    expect(JSON.stringify(steps)).not.toContain("好的");
  });
});

// ---------- MCP server (abc-quant) ----------

async function quantToken(sub: string, email: string): Promise<string> {
  const reg = await mcpFetch(`${QUANT}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "audit-test-client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: ["http://localhost/mcp-oauth-callback"]
    })
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const jwt = await signJwt({ sub, email, aud: MCP_AUD });
  const verifier = "v-" + crypto.randomUUID().replaceAll("-", "");
  const challenge = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
      )
    )
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const getResp = await mcpFetch(
    `${QUANT}/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent("http://localhost/mcp-oauth-callback")}` +
      `&scope=mcp%3Aread&state=s&code_challenge=${challenge}&code_challenge_method=S256` +
      `&resource=${encodeURIComponent("http://localhost/mcp")}`,
    { headers: { "cf-access-jwt-assertion": jwt } }
  );
  const html = await getResp.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
  const cookies = mergeCookieHeader(getSetCookies(getResp));
  const post = await mcpFetch(`${QUANT}/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookies,
      "cf-access-jwt-assertion": jwt,
      origin: "http://localhost"
    },
    body: `handle=${encodeURIComponent(handle)}&decision=approve`
  });
  const code = new URL(post.headers.get("location")!).searchParams.get("code")!;
  const tokenResp = await mcpFetch(`${QUANT}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body:
      `grant_type=authorization_code&code=${code}` +
      `&redirect_uri=${encodeURIComponent("http://localhost/mcp-oauth-callback")}` +
      `&client_id=${clientId}&code_verifier=${verifier}`
  });
  const tok = (await tokenResp.json()) as { access_token: string };
  return tok.access_token;
}

let rpcId = 500;
async function quantTool(
  token: string,
  name: string,
  args: unknown,
  meta?: Record<string, string>
) {
  const r = await mcpFetch(`${QUANT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) }
    })
  });
  const text = await r.text();
  const dataLine = text
    .split("\n")
    .find((l) => l.startsWith("data:"))
    ?.slice(5)
    .trim();
  return JSON.parse(dataLine ?? text) as Record<string, unknown>;
}

describe("mcp quant audit trail", () => {
  it("writes tool_call + data_access with _meta correlation and sanitized args", async () => {
    const token = await quantToken("sub-audit-q", ANALYST_EMAIL);
    const rid = crypto.randomUUID();
    const cid = crypto.randomUUID();
    await quantTool(token, "find_stock", { query: "茅台", api_key: "SECRET-XYZ" }, {
      "uk.righttu.demo/request_id": rid,
      "uk.righttu.demo/conversation_id": cid
    });
    const rows = await waitForRows("request_id = ?", [rid], 2);
    const call = rows.find((r) => r.event === "tool_call");
    const access = rows.find((r) => r.event === "data_access");
    expect(call?.source).toBe("mcp-quant");
    expect(call?.server).toBe("abc-quant");
    expect(call?.tool).toBe("find_stock");
    expect(call?.status).toBe("ok");
    expect(call?.user_email).toBe(ANALYST_EMAIL);
    expect(call?.conversation_id).toBe(cid);
    expect(call?.args_json).toContain("茅台");
    expect(call?.args_json).not.toContain("SECRET-XYZ");
    expect(call?.args_json).not.toContain("api_key");
    expect(access?.source).toBe("mcp-quant");
    expect(access?.tables).toBe("stock_basic");
    expect(access?.row_count).toBe(1);
    expect(access?.status).toBe("ok");
  });

  it("records SQL denials with the rejection reason", async () => {
    const token = await quantToken("sub-audit-q2", ANALYST_EMAIL);
    const rid = crypto.randomUUID();
    await quantTool(
      token,
      "query_data",
      { sql: "DROP TABLE stock_basic" },
      { "uk.righttu.demo/request_id": rid }
    );
    const rows = await waitForRows("request_id = ?", [rid], 2);
    const call = rows.find((r) => r.event === "tool_call");
    const access = rows.find((r) => r.event === "data_access");
    expect(call?.status).toBe("denied");
    expect(access?.status).toBe("denied");
    expect(access?.reason).toBeTruthy();
    expect(access?.sql_text).toContain("DROP TABLE");
  });

  it("keeps request_id null when _meta is absent", async () => {
    const token = await quantToken("sub-audit-q3", ANALYST_EMAIL);
    const marker = crypto.randomUUID();
    await quantTool(token, "find_stock", { query: marker });
    const rows = await waitForRows("tool = 'find_stock' AND args_json LIKE ?", [
      `%${marker}%`
    ]);
    expect(rows[0].request_id).toBeNull();
  });

  it("correlates via the _audit argument when _meta is dropped", async () => {
    const token = await quantToken("sub-audit-q4", ANALYST_EMAIL);
    const rid = crypto.randomUUID();
    const cid = crypto.randomUUID();
    const callId = crypto.randomUUID();
    await quantTool(token, "find_stock", {
      query: "茅台",
      _audit: { call_id: callId, request_id: rid, conversation_id: cid }
    });
    const rows = await waitForRows("call_id = ?", [callId], 2);
    const call = rows.find((r) => r.event === "tool_call");
    const access = rows.find((r) => r.event === "data_access");
    expect(call?.request_id).toBe(rid);
    expect(call?.conversation_id).toBe(cid);
    expect(access?.call_id).toBe(callId);
    expect(access?.request_id).toBe(rid);
    // _audit is stripped before the handler and before args are recorded.
    expect(call?.args_json ?? "").not.toContain("_audit");
    expect(call?.args_json ?? "").not.toContain(callId);
  });

  it("ignores malformed _audit ids", async () => {
    const token = await quantToken("sub-audit-q5", ANALYST_EMAIL);
    const marker = crypto.randomUUID();
    await quantTool(token, "find_stock", {
      query: marker,
      _audit: { call_id: "not-a-uuid", request_id: "bogus", conversation_id: null }
    });
    const rows = await waitForRows("tool = 'find_stock' AND args_json LIKE ?", [
      `%${marker}%`
    ]);
    const call = rows.find((r) => r.event === "tool_call");
    expect(call?.request_id).toBeNull();
    expect(call?.call_id).toBeNull();
    expect(call?.args_json ?? "").not.toContain("_audit");
  });

  it("publishes tool input schemas without an _audit property", async () => {
    const token = await quantToken("sub-audit-q6", ANALYST_EMAIL);
    const r = await mcpFetch(`${QUANT}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/list",
        params: {}
      })
    });
    const text = await r.text();
    const dataLine = text
      .split("\n")
      .find((l) => l.startsWith("data:"))
      ?.slice(5)
      .trim();
    const body = JSON.parse(dataLine ?? text) as {
      result?: { tools?: { name: string; inputSchema?: unknown }[] };
    };
    const tools = body.result?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(JSON.stringify(t.inputSchema ?? {})).not.toContain("_audit");
    }
  });
});

// ---------- quant-outbound (container -> Worker) ----------

describe("quant outbound audit", () => {
  const stub = (captured: AuditRow[]) => ({
    jobContext: async () => ({
      ts_code: "600519.SH",
      date: "20261017",
      requested_by: "reqhash123"
    }),
    auditAccess: (events: AuditRow[]) => captured.push(...events)
  });
  const fakeEnv = (captured: AuditRow[]) =>
    ({
      QUANT_DB: QUANT_DB(),
      ANALYSIS: {
        idFromString: () => ({}) as never,
        get: () => stub(captured) as never
      }
    }) as never;
  const req = (path: string, body: unknown) =>
    new Request(`http://quant-data.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

  it("records an allowed db query with tables and row count", async () => {
    const captured: AuditRow[] = [];
    const resp = await quantOutboundHandler(
      req("/api/db/query", { sql: "SELECT * FROM stock_basic" }),
      fakeEnv(captured),
      { containerId: "cid-1" }
    );
    expect(resp.status).toBe(200);
    expect(captured).toHaveLength(1);
    const ev = captured[0];
    expect(ev.source).toBe("quant-outbound");
    expect(ev.event).toBe("data_access");
    expect(ev.status).toBe("ok");
    expect(ev.job_id).toBe("600519.SH:20261017");
    expect(ev.actor_id).toBe("reqhash123");
    expect(ev.tables).toBe("stock_basic");
    expect(ev.row_count).toBe(1);
    expect(ev.sql_text).toContain("SELECT");
  });

  it("records a denied query with reason and no rows", async () => {
    const captured: AuditRow[] = [];
    const resp = await quantOutboundHandler(
      req("/api/db/query", { sql: "DROP TABLE stock_basic" }),
      fakeEnv(captured),
      { containerId: "cid-1" }
    );
    expect(resp.status).toBe(403);
    expect(captured).toHaveLength(1);
    expect(captured[0].status).toBe("denied");
    expect(captured[0].reason).toBe("db_query_sql");
    expect(captured[0].row_count).toBeNull();
  });
});

describe("quant ai.internal model_call audit", () => {
  const stub = (captured: AuditRow[]) => ({
    jobContext: async () => ({
      ts_code: "600519.SH",
      date: "20261017",
      requested_by: "reqhash123"
    }),
    auditAccess: (events: AuditRow[]) => captured.push(...events)
  });
  const aiEnv = (captured: AuditRow[], fetchImpl: typeof fetch) =>
    ({
      QUANT_DB: QUANT_DB(),
      ANALYSIS: {
        idFromString: () => ({}) as never,
        get: () => stub(captured) as never
      },
      CF_ACCOUNT_ID: "acct-t",
      CF_AIG_TOKEN: "tok-t",
      fetch: fetchImpl
    }) as never;
  const chatReq = (model: string) =>
    new Request("http://ai.internal/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] })
    });

  it("records a model_call row with served model, tokens and duration", async () => {
    const captured: AuditRow[] = [];
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: "@cf/served/real-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 321, completion_tokens: 12 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;
    const resp = await analysisAiOutboundHandler(
      chatReq("dynamic/abc-brain"),
      aiEnv(captured, fetchImpl),
      { containerId: "cid-ai" }
    );
    expect(resp.status).toBe(200);
    expect(captured).toHaveLength(1);
    const ev = captured[0];
    expect(ev.source).toBe("quant-outbound");
    expect(ev.event).toBe("model_call");
    expect(ev.status).toBe("ok");
    expect(ev.job_id).toBe("600519.SH:20261017");
    expect(ev.actor_id).toBe("reqhash123");
    expect(ev.tool).toBe("dynamic/abc-brain");
    expect(typeof ev.duration_ms).toBe("number");
    const args = JSON.parse(ev.args_json as string) as Record<string, unknown>;
    expect(args.served_model).toBe("@cf/served/real-model");
    expect(args.input_tokens).toBe(321);
    expect(args.output_tokens).toBe(12);
    expect(ev.reason).toBeNull();
  });

  it("records a model_call error row with ai_gateway_<status> reason", async () => {
    const captured: AuditRow[] = [];
    const fetchImpl = (async () => new Response("upstream boom", { status: 503 })) as typeof fetch;
    const resp = await analysisAiOutboundHandler(
      chatReq("dynamic/abc-brain"),
      aiEnv(captured, fetchImpl),
      { containerId: "cid-ai" }
    );
    expect(resp.status).toBe(503);
    expect(captured).toHaveLength(1);
    expect(captured[0].event).toBe("model_call");
    expect(captured[0].status).toBe("error");
    expect(captured[0].reason).toBe("ai_gateway_503");
  });
});

// ---------- admin view ----------

describe("admin audit surface", () => {
  const adminJwt = () =>
    signJwt({ sub: "sub-admin", email: ADMIN_EMAIL, aud: AGENT_AUD });

  it("gates /api/audit and /audit to AUDIT_ADMIN_EMAILS (404 otherwise)", async () => {
    const admin = await adminJwt();
    const analyst = await signJwt({ sub: "sub-n", email: ANALYST_EMAIL, aud: AGENT_AUD });
    expect((await authedFetch("/api/audit", { jwt: admin })).status).toBe(200);
    expect((await authedFetch("/audit", { jwt: admin })).status).toBe(200);
    const page = await (await authedFetch("/audit", { jwt: admin })).text();
    expect(page).toContain("审计视图");
    expect((await authedFetch("/api/audit", { jwt: analyst })).status).toBe(404);
    expect((await authedFetch("/audit", { jwt: analyst })).status).toBe(404);
    expect((await authedFetch("/api/audit")).status).toBe(404);
    const e = env as { AUDIT_ADMIN_EMAILS?: string };
    const saved = e.AUDIT_ADMIN_EMAILS;
    e.AUDIT_ADMIN_EMAILS = undefined;
    try {
      expect((await authedFetch("/api/audit", { jwt: admin })).status).toBe(404);
    } finally {
      e.AUDIT_ADMIN_EMAILS = saved;
    }
  });

  it("filters by Beijing dates, clamps limit and queries by job", async () => {
    const admin = await adminJwt();
    const rid = `f-${crypto.randomUUID()}`;
    // Beijing 2026-10-20 00:30 == 2026-10-19T16:30:00Z
    const ts = Date.parse("2026-10-19T16:30:00Z");
    await recordAudit(AUDIT_DB(), [
      { source: "agent", event: "question", request_id: rid, user_email: "x@t", ts },
      {
        source: "quant-outbound",
        event: "data_access",
        job_id: "600519.SH:20261017",
        tables: "sync_status",
        status: "ok",
        ts
      }
    ]);
    const q = (s: string) => authedFetch(`/api/audit?${s}`, { jwt: admin });
    const inDay = (await (await q(`request=${rid}&from=2026-10-20&to=2026-10-20`)).json()) as {
      events: AuditRow[];
    };
    expect(inDay.events).toHaveLength(1);
    const nextDay = (await (
      await q(`request=${rid}&from=2026-10-21&to=2026-10-21`)
    ).json()) as { events: AuditRow[] };
    expect(nextDay.events).toHaveLength(0);
    const prevDay = (await (
      await q(`request=${rid}&from=2026-10-19&to=2026-10-19`)
    ).json()) as { events: AuditRow[] };
    expect(prevDay.events).toHaveLength(0);
    const clamp = await q("limit=99999&user=nobody@t");
    expect(clamp.status).toBe(200);
    const jobRows = (await (
      await q("job=600519.SH:20261017")
    ).json()) as { events: AuditRow[] };
    expect(jobRows.events.length).toBeGreaterThan(0);
    expect(jobRows.events.every((r) => r.job_id === "600519.SH:20261017")).toBe(true);
    expect(jobRows.events.every((r) => r.source === "quant-outbound")).toBe(true);
    // user filter is case-insensitive and trimmed
    const mixed = (await (
      await q(`user=${encodeURIComponent(" X@T ")}`)
    ).json()) as { events: AuditRow[] };
    expect(mixed.events.length).toBeGreaterThan(0);
    expect(mixed.events.every((r) => String(r.user_email).toLowerCase() === "x@t")).toBe(true);
    // default load (no filters) is the last 24 h only
    const fresh = `fresh-${crypto.randomUUID()}`;
    const stale = `stale-${crypto.randomUUID()}`;
    await recordAudit(AUDIT_DB(), [
      { source: "agent", event: "question", request_id: fresh, ts: Date.now() - 1000 },
      {
        source: "agent",
        event: "question",
        request_id: stale,
        ts: Date.now() - 48 * 3600 * 1000
      }
    ]);
    const all = (await (await q("")).json()) as { events: AuditRow[] };
    expect(all.events.some((r) => r.request_id === fresh)).toBe(true);
    expect(all.events.some((r) => r.request_id === stale)).toBe(false);
  });

  it("session payload exposes auditAdmin only for admins", async () => {
    // Admins without an app role still reach the audit surfaces (verified
    // above); the session payload flag is for admins who also hold a role.
    const e = env as { VIEWER_EMAILS?: string };
    const saved = e.VIEWER_EMAILS;
    e.VIEWER_EMAILS = `${saved},${ADMIN_EMAIL}`;
    try {
      const admin = await adminJwt();
      const analyst = await signJwt({ sub: "sub-n2", email: ANALYST_EMAIL, aud: AGENT_AUD });
      const s1 = (await (await authedFetch("/api/session", { jwt: admin })).json()) as {
        user: { auditAdmin?: boolean };
      };
      const s2 = (await (await authedFetch("/api/session", { jwt: analyst })).json()) as {
        user: { auditAdmin?: boolean };
      };
      expect(s1.user.auditAdmin).toBe(true);
      expect(s2.user.auditAdmin).toBe(false);
    } finally {
      e.VIEWER_EMAILS = saved;
    }
  });
});
