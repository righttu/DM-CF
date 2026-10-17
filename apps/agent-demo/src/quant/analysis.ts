import { Container } from "@cloudflare/containers";
import { QUANT_QUERIES } from "./catalog.js";

export interface AnalysisEnv {
  QUANT_DB: D1Database;
  ANALYSIS?: DurableObjectNamespace<QuantAnalysisContainer>;
  VECTORIZE?: Vectorize;
  R2_STOCK_INFOR?: R2Bucket;
  MY_TUSHARE_TOKEN?: string;
  DASHSCOPE_API_KEY?: string;
  CF_AIG_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

export type AnalysisJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "not_found";

export interface AnalysisResultSummary {
  status: string | null;
  ts_code: string | null;
  final_score: number | null;
  target_price: number | null;
  miner_chunks: number | null;
}

export interface AnalysisJob {
  ts_code: string;
  date: string;
  requested_by: string;
  status: AnalysisJobStatus;
  phase: string | null;
  started_at: string;
  finished_at: string | null;
  result_summary: AnalysisResultSummary | null;
  error: string | null;
}

export interface AnalysisJobView extends AnalysisJob {
  job_id: string;
}

const JOB_TIMEOUT_MS = 20 * 60 * 1000;
const CONTAINER_HOST = "http://container";

export function shanghaiCompactDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(now)
    .replaceAll("-", "");
}

export const ANALYSIS_JOB_ID_PATTERN = /^\d{6}\.(SH|SZ|BJ):\d{8}$/;
export const ANALYSIS_OUTBOUND_HOST = "quant-data.internal";

export interface AnalysisTransport {
  start(envVars: Record<string, string>): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

let transportOverride: AnalysisTransport | undefined;

export function __setAnalysisTransportForTests(t?: AnalysisTransport): void {
  transportOverride = t;
}

export function analysisTransport(): AnalysisTransport | undefined {
  return transportOverride;
}

export class AnalysisJobRunner {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: AnalysisEnv,
    private readonly transport: () => AnalysisTransport,
    private readonly jobId: () => string
  ) {}

  private containerEnvVars(): Record<string, string> {
    const env = this.env;
    const vars: Record<string, string> = {
      D1_API_URL: `http://${ANALYSIS_OUTBOUND_HOST}`,
      CF_ACCESS_CLIENT_ID: "unused",
      CF_ACCESS_CLIENT_SECRET: "unused"
    };
    if (env.MY_TUSHARE_TOKEN) vars.MY_TUSHARE_TOKEN = env.MY_TUSHARE_TOKEN;
    if (env.DASHSCOPE_API_KEY) vars.DASHSCOPE_API_KEY = env.DASHSCOPE_API_KEY;
    if (env.CF_AIG_TOKEN) vars.CF_AIG_TOKEN = env.CF_AIG_TOKEN;
    if (env.CF_ACCOUNT_ID) vars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;
    return vars;
  }

  private async loadJob(): Promise<AnalysisJob | null> {
    return (await this.storage.get<AnalysisJob>("job")) ?? null;
  }

  private async saveJob(job: AnalysisJob): Promise<void> {
    await this.storage.put("job", job);
  }

  async jobContext(): Promise<{ ts_code: string; date: string } | null> {
    const job = await this.loadJob();
    return job ? { ts_code: job.ts_code, date: job.date } : null;
  }

  async startJob(input: {
    ts_code: string;
    date: string;
    requested_by: string;
  }): Promise<AnalysisJob> {
    const existing = await this.loadJob();
    if (
      existing &&
      (existing.status === "queued" ||
        existing.status === "running" ||
        existing.status === "succeeded")
    ) {
      return existing;
    }
    const job: AnalysisJob = {
      ts_code: input.ts_code,
      date: input.date,
      requested_by: input.requested_by,
      status: "running",
      phase: "queued",
      started_at: new Date().toISOString(),
      finished_at: null,
      result_summary: null,
      error: null
    };
    await this.saveJob(job);
    await this.storage.setAlarm(Date.now() + JOB_TIMEOUT_MS);
    const t = this.transport();
    try {
      await t.start(this.containerEnvVars());
      const resp = await t.request("/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ts_code: job.ts_code })
      });
      if (!resp.ok) throw new Error(`run_http_${resp.status}`);
    } catch (error) {
      job.status = "failed";
      job.phase = null;
      job.finished_at = new Date().toISOString();
      job.error = `container_start: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        300
      );
      await this.saveJob(job);
      throw error;
    }
    return job;
  }

  async status(): Promise<AnalysisJob> {
    const job = await this.loadJob();
    if (!job) {
      return {
        ts_code: "",
        date: "",
        requested_by: "",
        status: "not_found",
        phase: null,
        started_at: "",
        finished_at: null,
        result_summary: null,
        error: null
      };
    }
    if (job.status === "queued" || job.status === "running") {
      await this.refreshFromContainer(job);
    }
    return job;
  }

  private async refreshFromContainer(job: AnalysisJob): Promise<void> {
    let snap: {
      state?: string;
      phase?: string | null;
      result?: unknown;
      error?: string | null;
      log_tail?: unknown;
    };
    try {
      const resp = await this.transport().request("/status");
      if (!resp.ok) return;
      snap = (await resp.json()) as typeof snap;
    } catch {
      return;
    }
    if (typeof snap.phase === "string" && snap.phase.length > 0) {
      job.phase = snap.phase;
    }
    if (snap.state === "succeeded") {
      job.status = "succeeded";
      job.phase = snap.phase ?? "done";
      job.finished_at = new Date().toISOString();
      job.result_summary = summarizeResult(snap.result);
    } else if (snap.state === "failed") {
      job.status = "failed";
      job.finished_at = new Date().toISOString();
      job.error = typeof snap.error === "string" ? snap.error.slice(0, 300) : "engine_failed";
      console.error(
        JSON.stringify({
          event: "quant_analysis_failed",
          job_id: this.jobId(),
          error: job.error,
          log_tail: snap.log_tail
        })
      );
    }
    await this.saveJob(job);
  }

  async alarm(): Promise<void> {
    const job = await this.loadJob();
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    job.status = "timeout";
    job.finished_at = new Date().toISOString();
    job.error = "analysis_timeout";
    await this.saveJob(job);
    console.error(
      JSON.stringify({ event: "quant_analysis_timeout", job_id: this.jobId() })
    );
    try {
      await this.transport().stop();
    } catch {
      // best effort: container may already be gone
    }
  }
}

export class QuantAnalysisContainer extends Container<AnalysisEnv> {
  defaultPort = 8080;
  sleepAfter = "10m";

  private readonly runner = new AnalysisJobRunner(
    this.ctx.storage,
    this.env,
    () => transportOverride ?? this.defaultTransport(),
    () => this.ctx.id.name ?? ""
  );

  private defaultTransport(): AnalysisTransport {
    return {
      start: (envVars) => this.start({ envVars, enableInternet: true }),
      request: (path, init) => this.containerFetch(`${CONTAINER_HOST}${path}`, init),
      stop: () => this.stop()
    };
  }

  jobContext(): Promise<{ ts_code: string; date: string } | null> {
    return this.runner.jobContext();
  }

  startJob(input: {
    ts_code: string;
    date: string;
    requested_by: string;
  }): Promise<AnalysisJob> {
    return this.runner.startJob(input);
  }

  status(): Promise<AnalysisJob> {
    return this.runner.status();
  }

  alarm(): Promise<void> {
    return this.runner.alarm();
  }
}

QuantAnalysisContainer.outboundByHost = {
  [ANALYSIS_OUTBOUND_HOST]: quantOutboundHandler
};

function summarizeResult(result: unknown): AnalysisResultSummary | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const brain = (r.brain ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    status: str(r.status),
    ts_code: str(r.ts_code),
    final_score: num(brain.final_score),
    target_price: num(brain.target_price),
    miner_chunks: num(r.miner_chunks)
  };
}

// ============================ outbound handler ============================

const MAX_BODY = 2 * 1024 * 1024;
const R2_MAX_BYTES = 1024 * 1024;
const VECTOR_DIM = 512;

function deny(kind: string, hash?: string): Response {
  console.info(
    JSON.stringify({
      event: "quant_analysis_outbound",
      action: "deny",
      kind,
      sha256: hash ?? null
    })
  );
  return Response.json({ success: false, error: "operation_not_allowed" }, { status: 403 });
}

function allow(kind: string, hash: string | null, body: unknown): Response {
  console.info(
    JSON.stringify({
      event: "quant_analysis_outbound",
      action: "allow",
      kind,
      sha256: hash
    })
  );
  return Response.json(body);
}

function normalizeSql(raw: string): string {
  let sql = raw.replace(/\s+/g, " ").trim();
  while (sql.endsWith(";")) sql = sql.slice(0, -1).trimEnd();
  return sql;
}

async function sha256Short(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

const READONLY_FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b/i;
const READONLY_FORBIDDEN_OBJECTS = /\b(sqlite_\w+|_cf_\w+|d1_\w+|pragma_\w+)\b/i;

function checkReadOnlyOutbound(sql: string): boolean {
  if (sql.length === 0 || sql.length > 4000) return false;
  if (sql.includes(";") || sql.includes("--") || sql.includes("/*")) return false;
  if (!/^(select|with)\b/i.test(sql)) return false;
  if (READONLY_FORBIDDEN.test(sql)) return false;
  if (READONLY_FORBIDDEN_OBJECTS.test(sql)) return false;
  return true;
}

const PRAGMA_SYNC_STATUS = "PRAGMA table_info(sync_status)";
const DDL_NOOP = [
  /^CREATE TABLE IF NOT EXISTS (chip_hunter|sync_status|institutional_surveys|ai_analysis_result) \(/,
  /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (idx_chip_ts_code|idx_chip_scan_date|idx_chip_code_scan_date) ON chip_hunter\(/,
  /^ALTER TABLE sync_status ADD COLUMN last_news_sync TEXT$/
];
const SYNC_UPSERT =
  /^INSERT INTO sync_status \(ts_code, (last_report_sync|last_news_sync)\) VALUES \(\?, \?\) ON CONFLICT\(ts_code\) DO UPDATE SET \1=excluded\.\1$/;
const AI_RESULT_INSERT =
  /^INSERT OR REPLACE INTO ai_analysis_result VALUES \(\?(?:,\?){23}\)$/;
const SURVEY_KEYS = ["ts_code", "survey_date", "org_count", "org_names", "reception_place"];

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

type OutboundEnv = {
  QUANT_DB: D1Database;
  ANALYSIS?: DurableObjectNamespace<QuantAnalysisContainer>;
  VECTORIZE?: VectorizeLike;
  R2_STOCK_INFOR?: R2Bucket;
};

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function resolveJob(
  env: OutboundEnv,
  containerId: string
): Promise<{ ts_code: string; date: string } | null> {
  if (!env.ANALYSIS || !containerId) return null;
  try {
    const stub = env.ANALYSIS.get(env.ANALYSIS.idFromString(containerId));
    return await stub.jobContext();
  } catch {
    return null;
  }
}

export async function quantOutboundHandler(
  request: Request,
  env: OutboundEnv,
  ctx: { containerId: string }
): Promise<Response> {
  const url = new URL(request.url);
  const job = await resolveJob(env, ctx.containerId);
  if (!job) return deny("no_job");
  if (request.method !== "POST") return deny("method");
  const path = url.pathname;
  switch (path) {
    case "/api/db/query":
      return handleDbQuery(request, env, job);
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
      return deny("path", await sha256Short(path));
  }
}

type Job = { ts_code: string; date: string };

async function handleDbQuery(
  request: Request,
  env: OutboundEnv,
  _job: Job
): Promise<Response> {
  const body = await readJsonBody(request);
  const sql = typeof body?.sql === "string" ? normalizeSql(body.sql) : null;
  if (!sql) return deny("db_query_sql");
  const params = Array.isArray(body?.params) ? body.params : [];
  const hash = await sha256Short(sql);
  if (sql === PRAGMA_SYNC_STATUS) {
    const { results } = await env.QUANT_DB.prepare(sql).all();
    return allow("db_query_pragma", hash, { success: true, results });
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
  env: OutboundEnv,
  job: Job
): Promise<Response> {
  const body = await readJsonBody(request);
  const sql = typeof body?.sql === "string" ? normalizeSql(body.sql) : null;
  if (!sql) return deny("db_execute_sql");
  const params = Array.isArray(body?.params) ? body.params : [];
  const hash = await sha256Short(sql);
  if (DDL_NOOP.some((re) => re.test(sql))) {
    return allow("db_execute_ddl_noop", hash, { success: true });
  }
  const syncMatch = SYNC_UPSERT.exec(sql);
  if (syncMatch) {
    if (params.length !== 2 || params[0] !== job.ts_code) {
      return deny("db_execute_sync_params", hash);
    }
    await env.QUANT_DB.prepare(sql).bind(...params).run();
    return allow("db_execute_sync", hash, { success: true });
  }
  if (AI_RESULT_INSERT.test(sql)) {
    if (params.length !== 24 || params[0] !== job.date || params[2] !== job.ts_code) {
      return deny("db_execute_ai_params", hash);
    }
    await env.QUANT_DB.prepare(sql).bind(...params).run();
    return allow("db_execute_ai", hash, { success: true });
  }
  return deny("db_execute_sql", hash);
}

async function handleDbSave(
  request: Request,
  env: OutboundEnv,
  job: Job
): Promise<Response> {
  const body = await readJsonBody(request);
  const hash = await sha256Short(`save:${String(body?.table)}`);
  if (body?.table !== "institutional_surveys") return deny("db_save_table", hash);
  const data = body.data;
  if (!Array.isArray(data) || data.length > 500) return deny("db_save_rows", hash);
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return deny("db_save_row", hash);
    const keys = Object.keys(row as Record<string, unknown>).sort();
    if (keys.length !== SURVEY_KEYS.length || !SURVEY_KEYS.every((k) => keys.includes(k))) {
      return deny("db_save_keys", hash);
    }
    if ((row as Record<string, unknown>).ts_code !== job.ts_code) {
      return deny("db_save_ts_code", hash);
    }
  }
  const statements = (data as Record<string, unknown>[]).map((row) =>
    env.QUANT_DB.prepare(
      "INSERT OR IGNORE INTO institutional_surveys (ts_code, survey_date, org_count, org_names, reception_place) VALUES (?, ?, ?, ?, ?)"
    ).bind(
      row.ts_code as string,
      row.survey_date as string,
      row.org_count as number,
      row.org_names as string,
      row.reception_place as string
    )
  );
  if (statements.length > 0) await env.QUANT_DB.batch(statements);
  return allow("db_save", hash, { success: true, count: data.length });
}

function validVector(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === VECTOR_DIM &&
    (v as unknown[]).every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

async function handleVectorCheck(
  request: Request,
  env: OutboundEnv,
  job: Job
): Promise<Response> {
  const body = await readJsonBody(request);
  const id = body?.id;
  const hash = await sha256Short(`vector_check`);
  if (typeof id !== "string" || id.length > 64 || !id.startsWith(`${job.ts_code}_`)) {
    return deny("vector_check_id", hash);
  }
  if (!env.VECTORIZE?.getByIds) return deny("vector_unavailable", hash);
  const found = await env.VECTORIZE.getByIds([id]);
  return allow("vector_check", hash, { success: true, exists: Array.isArray(found) && found.length > 0 });
}

async function handleVectorUpsert(
  request: Request,
  env: OutboundEnv,
  job: Job
): Promise<Response> {
  const body = await readJsonBody(request);
  const hash = await sha256Short("vector_upsert");
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
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const meta = metadatas[i];
    if (
      typeof id !== "string" ||
      id.length > 64 ||
      !id.startsWith(`${job.ts_code}_`) ||
      !validVector(embeddings[i]) ||
      !meta ||
      typeof meta !== "object" ||
      (meta as Record<string, unknown>).ts_code !== job.ts_code
    ) {
      return deny("vector_upsert_item", hash);
    }
  }
  if (!env.VECTORIZE) return deny("vector_unavailable", hash);
  await env.VECTORIZE.upsert(
    ids.map((id, i) => ({
      id: id as string,
      values: embeddings[i] as number[],
      metadata: metadatas[i] as Record<string, unknown>,
      namespace: job.ts_code
    }))
  );
  return allow("vector_upsert", hash, { success: true, count: ids.length });
}

async function handleVectorQuery(
  request: Request,
  env: OutboundEnv,
  job: Job
): Promise<Response> {
  const body = await readJsonBody(request);
  const hash = await sha256Short("vector_query");
  const filter = body?.filter as Record<string, unknown> | undefined;
  const tsFilter = filter?.ts_code as Record<string, unknown> | undefined;
  const topK = body?.topK;
  if (
    !validVector(body?.vector) ||
    tsFilter?.$eq !== job.ts_code ||
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
    namespace: job.ts_code
  });
  return allow("vector_query", hash, { success: true, results });
}

async function handleR2Upload(
  request: Request,
  env: OutboundEnv,
  job: Job
): Promise<Response> {
  const hash = await sha256Short("r2_upload");
  const escaped = job.ts_code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyRe = new RegExp(`^prompt_logs/\\d{8}_\\d{6}_${escaped}_[^/]{1,40}_data\\.txt$`);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return deny("r2_form", hash);
  }
  const key = form.get("key");
  const file = form.get("file");
  if (typeof key !== "string" || !keyRe.test(key)) return deny("r2_key", hash);
  if (!(file instanceof File)) return deny("r2_file", hash);
  if (file.size > R2_MAX_BYTES) return deny("r2_size", hash);
  if (!env.R2_STOCK_INFOR) return deny("r2_unavailable", hash);
  await env.R2_STOCK_INFOR.put(key, file.stream());
  return allow("r2_upload", hash, { success: true, key });
}
