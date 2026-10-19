import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import schemaSql from "./fixtures/quant-schema.sql?raw";
import { aiOutboundHandler, batchOutboundHandler } from "../src/pipeline/outbound.js";
import {
  BatchJobRunner,
  __setBatchTransportForTests,
  type QuantBatchContainer
} from "../src/pipeline/batch.js";
import {
  bjCompactDate,
  runDailyPipeline,
  scheduledTick,
  type StepLike
} from "../src/pipeline/workflow.js";
import { fetchStockBasicRows, syncStockBasic } from "../src/pipeline/stockBasic.js";

type TestEnv = typeof env & {
  QUANT_DB: D1Database;
  BATCH: DurableObjectNamespace<QuantBatchContainer>;
};

const tenv = env as unknown as TestEnv;

let statusBody: Record<string, unknown> = { state: "running" };
let stopCalls = 0;

function stubTransport() {
  __setBatchTransportForTests({
    async start() {},
    async request(path) {
      if (path === "/run") return Response.json({ state: "running" });
      if (path === "/status") return Response.json(statusBody);
      return new Response("nf", { status: 404 });
    },
    async stop() {
      stopCalls += 1;
    }
  });
}

afterEach(() => {
  __setBatchTransportForTests(undefined);
  statusBody = { state: "running" };
  stopCalls = 0;
});

function batchStub(jobId: string) {
  return tenv.BATCH.get(tenv.BATCH.idFromName(jobId));
}

function containerCtx(jobId: string) {
  return { containerId: tenv.BATCH.idFromName(jobId).toString() };
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
    return { matches: [{ id: "m1", score: 0.9 }] };
  }
};

const fakeR2 = {
  puts: [] as { key: string; size: number }[],
  async put(key: string, body: ReadableStream) {
    const text = await new Response(body).text();
    this.puts.push({ key, size: text.length });
    return { key };
  }
};

function outboundEnv() {
  return {
    QUANT_DB: tenv.QUANT_DB,
    BATCH: tenv.BATCH as never,
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

const RUN_DATE = "20261017";

async function seedJob(name: string, script: string, runDate = RUN_DATE) {
  stubTransport();
  const jobId = `t1:${name}`;
  await batchStub(jobId).startJob({ script, run_date: runDate });
  return { jobId, ctx: containerCtx(jobId) };
}

async function denied(req: Request, jobId: string) {
  const resp = await batchOutboundHandler(req, outboundEnv(), containerCtx(jobId));
  const body = (await resp.json()) as { success: boolean; error: string };
  expect(resp.status).toBe(403);
  expect(body.error).toBe("operation_not_allowed");
}

beforeAll(async () => {
  for (const statement of schemaSql.split(";")) {
    const sql = statement.trim();
    if (sql) await tenv.QUANT_DB.prepare(sql).run();
  }
});

describe("batch outbound handler", () => {
  it("common query rules: fixed queries + read-only guard for any script", async () => {
    const { jobId, ctx } = await seedJob("q-common", "fundamentals");
    const env2 = outboundEnv();

    const pragma = await batchOutboundHandler(
      post("/api/db/query", { sql: "PRAGMA table_info(sync_status)" }),
      env2,
      ctx
    );
    expect(((await pragma.json()) as { success: boolean }).success).toBe(true);

    const hunterTables = await batchOutboundHandler(
      post("/api/db/query", {
        sql: "  SELECT name FROM sqlite_master\nWHERE type='table' AND name LIKE '%_hunter' "
      }),
      env2,
      ctx
    );
    const names = ((await hunterTables.json()) as { results: { name: string }[] }).results.map(
      (r) => r.name
    );
    expect(names).toContain("chip_hunter");

    const sel = await batchOutboundHandler(
      post("/api/db/query", { sql: "SELECT 1 AS one" }),
      env2,
      ctx
    );
    expect(((await sel.json()) as { success: boolean }).success).toBe(true);

    for (const sql of [
      "DELETE FROM chip_hunter",
      "UPDATE sync_status SET ts_code='x'",
      "DROP TABLE x",
      "SELECT name FROM sqlite_master"
    ]) {
      await denied(post("/api/db/query", { sql }), jobId);
    }
    await denied(post("/api/evil", {}), jobId);
    const getResp = await batchOutboundHandler(
      new Request("http://quant-data.internal/api/db/query", { method: "GET" }),
      env2,
      ctx
    );
    expect(getResp.status).toBe(403);
    const noJob = await batchOutboundHandler(
      post("/api/db/query", { sql: "SELECT 1" }),
      env2,
      { containerId: tenv.BATCH.idFromName("no:such").toString() }
    );
    expect(noJob.status).toBe(403);
  });

  it("fundamentals: stock_fundamentals DDL no-op and db/save with stock-api semantics", async () => {
    const { jobId, ctx } = await seedJob("j-fund", "fundamentals");
    const env2 = outboundEnv();

    const ddl = await batchOutboundHandler(
      post("/api/db/execute", {
        sql: `CREATE TABLE IF NOT EXISTS stock_fundamentals (
                ts_code TEXT, end_date TEXT, ann_date TEXT,
                PRIMARY KEY (ts_code, end_date)
            )`
      }),
      env2,
      ctx
    );
    expect(((await ddl.json()) as { success: boolean }).success).toBe(true);

    // data[0] keys -> columns; missing keys in later rows -> NULL.
    const save = await batchOutboundHandler(
      post("/api/db/save", {
        table: "stock_fundamentals",
        data: [
          { ts_code: "600519.SH", end_date: "20260630", roe: 0.2 },
          { ts_code: "000001.SZ", end_date: "20260630" }
        ]
      }),
      env2,
      ctx
    );
    const saveBody = (await save.json()) as { success: boolean; count: number };
    expect(saveBody.success).toBe(true);
    expect(saveBody.count).toBe(2);
    const row = await tenv.QUANT_DB.prepare(
      "SELECT roe FROM stock_fundamentals WHERE ts_code='000001.SZ' AND end_date='20260630'"
    ).first<{ roe: number | null }>();
    expect(row?.roe).toBeNull();

    // INSERT OR IGNORE: same PK saved again is a no-op, count still returned.
    const save2 = await batchOutboundHandler(
      post("/api/db/save", {
        table: "stock_fundamentals",
        data: [{ ts_code: "600519.SH", end_date: "20260630", roe: 0.99 }]
      }),
      env2,
      ctx
    );
    expect(((await save2.json()) as { success: boolean }).success).toBe(true);
    const roe = await tenv.QUANT_DB.prepare(
      "SELECT roe FROM stock_fundamentals WHERE ts_code='600519.SH' AND end_date='20260630'"
    ).first<{ roe: number }>();
    expect(roe?.roe).toBe(0.2);

    const empty = await batchOutboundHandler(
      post("/api/db/save", { table: "stock_fundamentals", data: [] }),
      env2,
      ctx
    );
    expect(((await empty.json()) as { count: number }).count).toBe(0);

    await denied(
      post("/api/db/save", { table: "chip_hunter", data: [{ ts_code: "600519.SH" }] }),
      jobId
    );
    await denied(
      post("/api/db/save", {
        table: "stock_fundamentals",
        data: [{ ts_code: "x", not_a_column: 1 }]
      }),
      jobId
    );
    await denied(post("/api/vector/query", { vector: [1], topK: 1, filter: {} }), jobId);
  });

  it("chip_hunter / alpha_hunter: own DDL no-ops and own save tables only", async () => {
    const chip = await seedJob("j-chip", "chip_hunter");
    const env2 = outboundEnv();
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS chip_hunter (id INTEGER PRIMARY KEY)",
      "CREATE INDEX IF NOT EXISTS idx_chip_ts_code ON chip_hunter(ts_code)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_chip_code_scan_date ON chip_hunter(ts_code, scan_date)",
      "CREATE TABLE IF NOT EXISTS alpha_hunter (id INTEGER PRIMARY KEY)",
      "CREATE INDEX IF NOT EXISTS idx_alpha_ts_code ON alpha_hunter(ts_code)"
    ]) {
      const r = await batchOutboundHandler(
        post("/api/db/execute", { sql }),
        env2,
        chip.ctx
      );
      // alpha_* DDL is a no-op for chip jobs? No — cross-script DDL is denied.
      const body = (await r.json()) as { success: boolean; error?: string };
      if (sql.includes("alpha")) {
        expect(body.success).toBe(false);
      } else {
        expect(body.success).toBe(true);
      }
    }
    const chipSave = await batchOutboundHandler(
      post("/api/db/save", {
        table: "chip_hunter",
        data: [{ ts_code: "600519.SH", scan_date: RUN_DATE, score: 5 }]
      }),
      env2,
      chip.ctx
    );
    expect(((await chipSave.json()) as { success: boolean }).success).toBe(true);
    await denied(
      post("/api/db/save", { table: "alpha_hunter", data: [{ ts_code: "600519.SH" }] }),
      chip.jobId
    );

    const alpha = await seedJob("j-alpha", "alpha_hunter");
    const alphaSave = await batchOutboundHandler(
      post("/api/db/save", {
        table: "alpha_hunter",
        data: [{ ts_code: "600519.SH", scan_date: RUN_DATE, score: 7 }]
      }),
      env2,
      alpha.ctx
    );
    expect(((await alphaSave.json()) as { success: boolean }).success).toBe(true);
    await denied(
      post("/api/db/save", { table: "chip_hunter", data: [{ ts_code: "600519.SH" }] }),
      alpha.jobId
    );
    // alpha DDL no-ops for alpha job
    const idx = await batchOutboundHandler(
      post("/api/db/execute", {
        sql: "CREATE INDEX IF NOT EXISTS idx_alpha_scan_date ON alpha_hunter(scan_date)"
      }),
      env2,
      alpha.ctx
    );
    expect(((await idx.json()) as { success: boolean }).success).toBe(true);
  });

  it("hotspot_registry: upsert exact form only", async () => {
    const { jobId, ctx } = await seedJob("j-reg", "hotspot_registry");
    const env2 = outboundEnv();
    const upsert = `INSERT INTO hotspot_registry (ts_code, name, sector, node, purity, em_reason, ts_main_biz, volume_node, remark, create_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ts_code, sector, node) DO UPDATE SET
            em_reason = excluded.em_reason,
            ts_main_biz = excluded.ts_main_biz,
            create_date = excluded.create_date`;
    const r = await batchOutboundHandler(
      post("/api/db/execute", {
        sql: upsert,
        params: ["600519.SH", "茅台", "白酒", "龙头", "", "reason", "biz", "node_t", "", RUN_DATE]
      }),
      env2,
      ctx
    );
    expect(((await r.json()) as { success: boolean }).success).toBe(true);
    const row = await tenv.QUANT_DB.prepare(
      "SELECT em_reason FROM hotspot_registry WHERE ts_code='600519.SH' AND sector='白酒' AND node='龙头'"
    ).first<{ em_reason: string }>();
    expect(row?.em_reason).toBe("reason");

    await denied(
      post("/api/db/execute", { sql: upsert, params: ["600519.SH", "茅台", "白酒", "龙头"] }),
      jobId
    );
    await denied(post("/api/db/execute", { sql: "UPDATE hotspot_registry SET purity='x'" }), jobId);
  });

  it("registry_auditor: exact UPDATE only, nothing else", async () => {
    const { jobId, ctx } = await seedJob("j-aud", "registry_auditor");
    const env2 = outboundEnv();
    const r = await batchOutboundHandler(
      post("/api/db/execute", {
        sql: `UPDATE hotspot_registry
              SET purity = ?, remark = ?
              WHERE ts_code = ? AND sector = ? AND node = ?`,
        params: ["真题材", "真题材|龙头|ok", "600519.SH", "白酒", "龙头"]
      }),
      env2,
      ctx
    );
    expect(((await r.json()) as { success: boolean }).success).toBe(true);
    await denied(
      post("/api/db/execute", {
        sql: "INSERT INTO hotspot_registry (ts_code) VALUES ('x')"
      }),
      jobId
    );
    await denied(
      post("/api/db/save", { table: "institutional_surveys", data: [] }),
      jobId
    );
  });

  it("hotspot_hunter: DDL no-op and exact 32-column insert", async () => {
    const { jobId, ctx } = await seedJob("j-hot", "hotspot_hunter");
    const env2 = outboundEnv();
    const ddl = await batchOutboundHandler(
      post("/api/db/execute", {
        sql: "CREATE TABLE IF NOT EXISTS hotspot_hunter (ts_code TEXT)"
      }),
      env2,
      ctx
    );
    expect(((await ddl.json()) as { success: boolean }).success).toBe(true);

    const insertSql = `INSERT OR REPLACE INTO hotspot_hunter (
    ts_code, trade_date, name, industry, sector, close,
    turnover_rate_3d, industry_turnover_rate_3d, pe_ttm,
    pe_ttm_percentile, industry_pe_ttm_median, peg, pb,
    pb_percentile, industry_pb_median, forecast_eps_fy1,
    forecast_eps_fy2, net_inflow_5d, total_mv, ps_ttm,
    con_growth_rate, chip_latest_change, chip_cumu_change,
    volume_ratio, mf_intensity, pct_chg, net_mf_amount,
    bias_60, is_institutional, em_reason, scan_date, tags
) VALUES (
    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
)`;
    const params = new Array<unknown>(32).fill("x");
    params[0] = "600519.SH";
    params[1] = "20261017";
    params[30] = RUN_DATE;
    const r = await batchOutboundHandler(
      post("/api/db/execute", { sql: insertSql, params }),
      env2,
      ctx
    );
    expect(((await r.json()) as { success: boolean }).success).toBe(true);
    await denied(
      post("/api/db/execute", { sql: insertSql, params: params.slice(0, 31) }),
      jobId
    );
  });

  it("knowledge_miner: sync DDL/upserts, surveys save, vector check/upsert", async () => {
    const { jobId, ctx } = await seedJob("j-km", "knowledge_miner");
    const env2 = outboundEnv();
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS sync_status (ts_code TEXT PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS institutional_surveys (ts_code TEXT)",
      "ALTER TABLE sync_status ADD COLUMN last_news_sync TEXT"
    ]) {
      const r = await batchOutboundHandler(post("/api/db/execute", { sql }), env2, ctx);
      expect(((await r.json()) as { success: boolean }).success).toBe(true);
    }
    for (const col of ["last_report_sync", "last_news_sync"]) {
      const r = await batchOutboundHandler(
        post("/api/db/execute", {
          sql: `INSERT INTO sync_status (ts_code, ${col}) VALUES (?, ?)
                ON CONFLICT(ts_code) DO UPDATE SET ${col}=excluded.${col}`,
          params: ["600519.SH", "2026-10-17"]
        }),
        env2,
        ctx
      );
      expect(((await r.json()) as { success: boolean }).success).toBe(true);
    }
    await denied(
      post("/api/db/execute", {
        sql: "INSERT INTO sync_status (ts_code, last_report_sync) VALUES (?, ?) ON CONFLICT(ts_code) DO UPDATE SET last_report_sync=excluded.last_report_sync",
        params: ["NOT_A_CODE", "2026-10-17"]
      }),
      jobId
    );

    const save = await batchOutboundHandler(
      post("/api/db/save", {
        table: "institutional_surveys",
        data: [
          {
            ts_code: "600519.SH",
            survey_date: "2026-10-16",
            org_count: 3,
            org_names: "中金",
            reception_place: "会议室"
          }
        ]
      }),
      env2,
      ctx
    );
    expect(((await save.json()) as { success: boolean }).success).toBe(true);
    await denied(
      post("/api/db/save", {
        table: "institutional_surveys",
        data: [{ ts_code: "600519.SH", survey_date: "d", org_count: 1, org_names: "n", extra: 1 }]
      }),
      jobId
    );
    await denied(
      post("/api/db/save", {
        table: "institutional_surveys",
        data: [{ ts_code: "BAD", survey_date: "d", org_count: 1, org_names: "n", reception_place: "p" }]
      }),
      jobId
    );

    const vec = new Array(512).fill(0.1);
    const check = await batchOutboundHandler(
      post("/api/vector/check", { id: "600519.SH_2026-10-16_ab_present" }),
      env2,
      ctx
    );
    expect(((await check.json()) as { exists: boolean }).exists).toBe(true);

    const up = await batchOutboundHandler(
      post("/api/vector/upsert", {
        ids: ["600519.SH_a_0", "000001.SZ_b_1"],
        embeddings: [vec, vec],
        metadatas: [
          { ts_code: "600519.SH", t: 1 },
          { ts_code: "000001.SZ", t: 2 }
        ]
      }),
      env2,
      ctx
    );
    expect(((await up.json()) as { success: boolean }).success).toBe(true);
    expect(fakeVectorize.upserted.at(-2)?.namespace).toBe("600519.SH");
    expect(fakeVectorize.upserted.at(-1)?.namespace).toBe("000001.SZ");

    await denied(
      post("/api/vector/upsert", {
        ids: ["600519.SH_x_0"],
        embeddings: [vec],
        metadatas: [{ ts_code: "000001.SZ" }]
      }),
      jobId
    );
    await denied(
      post("/api/vector/query", { vector: vec, topK: 5, filter: { ts_code: { $eq: "600519.SH" } } }),
      jobId
    );
  });

  it("ai_brain: ai_analysis_result DDL/insert with run_date, prompt-log R2, vector query", async () => {
    const { jobId, ctx } = await seedJob("j-brain", "ai_brain");
    const env2 = outboundEnv();
    const ddl = await batchOutboundHandler(
      post("/api/db/execute", {
        sql: "CREATE TABLE IF NOT EXISTS ai_analysis_result (report_date TEXT)"
      }),
      env2,
      ctx
    );
    expect(((await ddl.json()) as { success: boolean }).success).toBe(true);

    const params = new Array<unknown>(24).fill("x");
    params[0] = RUN_DATE;
    params[2] = "600519.SH";
    const ins = await batchOutboundHandler(
      post("/api/db/execute", {
        sql: "INSERT OR REPLACE INTO ai_analysis_result VALUES (" + "?,".repeat(23) + "?)",
        params
      }),
      env2,
      ctx
    );
    expect(((await ins.json()) as { success: boolean }).success).toBe(true);

    const wrongDate = [...params];
    wrongDate[0] = "19990101";
    await denied(
      post("/api/db/execute", {
        sql: "INSERT OR REPLACE INTO ai_analysis_result VALUES (" + "?,".repeat(23) + "?)",
        params: wrongDate
      }),
      jobId
    );

    // Midnight crossover: the current Asia/Shanghai date is accepted even when
    // it differs from the job's run_date.
    const old = await seedJob("j-brain2", "ai_brain", "19990101");
    const todayBj = [...params];
    todayBj[0] = bjCompactDate();
    const todayIns = await batchOutboundHandler(
      post("/api/db/execute", {
        sql: "INSERT OR REPLACE INTO ai_analysis_result VALUES (" + "?,".repeat(23) + "?)",
        params: todayBj
      }),
      env2,
      old.ctx
    );
    expect(((await todayIns.json()) as { success: boolean }).success).toBe(true);
    const neither = [...params];
    neither[0] = "20000101";
    await denied(
      post("/api/db/execute", {
        sql: "INSERT OR REPLACE INTO ai_analysis_result VALUES (" + "?,".repeat(23) + "?)",
        params: neither
      }),
      old.jobId
    );

    const key = `prompt_logs/20261017_153000_600519.SH_茅台_data.txt`;
    const form = new FormData();
    form.append("key", key);
    form.append("file", new File(["prompt"], "f.txt"));
    const up = await batchOutboundHandler(
      new Request("http://quant-data.internal/api/r2/upload", { method: "POST", body: form }),
      env2,
      ctx
    );
    expect(((await up.json()) as { success: boolean }).success).toBe(true);

    for (const badKey of [
      `prompt_logs/../600519.SH_x_data.txt`,
      `prompt_logs/20261017_153000_600519_SH_x_data.txt`,
      `other/20261017_153000_600519.SH_x_data.txt`
    ]) {
      const f2 = new FormData();
      f2.append("key", badKey);
      f2.append("file", new File(["x"], "f.txt"));
      await denied(
        new Request("http://quant-data.internal/api/r2/upload", { method: "POST", body: f2 }),
        jobId
      );
    }

    const vec = new Array(512).fill(0.1);
    const q = await batchOutboundHandler(
      post("/api/vector/query", {
        vector: vec,
        topK: 5,
        filter: { ts_code: { $eq: "600519.SH" } }
      }),
      env2,
      ctx
    );
    expect(((await q.json()) as { success: boolean }).success).toBe(true);
    expect(fakeVectorize.queried.at(-1)?.namespace).toBe("600519.SH");
    await denied(
      post("/api/vector/query", { vector: vec, topK: 5, filter: { ts_code: { $eq: "BAD" } } }),
      jobId
    );
    await denied(post("/api/vector/check", { id: "600519.SH_x" }), jobId);
  });
});

describe("ai.internal outbound handler", () => {
  const fakeGateway = {
    calls: [] as { url: string; init: RequestInit }[],
    response: new Response(JSON.stringify({ response: "pong" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }) as unknown,
    async fetch(url: RequestInfo | URL, init?: RequestInit) {
      this.calls.push({ url: String(url), init: init ?? {} });
      return (this.response as Response).clone();
    }
  };

  function aiEnv() {
    return {
      ...outboundEnv(),
      CF_ACCOUNT_ID: "acct-test",
      CF_AIG_TOKEN: "tok-test",
      fetch: fakeGateway.fetch.bind(fakeGateway) as typeof fetch
    };
  }

  function chat(body: unknown) {
    return post("/v1/chat/completions", body);
  }
  async function aiDenied(req: Request, jobId: string) {
    const resp = await aiOutboundHandler(req, aiEnv(), containerCtx(jobId));
    const body = (await resp.json()) as { success: boolean; error: string };
    expect(resp.status).toBe(403);
    expect(body.error).toBe("operation_not_allowed");
  }
  const goodBody = {
    model: "@cf/moonshotai/kimi-k2.6",
    messages: [{ role: "user", content: "hi" }]
  };

  it("denies: non-string/empty/oversize model, non-chat path, GET, oversize, non-brain script", async () => {
    const { jobId, ctx } = await seedJob("j-ai", "ai_brain");
    const env2 = aiEnv();
    await aiDenied(chat({ ...goodBody, model: "" }), jobId);
    await aiDenied(chat({ ...goodBody, model: "x".repeat(300) }), jobId);
    await aiDenied(chat({ ...goodBody, model: 42 }), jobId);
    await aiDenied(chat({ messages: goodBody.messages }), jobId);
    await aiDenied(post("/v1/embeddings", goodBody), jobId);
    await aiDenied(post("/v1/chat/completions/extra", goodBody), jobId);
    const get = await aiOutboundHandler(
      new Request("http://ai.internal/v1/chat/completions", { method: "GET" }),
      env2,
      ctx
    );
    expect(get.status).toBe(403);
    const big = await aiOutboundHandler(
      new Request("http://ai.internal/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...goodBody, pad: "x".repeat(3 * 1024 * 1024) })
      }),
      env2,
      ctx
    );
    expect(big.status).toBe(403);
    const chip = await seedJob("j-ai-chip", "chip_hunter");
    await aiDenied(chat(goodBody), chip.jobId);
    await aiDenied(chat(goodBody), "no:job");
  });

  function sentBody(i = -1) {
    return JSON.parse(fakeGateway.calls.at(i)!.init.body as string) as Record<string, unknown>;
  }
  function sentHeaders(i = -1) {
    return new Headers(fakeGateway.calls.at(i)!.init.headers);
  }

  it("allows brain/auditor, posts to gateway compat endpoint with auth+metadata, shapes both result forms", async () => {
    fakeGateway.calls.length = 0;
    const brain = await seedJob("j-ai-b1", "ai_brain");
    const env2 = aiEnv();
    const r1 = await aiOutboundHandler(
      chat({
        ...goodBody,
        temperature: 0.1,
        top_p: 0.9,
        max_tokens: 512,
        chat_template_kwargs: { thinking: false },
        evil_field: "drop_me",
        api_key: "drop_me_too"
      }),
      env2,
      brain.ctx
    );
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { choices: { message: { content: string } }[] };
    expect(b1.choices[0].message.content).toBe("pong");
    const call = fakeGateway.calls[0];
    expect(call.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-test/ai-gateway/compat/chat/completions"
    );
    const h = sentHeaders(0);
    expect(h.get("cf-aig-authorization")).toBe("Bearer tok-test");
    const meta = JSON.parse(h.get("cf-aig-metadata")!) as Record<string, string>;
    expect(meta).toEqual({ source: "batch", script: "ai_brain", run_date: RUN_DATE });
    const out = sentBody(0);
    expect(out.model).toBe("@cf/moonshotai/kimi-k2.6");
    expect(out.stream).toBe(false);
    expect(out.messages).toEqual(goodBody.messages);
    expect(out.chat_template_kwargs).toEqual({ thinking: false });
    expect(out).not.toHaveProperty("evil_field");
    expect(out).not.toHaveProperty("api_key");

    // Any non-empty model string is passed through: Workers AI, dynamic routes,
    // provider routes, bare names.
    for (const m of [
      "dynamic/abc-brain",
      "custom-dashscope-compat/qwen3.8-2.4t-a95b",
      "qwen3.8-2.4t-a95b"
    ]) {
      const rAlt = await aiOutboundHandler(
        chat({ ...goodBody, model: m }),
        env2,
        brain.ctx
      );
      expect(rAlt.status).toBe(200);
      expect(sentBody().model).toBe(m);
    }

    // Auditor job allowed too.
    const aud = await seedJob("j-ai-a1", "registry_auditor");
    const r2 = await aiOutboundHandler(chat(goodBody), env2, aud.ctx);
    expect(r2.status).toBe(200);
    const meta2 = JSON.parse(sentHeaders().get("cf-aig-metadata")!) as Record<string, string>;
    expect(meta2.script).toBe("registry_auditor");

    // OpenAI-shaped gateway result is passed through (reasoning preserved).
    fakeGateway.response = new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok", reasoning_content: "thought" },
            finish_reason: "stop"
          }
        ],
        usage: { total_tokens: 9 }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const r3 = await aiOutboundHandler(chat(goodBody), env2, brain.ctx);
    const b3 = (await r3.json()) as {
      choices: { message: { content: string; reasoning_content?: string } }[];
      usage: { total_tokens: number };
    };
    expect(b3.choices[0].message.content).toBe("ok");
    expect(b3.choices[0].message.reasoning_content).toBe("thought");
    expect(b3.usage.total_tokens).toBe(9);

    // Non-OpenAI shape is defensively normalized.
    fakeGateway.response = new Response(
      JSON.stringify({ response: { content: "wrapped", reasoning_content: "r" }, usage: { t: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const r4 = await aiOutboundHandler(chat(goodBody), env2, brain.ctx);
    const b4 = (await r4.json()) as {
      choices: { message: { content: string; reasoning_content?: string } }[];
    };
    expect(b4.choices[0].message.content).toBe("wrapped");
    expect(b4.choices[0].message.reasoning_content).toBe("r");
    fakeGateway.response = new Response(JSON.stringify({ response: "pong" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });

  it("forwards cf-aig-cache-key as an upstream header (<=128 chars)", async () => {
    fakeGateway.calls.length = 0;
    const { ctx } = await seedJob("j-ai-cache", "ai_brain");
    const env2 = aiEnv();
    const req = (key: string | null) =>
      new Request("http://ai.internal/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { "cf-aig-cache-key": key } : {})
        },
        body: JSON.stringify(goodBody)
      });

    const r1 = await aiOutboundHandler(req("601377.SH_20261018"), env2, ctx);
    expect(r1.status).toBe(200);
    expect(sentHeaders().get("cf-aig-cache-key")).toBe("601377.SH_20261018");

    const r2 = await aiOutboundHandler(req(null), env2, ctx);
    expect(r2.status).toBe(200);
    expect(sentHeaders().get("cf-aig-cache-key")).toBeNull();

    const r3 = await aiOutboundHandler(req("k".repeat(200)), env2, ctx);
    expect(r3.status).toBe(200);
    expect(sentHeaders().get("cf-aig-cache-key")).toBeNull();
  });

  it("passes upstream status through: 424 body becomes a real error, not model output", async () => {
    const { ctx } = await seedJob("j-ai-424", "ai_brain");
    const env2 = aiEnv();
    fakeGateway.response = new Response(
      JSON.stringify({ error: [{ code: 2030, message: "blocked" }], name: "AiGatewayError" }),
      { status: 424, headers: { "content-type": "application/json" } }
    );
    const r424 = await aiOutboundHandler(chat(goodBody), env2, ctx);
    expect(r424.status).toBe(424);
    const e424 = (await r424.json()) as { error: { message: string; type: string } };
    expect(e424.error.type).toBe("server_error");
    expect(e424.error.message).toContain("ai_gateway_424");

    fakeGateway.response = new Response("upstream exploded", { status: 500 });
    const r500 = await aiOutboundHandler(chat(goodBody), env2, ctx);
    expect(r500.status).toBe(500);
    expect(((await r500.json()) as { error: { message: string } }).error.message).toContain(
      "ai_gateway_500"
    );
  });

  it("denies ai_unconfigured when account or token is missing", async () => {
    const { ctx } = await seedJob("j-ai-noconf", "ai_brain");
    for (const env3 of [
      { ...aiEnv(), CF_ACCOUNT_ID: undefined },
      { ...aiEnv(), CF_AIG_TOKEN: undefined }
    ]) {
      const resp = await aiOutboundHandler(chat(goodBody), env3, ctx);
      expect(resp.status).toBe(403);
      expect(((await resp.json()) as { error: string }).error).toBe("operation_not_allowed");
    }
  });
});

describe("batch DO cleanup", () => {
  it("wipes storage for a terminal job; no-op while running or after a re-run", async () => {
    // A running job has no armed token: cleanup is a no-op.
    const running = await seedJob("j-clean-run", "chip_hunter");
    const runStub = batchStub(running.jobId);
    await runInDurableObject(runStub, async (instance) => {
      await (instance as unknown as { runCleanup(): Promise<void> }).runCleanup();
    });
    await runInDurableObject(runStub, async (_i, ctx) => {
      expect(await ctx.storage.get("job")).toBeTruthy();
    });

    // Terminal -> cleanup armed -> wipe removes all storage.
    const done = await seedJob("j-clean-done", "chip_hunter");
    const doneStub = batchStub(done.jobId);
    statusBody = { state: "finished", exit_code: 0 };
    expect((await doneStub.status()).status).toBe("succeeded");
    await runInDurableObject(doneStub, async (instance) => {
      await (instance as unknown as { runCleanup(): Promise<void> }).runCleanup();
    });
    await runInDurableObject(doneStub, async (_i, ctx) => {
      expect(await ctx.storage.get("job")).toBeFalsy();
      expect(await ctx.storage.get("cleanup_scheduled")).toBeFalsy();
    });

    // Terminal -> armed, but a re-run disarms: cleanup must not touch the
    // live job.
    const retried = await seedJob("j-clean-retry", "chip_hunter");
    const retryStub = batchStub(retried.jobId);
    statusBody = { state: "finished", exit_code: 1, error_tail: ["boom"] };
    expect((await retryStub.status()).status).toBe("failed");
    statusBody = { state: "running" };
    await retryStub.startJob({ script: "chip_hunter", run_date: RUN_DATE });
    await runInDurableObject(retryStub, async (instance) => {
      await (instance as unknown as { runCleanup(): Promise<void> }).runCleanup();
    });
    await runInDurableObject(retryStub, async (_i, ctx) => {
      const job = (await ctx.storage.get("job")) as { status: string } | null;
      expect(job?.status).toBe("running");
    });
  });
});

describe("batch container env", () => {
  it("forwards optional AI vars into the container env only when set", async () => {
    const fakeStorage = () => {
      const m = new Map<string, unknown>();
      return {
        get: async (k: string) => m.get(k) ?? null,
        put: async (k: string, v: unknown) => void m.set(k, v),
        delete: async (k: string) => (m.delete(k), true)
      } as never;
    };
    const transport = (seen: Record<string, string>[]) => () => ({
      async start(envVars: Record<string, string>) { seen.push(envVars); },
      async request() { return Response.json({ state: "running" }); },
      async stop() {}
    });
    const seen: Record<string, string>[] = [];
    const runner = new BatchJobRunner(
      fakeStorage(),
      {
        AI_ENGINE: "WORKERS_AI",
        BRAIN_AI_MODEL: "dynamic/abc-brain",
        AUDITOR_AI_MODEL: "dynamic/abc-auditor",
        DASHSCOPE_API_KEY: "dash-secret",
        CF_AIG_TOKEN: "aig-secret"
      } as never,
      transport(seen),
      () => "jid",
      { schedule() {}, wipe: async () => {} }
    );
    await runner.startJob({ script: "ai_brain", run_date: RUN_DATE });
    expect(seen[0].AI_ENGINE).toBe("WORKERS_AI");
    expect(seen[0].BRAIN_AI_MODEL).toBe("dynamic/abc-brain");
    expect(seen[0].AUDITOR_AI_MODEL).toBe("dynamic/abc-auditor");
    expect(seen[0].AI_BASE_URL).toBe("http://ai.internal/v1");
    // model credentials stay on the Worker; containers don't need them any more
    expect(seen[0]).not.toHaveProperty("DASHSCOPE_API_KEY");
    expect(seen[0]).not.toHaveProperty("CF_AIG_TOKEN");

    const seen2: Record<string, string>[] = [];
    const runner2 = new BatchJobRunner(
      fakeStorage(), {} as never, transport(seen2), () => "jid",
      { schedule() {}, wipe: async () => {} }
    );
    await runner2.startJob({ script: "ai_brain", run_date: RUN_DATE });
    expect(seen2[0]).not.toHaveProperty("AI_ENGINE");
    expect(seen2[0]).not.toHaveProperty("BRAIN_AI_MODEL");
    expect(seen2[0]).not.toHaveProperty("AUDITOR_AI_MODEL");
  });
});

describe("stock_basic sync (TS port)", () => {
  function tushareItems(status: string, n: number, prefix: string) {
    return {
      fields: [
        "ts_code", "symbol", "name", "fullname", "cnspell", "area", "industry",
        "market", "exchange", "list_status", "list_date", "delist_date", "is_hs"
      ],
      items: Array.from({ length: n }, (_, i) => [
        `${prefix}${String(i).padStart(4, "0")}.SH`,
        `${prefix}${i}`,
        i === 0 ? "茅'台" : `name${i}`,
        "",
        "nan",
        null,
        "白酒",
        "主板",
        "SSE",
        status,
        "20010827",
        null,
        "N"
      ])
    };
  }

  it("fetches L/D/P, dedupes by ts_code, maps empty/nan/null to NULL", async () => {
    const calls: string[] = [];
    const dup = tushareItems("L", 10, "600");
    dup.items.push([...dup.items[0]]); // duplicate ts_code
    const fetcher = async (_api: string, params: Record<string, unknown>) => {
      calls.push(String(params.list_status));
      if (params.list_status === "L") return dup;
      if (params.list_status === "D") return { fields: dup.fields, items: [] };
      return tushareItems("P", 2, "920");
    };
    const rows = await fetchStockBasicRows("token", fetcher);
    expect(calls).toEqual(["L", "D", "P"]);
    expect(rows).toHaveLength(12);
  });

  it("aborts when < 4000 rows; writes bound params in batches otherwise", async () => {
    const small = async () => tushareItems("L", 3, "600");
    await expect(
      syncStockBasic({ QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" }, { fetcher: small })
    ).rejects.toThrow("stock_basic_rows_abnormal: 3");

    const big = async (_api: string, params: Record<string, unknown>) => {
      if (params.list_status === "L") return tushareItems("L", 4100, "600");
      return { fields: tushareItems("L", 0, "x").fields, items: [] };
    };
    const res = await syncStockBasic(
      { QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      { fetcher: big }
    );
    expect(res.written).toBe(4100);
    expect(res.total).toBe(4100);
    const sample = await tenv.QUANT_DB.prepare(
      "SELECT name, fullname, cnspell, update_time FROM stock_basic WHERE ts_code='6000000.SH'"
    ).first<{ name: string; fullname: string | null; cnspell: string | null; update_time: string }>();
    expect(sample?.name).toBe("茅'台");
    expect(sample?.fullname).toBeNull();
    expect(sample?.cnspell).toBeNull();
    expect(sample?.update_time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const badCode = async () => {
      throw new Error("tushare_stock_basic: code=-1 bad");
    };
    await expect(
      syncStockBasic({ QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" }, { fetcher: badCode })
    ).rejects.toThrow("code=-1");
  });
});

describe("daily workflow", () => {
  function fakeStep() {
    const calls: string[] = [];
    const step: StepLike & { calls: string[] } = {
      calls,
      async do(name, fn) {
        calls.push(`do:${name}`);
        return fn();
      },
      async sleep(name) {
        calls.push(`sleep:${name}`);
      }
    };
    return step;
  }

  function fakeBatch(behaviour: Record<string, { statuses?: string[]; fail?: boolean }>) {
    const starts: string[] = [];
    const stops: string[] = [];
    const ns = {
      starts,
      stops,
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => {
        const name = id.toString().split(":")[1];
        const b = (behaviour[name] ?? {}) as { statuses?: string[]; fail?: boolean; _n?: number };
        b._n = b._n ?? 0;
        return {
          async startJob() {
            starts.push(name);
            if (b.fail) throw new Error("start_boom");
            return { script: name, status: "running" };
          },
          async status() {
            const s =
              b.statuses?.[Math.min(b._n ?? 0, (b.statuses?.length ?? 1) - 1)] ?? "succeeded";
            b._n = (b._n ?? 0) + 1;
            return {
              status: s === "finished" ? "succeeded" : s,
              error_tail: s === "failed" ? ["boom_err"] : []
            };
          },
          async stopJob() {
            stops.push(name);
          }
        };
      }
    };
    return ns;
  }

  const openCal = async () => ({ fields: ["cal_date", "is_open"], items: [["20261017", "1"]] });
  const closedCal = async () => ({ fields: ["cal_date", "is_open"], items: [["20261017", "0"]] });

  it("skips everything on a non-trading day", async () => {
    const step = fakeStep();
    const res = await runDailyPipeline(
      { BATCH: fakeBatch({}) as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      "i1",
      { date: "20261017" },
      step,
      { fetcher: closedCal }
    );
    expect(res.trade_day).toBe(false);
    expect(res.steps.every((s) => s.status === "skipped")).toBe(true);
    expect(res.steps.every((s) => s.error === "non_trading_day")).toBe(true);
    expect(res.steps.every((s) => s.reason_zh === "非交易日（Tushare 交易日历）")).toBe(true);
    expect(res.steps).toHaveLength(9);
    expect(step.calls).toEqual(["do:trade_day"]);
  });

  it("runs steps in order, polling until finished, continuing on failure", async () => {
    const step = fakeStep();
    const batch = fakeBatch({
      fundamentals: { statuses: ["failed", "succeeded"] },
      chip_hunter: { statuses: ["running", "succeeded"] }
    });
    const res = await runDailyPipeline(
      { BATCH: batch as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      "i2",
      { date: "20261017", only: ["fundamentals", "chip_hunter"] },
      step,
      { fetcher: openCal }
    );
    expect(res.trade_day).toBe(true);
    expect(res.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      "fundamentals:succeeded",
      "chip_hunter:succeeded"
    ]);
    // fundamentals failed once -> retried once -> started twice.
    expect(batch.starts).toEqual(["fundamentals", "fundamentals", "chip_hunter"]);
    const fundIdx = step.calls.findIndex((c) => c === "do:poll fundamentals #1 0");
    const chipIdx = step.calls.findIndex((c) => c === "do:start chip_hunter #1");
    expect(chipIdx).toBeGreaterThan(fundIdx);
    for (const s of res.steps) {
      expect(typeof s.duration_s).toBe("number");
      expect(s.started_at_bj).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
  });

  it("marks a script failed after the 4 h cap and stops its container", async () => {
    const step = fakeStep();
    let now = 1_000_000;
    const batch = fakeBatch({ fundamentals: { statuses: ["running"] } });
    const res = await runDailyPipeline(
      { BATCH: batch as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      "i3",
      { date: "20261017", only: ["fundamentals"] },
      step,
      { fetcher: openCal, clock: () => (now += 3 * 60 * 60 * 1000) }
    );
    expect(res.steps[0].status).toBe("failed");
    expect(res.steps[0].error).toBe("step_timeout_4h");
    expect(batch.stops).toContain("fundamentals");
  });

  it("fundamentals runs only on report-window Fridays unless forced/only", async () => {
    const mk = () => fakeBatch({ fundamentals: { statuses: ["succeeded"] } });
    const env2 = () => ({ BATCH: mk() as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" });
    const fund = (r: { steps: { name: string; status: string; error: string | null }[] }) =>
      r.steps.find((s) => s.name === "fundamentals");

    // Scheduled run (no only/force), 2026-10-16: Friday inside 10-01..10-31 -> runs.
    const fri = await runDailyPipeline(env2(), "w1", { date: "20261016" }, fakeStep(), { fetcher: openCal });
    expect(fund(fri)?.status).toBe("succeeded");

    // 2026-10-15: Thursday inside the window -> skipped.
    const thu = await runDailyPipeline(env2(), "w2", { date: "20261015" }, fakeStep(), { fetcher: openCal });
    expect(fund(thu)).toMatchObject({ status: "skipped", error: "not_in_report_window" });

    // 2026-05-15: Friday outside every window -> skipped.
    const offFri = await runDailyPipeline(env2(), "w3", { date: "20260515" }, fakeStep(), { fetcher: openCal });
    expect(fund(offFri)?.status).toBe("skipped");

    // force overrides the window.
    const forced = await runDailyPipeline(env2(), "w4", { date: "20260515", force: true }, fakeStep(), { fetcher: openCal });
    expect(fund(forced)?.status).toBe("succeeded");

    // `only` containing fundamentals overrides the window too.
    const only = await runDailyPipeline(env2(), "w5", { date: "20260515", only: ["fundamentals"] }, fakeStep(), { fetcher: openCal });
    expect(fund(only)?.status).toBe("succeeded");

    // `only` on a non-window Friday without force still skips? No — only wins:
    // covered above; a scheduled non-Friday in-window skips (2026-10-22 Thu).
    const thu2 = await runDailyPipeline(env2(), "w6", { date: "20261022" }, fakeStep(), { fetcher: openCal });
    expect(fund(thu2)?.status).toBe("skipped");
  });

  it("knowledge_miner / ai_brain get an 8 h cap instead of 4 h", async () => {
    const step = fakeStep();
    // +5h per clock call: a 4h step would cap on the first poll; an 8h step continues.
    let now = 1_000_000;
    const clock = () => (now += 5 * 60 * 60 * 1000);
    const batch = fakeBatch({ knowledge_miner: { statuses: ["running"] } });
    const res = await runDailyPipeline(
      { BATCH: batch as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      "w7",
      { date: "20261017", force: true, only: ["knowledge_miner"] },
      step,
      { fetcher: openCal, clock }
    );
    expect(res.steps[0].status).toBe("failed");
    expect(res.steps[0].error).toBe("step_timeout_8h");
    // First poll (elapsed 5h) did NOT stop: a second poll ran before the cap.
    expect(step.calls).toContain("do:poll knowledge_miner #1 1");
    expect(step.calls).toContain("do:poll knowledge_miner #1 0");

    // ai_brain gets 16h: polls at 5h/10h/15h continue, 20h caps.
    const step2 = fakeStep();
    now = 1_000_000;
    const batch2 = fakeBatch({ ai_brain: { statuses: ["running"] } });
    const res2 = await runDailyPipeline(
      { BATCH: batch2 as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      "w8",
      { date: "20261017", force: true, only: ["ai_brain"] },
      step2,
      { fetcher: openCal, clock }
    );
    expect(res2.steps[0].error).toBe("step_timeout_16h");
    expect(step2.calls).toContain("do:poll ai_brain #1 2");
    expect(step2.calls).toContain("do:poll ai_brain #1 3"); // elapsed 20h -> cap fires here
    expect(step2.calls).not.toContain("do:poll ai_brain #1 4");
  });

  it("force runs on a non-trading day; a failed step reports its error", async () => {
    const step = fakeStep();
    const batch = fakeBatch({ fundamentals: { statuses: ["failed"] } });
    const res = await runDailyPipeline(
      { BATCH: batch as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      "i4",
      { date: "20261017", force: true, only: ["fundamentals"] },
      step,
      { fetcher: closedCal }
    );
    expect(res.steps[0].status).toBe("failed");
    expect(res.steps[0].error).toBe("boom_err");
    // retry once -> two start calls
    expect(batch.starts.filter((n) => n === "fundamentals")).toHaveLength(2);
  });

  it("joins the last non-empty error_tail lines", async () => {
    const step = fakeStep();
    const batch = {
      starts: 0,
      idFromName: (n: string) => ({ toString: () => n }),
      get: () => ({
        async startJob() {
          batch.starts += 1;
          return {};
        },
        async status() {
          return { status: "failed", error_tail: ["", "first_boom", "", "last_boom", ""] };
        },
        async stopJob() {}
      })
    };
    const res = await runDailyPipeline(
      { BATCH: batch as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      "i5",
      { date: "20261017", only: ["fundamentals"] },
      step,
      { fetcher: openCal }
    );
    expect(res.steps[0].error).toBe("first_boom | last_boom");
  });

  // A Workflow-like step: step.do results are memoized by name; replays re-run
  // runDailyPipeline from the top with the cache intact.
  function memoStep() {
    const cache = new Map<string, unknown>();
    const calls: string[] = [];
    let hibernated = false;
    const step = {
      calls,
      hibernateOnFirstSleep() {
        hibernated = false;
        this._armed = true;
      },
      _armed: false,
      async do(name: string, fn: () => Promise<unknown> | unknown) {
        calls.push(`do:${name}`);
        if (cache.has(name)) return cache.get(name);
        const v = await fn();
        cache.set(name, v);
        return v;
      },
      async sleep(name: string) {
        calls.push(`sleep:${name}`);
        if (this._armed && !hibernated) {
          hibernated = true;
          throw new Error("workflow_hibernate");
        }
      }
    };
    return step as StepLike & {
      calls: string[];
      _armed: boolean;
      hibernateOnFirstSleep(): void;
    };
  }

  it("retries re-execute under #2 step names (memoized steps are not reused)", async () => {
    const step = memoStep();
    const batch = fakeBatch({ fundamentals: { statuses: ["failed", "succeeded"] } });
    const res = await runDailyPipeline(
      { BATCH: batch as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      "i6",
      { date: "20261017", only: ["fundamentals"] },
      step,
      { fetcher: openCal }
    );
    expect(res.steps[0].status).toBe("succeeded");
    // startJob really ran twice: attempt 2 used fresh #2 step names.
    expect(batch.starts).toEqual(["fundamentals", "fundamentals"]);
    expect(step.calls).toContain("do:start fundamentals #2");
    expect(step.calls).not.toContain("do:start fundamentals");
  });

  it("replays return memoized steps: identical result, no re-executed starts", async () => {
    const step = memoStep();
    // 30 min per clock call: begin@+0.5h ... end@+2.5h -> duration 7200 s.
    let now = 1_000_000;
    const clock = () => (now += 30 * 60 * 1000);
    const batch = fakeBatch({ fundamentals: { statuses: ["running", "succeeded"] } });
    const env2 = { BATCH: batch as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" };

    const res = await runDailyPipeline(
      env2, "i7", { date: "20261017", only: ["fundamentals"] }, step,
      { fetcher: openCal, clock }
    );
    expect(res.steps[0].status).toBe("succeeded");
    expect(res.steps[0].duration_s).toBe(7200);
    expect(batch.starts).toEqual(["fundamentals"]);

    // Replay hours later (the run re-executes top to bottom): every step
    // returns its memoized value, so the result is byte-identical and no
    // side-effecting step runs again.
    now += 3 * 60 * 60 * 1000;
    const res2 = await runDailyPipeline(
      env2, "i7", { date: "20261017", only: ["fundamentals"] }, step,
      { fetcher: openCal, clock }
    );
    expect(res2).toEqual(res);
    expect(batch.starts).toEqual(["fundamentals"]);
  });

  it("the 4h cap triggers only when persisted elapsed time exceeds it", async () => {
    const step = memoStep();
    // Each clock() call advances 1 h so persisted poll times keep increasing.
    let now = 1_000_000;
    const clock = () => (now += 60 * 60 * 1000);
    const batch = fakeBatch({ fundamentals: { statuses: ["running"] } });
    const env2 = { BATCH: batch as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" };

    // Pass 1: begin/t0/start persist (t0 = +2h), then the first sleep
    // hibernates -> the step is recorded failed and the run ends.
    step.hibernateOnFirstSleep();
    const pass1 = await runDailyPipeline(
      env2, "i8", { date: "20261017", only: ["fundamentals"] }, step,
      { fetcher: openCal, clock }
    );
    expect(pass1.steps[0].error).toBe("workflow_hibernate");

    // Replay: poll 0 executes now and persists its timestamp; the cap compares
    // poll.now - t0 using values that came out of steps, so it fires on the
    // fifth poll (elapsed 5h), not on a recomputed replay clock.
    now += 2 * 60 * 60 * 1000;
    const res = await runDailyPipeline(
      env2, "i8", { date: "20261017", only: ["fundamentals"] }, step,
      { fetcher: openCal, clock }
    );
    const fund = res.steps[0];
    expect(fund.status).toBe("failed");
    expect(fund.error).toBe("step_timeout_4h");
    // Both attempts hit the cap -> two stops.
    expect(batch.stops).toEqual(["fundamentals", "fundamentals"]);
    // The cap fired on the second persisted poll of attempt 1 (elapsed 5h),
    // not immediately on replay — poll 0's persisted `now` was used.
    const stopIdx = step.calls.indexOf("do:stop fundamentals #1");
    expect(step.calls.indexOf("do:poll fundamentals #1 1")).toBeGreaterThan(-1);
    expect(step.calls.indexOf("do:poll fundamentals #1 1")).toBeLessThan(stopIdx);
    expect(step.calls.indexOf("do:poll fundamentals #1 2")).toBe(-1);
    expect(stopIdx).toBeGreaterThan(step.calls.indexOf("do:poll fundamentals #1 0"));
  });

  it("scheduled() creates a deterministic daily instance id and ignores duplicates", async () => {
    const created: string[] = [];
    const daily = {
      async create(opts: { id: string }) {
        created.push(opts.id);
        if (created.length > 1) throw new Error("instance already exists");
        return {};
      }
    };
    const id = await scheduledTick({ DAILY: daily as never, QUANT_DB: tenv.QUANT_DB });
    expect(id).toBe(`daily-${bjCompactDate()}`);
    await expect(scheduledTick({ DAILY: daily as never, QUANT_DB: tenv.QUANT_DB })).resolves.toBe(id);
    const failing = {
      async create() {
        throw new Error("quota exceeded");
      }
    };
    await expect(scheduledTick({ DAILY: failing as never, QUANT_DB: tenv.QUANT_DB })).rejects.toThrow("quota exceeded");
  });

  it("passes the fired cron string into the instance params", async () => {
    const created: { id: string; params: unknown }[] = [];
    const daily = {
      async create(opts: { id: string; params: unknown }) {
        created.push(opts);
        return {};
      }
    };
    await scheduledTick(
      { DAILY: daily as never, QUANT_DB: tenv.QUANT_DB },
      new Date(),
      "0 1 * * 1-5"
    );
    expect(created).toHaveLength(1);
    expect(created[0].params).toEqual({ trigger: "cron", cron: "0 1 * * 1-5" });
  });

  it("DailyResult carries trigger/cron/rules; manual runs report trigger manual", async () => {
    const env2 = () => ({
      BATCH: fakeBatch({ fundamentals: { statuses: ["succeeded"] } }) as never,
      QUANT_DB: tenv.QUANT_DB,
      MY_TUSHARE_TOKEN: "t"
    });
    const cronRes = await runDailyPipeline(
      env2(), "c1",
      { date: "20261016", only: ["fundamentals"], trigger: "cron", cron: "0 1 * * 1-5" },
      fakeStep(), { fetcher: openCal }
    );
    expect(cronRes.trigger).toBe("cron");
    expect(cronRes.cron).toBe("0 1 * * 1-5");
    const manual = await runDailyPipeline(
      env2(), "c2",
      { date: "20261016", only: ["fundamentals"] },
      fakeStep(), { fetcher: openCal }
    );
    expect(manual.trigger).toBe("manual");
    expect(manual.cron).toBeUndefined();
    // rules are derived from the pipeline's own constants
    expect(manual.rules.步骤顺序).toEqual([
      "stock_basic", "fundamentals", "chip_hunter", "alpha_hunter",
      "hotspot_registry", "registry_auditor", "hotspot_hunter",
      "knowledge_miner", "ai_brain"
    ]);
    expect(manual.rules.基本面窗口).toBe("仅在 1–4、7–8、10 月的周五运行");
    expect(manual.rules.单步时长上限).toEqual({
      knowledge_miner: "8 小时",
      ai_brain: "16 小时",
      其他: "4 小时"
    });
    expect(manual.rules.进度检查间隔).toBe("2 分钟");
    expect(manual.rules.失败重试).toBe("每个脚本失败后整体重试 1 次");
  });

  it("stops the batch container when a script reaches a terminal status", async () => {
    const step = fakeStep();
    const batch = fakeBatch({
      fundamentals: { statuses: ["failed", "succeeded"] },
      chip_hunter: { statuses: ["succeeded"] }
    });
    const res = await runDailyPipeline(
      { BATCH: batch as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      "i9",
      { date: "20261016", only: ["fundamentals", "chip_hunter"] },
      step,
      { fetcher: openCal }
    );
    expect(res.steps.every((s) => s.status === "succeeded")).toBe(true);
    // one stop per terminal attempt: fundamentals failed #1 -> stop, succeeded
    // #2 -> stop, chip_hunter succeeded -> stop
    expect(batch.stops).toEqual(["fundamentals", "fundamentals", "chip_hunter"]);
    expect(step.calls).toContain("do:stop fundamentals #1");
    expect(step.calls).toContain("do:stop fundamentals #2");
    expect(step.calls).toContain("do:stop chip_hunter #1");
  });

  it("reason_zh maps skip/failure causes to Chinese explanations", async () => {
    const env2 = (b: ReturnType<typeof fakeBatch>) => ({
      BATCH: b as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t"
    });
    // fundamentals skip on a Thursday inside the window
    const thu = await runDailyPipeline(
      env2(fakeBatch({ fundamentals: { statuses: ["succeeded"] } })),
      "r1", { date: "20261015" }, fakeStep(), { fetcher: openCal }
    );
    const fund = thu.steps.find((s) => s.name === "fundamentals")!;
    expect(fund.error).toBe("not_in_report_window");
    expect(fund.reason_zh).toBe("不在财报窗口（仅在 1–4、7–8、10 月的周五运行）");
    // step timeout
    let now = 1_000_000;
    const cap = await runDailyPipeline(
      env2(fakeBatch({ fundamentals: { statuses: ["running"] } })),
      "r2", { date: "20261016", only: ["fundamentals"] }, fakeStep(),
      { fetcher: openCal, clock: () => (now += 3 * 60 * 60 * 1000) }
    );
    expect(cap.steps[0].reason_zh).toBe("超过单步时长上限");
    // container instance limit surfaced by startJob
    const limited = {
      idFromName: (n: string) => ({ toString: () => n }),
      get: () => ({
        async startJob() {
          throw new Error("Maximum number of running container instances exceeded");
        },
        async status() {
          return { status: "running" };
        },
        async stopJob() {}
      })
    };
    const lim = await runDailyPipeline(
      { BATCH: limited as never, QUANT_DB: tenv.QUANT_DB, MY_TUSHARE_TOKEN: "t" },
      "r3", { date: "20261016", only: ["fundamentals"] }, fakeStep(), { fetcher: openCal }
    );
    expect(lim.steps[0].reason_zh).toBe("容器实例已达上限（max_instances）");
    // a plain failure keeps reason_zh null
    const boom = await runDailyPipeline(
      env2(fakeBatch({ fundamentals: { statuses: ["failed"] } })),
      "r4", { date: "20261016", only: ["fundamentals"], force: true }, fakeStep(), { fetcher: openCal }
    );
    expect(boom.steps[0].reason_zh).toBeNull();
  });

  it("pipeline entry exports ContainerProxy for outbound interception", async () => {
    const mod = (await import("../src/pipeline/index.js")) as Record<string, unknown>;
    expect(typeof mod.ContainerProxy).toBe("function");
    const { ContainerProxy } = await import("@cloudflare/containers");
    expect(mod.ContainerProxy).toBe(ContainerProxy);
    expect(typeof mod.QuantDailyWorkflow).toBe("function");
    expect(typeof mod.QuantBatchContainer).toBe("function");
  });
});
