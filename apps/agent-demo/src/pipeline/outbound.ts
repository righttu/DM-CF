// Outbound allowlist for batch containers. Each job carries {script, run_date};
// the allowlist is resolved by script name. Everything else -> 403 + audit log
// of kind + sha256 (never SQL text or bodies).
import {
  AI_CHAT_MODEL,
  AI_OUTBOUND_HOST,
  TS_CODE_PATTERN,
  aiChatOutboundHandler,
  bjCompactDate,
  checkReadOnlyOutbound,
  type AiRunLike,
  normalizeSql,
  outboundAllow,
  outboundDeny,
  readJsonBody,
  sha256Short,
  validVector
} from "../shared/outbound.js";

const EVENT = "quant_batch_outbound";
const R2_MAX_BYTES = 1024 * 1024;
const SAVE_MAX_ROWS = 10000;

function deny(kind: string, hash?: string): Response {
  return outboundDeny(EVENT, kind, hash);
}

function allow(kind: string, hash: string | null, body: unknown): Response {
  return outboundAllow(EVENT, kind, hash, body);
}

// ---------- shared SQL ----------

const PRAGMA_SYNC_STATUS = "PRAGMA table_info(sync_status)";
const HUNTER_TABLES_QUERY =
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_hunter'";
const SYNC_UPSERT =
  /^INSERT INTO sync_status \(ts_code, (last_report_sync|last_news_sync)\) VALUES \(\?, \?\) ON CONFLICT\(ts_code\) DO UPDATE SET \1=excluded\.\1$/;
const AI_RESULT_INSERT = /^INSERT OR REPLACE INTO ai_analysis_result VALUES \(\?(?:,\?){23}\)$/;

const REGISTRY_UPSERT =
  "INSERT INTO hotspot_registry (ts_code, name, sector, node, purity, em_reason, ts_main_biz, volume_node, remark, create_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ts_code, sector, node) DO UPDATE SET em_reason = excluded.em_reason, ts_main_biz = excluded.ts_main_biz, create_date = excluded.create_date";
const AUDITOR_UPDATE =
  "UPDATE hotspot_registry SET purity = ?, remark = ? WHERE ts_code = ? AND sector = ? AND node = ?";

const HOTSPOT_COLS = [
  "ts_code", "trade_date", "name", "industry", "sector", "close",
  "turnover_rate_3d", "industry_turnover_rate_3d", "pe_ttm",
  "pe_ttm_percentile", "industry_pe_ttm_median", "peg", "pb",
  "pb_percentile", "industry_pb_median", "forecast_eps_fy1",
  "forecast_eps_fy2", "net_inflow_5d", "total_mv", "ps_ttm",
  "con_growth_rate", "chip_latest_change", "chip_cumu_change",
  "volume_ratio", "mf_intensity", "pct_chg", "net_mf_amount",
  "bias_60", "is_institutional", "em_reason", "scan_date", "tags"
];
const HOTSPOT_INSERT = new RegExp(
  `^INSERT OR REPLACE INTO hotspot_hunter \\(\\s*${HOTSPOT_COLS.join(", ")}\\s*\\) VALUES \\(\\s*\\?(?:\\s*,\\s*\\?){31}\\s*\\)$`
);

// ---------- per-script DDL no-ops (returned success without executing) ----------

const DDL = {
  fundamentals: [/^CREATE TABLE IF NOT EXISTS stock_fundamentals \(/],
  chip_hunter: [
    /^CREATE TABLE IF NOT EXISTS chip_hunter \(/,
    /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (idx_chip_ts_code|idx_chip_scan_date|idx_chip_code_scan_date) ON chip_hunter\(/
  ],
  alpha_hunter: [
    /^CREATE TABLE IF NOT EXISTS alpha_hunter \(/,
    /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (idx_alpha_ts_code|idx_alpha_scan_date|idx_alpha_code_scan_date) ON alpha_hunter\(/
  ],
  hotspot_registry: [/^CREATE TABLE IF NOT EXISTS hotspot_registry \(/],
  hotspot_hunter: [/^CREATE TABLE IF NOT EXISTS hotspot_hunter \(/],
  knowledge_miner: [
    /^CREATE TABLE IF NOT EXISTS (sync_status|institutional_surveys) \(/,
    /^ALTER TABLE sync_status ADD COLUMN last_news_sync TEXT$/
  ],
  ai_brain: [/^CREATE TABLE IF NOT EXISTS ai_analysis_result \(/]
} as const;

// ---------- /api/db/save column sets (keys of data[0] must be a subset) ----------

const SAVE_COLUMNS: Record<string, readonly string[]> = {
  stock_fundamentals: [
    "ts_code", "end_date", "ann_date", "revenue", "tr_yoy", "q_sales_yoy",
    "n_income_attr_p", "netprofit_yoy", "q_netprofit_yoy", "dt_netprofit_yoy",
    "q_dtprofit", "profit_dedt", "eps", "bps", "grossprofit_margin",
    "netprofit_margin", "roe", "roe_dt", "roic", "int_exp", "daa", "ebitda",
    "ebit", "debt_to_assets", "current_ratio", "quick_ratio", "assets_turn",
    "ar_turn", "accounts_receiv", "inventories", "rd_exp", "n_cashflow_act",
    "pe_ttm", "pb", "ps_ttm", "total_mv", "dv_ratio", "update_time"
  ],
  chip_hunter: [
    "id", "scan_date", "ts_code", "name", "industry", "close", "pct_chg",
    "volume_ratio", "total_mv", "turnover_rate", "turnover_rate_3d",
    "industry_turnover_rate_3d", "score", "tags", "holders_wan",
    "chip_cumu_change", "chip_latest_change", "net_mf_amount", "net_inflow_5d",
    "pe_ttm", "pe_ttm_percentile", "industry_pe_ttm_median", "peg", "pb",
    "pb_percentile", "industry_pb_median", "ratio_current", "ratio_prev_1",
    "ps_ttm", "forecast_eps_fy1", "forecast_eps_fy2", "con_growth_rate", "roe",
    "grossprofit_margin", "netprofit_yoy", "concepts", "top_list_reason",
    "pattern", "bias_60", "vol_signal", "create_time"
  ],
  alpha_hunter: [
    "id", "ts_code", "name", "industry", "close", "turnover_rate_3d",
    "industry_turnover_rate_3d", "pe_ttm", "pe_ttm_percentile",
    "industry_pe_ttm_median", "peg", "pb", "pb_percentile",
    "industry_pb_median", "forecast_eps_fy1", "net_inflow_5d", "total_mv",
    "ps_ttm", "forecast_eps_fy2", "con_growth_rate", "roe",
    "grossprofit_margin", "netprofit_yoy", "scan_date", "score", "tags",
    "industry_heat_status", "main_business", "ratio_current", "ratio_prev_1",
    "ratio_prev_2", "accel_ratio", "hold_mv_billion", "chip_latest_change",
    "chip_cumu_change", "create_time"
  ]
};

const SURVEY_KEYS = ["ts_code", "survey_date", "org_count", "org_names", "reception_place"];

// ---------- per-script capabilities ----------

const SAVE_TABLE_BY_SCRIPT: Record<string, string> = {
  fundamentals: "stock_fundamentals",
  chip_hunter: "chip_hunter",
  alpha_hunter: "alpha_hunter"
};

const PROMPT_LOG_KEY =
  /^prompt_logs\/\d{8}_\d{6}_\d{6}\.(SH|SZ|BJ)_[^/]{1,40}_data\.txt$/;

type VectorizeLike = {
  getByIds?(ids: string[]): Promise<unknown[]>;
  upsert(
    vectors: { id: string; values: number[]; metadata?: Record<string, unknown>; namespace?: string }[]
  ): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; filter?: unknown; returnMetadata?: string; namespace?: string }
  ): Promise<{ matches: unknown[] }>;
};

type JobContextStub = {
  get(id: unknown): { jobContext(): Promise<Job | null> };
  idFromString(id: string): unknown;
};

type BatchOutboundEnv = {
  QUANT_DB: D1Database;
  BATCH?: JobContextStub;
  VECTORIZE?: VectorizeLike;
  R2_STOCK_INFOR?: R2Bucket;
};

type Job = { script: string; run_date: string };

async function resolveJob(env: BatchOutboundEnv, containerId: string): Promise<Job | null> {
  if (!env.BATCH || !containerId) return null;
  try {
    const stub = env.BATCH.get(env.BATCH.idFromString(containerId));
    return await stub.jobContext();
  } catch {
    return null;
  }
}

export async function batchOutboundHandler(
  request: Request,
  env: BatchOutboundEnv,
  ctx: { containerId: string }
): Promise<Response> {
  const url = new URL(request.url);
  const job = await resolveJob(env, ctx.containerId);
  if (!job) return deny("no_job");
  if (request.method !== "POST") return deny("method");
  switch (url.pathname) {
    case "/api/db/query":
      return handleDbQuery(request, env);
    case "/api/db/execute":
      return handleDbExecute(request, env, job);
    case "/api/db/save":
      return handleDbSave(request, env, job);
    case "/api/vector/check":
      return handleVectorCheck(request, env, job);
    case "/api/vector/upsert":
      return handleVectorUpsert(request, env, job);
    case "/api/vector/query":
      return handleVectorQuery(request, env, job);
    case "/api/r2/upload":
      return handleR2Upload(request, env, job);
    default:
      return deny("path", await sha256Short(url.pathname));
  }
}

export { AI_OUTBOUND_HOST, AI_CHAT_MODEL };

const AI_SCRIPTS = new Set(["ai_brain", "registry_auditor"]);

// ai.internal handler: only the Brain and Auditor jobs may call Workers AI.
export async function aiOutboundHandler(
  request: Request,
  env: BatchOutboundEnv & { AI?: AiRunLike },
  ctx: { containerId: string }
): Promise<Response> {
  const job = await resolveJob(env, ctx.containerId);
  const hash = await sha256Short("ai:job");
  if (!job) return deny("no_job", hash);
  if (!AI_SCRIPTS.has(job.script)) return deny("ai_script", hash);
  return aiChatOutboundHandler(
    request,
    env.AI,
    { source: "batch", script: job.script, run_date: job.run_date },
    EVENT
  );
}

async function handleDbQuery(request: Request, env: BatchOutboundEnv): Promise<Response> {
  const body = await readJsonBody(request);
  const sql = typeof body?.sql === "string" ? normalizeSql(body.sql) : null;
  if (!sql) return deny("db_query_sql");
  const params = Array.isArray(body?.params) ? body.params : [];
  const hash = await sha256Short(sql);
  if (sql === PRAGMA_SYNC_STATUS || sql === HUNTER_TABLES_QUERY) {
    const { results } = await env.QUANT_DB.prepare(sql).all();
    return allow("db_query_fixed", hash, { success: true, results });
  }
  if (!checkReadOnlyOutbound(sql)) return deny("db_query_sql", hash);
  try {
    const { results } = await env.QUANT_DB.prepare(`SELECT * FROM (${sql})`)
      .bind(...params)
      .all();
    return allow("db_query", hash, { success: true, results });
  } catch (error) {
    return Response.json({
      success: false,
      error: `d1_error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
    });
  }
}

async function handleDbExecute(
  request: Request,
  env: BatchOutboundEnv,
  job: Job
): Promise<Response> {
  const body = await readJsonBody(request);
  const sql = typeof body?.sql === "string" ? normalizeSql(body.sql) : null;
  if (!sql) return deny("db_execute_sql");
  const params = Array.isArray(body?.params) ? body.params : [];
  const hash = await sha256Short(sql);

  const ddlList = (DDL as Record<string, readonly RegExp[]>)[job.script];
  if (ddlList?.some((re) => re.test(sql))) {
    return allow("db_execute_ddl_noop", hash, { success: true });
  }

  switch (job.script) {
    case "hotspot_registry": {
      if (sql === REGISTRY_UPSERT && params.length === 10) {
        await env.QUANT_DB.prepare(sql).bind(...params).run();
        return allow("db_execute_registry_upsert", hash, { success: true });
      }
      return deny("db_execute_sql", hash);
    }
    case "registry_auditor": {
      if (sql === AUDITOR_UPDATE && params.length === 5) {
        await env.QUANT_DB.prepare(sql).bind(...params).run();
        return allow("db_execute_auditor_update", hash, { success: true });
      }
      return deny("db_execute_sql", hash);
    }
    case "hotspot_hunter": {
      if (HOTSPOT_INSERT.test(sql) && params.length === 32) {
        await env.QUANT_DB.prepare(sql).bind(...params).run();
        return allow("db_execute_hotspot_insert", hash, { success: true });
      }
      return deny("db_execute_sql", hash);
    }
    case "knowledge_miner": {
      if (SYNC_UPSERT.test(sql)) {
        if (params.length !== 2 || typeof params[0] !== "string" || !TS_CODE_PATTERN.test(params[0])) {
          return deny("db_execute_sync_params", hash);
        }
        await env.QUANT_DB.prepare(sql).bind(...params).run();
        return allow("db_execute_sync", hash, { success: true });
      }
      return deny("db_execute_sql", hash);
    }
    case "ai_brain": {
      if (AI_RESULT_INSERT.test(sql)) {
        // The pipeline can cross midnight: accept the job's run_date or the
        // current Asia/Shanghai date.
        if (
          params.length !== 24 ||
          (params[0] !== job.run_date && params[0] !== bjCompactDate())
        ) {
          return deny("db_execute_ai_params", hash);
        }
        await env.QUANT_DB.prepare(sql).bind(...params).run();
        return allow("db_execute_ai", hash, { success: true });
      }
      return deny("db_execute_sql", hash);
    }
    default:
      return deny("db_execute_sql", hash);
  }
}

// Mirrors stock-api /api/db/save: INSERT OR IGNORE INTO <table> (<keys of
// data[0]>) VALUES (...) binding row[c] ?? null per first-row column, batched.
async function handleDbSave(
  request: Request,
  env: BatchOutboundEnv,
  job: Job
): Promise<Response> {
  const body = await readJsonBody(request);
  const table = typeof body?.table === "string" ? body.table : "";
  const hash = await sha256Short(`save:${table}`);
  const allowedTable = SAVE_TABLE_BY_SCRIPT[job.script];
  const exactKeys = job.script === "knowledge_miner" ? SURVEY_KEYS : null;
  if (exactKeys ? table !== "institutional_surveys" : !allowedTable || table !== allowedTable) {
    return deny("db_save_table", hash);
  }
  const data = body?.data;
  if (!Array.isArray(data) || data.length > SAVE_MAX_ROWS) return deny("db_save_rows", hash);
  if (data.length === 0) return allow("db_save", hash, { success: true, count: 0 });
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return deny("db_save_row", hash);
  }
  const columns = Object.keys(data[0] as Record<string, unknown>);
  if (columns.length === 0) return deny("db_save_keys", hash);
  if (exactKeys) {
    for (const row of data as Record<string, unknown>[]) {
      const keys = Object.keys(row).sort();
      if (keys.length !== exactKeys.length || !exactKeys.every((k) => keys.includes(k))) {
        return deny("db_save_keys", hash);
      }
      if (!TS_CODE_PATTERN.test(String(row.ts_code))) return deny("db_save_ts_code", hash);
    }
  } else {
    const allowed = SAVE_COLUMNS[table];
    if (!allowed || !columns.every((c) => allowed.includes(c))) {
      return deny("db_save_keys", hash);
    }
  }
  const placeholders = `(${columns.map(() => "?").join(",")})`;
  const sql = `INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`;
  const statements = (data as Record<string, unknown>[]).map((row) =>
    env.QUANT_DB.prepare(sql).bind(...columns.map((c) => row[c] ?? null))
  );
  for (let i = 0; i < statements.length; i += 100) {
    await env.QUANT_DB.batch(statements.slice(i, i + 100));
  }
  return allow("db_save", hash, { success: true, count: data.length });
}

function vectorTsCode(id: unknown): string | null {
  if (typeof id !== "string" || id.length > 64) return null;
  const code = id.split("_")[0];
  if (!TS_CODE_PATTERN.test(code) || !id.startsWith(`${code}_`)) return null;
  return code;
}

async function handleVectorCheck(
  request: Request,
  env: BatchOutboundEnv,
  job: Job
): Promise<Response> {
  const hash = await sha256Short("vector_check");
  if (job.script !== "knowledge_miner") return deny("vector_script", hash);
  const body = await readJsonBody(request);
  if (!vectorTsCode(body?.id)) return deny("vector_check_id", hash);
  if (!env.VECTORIZE?.getByIds) return deny("vector_unavailable", hash);
  const found = await env.VECTORIZE.getByIds([body!.id as string]);
  return allow("vector_check", hash, {
    success: true,
    exists: Array.isArray(found) && found.length > 0
  });
}

async function handleVectorUpsert(
  request: Request,
  env: BatchOutboundEnv,
  job: Job
): Promise<Response> {
  const hash = await sha256Short("vector_upsert");
  if (job.script !== "knowledge_miner") return deny("vector_script", hash);
  const body = await readJsonBody(request);
  const { ids, embeddings, metadatas } = body ?? {};
  if (
    !Array.isArray(ids) ||
    !Array.isArray(embeddings) ||
    !Array.isArray(metadatas) ||
    ids.length === 0 ||
    ids.length > 1000 ||
    ids.length !== embeddings.length ||
    ids.length !== metadatas.length
  ) {
    return deny("vector_upsert_shape", hash);
  }
  const vectors: { id: string; values: number[]; metadata: Record<string, unknown>; namespace: string }[] = [];
  for (let i = 0; i < ids.length; i++) {
    const code = vectorTsCode(ids[i]);
    const meta = metadatas[i];
    if (
      !code ||
      !validVector(embeddings[i]) ||
      !meta ||
      typeof meta !== "object" ||
      (meta as Record<string, unknown>).ts_code !== code
    ) {
      return deny("vector_upsert_item", hash);
    }
    vectors.push({
      id: ids[i] as string,
      values: embeddings[i] as number[],
      metadata: meta as Record<string, unknown>,
      namespace: code
    });
  }
  if (!env.VECTORIZE) return deny("vector_unavailable", hash);
  await env.VECTORIZE.upsert(vectors);
  return allow("vector_upsert", hash, { success: true, count: ids.length });
}

async function handleVectorQuery(
  request: Request,
  env: BatchOutboundEnv,
  job: Job
): Promise<Response> {
  const hash = await sha256Short("vector_query");
  if (job.script !== "ai_brain") return deny("vector_script", hash);
  const body = await readJsonBody(request);
  const filter = body?.filter as Record<string, unknown> | undefined;
  const tsFilter = filter?.ts_code as Record<string, unknown> | undefined;
  const code = typeof tsFilter?.$eq === "string" ? tsFilter.$eq : "";
  const topK = body?.topK;
  if (
    !validVector(body?.vector) ||
    !TS_CODE_PATTERN.test(code) ||
    typeof topK !== "number" ||
    !Number.isInteger(topK) ||
    topK < 1 ||
    topK > 50
  ) {
    return deny("vector_query_params", hash);
  }
  if (!env.VECTORIZE) return deny("vector_unavailable", hash);
  const results = await env.VECTORIZE.query(body!.vector as number[], {
    topK,
    returnMetadata: "all",
    namespace: code
  });
  return allow("vector_query", hash, { success: true, results });
}

async function handleR2Upload(
  request: Request,
  env: BatchOutboundEnv,
  job: Job
): Promise<Response> {
  const hash = await sha256Short("r2_upload");
  if (job.script !== "ai_brain") return deny("r2_script", hash);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return deny("r2_form", hash);
  }
  const key = form.get("key");
  const file = form.get("file");
  if (typeof key !== "string" || !PROMPT_LOG_KEY.test(key)) return deny("r2_key", hash);
  if (!(file instanceof File)) return deny("r2_file", hash);
  if (file.size > R2_MAX_BYTES) return deny("r2_size", hash);
  if (!env.R2_STOCK_INFOR) return deny("r2_unavailable", hash);
  await env.R2_STOCK_INFOR.put(key, file.stream());
  return allow("r2_upload", hash, { success: true, key });
}
