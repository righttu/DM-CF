import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import schemaSql from "./fixtures/quant-schema.sql?raw";
import {
  AnalysisJobRunner,
  __setAnalysisTransportForTests,
  analysisTimelineView,
  quantOutboundHandler,
  shanghaiCompactDate,
  type QuantAnalysisContainer
} from "../src/quant/analysis.js";
import {
  MCP_AUD,
  ANALYST_EMAIL,
  getSetCookies,
  mergeCookieHeader,
  mcpFetch,
  signJwt
} from "./helpers.js";

const QUANT = "/quant";
const TS = "600519.SH";
const OTHER_TS = "000001.SZ";

type TestEnv = typeof env & {
  QUANT_DB: D1Database;
  ANALYSIS: DurableObjectNamespace<QuantAnalysisContainer>;
};

const tenv = env as unknown as TestEnv;

let statusBody: Record<string, unknown> = { state: "running", phase: "chip" };
let runBody: Record<string, unknown> = { state: "running", phase: "chip" };
let startError: Error | null = null;
let stopCalls = 0;

function stubTransport() {
  __setAnalysisTransportForTests({
    async start() {
      if (startError) throw startError;
    },
    async request(path) {
      if (path === "/run") {
        return Response.json(runBody);
      }
      if (path === "/status") {
        return Response.json(statusBody);
      }
      return new Response("nf", { status: 404 });
    },
    async stop() {
      stopCalls += 1;
    }
  });
}

afterEach(() => {
  __setAnalysisTransportForTests(undefined);
  statusBody = { state: "running", phase: "chip" };
  runBody = { state: "running", phase: "chip" };
  startError = null;
});

function stubFor(jobId: string) {
  return tenv.ANALYSIS.get(tenv.ANALYSIS.idFromName(jobId));
}

function containerCtx(jobId: string) {
  return { containerId: tenv.ANALYSIS.idFromName(jobId).toString() };
}

const fakeVectorize = {
  checked: [] as string[],
  upserted: [] as { id: string; values: number[]; metadata: Record<string, unknown>; namespace?: string }[],
  queried: [] as { topK: number; namespace?: string }[],
  async getByIds(ids: string[]) {
    this.checked.push(...ids);
    return ids.filter((id) => id.endsWith("_present")).map((id) => ({ id }));
  },
  async upsert(vectors: { id: string; values: number[]; metadata: Record<string, unknown>; namespace?: string }[]) {
    this.upserted.push(...vectors);
    return {};
  },
  async query(_v: number[], options: { topK: number; namespace?: string }) {
    this.queried.push({ topK: options.topK, namespace: options.namespace });
    return { matches: [{ id: "m1", score: 0.9, metadata: { ts_code: TS } }] };
  }
};

const fakeR2 = {
  puts: [] as { key: string; size: number }[],
  async put(key: string, body: ReadableStream) {
    const resp = new Response(body);
    const text = await resp.text();
    this.puts.push({ key, size: text.length });
    return { key };
  }
};

function outboundEnv() {
  return {
    QUANT_DB: tenv.QUANT_DB,
    ANALYSIS: tenv.ANALYSIS,
    VECTORIZE: fakeVectorize as never,
    R2_STOCK_INFOR: fakeR2 as never
  };
}

function post(path: string, body: unknown) {
  return new Request(`http://quant-data.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function seedJob(jobId: string, ts = TS, date = today()) {
  stubTransport();
  return stubFor(jobId).startJob({ ts_code: ts, date, requested_by: "actor-test" });
}

function today() {
  return shanghaiCompactDate();
}

beforeAll(async () => {
  const db = tenv.QUANT_DB;
  for (const statement of schemaSql.split(";")) {
    const sql = statement.trim();
    if (sql) await db.prepare(sql).run();
  }
  await db
    .prepare(
      "INSERT INTO stock_basic (ts_code,symbol,name,fullname,cnspell,industry,market,exchange,list_status,list_date) VALUES ('600519.SH','600519','贵州茅台','x','GZMT','白酒','主板','SSE','L','20010827'),('000001.SZ','000001','平安银行','y','PAYH','银行','主板','SZSE','L','19910403')"
    )
    .run();
  await db
    .prepare("INSERT INTO sync_status (ts_code,last_report_sync) VALUES ('600519.SH','2026-10-01')")
    .run();
});

describe("analysis outbound handler", () => {
  const jobId = `${TS}:${today()}`;

  it("allows read-only queries incl. PRAGMA, parameterized selects", async () => {
    await seedJob(jobId);
    const ctx = containerCtx(jobId);
    const env2 = outboundEnv();

    const sel = await quantOutboundHandler(
      post("/api/db/query", {
        sql: "SELECT name FROM stock_basic WHERE ts_code = ?",
        params: [TS]
      }),
      env2,
      ctx
    );
    const selBody = (await sel.json()) as { success: boolean; results: { name: string }[] };
    expect(selBody.success).toBe(true);
    expect(selBody.results[0].name).toBe("贵州茅台");

    const pragma = await quantOutboundHandler(
      post("/api/db/query", { sql: "PRAGMA table_info(sync_status)" }),
      env2,
      ctx
    );
    const pragmaBody = (await pragma.json()) as { success: boolean; results: { name: string }[] };
    expect(pragmaBody.success).toBe(true);
    expect(pragmaBody.results.map((r) => r.name)).toContain("last_report_sync");

    const grouped = await quantOutboundHandler(
      post("/api/db/query", {
        sql: "SELECT ts_code, COUNT(*) c FROM stock_basic GROUP BY ts_code HAVING COUNT(*) > 0"
      }),
      env2,
      ctx
    );
    expect(((await grouped.json()) as { success: boolean }).success).toBe(true);
  });

  it("no-ops allowed DDL and executes sync_status + ai_analysis_result writes for the job's stock/date", async () => {
    const ctx = containerCtx(jobId);
    const env2 = outboundEnv();

    for (const sql of [
      "CREATE TABLE IF NOT EXISTS chip_hunter (id INTEGER PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS sync_status (ts_code TEXT)",
      "CREATE TABLE IF NOT EXISTS institutional_surveys (ts_code TEXT)",
      "CREATE TABLE IF NOT EXISTS ai_analysis_result (report_date TEXT)",
      "CREATE INDEX IF NOT EXISTS idx_chip_ts_code ON chip_hunter(ts_code)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_chip_code_scan_date ON chip_hunter(ts_code, scan_date)",
      "ALTER TABLE sync_status ADD COLUMN last_news_sync TEXT"
    ]) {
      const resp = await quantOutboundHandler(post("/api/db/execute", { sql }), env2, ctx);
      const body = (await resp.json()) as { success: boolean };
      expect(body.success, sql).toBe(true);
      expect(resp.status).toBe(200);
    }

    const sync = await quantOutboundHandler(
      post("/api/db/execute", {
        sql: "INSERT INTO sync_status (ts_code, last_report_sync) VALUES (?, ?)\n ON CONFLICT(ts_code) DO UPDATE SET last_report_sync=excluded.last_report_sync",
        params: [TS, "2026-10-17"]
      }),
      env2,
      ctx
    );
    expect(((await sync.json()) as { success: boolean }).success).toBe(true);
    const row = await tenv.QUANT_DB.prepare(
      "SELECT last_report_sync FROM sync_status WHERE ts_code = ?"
    )
      .bind(TS)
      .first<{ last_report_sync: string }>();
    expect(row?.last_report_sync).toBe("2026-10-17");

    const params = new Array<unknown>(24).fill("x");
    params[0] = today();
    params[1] = "贵州茅台";
    params[2] = TS;
    params[4] = "Manual";
    const ai = await quantOutboundHandler(
      post("/api/db/execute", {
        sql: "INSERT OR REPLACE INTO ai_analysis_result VALUES (" + "?,".repeat(23) + "?)",
        params
      }),
      env2,
      ctx
    );
    expect(((await ai.json()) as { success: boolean }).success).toBe(true);
    const saved = await tenv.QUANT_DB.prepare(
      "SELECT name, source_strategy FROM ai_analysis_result WHERE ts_code = ? AND report_date = ?"
    )
      .bind(TS, today())
      .first<{ name: string; source_strategy: string }>();
    expect(saved?.name).toBe("贵州茅台");
    expect(saved?.source_strategy).toBe("Manual");
  });

  it("allows db/save only for institutional_surveys rows of the job's stock", async () => {
    const ctx = containerCtx(jobId);
    const ok = await quantOutboundHandler(
      post("/api/db/save", {
        table: "institutional_surveys",
        data: [
          {
            ts_code: TS,
            survey_date: "2026-10-16",
            org_count: 3,
            org_names: "中金;高毅",
            reception_place: "会议室"
          }
        ]
      }),
      outboundEnv(),
      ctx
    );
    const body = (await ok.json()) as { success: boolean; count: number };
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);
    const row = await tenv.QUANT_DB.prepare(
      "SELECT org_names FROM institutional_surveys WHERE ts_code = ? AND survey_date = '2026-10-16'"
    )
      .bind(TS)
      .first<{ org_names: string }>();
    expect(row?.org_names).toBe("中金;高毅");
  });

  it("allows vector check/upsert/query scoped to the job namespace", async () => {
    const ctx = containerCtx(jobId);
    const env2 = outboundEnv();
    const vec = new Array(512).fill(0.1);

    const check = await quantOutboundHandler(
      post("/api/vector/check", { id: `${TS}_2026-10-16_ab12_present` }),
      env2,
      ctx
    );
    expect(((await check.json()) as { exists: boolean }).exists).toBe(true);

    const upsert = await quantOutboundHandler(
      post("/api/vector/upsert", {
        ids: [`${TS}_2026-10-16_ab12_0`],
        embeddings: [vec],
        metadatas: [{ ts_code: TS, title: "t", chunk_text: "c" }]
      }),
      env2,
      ctx
    );
    expect(((await upsert.json()) as { success: boolean }).success).toBe(true);
    expect(fakeVectorize.upserted[0].namespace).toBe(TS);

    const query = await quantOutboundHandler(
      post("/api/vector/query", {
        vector: vec,
        topK: 5,
        filter: { ts_code: { $eq: TS } }
      }),
      env2,
      ctx
    );
    const qBody = (await query.json()) as { success: boolean; results: { matches: unknown[] } };
    expect(qBody.success).toBe(true);
    expect(qBody.results.matches.length).toBe(1);
    expect(fakeVectorize.queried.at(-1)?.namespace).toBe(TS);
  });

  it("allows prompt-log r2 uploads with the job key shape", async () => {
    const ctx = containerCtx(jobId);
    const key = `prompt_logs/20261017_153000_${TS}_贵州茅台_data.txt`;
    const form = new FormData();
    form.append("key", key);
    form.append("file", new File(["prompt body"], key, { type: "text/plain" }));
    const resp = await quantOutboundHandler(
      new Request("http://quant-data.internal/api/r2/upload", { method: "POST", body: form }),
      outboundEnv(),
      ctx
    );
    const body = (await resp.json()) as { success: boolean; key: string };
    expect(body.success).toBe(true);
    expect(body.key).toBe(key);
    expect(fakeR2.puts.at(-1)?.size).toBe(11);
  });

  it("denies writes, wrong-scope params, foreign tables and oversized/bad requests", async () => {
    const ctx = containerCtx(jobId);
    const env2 = outboundEnv();
    const denied = async (req: Request) => {
      const resp = await quantOutboundHandler(req, env2, ctx);
      const body = (await resp.json()) as { success: boolean; error: string };
      expect(resp.status).toBe(403);
      expect(body.error).toBe("operation_not_allowed");
    };

    for (const sql of [
      "DELETE FROM chip_hunter",
      "DROP TABLE chip_hunter",
      "UPDATE stock_basic SET name='x'",
      "ATTACH DATABASE 'x' AS x",
      "INSERT INTO chip_hunter (ts_code) VALUES ('600519.SH')",
      "CREATE TABLE IF NOT EXISTS favorites (x TEXT)",
      "PRAGMA table_info(chip_hunter)"
    ]) {
      await denied(post("/api/db/execute", { sql }));
      await denied(post("/api/db/query", { sql }));
    }

    await denied(
      post("/api/db/execute", {
        sql: "INSERT INTO sync_status (ts_code, last_report_sync) VALUES (?, ?) ON CONFLICT(ts_code) DO UPDATE SET last_report_sync=excluded.last_report_sync",
        params: [OTHER_TS, "2026-10-17"]
      })
    );
    await denied(
      post("/api/db/execute", {
        sql: "INSERT INTO sync_status (ts_code, last_news_sync) VALUES (?, ?) ON CONFLICT(ts_code) DO UPDATE SET last_news_sync=excluded.last_news_sync",
        params: [TS, "2026-10-17", "extra"]
      })
    );

    const aiParams = new Array<unknown>(24).fill("x");
    aiParams[0] = today();
    aiParams[2] = TS;
    aiParams[2] = OTHER_TS;
    await denied(
      post("/api/db/execute", {
        sql: "INSERT OR REPLACE INTO ai_analysis_result VALUES (" + "?,".repeat(23) + "?)",
        params: aiParams
      })
    );
    const wrongDate = new Array<unknown>(24).fill("x");
    wrongDate[0] = "19990101";
    wrongDate[2] = TS;
    await denied(
      post("/api/db/execute", {
        sql: "INSERT OR REPLACE INTO ai_analysis_result VALUES (" + "?,".repeat(23) + "?)",
        params: wrongDate
      })
    );
    const shortParams = new Array<unknown>(23).fill("x");
    await denied(
      post("/api/db/execute", {
        sql: "INSERT OR REPLACE INTO ai_analysis_result VALUES (" + "?,".repeat(23) + "?)",
        params: shortParams
      })
    );

    await denied(post("/api/db/save", { table: "chip_hunter", data: [] }));
    await denied(
      post("/api/db/save", {
        table: "institutional_surveys",
        data: [{ ts_code: OTHER_TS, survey_date: "d", org_count: 1, org_names: "n", reception_place: "p" }]
      })
    );
    await denied(
      post("/api/db/save", {
        table: "institutional_surveys",
        data: [{ ts_code: TS, survey_date: "d", org_count: 1, org_names: "n", reception_place: "p", extra: 1 }]
      })
    );

    const vec = new Array(512).fill(0.1);
    await denied(post("/api/vector/check", { id: `${OTHER_TS}_x` }));
    await denied(post("/api/vector/check", { id: `${TS}_${"y".repeat(80)}` }));
    await denied(
      post("/api/vector/upsert", {
        ids: [`${OTHER_TS}_0`],
        embeddings: [vec],
        metadatas: [{ ts_code: OTHER_TS }]
      })
    );
    await denied(
      post("/api/vector/upsert", {
        ids: [`${TS}_0`],
        embeddings: [vec],
        metadatas: [{ ts_code: OTHER_TS }]
      })
    );
    await denied(
      post("/api/vector/query", { vector: vec, topK: 5, filter: { ts_code: { $eq: OTHER_TS } } })
    );
    await denied(
      post("/api/vector/query", { vector: vec.slice(0, 10), topK: 5, filter: { ts_code: { $eq: TS } } })
    );
    await denied(
      post("/api/vector/query", { vector: vec, topK: 51, filter: { ts_code: { $eq: TS } } })
    );

    for (const key of [
      `prompt_logs/../${TS}_x_data.txt`,
      `prompt_logs/20261017_153000_${OTHER_TS}_x_data.txt`,
      `prompt_logs/20261017_153000_${TS}_x_data.txt/`,
      `other/${TS}_x_data.txt`
    ]) {
      const form = new FormData();
      form.append("key", key);
      form.append("file", new File(["x"], "f.txt"));
      await denied(
        new Request("http://quant-data.internal/api/r2/upload", { method: "POST", body: form })
      );
    }
    const bigForm = new FormData();
    bigForm.append("key", `prompt_logs/20261017_153000_${TS}_x_data.txt`);
    bigForm.append("file", new File([new Uint8Array(1024 * 1024 + 1)], "f.txt"));
    await denied(
      new Request("http://quant-data.internal/api/r2/upload", { method: "POST", body: bigForm })
    );

    await denied(post("/api/evil", {}));
    const getResp = await quantOutboundHandler(
      new Request("http://quant-data.internal/api/db/query", { method: "GET" }),
      env2,
      ctx
    );
    expect(getResp.status).toBe(403);

    const noJob = await quantOutboundHandler(
      post("/api/db/query", { sql: "SELECT 1" }),
      env2,
      { containerId: tenv.ANALYSIS.idFromName("no:such").toString() }
    );
    expect(noJob.status).toBe(403);
  });
});

describe("analysis tools", () => {
  let token: string;

  async function quantRegister() {
    const resp = await mcpFetch(`${QUANT}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "quant-analysis-test",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        redirect_uris: ["http://localhost/mcp-oauth-callback"]
      })
    });
    return { clientId: ((await resp.json()) as { client_id: string }).client_id, redirectUri: "http://localhost/mcp-oauth-callback" };
  }

  async function consent(jwt: string, clientId: string, redirectUri: string) {
    const verifier = "v" + crypto.randomUUID().replaceAll("-", "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const getResp = await mcpFetch(
      `${QUANT}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=mcp%3Aread&state=s&code_challenge=${challenge}&code_challenge_method=S256` +
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
    const code = new URL(postResp.headers.get("location")!).searchParams.get("code")!;
    const tokenResp = await mcpFetch(`${QUANT}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:
        `grant_type=authorization_code&code=${code}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${clientId}` +
        `&code_verifier=${verifier}`
    });
    return ((await tokenResp.json()) as { access_token: string }).access_token;
  }

  async function rpc(method: string, params: unknown, id: number) {
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
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
    return JSON.parse(dataLine ?? text) as Record<string, unknown>;
  }

  let callId = 500;
  async function callTool(name: string, args: unknown) {
    const body = await rpc("tools/call", { name, arguments: args }, ++callId);
    const result = body.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    return { payload, isError: result?.isError === true, body };
  }

  beforeAll(async () => {
    const { clientId, redirectUri } = await quantRegister();
    const jwt = await signJwt({ sub: "sub-q-analysis", email: ANALYST_EMAIL, aud: MCP_AUD });
    token = await consent(jwt, clientId, redirectUri);
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" }
    }, 1);
  });

  it("run_analysis starts a job, is idempotent, and get_analysis_status tracks it to success", async () => {
    stubTransport();
    const started = await callTool("run_analysis", { ts_code: OTHER_TS });
    const jobId = `${OTHER_TS}:${today()}`;
    expect(started.payload.status).toBe("running");
    expect(started.payload.job_id).toBe(jobId);

    const again = await callTool("run_analysis", { ts_code: OTHER_TS });
    expect(again.payload.status).toBe("running");
    expect(again.payload.job_id).toBe(jobId);

    const byJob = await callTool("get_analysis_status", { job_id: jobId });
    expect(byJob.payload.status).toBe("running");
    expect(byJob.payload.job_id).toBe(jobId);
    expect(typeof byJob.payload.elapsed_s).toBe("number");

    const byTs = await callTool("get_analysis_status", { ts_code: OTHER_TS });
    expect(byTs.payload.job_id).toBe(jobId);
    expect(byTs.payload.status).toBe("running");

    statusBody = {
      state: "succeeded",
      phase: "done",
      result: { status: "success", ts_code: OTHER_TS, brain: { final_score: 74, target_price: 12.3 }, miner_chunks: 5 }
    };
    const done = await callTool("get_analysis_status", { job_id: jobId });
    expect(done.payload.status).toBe("succeeded");
    expect(done.payload.phase).toBe("done");
    expect((done.payload.result_summary as { final_score: number }).final_score).toBe(74);

    // D1 has no row for today: a stale succeeded DO job must re-run instead of
    // replaying the old result.
    const existsAfter = await callTool("run_analysis", { ts_code: OTHER_TS });
    expect(existsAfter.payload.status).toBe("running");
    statusBody = { state: "running", phase: "chip" };
    const restarted = await callTool("get_analysis_status", { job_id: jobId });
    expect(restarted.payload.status).toBe("running");
  });

  it("run_analysis returns exists when today's report already exists", async () => {
    await tenv.QUANT_DB.prepare(
      "INSERT OR REPLACE INTO ai_analysis_result (report_date,ts_code,name) VALUES (?,?,?)"
    )
      .bind(today(), TS, "贵州茅台")
      .run();
    const r = await callTool("run_analysis", { ts_code: TS });
    expect(r.payload.status).toBe("exists");
    expect(r.payload.job_id).toBe(`${TS}:${today()}`);
    expect((r.payload.report as { name: string }).name).toBe("贵州茅台");
  });

  it("run_analysis reports busy when container capacity fails", async () => {
    startError = new Error("container capacity exceeded: max_instances reached");
    stubTransport();
    const r = await callTool("run_analysis", { ts_code: "000063.SZ" });
    expect(r.payload.status).toBe("busy");
    expect(String(r.payload.message)).toContain("容量已满");
    startError = null;
  });

  it("get_analysis_status validates selectors and reports not_found/timeout", async () => {
    const bad = await callTool("get_analysis_status", {});
    expect(bad.payload.error).toBe("invalid_arguments");
    const both = await callTool("get_analysis_status", {
      job_id: `${TS}:${today()}`,
      ts_code: TS
    });
    expect(both.payload.error).toBe("invalid_arguments");

    const missing = await callTool("get_analysis_status", { job_id: "000063.SZ:20260101" });
    expect(missing.payload.status).toBe("not_found");

    stubTransport();
    const jobId = `000063.SZ:${today()}`;
    const stub = stubFor(jobId);
    await stub.startJob({ ts_code: "000063.SZ", date: today(), requested_by: "a" });
    stopCalls = 0;
    // Backdate started_at so the 20-minute window has elapsed.
    await runInDurableObject(stub, async (instance, ctx) => {
      const job = (await ctx.storage.get("job")) as { started_at: string };
      job.started_at = new Date(Date.now() - 21 * 60 * 1000).toISOString();
      await ctx.storage.put("job", job);
      await instance.alarm();
    });
    const timed = await callTool("get_analysis_status", { job_id: jobId });
    expect(timed.payload.status).toBe("timeout");
    expect(stopCalls).toBeGreaterThan(0);
  });

  it("an unrelated alarm tick does not mark a running job as timeout", async () => {
    stubTransport();
    const jobId = `000008.SZ:${today()}`;
    const stub = stubFor(jobId);
    await stub.startJob({ ts_code: "000008.SZ", date: today(), requested_by: "a" });
    // A fresh alarm tick (e.g. the container lifecycle monitor firing seconds
    // after start) must be ignored while the job is inside its timeout window.
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    const view = await stub.status();
    expect(view.status).toBe("running");
    // Once the job has finished, a late timeout tick is a no-op too.
    statusBody = { state: "succeeded", phase: "done", result: { status: "success" } };
    await stub.status();
    await runInDurableObject(stub, async (instance, ctx) => {
      const job = (await ctx.storage.get("job")) as { started_at: string };
      job.started_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await ctx.storage.put("job", job);
      await instance.alarm();
    });
    expect((await stub.status()).status).toBe("succeeded");
  });

  it("forwards optional AI vars into the container env only when set", async () => {
    const fakeStorage = () => {
      const m = new Map<string, unknown>();
      return {
        get: async (k: string) => m.get(k) ?? null,
        put: async (k: string, v: unknown) => void m.set(k, v),
        delete: async (k: string) => (m.delete(k), true)
      } as never;
    };
    const seen: Record<string, string>[] = [];
    const transport = (seen: Record<string, string>[]) => () => ({
      async start(envVars: Record<string, string>) { seen.push(envVars); },
      async request() { return Response.json({ state: "running" }); },
      async stop() {}
    });
    const runner = new AnalysisJobRunner(
      fakeStorage(),
      {
        AI_ENGINE: "WORKERS_AI",
        BRAIN_AI_MODEL: "dynamic/abc-brain",
        AUDITOR_AI_MODEL: "dynamic/abc-auditor"
      } as never,
      transport(seen),
      () => "jid",
      () => {},
      { schedule() {}, wipe: async () => {} }
    );
    await runner.startJob({ ts_code: TS, date: today(), requested_by: "a" });
    expect(seen[0].AI_ENGINE).toBe("WORKERS_AI");
    expect(seen[0].BRAIN_AI_MODEL).toBe("dynamic/abc-brain");
    expect(seen[0].AUDITOR_AI_MODEL).toBe("dynamic/abc-auditor");
    expect(seen[0].AI_BASE_URL).toBe("http://ai.internal/v1");

    const seen2: Record<string, string>[] = [];
    const runner2 = new AnalysisJobRunner(
      fakeStorage(), {} as never, transport(seen2), () => "jid",
      () => {}, { schedule() {}, wipe: async () => {} }
    );
    await runner2.startJob({ ts_code: TS, date: today(), requested_by: "a" });
    expect(seen2[0]).not.toHaveProperty("AI_ENGINE");
    expect(seen2[0]).not.toHaveProperty("BRAIN_AI_MODEL");
    expect(seen2[0]).not.toHaveProperty("AUDITOR_AI_MODEL");
  });

  it("cleanup wipes a terminal job's storage; a re-run disarms it", async () => {
    stubTransport();
    // Terminal -> armed -> runCleanup deletes all storage.
    const doneId = `000776.SZ:${today()}`;
    const doneStub = stubFor(doneId);
    await doneStub.startJob({ ts_code: "000776.SZ", date: today(), requested_by: "a" });
    statusBody = { state: "succeeded", phase: "done", result: { status: "success" } };
    await doneStub.status();
    await runInDurableObject(doneStub, async (instance) => {
      await (instance as unknown as { runCleanup(): Promise<void> }).runCleanup();
    });
    await runInDurableObject(doneStub, async (_i, ctx) => {
      expect(await ctx.storage.get("job")).toBeFalsy();
      expect(await ctx.storage.get("cleanup_scheduled")).toBeFalsy();
    });

    // Failed -> armed; a re-run removes the token so the scheduled cleanup is
    // a no-op for the live job.
    const retryId = `000777.SZ:${today()}`;
    const retryStub = stubFor(retryId);
    await retryStub.startJob({ ts_code: "000777.SZ", date: today(), requested_by: "a" });
    statusBody = { state: "failed", error: "boom" };
    await retryStub.status();
    statusBody = { state: "running", phase: "chip" };
    await retryStub.startJob({ ts_code: "000777.SZ", date: today(), requested_by: "a" });
    await runInDurableObject(retryStub, async (instance) => {
      await (instance as unknown as { runCleanup(): Promise<void> }).runCleanup();
    });
    await runInDurableObject(retryStub, async (_i, ctx) => {
      const job = (await ctx.storage.get("job")) as { status: string } | null;
      expect(job?.status).toBe("running");
    });
  });

  it("persists the phase timeline and returns labels, Beijing times and totals", async () => {
    stubTransport();
    const jobId = `600000.SH:${today()}`;
    await stubFor(jobId).startJob({
      ts_code: "600000.SH",
      date: today(),
      requested_by: "a"
    });

    const t0 = Date.now();
    statusBody = {
      state: "running",
      phase: "chip",
      timeline: [
        {
          phase: "start",
          started_at: new Date(t0 - 30_000).toISOString(),
          ended_at: new Date(t0 - 25_000).toISOString(),
          duration_s: 5
        },
        {
          phase: "chip",
          started_at: new Date(t0 - 25_000).toISOString(),
          ended_at: null,
          duration_s: 25
        }
      ]
    };
    const running = await callTool("get_analysis_status", { job_id: jobId });
    const tl = running.payload.timeline as {
      phase: string;
      label: string;
      started_at_bj: string;
      duration_s: number;
    }[];
    expect(tl).toHaveLength(2);
    expect(tl[0].label).toBe("引擎初始化");
    expect(tl[0].duration_s).toBe(5);
    expect(tl[1].phase).toBe("chip");
    expect(tl[1].label).toBe("数据与筹码计算");
    expect(tl[1].duration_s).toBe(25);
    expect(tl[0].started_at_bj).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const bjStart = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date(t0 - 30_000));
    expect(tl[0].started_at_bj).toBe(bjStart);
    expect(running.payload.total_s).toBeGreaterThan(0);

    // Finishing keeps the timeline; later status calls return the stored one.
    statusBody = {
      state: "succeeded",
      phase: "done",
      result: { status: "success" },
      timeline: [
        {
          phase: "start",
          started_at: new Date(t0 - 30_000).toISOString(),
          ended_at: new Date(t0 - 25_000).toISOString(),
          duration_s: 5
        },
        {
          phase: "chip",
          started_at: new Date(t0 - 25_000).toISOString(),
          ended_at: new Date(t0 - 5_000).toISOString(),
          duration_s: 20
        },
        {
          phase: "knowledge",
          started_at: new Date(t0 - 5_000).toISOString(),
          ended_at: new Date(t0 - 3_000).toISOString(),
          duration_s: 2
        },
        {
          phase: "ai",
          started_at: new Date(t0 - 3_000).toISOString(),
          ended_at: new Date(t0).toISOString(),
          duration_s: 3
        },
        {
          phase: "done",
          started_at: new Date(t0).toISOString(),
          ended_at: new Date(t0).toISOString(),
          duration_s: 0
        }
      ]
    };
    const done = await callTool("get_analysis_status", { job_id: jobId });
    expect(done.payload.status).toBe("succeeded");
    const tlDone = done.payload.timeline as { phase: string; label: string }[];
    expect(tlDone).toHaveLength(5);
    expect(tlDone.map((e) => e.label)).toEqual([
      "引擎初始化",
      "数据与筹码计算",
      "知识库挖掘（研报/公告/调研）",
      "AI 诊断",
      "完成"
    ]);
    expect(done.payload.total_s).toBe(30);

    // No further refresh happens after success: timeline comes from storage.
    statusBody = { state: "running", phase: "chip" };
    const again = await callTool("get_analysis_status", { job_id: jobId });
    expect(again.payload.status).toBe("succeeded");
    expect((again.payload.timeline as unknown[]).length).toBe(5);

    // D1 has no report row: run_analysis on a stale succeeded job re-runs
    // fresh instead of replaying the stored timeline.
    const rerun = await callTool("run_analysis", { ts_code: "600000.SH" });
    expect(rerun.payload.status).toBe("running");
    expect(rerun.payload.timeline).toBeUndefined();

    // A fresh job has no timeline yet — the field is omitted, not empty.
    const fresh = await callTool("run_analysis", { ts_code: "600004.SH" });
    expect(fresh.payload.status).toBe("running");
    expect(fresh.payload.timeline).toBeUndefined();
    expect(fresh.payload.total_s).toBeUndefined();
    expect(analysisTimelineView({ timeline: null })).toBeNull();
  });

  it("exports ContainerProxy so container outbound interception works", async () => {
    const mod = (await import("../src/quant/index.js")) as Record<string, unknown>;
    expect(typeof mod.ContainerProxy).toBe("function");
    const { ContainerProxy } = await import("@cloudflare/containers");
    expect(mod.ContainerProxy).toBe(ContainerProxy);
  });

  it("marks the job failed when the container reports failure", async () => {
    stubTransport();
    const jobId = `000002.SZ:${today()}`;
    await stubFor(jobId).startJob({ ts_code: "000002.SZ", date: today(), requested_by: "a" });
    statusBody = { state: "failed", phase: "ai", error: "engine boom", log_tail: ["x"] };
    const view = await stubFor(jobId).status();
    expect(view.status).toBe("failed");
    expect(view.error).toContain("engine boom");
  });
});
