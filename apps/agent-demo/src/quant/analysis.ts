import { Container } from "@cloudflare/containers";
import { QUANT_QUERIES } from "./catalog.js";
import {
  AI_OUTBOUND_HOST,
  aiChatOutboundHandler,
  checkReadOnlyOutbound,
  normalizeSql,
  outboundAllow,
  outboundDeny,
  readJsonBody,
  sha256Short,
  validVector,
  type AiRunLike
} from "../shared/outbound.js";

export interface AnalysisEnv {
  QUANT_DB: D1Database;
  ANALYSIS?: DurableObjectNamespace<QuantAnalysisContainer>;
  VECTORIZE?: Vectorize;
  R2_STOCK_INFOR?: R2Bucket;
  AI?: Ai;
  MY_TUSHARE_TOKEN?: string;
  DASHSCOPE_API_KEY?: string;
  CF_AIG_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  AI_ENGINE?: string;
  BRAIN_AI_MODEL?: string;
  AUDITOR_AI_MODEL?: string;
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

export interface AnalysisTimelineEntry {
  phase: string;
  started_at: string;
  ended_at: string | null;
  duration_s: number;
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
  timeline: AnalysisTimelineEntry[] | null;
}

export const ANALYSIS_PHASE_LABELS: Record<string, string> = {
  start: "引擎初始化",
  chip: "数据与筹码计算",
  knowledge: "知识库挖掘（研报/公告/调研）",
  ai: "AI 诊断",
  done: "完成"
};

export interface AnalysisTimelineViewEntry {
  phase: string;
  label: string;
  started_at_bj: string;
  duration_s: number;
}

const BEIJING_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

export function analysisTimelineView(
  job: Pick<AnalysisJob, "timeline">
): { timeline: AnalysisTimelineViewEntry[]; total_s: number } | null {
  if (!job.timeline || job.timeline.length === 0) return null;
  const timeline = job.timeline.map((e) => ({
    phase: e.phase,
    label: ANALYSIS_PHASE_LABELS[e.phase] ?? e.phase,
    started_at_bj: BEIJING_TIME.format(new Date(e.started_at)),
    duration_s: e.duration_s
  }));
  const first = Date.parse(job.timeline[0].started_at);
  const last = job.timeline[job.timeline.length - 1];
  const end = last.ended_at ? Date.parse(last.ended_at) : Date.now();
  const total_s =
    Number.isFinite(first) && Number.isFinite(end)
      ? Math.max(0, Math.round((end - first) / 1000))
      : 0;
  return { timeline, total_s };
}

export interface AnalysisJobView extends AnalysisJob {
  job_id: string;
}

const JOB_TIMEOUT_MS = 20 * 60 * 1000;
const JOB_TIMEOUT_SECONDS = JOB_TIMEOUT_MS / 1000;
// A terminal job's DO storage is wiped 24 h later (the job id contains the
// date, so next day's run gets a fresh DO anyway); a re-run disarms it.
export const CLEANUP_AFTER_SECONDS = 24 * 60 * 60;
const CLEANUP_TOKEN_KEY = "cleanup_token";
const TERMINAL_STATUSES = new Set<AnalysisJobStatus>(["succeeded", "failed", "timeout"]);
const CONTAINER_HOST = "http://container";

export interface CleanupHooks {
  schedule(token: string): Promise<void> | void;
  wipe(): Promise<void>;
}

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
    private readonly jobId: () => string,
    private readonly scheduleTimeout: (seconds: number) => void | Promise<void>,
    private readonly cleanup: CleanupHooks
  ) {}

  private async armCleanup(): Promise<void> {
    const token = crypto.randomUUID();
    await this.storage.put(CLEANUP_TOKEN_KEY, token);
    await this.cleanup.schedule(token);
  }

  async runCleanup(payload: unknown): Promise<void> {
    const token =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).token
        : payload;
    if (!token || token !== (await this.storage.get(CLEANUP_TOKEN_KEY))) return;
    const job = await this.loadJob();
    if (!job || !TERMINAL_STATUSES.has(job.status)) return;
    await this.cleanup.wipe();
  }

  private containerEnvVars(): Record<string, string> {
    const env = this.env;
    const vars: Record<string, string> = {
      D1_API_URL: `http://${ANALYSIS_OUTBOUND_HOST}`,
      AI_BASE_URL: `http://${AI_OUTBOUND_HOST}/v1`,
      AI_API_KEY: "unused",
      CF_ACCESS_CLIENT_ID: "unused",
      CF_ACCESS_CLIENT_SECRET: "unused"
    };
    if (env.MY_TUSHARE_TOKEN) vars.MY_TUSHARE_TOKEN = env.MY_TUSHARE_TOKEN;
    if (env.DASHSCOPE_API_KEY) vars.DASHSCOPE_API_KEY = env.DASHSCOPE_API_KEY;
    if (env.CF_AIG_TOKEN) vars.CF_AIG_TOKEN = env.CF_AIG_TOKEN;
    if (env.CF_ACCOUNT_ID) vars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;
    if (env.AI_ENGINE) vars.AI_ENGINE = env.AI_ENGINE;
    if (env.BRAIN_AI_MODEL) vars.BRAIN_AI_MODEL = env.BRAIN_AI_MODEL;
    if (env.AUDITOR_AI_MODEL) vars.AUDITOR_AI_MODEL = env.AUDITOR_AI_MODEL;
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
    // restart=true is used when D1 has no report for today even though the DO
    // still holds a stale "succeeded" job: re-run instead of replaying it.
    restart?: boolean;
  }): Promise<AnalysisJob> {
    const existing = await this.loadJob();
    if (
      existing &&
      (existing.status === "queued" ||
        existing.status === "running" ||
        (!input.restart && existing.status === "succeeded"))
    ) {
      return existing;
    }
    // A re-run must disarm any cleanup scheduled by the previous terminal job.
    await this.storage.delete(CLEANUP_TOKEN_KEY);
    const job: AnalysisJob = {
      ts_code: input.ts_code,
      date: input.date,
      requested_by: input.requested_by,
      status: "running",
      phase: "queued",
      started_at: new Date().toISOString(),
      finished_at: null,
      result_summary: null,
      error: null,
      timeline: null
    };
    await this.saveJob(job);
    await this.scheduleTimeout(JOB_TIMEOUT_SECONDS);
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
      await this.armCleanup();
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
        error: null,
        timeline: null
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
      timeline?: unknown;
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
    if (Array.isArray(snap.timeline)) {
      const tl: AnalysisTimelineEntry[] = [];
      for (const e of snap.timeline) {
        if (!e || typeof e !== "object") continue;
        const o = e as Record<string, unknown>;
        if (typeof o.phase !== "string" || typeof o.started_at !== "string") continue;
        tl.push({
          phase: o.phase,
          started_at: o.started_at,
          ended_at: typeof o.ended_at === "string" ? o.ended_at : null,
          duration_s:
            typeof o.duration_s === "number" && Number.isFinite(o.duration_s)
              ? o.duration_s
              : 0
        });
      }
      if (tl.length > 0) job.timeline = tl;
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
    if (job.status === "succeeded" || job.status === "failed") {
      await this.armCleanup();
    }
  }

  async onTimeout(): Promise<void> {
    const job = await this.loadJob();
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    // Ignore early/unrelated ticks: the timeout only applies once the job has
    // actually been alive for the full timeout window.
    if (Date.now() - Date.parse(job.started_at) < JOB_TIMEOUT_MS) return;
    job.status = "timeout";
    job.finished_at = new Date().toISOString();
    job.error = "analysis_timeout";
    await this.saveJob(job);
    await this.armCleanup();
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
    () => this.ctx.id.name ?? "",
    (seconds) => this.schedule(seconds, "onJobTimeout").then(() => undefined),
    {
      schedule: (token) =>
        this.schedule(CLEANUP_AFTER_SECONDS, "onJobCleanup", { token }).then(() => undefined),
      wipe: () =>
        this.ctx.storage.deleteAll().then(() => this.ctx.storage.deleteAlarm())
    }
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
    restart?: boolean;
  }): Promise<AnalysisJob> {
    return this.runner.startJob(input);
  }

  status(): Promise<AnalysisJob> {
    return this.runner.status();
  }

  async onJobTimeout(): Promise<void> {
    await this.runner.onTimeout();
  }

  async onJobCleanup(payload: unknown): Promise<void> {
    await this.runner.runCleanup(payload);
  }
}

QuantAnalysisContainer.outboundByHost = {
  [ANALYSIS_OUTBOUND_HOST]: quantOutboundHandler,
  [AI_OUTBOUND_HOST]: analysisAiOutboundHandler
};

// ai.internal handler: any job on this container may call Workers AI
// (validated model + whitelisted fields inside the shared handler).
export async function analysisAiOutboundHandler(
  request: Request,
  env: OutboundEnv & { AI?: AiRunLike },
  ctx: { containerId: string }
): Promise<Response> {
  const job = await resolveJob(env, ctx.containerId);
  if (!job) return deny("no_job");
  return aiChatOutboundHandler(
    request,
    env.AI,
    { source: "analysis", ts_code: job.ts_code },
    OUTBOUND_EVENT
  );
}

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

const R2_MAX_BYTES = 1024 * 1024;

const OUTBOUND_EVENT = "quant_analysis_outbound";

function deny(kind: string, hash?: string): Response {
  return outboundDeny(OUTBOUND_EVENT, kind, hash);
}

function allow(kind: string, hash: string | null, body: unknown): Response {
  return outboundAllow(OUTBOUND_EVENT, kind, hash, body);
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
