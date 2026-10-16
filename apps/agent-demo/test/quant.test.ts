import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schemaSql from "./fixtures/quant-schema.sql?raw";
import { __setEmbeddingForTests } from "../src/quant/tools.js";
import type { VectorMatch } from "../src/quant/tools.js";
import {
  MCP_AUD,
  VIEWER_EMAIL,
  ANALYST_EMAIL,
  getSetCookies,
  mergeCookieHeader,
  mcpFetch,
  signJwt
} from "./helpers.js";

const QUANT = "/quant";

const CANNED_MATCHES: VectorMatch[] = [
  {
    score: 0.9,
    metadata: {
      ts_code: "600519.SH",
      stock_name: "贵州茅台",
      publish_date: "2026-09-01",
      source_type: "研报",
      title: "贵州茅台中报点评",
      org: "中信证券",
      chunk_text: "业绩稳健增长，渠道库存健康"
    }
  },
  {
    score: 0.8,
    metadata: {
      ts_code: "600519.SH",
      stock_name: "贵州茅台",
      publish_date: "2026-09-01",
      source_type: "研报",
      title: "贵州茅台中报点评",
      org: "中信证券",
      chunk_text: "产能扩张顺利，飞天批价稳定"
    }
  },
  {
    score: 0.7,
    metadata: {
      ts_code: "600519.SH",
      stock_name: "贵州茅台",
      publish_date: "2026-06-15",
      source_type: "公告",
      title: "年度分红公告",
      org: "公司",
      chunk_text: "每10股派发现金红利"
    }
  },
  {
    score: 0.6,
    metadata: {
      ts_code: "600519.SH",
      stock_name: "贵州茅台",
      publish_date: "2026-05-01",
      source_type: "新闻",
      title: "白酒行业景气度观察",
      org: "财经媒体",
      chunk_text: "行业动销平稳"
    }
  }
];

const fakeEmbedder = {
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.some((t) => t.includes("FAIL_EMBED"))) {
      throw new Error("embed down");
    }
    return texts.map((t) => {
      const v = new Array<number>(512).fill(0);
      for (let i = 0; i < t.length; i++) v[i % 512] += t.charCodeAt(i) / 1e5;
      return v;
    });
  }
};

const fakeIndex = {
  async query(
    _vector: number[],
    options: { topK: number; namespace?: string }
  ): Promise<{ matches: VectorMatch[] }> {
    const matches = CANNED_MATCHES.filter(
      (m) => !options.namespace || m.metadata?.ts_code === options.namespace
    ).slice(0, options.topK);
    return { matches };
  }
};

async function quantRegister(): Promise<{ clientId: string; redirectUri: string }> {
  const resp = await mcpFetch(`${QUANT}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "quant-test-client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: ["http://localhost/mcp-oauth-callback"]
    })
  });
  expect(resp.status).toBeLessThan(300);
  const data = (await resp.json()) as { client_id: string };
  return { clientId: data.client_id, redirectUri: "http://localhost/mcp-oauth-callback" };
}

function pkce() {
  const verifier = "q-verifier-" + crypto.randomUUID().replaceAll("-", "");
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(verifier))
    .then((d) => ({
      verifier,
      challenge: btoa(String.fromCharCode(...new Uint8Array(d)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")
    }));
}

async function quantConsent(jwt: string, clientId: string, redirectUri: string) {
  const { verifier, challenge } = await pkce();
  const getResp = await mcpFetch(
    `${QUANT}/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=mcp%3Aread&state=qstate&code_challenge=${challenge}&code_challenge_method=S256` +
      `&resource=${encodeURIComponent("http://localhost/mcp")}`,
    { headers: { "cf-access-jwt-assertion": jwt } }
  );
  const html = await getResp.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
  const cookies = mergeCookieHeader(getSetCookies(getResp));
  const postResp = await mcpFetch(`${QUANT}/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookies,
      "cf-access-jwt-assertion": jwt,
      origin: "http://localhost"
    },
    body: `handle=${encodeURIComponent(handle)}&decision=approve`
  });
  expect(postResp.status).toBe(302);
  const code = new URL(postResp.headers.get("location")!).searchParams.get("code")!;
  const tokenResp = await mcpFetch(`${QUANT}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body:
      `grant_type=authorization_code&code=${code}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${clientId}` +
      `&code_verifier=${verifier}`
  });
  expect(tokenResp.status).toBe(200);
  const token = (await tokenResp.json()) as { access_token: string };
  return { getResp, html, token: token.access_token };
}

async function quantRpc(
  token: string,
  method: string,
  params: unknown,
  id: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await mcpFetch(`${QUANT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const text = await r.text();
  const dataLine = text
    .split("\n")
    .find((l) => l.startsWith("data:"))
    ?.slice(5)
    .trim();
  return { status: r.status, body: JSON.parse(dataLine ?? text) as Record<string, unknown> };
}

function toolPayload(body: Record<string, unknown>): Record<string, unknown> {
  const content = (body.result as { content?: { text?: string }[] })?.content;
  try {
    return JSON.parse(content?.[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

let callId = 100;
async function callTool(token: string, name: string, args: unknown) {
  const r = await quantRpc(token, "tools/call", { name, arguments: args }, ++callId);
  const result = r.body.result as { isError?: boolean } | undefined;
  return { status: r.status, body: r.body, payload: toolPayload(r.body), isError: result?.isError === true };
}

beforeAll(async () => {
  const db = (env as unknown as { QUANT_DB: D1Database }).QUANT_DB;
  for (const statement of schemaSql.split(";")) {
    const sql = statement.trim();
    if (sql) await db.prepare(sql).run();
  }
  const seeds = [
    `INSERT INTO stock_basic (ts_code,symbol,name,fullname,cnspell,industry,market,exchange,list_status,list_date) VALUES
      ('600519.SH','600519','贵州茅台','贵州茅台酒股份有限公司','GZMT','白酒','主板','SSE','L','20010827'),
      ('000001.SZ','000001','平安银行','平安银行股份有限公司','PAYH','银行','主板','SZSE','L','19910403')`,
    `INSERT INTO chip_hunter (scan_date,ts_code,name,industry,close,pct_chg,total_mv,score,tags,chip_cumu_change,chip_latest_change,holders_wan,turnover_rate_3d,net_mf_amount,net_inflow_5d,pe_ttm,roe,netprofit_yoy) VALUES
      ('20261015','600519.SH','贵州茅台','白酒',1500,1.2,19000,88.5,'户数三连降',-12.3,-4.1,15.2,3.4,5000,12000,28.5,34.1,15.2),
      ('20261014','600519.SH','贵州茅台','白酒',1480,0.5,18800,80,'',-10,-3,15.5,3.1,4000,11000,28,34,15)`,
    `INSERT INTO alpha_hunter (ts_code,name,industry,close,total_mv,score,tags,roe,netprofit_yoy,scan_date,ratio_current,ratio_prev_1,main_business) VALUES
      ('600519.SH','贵州茅台','白酒',1500,19000,90,'长线机构:3家',34,15,'20261015','5.2%','4.9%','白酒生产销售')`,
    `INSERT INTO hotspot_hunter (ts_code,trade_date,name,industry,sector,close,pct_chg,total_mv,mf_intensity,net_mf_amount,net_inflow_5d,scan_date,tags) VALUES
      ('002050.SZ','20261015','三花智控','汽零','具身智能',45,3.2,1600,75,8000,9000,'20261015','真题材|执行器|理由')`,
    `INSERT INTO hotspot_registry (ts_code,name,sector,node,purity,remark,volume_node,create_date) VALUES
      ('002050.SZ','三花智控','具身智能','4. 六维力矩传感器','真题材','核心供应商','26Q1','20261010'),
      ('600519.SH','贵州茅台','白酒','0. 主营','真题材','不相关','', '20261010')`,
    `INSERT INTO stock_fundamentals (ts_code,end_date,ann_date,revenue,netprofit_yoy,roe,total_mv) VALUES
      ('600519.SH','20260630','20260801',80000000000,15.0,34.5,190000000),
      ('600519.SH','20260331','20260428',40000000000,14.0,17.0,188000000)`,
    `INSERT INTO institutional_surveys (ts_code,survey_date,org_count,org_names,reception_place) VALUES
      ('600519.SH','2026-09-20',12,'中信证券;易方达','公司会议室')`,
    `INSERT INTO sync_status (ts_code,last_report_sync,last_news_sync) VALUES
      ('600519.SH','2026-10-01','2026-10-10')`
  ];
  for (const sql of seeds) {
    await db.prepare(sql).run();
  }
  await db
    .prepare(
      "INSERT INTO ai_analysis_result (report_date,ts_code,name,industry,source_strategy,current_price,target_price,upside_potential,score_certainty,final_score,ai_report,tags,update_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(
      "20261015", "600519.SH", "贵州茅台", "白酒", "chip_hunter",
      1500, 1800, 20, 80, 74, "长".repeat(9000), "标签", "t1"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ai_analysis_result (report_date,ts_code,name,industry,source_strategy,current_price,target_price,upside_potential,score_certainty,final_score,ai_report,tags,update_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(
      "20261001", "600519.SH", "贵州茅台", "白酒", "alpha_hunter",
      1480, 1750, 18, 70, 60, "短报告", "", "t2"
    )
    .run();
  __setEmbeddingForTests(fakeEmbedder, fakeIndex);
});

describe("quant MCP OAuth gating", () => {
  it("denies the consent page to viewers and serves it to analysts", async () => {
    const { clientId, redirectUri } = await quantRegister();
    const { challenge } = await pkce();
    const viewerJwt = await signJwt({ sub: "sub-q-viewer", email: VIEWER_EMAIL, aud: MCP_AUD });
    const denied = await mcpFetch(
      `${QUANT}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=mcp%3Aread&state=s&code_challenge=${challenge}&code_challenge_method=S256` +
        `&resource=${encodeURIComponent("http://localhost/mcp")}`,
      { headers: { "cf-access-jwt-assertion": viewerJwt } }
    );
    expect(denied.status).toBe(403);

    const analystJwt = await signJwt({ sub: "sub-q-analyst", email: ANALYST_EMAIL, aud: MCP_AUD });
    const ok = await mcpFetch(
      `${QUANT}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=mcp%3Aread&state=s&code_challenge=${challenge}&code_challenge_method=S256` +
        `&resource=${encodeURIComponent("http://localhost/mcp")}`,
      { headers: { "cf-access-jwt-assertion": analystJwt } }
    );
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("ABC Quant MCP-S 访问授权");
    expect(html).toContain("只读访问 ABC 量化数据");
    expect(html).toContain('name="handle"');
  });

  it("denies consent POST for viewer role", async () => {
    const { clientId, redirectUri } = await quantRegister();
    const analystJwt = await signJwt({ sub: "sub-q-post-a", email: ANALYST_EMAIL, aud: MCP_AUD });
    const viewerJwt = await signJwt({ sub: "sub-q-post-v", email: VIEWER_EMAIL, aud: MCP_AUD });
    const { challenge } = await pkce();
    const getResp = await mcpFetch(
      `${QUANT}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=mcp%3Aread&state=s&code_challenge=${challenge}&code_challenge_method=S256` +
        `&resource=${encodeURIComponent("http://localhost/mcp")}`,
      { headers: { "cf-access-jwt-assertion": analystJwt } }
    );
    const html = await getResp.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
    const cookies = mergeCookieHeader(getSetCookies(getResp));
    const post = await mcpFetch(`${QUANT}/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": viewerJwt,
        origin: "http://localhost"
      },
      body: `handle=${encodeURIComponent(handle)}&decision=approve`
    });
    expect(post.status).toBe(403);
  });

  it("blocks viewer-role principals at /mcp with 403", async () => {
    const { clientId, redirectUri } = await quantRegister();
    const jwt = await signJwt({ sub: "sub-q-flip", email: ANALYST_EMAIL, aud: MCP_AUD });
    const { token } = await quantConsent(jwt, clientId, redirectUri);
    const mutable = env as unknown as { ANALYST_EMAILS?: string; VIEWER_EMAILS?: string };
    const origAnalyst = mutable.ANALYST_EMAILS;
    const origViewer = mutable.VIEWER_EMAILS;
    try {
      mutable.ANALYST_EMAILS = "someone-else@example.com";
      mutable.VIEWER_EMAILS = `${origViewer},${ANALYST_EMAIL}`;
      const resp = await mcpFetch(`${QUANT}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      });
      expect(resp.status).toBe(403);
    } finally {
      mutable.ANALYST_EMAILS = origAnalyst;
      mutable.VIEWER_EMAILS = origViewer;
    }
  });
});

describe("quant tools", () => {
  let token: string;

  beforeAll(async () => {
    const { clientId, redirectUri } = await quantRegister();
    const jwt = await signJwt({ sub: "sub-q-tools", email: ANALYST_EMAIL, aud: MCP_AUD });
    ({ token } = await quantConsent(jwt, clientId, redirectUri));
    const init = await quantRpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" }
    }, 1);
    expect(init.status).toBe(200);
  });

  it("tools/list advertises typed schemas with descriptions", async () => {
    const listResp = await quantRpc(token, "tools/list", {}, 2);
    const tools = ((listResp.body.result as { tools?: { name: string; inputSchema?: { properties?: Record<string, { type?: string; enum?: string[]; description?: string; maximum?: number }> } }[] })?.tools) ?? [];
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(tools.length).toBe(9);
    const findQuery = byName.get("find_stock")!.inputSchema!.properties!.query;
    expect(findQuery.type).toBe("string");
    expect(findQuery.description).toContain("拼音");
    const strategy = byName.get("get_signals")!.inputSchema!.properties!.strategy;
    expect(strategy.enum).toEqual(["chip", "alpha", "hotspot", "all"]);
    const limit = byName.get("get_signals")!.inputSchema!.properties!.limit;
    expect(limit.type).toBe("integer");
    expect(limit.maximum).toBe(50);
  });

  it("describe_data returns the dictionary and one entry", async () => {
    const all = await callTool(token, "describe_data", {});
    expect((all.payload.tables as Record<string, unknown>).stock_basic).toBeTruthy();
    expect(all.payload.research).toBeTruthy();
    const one = await callTool(token, "describe_data", { table: "chip_hunter" });
    expect((one.payload.doc as { description: string }).description).toContain("筹码");
    const research = await callTool(token, "describe_data", { table: "research" });
    expect((research.payload.doc as { description: string }).description).toContain("研报");
    const bad = await callTool(token, "describe_data", { table: "nope" });
    // enum mismatch is rejected at the protocol layer by the advertised schema
    expect(bad.isError || bad.body.error).toBeTruthy();
  });

  it("find_stock resolves name, code and pinyin", async () => {
    const byName = await callTool(token, "find_stock", { query: "茅台" });
    const results = byName.payload.results as { ts_code: string }[];
    expect(results[0].ts_code).toBe("600519.SH");
    const bySpell = await callTool(token, "find_stock", { query: "gzmt" });
    expect((bySpell.payload.results as { ts_code: string }[])[0].ts_code).toBe("600519.SH");
    const bad = await callTool(token, "find_stock", { query: "x".repeat(21) });
    expect(bad.payload.error).toBe("invalid_arguments");
  });

  it("get_signals returns per-stock and latest rows", async () => {
    const byStock = await callTool(token, "get_signals", { ts_code: "600519.SH" });
    const results = byStock.payload.results as Record<string, { rows: unknown[] }>;
    expect(results.chip.rows.length).toBe(2);
    expect(results.alpha.rows.length).toBe(1);
    expect(byStock.payload.name).toBe("贵州茅台");
    const chipOnly = await callTool(token, "get_signals", {
      ts_code: "600519.SH",
      strategy: "chip",
      limit: 1
    });
    expect((chipOnly.payload.results as Record<string, { rows: unknown[] }>).chip.rows.length).toBe(1);
    expect((chipOnly.payload.results as Record<string, unknown>).alpha).toBeUndefined();
    const latest = await callTool(token, "get_signals", {});
    const latestChip = (latest.payload.results as Record<string, { rows: { scan_date: string }[] }>).chip;
    expect(latestChip.rows.length).toBe(1);
    expect(latestChip.rows[0].scan_date).toBe("20261015");
    const badCode = await callTool(token, "get_signals", { ts_code: "600519" });
    expect(badCode.payload.error).toBe("invalid_arguments");
  });

  it("get_fundamentals returns periods newest first with unit note", async () => {
    const r = await callTool(token, "get_fundamentals", { ts_code: "600519.SH" });
    const periods = r.payload.periods as { end_date: string }[];
    expect(periods.length).toBe(2);
    expect(periods[0].end_date).toBe("20260630");
    expect(r.payload.name).toBe("贵州茅台");
    expect(r.payload.unit_note).toContain("累计值");
  });

  it("get_ai_report returns latest with truncation note, history, and list", async () => {
    const latest = await callTool(token, "get_ai_report", { ts_code: "600519.SH" });
    const report = latest.payload.report as { ai_report: string; ai_report_length: number };
    expect(report.ai_report.length).toBe(8000);
    expect(report.ai_report_length).toBe(9000);
    expect(String(latest.payload.note)).toContain("截断");
    const history = await callTool(token, "get_ai_report", { ts_code: "600519.SH", history: true });
    expect((history.payload.reports as unknown[]).length).toBe(2);
    expect((history.payload.reports as { ai_report?: string }[])[0].ai_report).toBeUndefined();
    const list = await callTool(token, "get_ai_report", {});
    const rows = list.payload.reports as { report_date: string }[];
    expect(rows.length).toBe(2);
    expect(rows[0].report_date).toBe("20261015");
  });

  it("search_research groups documents, filters, covers empty and embed failure", async () => {
    const r = await callTool(token, "search_research", { ts_code: "600519.SH", query: "业绩" });
    const docs = r.payload.documents as {
      title: string; publish_date: string; source_type: string; excerpts: string[];
    }[];
    expect(docs.length).toBe(3);
    expect(docs[0].publish_date).toBe("2026-09-01");
    expect(docs[0].excerpts.length).toBe(2);
    const coverage = r.payload.coverage as { last_report_sync: string };
    expect(coverage.last_report_sync).toBe("2026-10-01");

    const since = await callTool(token, "search_research", {
      ts_code: "600519.SH", query: "业绩", since: "2026-08-01"
    });
    expect((since.payload.documents as unknown[]).length).toBe(1);
    const byType = await callTool(token, "search_research", {
      ts_code: "600519.SH", query: "业绩", source_type: "公告"
    });
    expect((byType.payload.documents as { source_type: string }[])[0].source_type).toBe("公告");

    const empty = await callTool(token, "search_research", { ts_code: "000001.SZ" });
    expect((empty.payload.documents as unknown[]).length).toBe(0);
    expect(String(empty.payload.note)).toContain("知识库中没有匹配");

    const fail = await callTool(token, "search_research", {
      ts_code: "600519.SH", query: "FAIL_EMBED"
    });
    expect(fail.isError).toBe(true);
    expect(fail.payload.error).toBe("embedding_unavailable");

    const badDate = await callTool(token, "search_research", {
      ts_code: "600519.SH", since: "2026/08/01"
    });
    expect(badDate.payload.error).toBe("invalid_arguments");
  });

  it("get_surveys returns survey rows", async () => {
    const r = await callTool(token, "get_surveys", { ts_code: "600519.SH" });
    const surveys = r.payload.surveys as { survey_date: string; org_names: string }[];
    expect(surveys.length).toBe(1);
    expect(surveys[0].survey_date).toBe("2026-09-20");
  });

  it("get_industry_chain requires exactly one selector", async () => {
    const byStock = await callTool(token, "get_industry_chain", { ts_code: "600519.SH" });
    expect((byStock.payload.rows as unknown[]).length).toBe(1);
    const bySector = await callTool(token, "get_industry_chain", { sector: "具身智能" });
    const rows = bySector.payload.rows as { node: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].node).toContain("六维力矩传感器");
    const both = await callTool(token, "get_industry_chain", {
      ts_code: "600519.SH", sector: "具身智能"
    });
    expect(both.payload.error).toBe("invalid_arguments");
    const neither = await callTool(token, "get_industry_chain", {});
    expect(neither.payload.error).toBe("invalid_arguments");
  });

  it("query_data runs read-only SQL, caps rows, and reports sql_error", async () => {
    const ok = await callTool(token, "query_data", {
      sql: "SELECT ts_code, name FROM stock_basic ORDER BY ts_code"
    });
    const rows = ok.payload.rows as { ts_code: string }[];
    expect(rows.length).toBe(2);
    expect(ok.payload.row_count).toBe(2);
    expect((ok.payload.columns as string[])[0]).toBe("ts_code");

    const withCte = await callTool(token, "query_data", {
      sql: "WITH x AS (SELECT ts_code FROM stock_basic WHERE symbol = '600519') SELECT * FROM x"
    });
    expect((withCte.payload.rows as unknown[]).length).toBe(1);

    const replaceFn = await callTool(token, "query_data", {
      sql: "SELECT replace(ratio_current, '%', '') AS r FROM alpha_hunter"
    });
    expect((replaceFn.payload.rows as { r: string }[])[0].r).toBe("5.2");

    const capped = await callTool(token, "query_data", {
      sql: "SELECT ts_code FROM stock_basic", max_rows: 1
    });
    expect(capped.payload.row_count).toBe(1);
    expect(capped.payload.truncated).toBe(true);

    const sqlErr = await callTool(token, "query_data", {
      sql: "SELECT nope FROM nonexistent_table"
    });
    expect(sqlErr.payload.error).toBe("sql_error");

    const rejected = [
      "SELECT 1; DELETE FROM chip_hunter",
      "SELECT 1) ; DELETE FROM chip_hunter; --",
      "SELECT ts_code FROM stock_basic -- comment",
      "SELECT ts_code /* c */ FROM stock_basic",
      "DELETE FROM chip_hunter",
      "INSERT INTO chip_hunter (ts_code) VALUES ('x')",
      "UPDATE stock_basic SET name='x'",
      "DROP TABLE stock_basic",
      "ATTACH DATABASE 'x' AS x",
      "PRAGMA table_info(stock_basic)",
      "SELECT * FROM sqlite_master",
      "   ",
      `SELECT ${"a".repeat(5000)}`
    ];
    for (const sql of rejected) {
      const r = await callTool(token, "query_data", { sql });
      expect(r.payload.error, sql).toBe("sql_rejected");
    }

    const tooLong = await callTool(token, "query_data", { sql: "a".repeat(4500) });
    expect(tooLong.payload.error).toBe("sql_rejected");
  });
});
