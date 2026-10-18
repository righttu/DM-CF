import { getContainer } from "@cloudflare/containers";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  COMPACT_DATE_PATTERN,
  QUANT_PARAM_DESCRIPTIONS,
  DASHED_DATE_PATTERN,
  DATA_DICTIONARY,
  QUERY_LIMITS,
  QUANT_QUERIES,
  QUANT_TABLES,
  QUANT_TOOL_DESCRIPTIONS,
  RESEARCH_DOC,
  SOURCE_TYPES,
  STRATEGIES,
  TS_CODE_PATTERN
} from "./catalog.js";
import type { McpPrincipal, ToolCall, ToolTextResult } from "../shared/mcp-kit.js";
import {
  ANALYSIS_JOB_ID_PATTERN,
  QuantAnalysisContainer,
  analysisTimelineView,
  shanghaiCompactDate
} from "./analysis.js";

export interface QuantToolsEnv {
  QUANT_DB: D1Database;
  VECTORIZE?: Vectorize;
  EMBEDDING?: DurableObjectNamespace;
  ANALYSIS?: DurableObjectNamespace<QuantAnalysisContainer>;
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorMatch {
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorIndexLike {
  query(
    vector: number[],
    options: { topK: number; returnMetadata: "all"; namespace?: string }
  ): Promise<{ matches: VectorMatch[] }>;
}

let injectedSearch: { embedder: Embedder; index: VectorIndexLike } | undefined;

export function __setEmbeddingForTests(
  embedder?: Embedder,
  index?: VectorIndexLike
): void {
  injectedSearch = embedder && index ? { embedder, index } : undefined;
}

const EMBEDDING_INSTANCE = "embedding-1";
const EMBEDDING_DIM = 512;
const EMBEDDING_TIMEOUT_MS = 30_000;
const MAX_JSON_CHARS = 60_000;

function containerEmbedder(ns: DurableObjectNamespace): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const instance = getContainer(
        ns as DurableObjectNamespace<import("@cloudflare/containers").Container>,
        EMBEDDING_INSTANCE
      );
      const resp = await instance.fetch("http://container/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS)
      });
      if (!resp.ok) throw new Error(`embed_http_${resp.status}`);
      const data = (await resp.json()) as { vectors?: unknown };
      const vectors = data.vectors;
      if (
        !Array.isArray(vectors) ||
        vectors.length !== texts.length ||
        !vectors.every(
          (v) =>
            Array.isArray(v) &&
            v.length === EMBEDDING_DIM &&
            (v as unknown[]).every((n) => typeof n === "number" && Number.isFinite(n))
        )
      ) {
        throw new Error("embed_invalid_response");
      }
      return vectors as number[][];
    }
  };
}

function resolveSearch(env: QuantToolsEnv): { embedder: Embedder; index: VectorIndexLike } | null {
  if (injectedSearch) return injectedSearch;
  if (!env.EMBEDDING || !env.VECTORIZE) return null;
  return {
    embedder: containerEmbedder(env.EMBEDDING),
    index: env.VECTORIZE as unknown as VectorIndexLike
  };
}

type Row = Record<string, unknown>;

const text = (value: unknown): ToolTextResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }]
});

const toolError = (body: Record<string, unknown>): ToolTextResult => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify(body) }]
});

function invalidArguments(error: z.ZodError): ToolTextResult {
  const message = error.issues
    .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    .join("; ")
    .slice(0, 300);
  return toolError({ error: "invalid_arguments", message });
}

function truncateCell(value: unknown, exempt: boolean): unknown {
  if (exempt || typeof value !== "string") return value;
  return value.length > QUERY_LIMITS.maxCellChars
    ? value.slice(0, QUERY_LIMITS.maxCellChars)
    : value;
}

async function rows(
  env: QuantToolsEnv,
  sql: string,
  binds: unknown[],
  exemptColumns: ReadonlySet<string> = new Set()
): Promise<Row[]> {
  const { results } = await env.QUANT_DB.prepare(sql).bind(...binds).all<Row>();
  return (results as Row[]).map((row) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = truncateCell(v, exemptColumns.has(k));
    }
    return out;
  });
}

async function firstRow(
  env: QuantToolsEnv,
  sql: string,
  binds: unknown[]
): Promise<Row | null> {
  const result = await env.QUANT_DB.prepare(sql).bind(...binds).first<Row>();
  return (result as Row | null) ?? null;
}

function capPayload<T extends Record<string, unknown>>(
  payload: T,
  rowGroups: { rows: Row[] }[]
): T {
  const out = payload as T & { truncated?: boolean };
  while (JSON.stringify(out).length > MAX_JSON_CHARS) {
    const biggest = rowGroups.reduce((a, b) => (a.rows.length >= b.rows.length ? a : b));
    if (biggest.rows.length === 0) break;
    biggest.rows.pop();
    out.truncated = true;
  }
  return out;
}

const likeEscape = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

async function stockName(
  env: QuantToolsEnv,
  tsCode: string
): Promise<{ name?: string; industry?: string }> {
  const row = await firstRow(env, QUANT_QUERIES.stockName, [tsCode]);
  return {
    name: typeof row?.name === "string" ? row.name : undefined,
    industry: typeof row?.industry === "string" ? row.industry : undefined
  };
}

const tsCode = z.string().regex(TS_CODE_PATTERN);
const compactDate = z.string().regex(COMPACT_DATE_PATTERN);
const dashedDate = z.string().regex(DASHED_DATE_PATTERN);
const intRange = (min: number, max: number, def: number) =>
  z.number().int().min(min).max(max).default(def);

const schemas = {
  describe_data: z.object({
    table: z.enum([...QUANT_TABLES, "research"]).optional()
  }),
  find_stock: z.object({
    query: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().min(1).max(20))
  }),
  get_signals: z.object({
    ts_code: tsCode.optional(),
    strategy: z.enum([...STRATEGIES, "all"]).default("all"),
    scan_date: compactDate.optional(),
    limit: intRange(1, 50, 20)
  }),
  get_fundamentals: z.object({
    ts_code: tsCode,
    periods: intRange(1, 20, 8)
  }),
  get_ai_report: z.object({
    ts_code: tsCode.optional(),
    history: z.boolean().default(false),
    report_date: compactDate.optional(),
    limit: intRange(1, 30, 10)
  }),
  search_research: z.object({
    ts_code: tsCode,
    query: z
      .string()
      .max(200)
      .default("业绩 风险 增长 竞争格局 产能 订单 护城河"),
    since: dashedDate.optional(),
    source_type: z.enum(SOURCE_TYPES).optional(),
    top_k: intRange(1, 50, 20)
  }),
  get_surveys: z.object({
    ts_code: tsCode,
    limit: intRange(1, 50, 20)
  }),
  get_industry_chain: z.object({
    ts_code: tsCode.optional(),
    sector: z.string().min(1).max(20).optional(),
    limit: intRange(1, 50, 30)
  }),
  query_data: z.object({
    sql: z.string(),
    max_rows: intRange(1, 200, 50)
  }),
  run_analysis: z.object({
    ts_code: tsCode
  }),
  get_analysis_status: z.object({
    job_id: z.string().regex(ANALYSIS_JOB_ID_PATTERN).optional(),
    ts_code: tsCode.optional()
  })
} as const;

function parseArgs<K extends keyof typeof schemas>(
  name: K,
  args: unknown
): { ok: true; data: z.infer<(typeof schemas)[K]> } | { ok: false; result: ToolTextResult } {
  const parsed = schemas[name].safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, result: invalidArguments(parsed.error) };
  }
  return { ok: true, data: parsed.data as z.infer<(typeof schemas)[K]> };
}

const FORBIDDEN_SQL =
  /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b/i;
const FORBIDDEN_OBJECTS = /\b(sqlite_\w+|_cf_\w+|d1_\w+|pragma_\w+)\b/i;

function checkReadOnlySql(raw: string): { ok: true; sql: string } | { ok: false; reason: string } {
  let sql = raw.trim();
  for (;;) {
    const stripped = sql.replace(/[\s;]+$/, "");
    if (stripped === sql) break;
    sql = stripped.trimEnd();
  }
  if (sql.length === 0) return { ok: false, reason: "empty" };
  if (sql.length > QUERY_LIMITS.maxSqlLength) return { ok: false, reason: "too_long" };
  if (sql.includes(";") || sql.includes("--") || sql.includes("/*")) {
    return { ok: false, reason: "multiple_statements_or_comments" };
  }
  if (!/^(select|with)\b/i.test(sql)) return { ok: false, reason: "not_select" };
  if (FORBIDDEN_SQL.test(sql)) return { ok: false, reason: "forbidden_keyword" };
  if (FORBIDDEN_OBJECTS.test(sql)) return { ok: false, reason: "forbidden_object" };
  return { ok: true, sql };
}

const D = QUANT_PARAM_DESCRIPTIONS;
const optInt = (min: number, max: number, def: number, desc: string) =>
  z.number().int().min(min).max(max).default(def).describe(desc);

export function registerQuantTools(
  server: McpServer,
  ctx: { env: QuantToolsEnv; call: ToolCall; principal: McpPrincipal }
): void {
  const { env, call, principal } = ctx;

  server.registerTool(
    "describe_data",
    {
      description: QUANT_TOOL_DESCRIPTIONS.describe_data,
      inputSchema: z.object({ table: z.enum([...QUANT_TABLES, "research"]).optional().describe(D.table) })
    },
    async (args, callCtx) =>
      call("describe_data", callCtx, async () => {
        const p = parseArgs("describe_data", args);
        if (!p.ok) return p.result;
        if (!p.data.table) {
          return text({ tables: DATA_DICTIONARY, research: RESEARCH_DOC });
        }
        if (p.data.table === "research") {
          return text({ table: "research", doc: RESEARCH_DOC });
        }
        return text({ table: p.data.table, doc: DATA_DICTIONARY[p.data.table] });
      })
  );

  server.registerTool(
    "find_stock",
    {
      description: QUANT_TOOL_DESCRIPTIONS.find_stock,
      inputSchema: z.object({ query: z.string().describe(D.find_query) })
    },
    async (args, callCtx) =>
      call("find_stock", callCtx, async () => {
        const p = parseArgs("find_stock", args);
        if (!p.ok) return p.result;
        const q = p.data.query;
        const found = await rows(env, QUANT_QUERIES.findStock, [
          q.toUpperCase(),
          q,
          `%${likeEscape(q)}%`,
          q
        ]);
        return text(capPayload({ query: q, results: found }, [{ rows: found }]));
      })
  );

  server.registerTool(
    "get_signals",
    {
      description: QUANT_TOOL_DESCRIPTIONS.get_signals,
      inputSchema: z.object({
        ts_code: z.string().optional().describe(D.ts_code),
        strategy: z.enum([...STRATEGIES, "all"]).default("all").describe(D.strategy),
        scan_date: z.string().optional().describe(D.scan_date),
        limit: optInt(1, 50, 20, D.limit)
      })
    },
    async (args, callCtx) =>
      call("get_signals", callCtx, async () => {
        const p = parseArgs("get_signals", args);
        if (!p.ok) return p.result;
        const { ts_code, strategy, scan_date, limit } = p.data;
        const wanted = strategy === "all" ? STRATEGIES : [strategy];
        const results: Record<string, { rows: Row[] }> = {};
        const groups: { rows: Row[] }[] = [];
        for (const name of wanted) {
          const queries = QUANT_QUERIES.signals[name];
          const binds = ts_code ? [ts_code, limit] : [scan_date ?? null, limit];
          const sql = ts_code ? queries.byStock : queries.latest;
          const exempt = name === "alpha"
            ? new Set(["main_business"])
            : name === "hotspot"
              ? new Set(["tags"])
              : new Set<string>();
          const group = { rows: await rows(env, sql, binds, exempt) };
          results[name] = group;
          groups.push(group);
        }
        const payload: Record<string, unknown> = { results };
        if (ts_code) {
          payload.ts_code = ts_code;
          const { name } = await stockName(env, ts_code);
          if (name) payload.name = name;
        }
        payload.note = ts_code
          ? "返回该股票被各量化策略选中的记录；各 Hunter 表目前只保留最近一次扫描"
          : "返回最近一次（或 scan_date 指定日期）扫描命中的股票，按策略评分排序";
        return text(capPayload(payload, groups));
      })
  );

  server.registerTool(
    "get_fundamentals",
    {
      description: QUANT_TOOL_DESCRIPTIONS.get_fundamentals,
      inputSchema: z.object({
        ts_code: z.string().describe(D.ts_code),
        periods: optInt(1, 20, 8, D.periods)
      })
    },
    async (args, callCtx) =>
      call("get_fundamentals", callCtx, async () => {
        const p = parseArgs("get_fundamentals", args);
        if (!p.ok) return p.result;
        const { ts_code, periods } = p.data;
        const [{ name, industry }, periodRows] = await Promise.all([
          stockName(env, ts_code),
          rows(env, QUANT_QUERIES.fundamentals, [ts_code, periods])
        ]);
        return text(
          capPayload(
            {
              ts_code,
              name: name ?? null,
              industry: industry ?? null,
              periods: periodRows,
              unit_note:
                "金额为年初至报告期末累计值，单位元；total_mv 单位万元；百分比字段单位 %"
            },
            [{ rows: periodRows }]
          )
        );
      })
  );

  server.registerTool(
    "get_ai_report",
    {
      description: QUANT_TOOL_DESCRIPTIONS.get_ai_report,
      inputSchema: z.object({
        ts_code: z.string().optional().describe(D.ts_code),
        history: z.boolean().default(false).describe(D.history),
        report_date: z.string().optional().describe(D.report_date),
        limit: optInt(1, 30, 10, D.limit)
      })
    },
    async (args, callCtx) =>
      call("get_ai_report", callCtx, async () => {
        const p = parseArgs("get_ai_report", args);
        if (!p.ok) return p.result;
        const { ts_code, history, report_date, limit } = p.data;
        if (ts_code && !history) {
          const report = (
            await rows(env, QUANT_QUERIES.aiReportLatest, [ts_code], new Set(["ai_report"]))
          )[0] ?? null;
          const payload: Record<string, unknown> = { ts_code, report };
          const full = typeof report?.ai_report_length === "number" ? report.ai_report_length : 0;
          if (report && full > QUERY_LIMITS.maxReportChars) {
            payload.note = `ai_report 已截断为前 ${QUERY_LIMITS.maxReportChars} 字符（原文 ${full} 字符）`;
          }
          return text(payload);
        }
        if (ts_code) {
          const list = await rows(env, QUANT_QUERIES.aiReportHistory, [ts_code, limit]);
          return text(capPayload({ ts_code, reports: list }, [{ rows: list }]));
        }
        const list = await rows(env, QUANT_QUERIES.aiReportList, [
          report_date ?? null,
          limit
        ]);
        return text(capPayload({ reports: list }, [{ rows: list }]));
      })
  );

  server.registerTool(
    "search_research",
    {
      description: QUANT_TOOL_DESCRIPTIONS.search_research,
      inputSchema: z.object({
        ts_code: z.string().describe(D.ts_code),
        query: z.string().max(200).default("业绩 风险 增长 竞争格局 产能 订单 护城河").describe(D.research_query),
        since: z.string().optional().describe(D.since),
        source_type: z.enum(SOURCE_TYPES).optional().describe(D.source_type),
        top_k: optInt(1, 50, 20, D.top_k)
      })
    },
    async (args, callCtx) =>
      call("search_research", callCtx, async () => {
        const p = parseArgs("search_research", args);
        if (!p.ok) return p.result;
        const { ts_code, query, since, source_type, top_k } = p.data;
        const { name } = await stockName(env, ts_code);
        const search = resolveSearch(env);
        if (!search) {
          return toolError({ error: "embedding_unavailable" });
        }
        let vectors: number[][];
        try {
          vectors = await search.embedder.embed([`${name ?? ""} ${query}`]);
        } catch {
          return toolError({ error: "embedding_unavailable" });
        }
        const vec = vectors[0];
        if (!Array.isArray(vec) || vec.length === 0) {
          return toolError({ error: "embedding_unavailable" });
        }
        const raw = await search.index.query(vec, {
          topK: since || source_type ? QUERY_LIMITS.maxResearchTopK : top_k,
          returnMetadata: "all",
          namespace: ts_code
        });
        const coverage = await firstRow(env, QUANT_QUERIES.researchCoverage, [ts_code]);
        const matches = (raw.matches ?? [])
          .filter((m) => {
            const md = m.metadata ?? {};
            if (since && String(md.publish_date ?? "") < since) return false;
            if (source_type && md.source_type !== source_type) return false;
            return true;
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, top_k);
        if (matches.length === 0) {
          return text({
            ts_code,
            documents: [],
            coverage: coverage ?? null,
            note: "知识库中没有匹配的文档；知识库只覆盖已抓取的股票"
          });
        }
        const docs = new Map<
          string,
          {
            title: string;
            publish_date: string;
            source_type: string;
            org: string;
            score: number;
            excerpts: string[];
          }
        >();
        let usedChars = 0;
        for (const m of matches) {
          const md = m.metadata ?? {};
          const title = String(md.title ?? "");
          const publishDate = String(md.publish_date ?? "");
          const chunk = typeof md.chunk_text === "string" ? md.chunk_text : "";
          const key = `${title}|${publishDate}`;
          let doc = docs.get(key);
          if (!doc) {
            doc = {
              title,
              publish_date: publishDate,
              source_type: String(md.source_type ?? ""),
              org: String(md.org ?? ""),
              score: m.score,
              excerpts: []
            };
            docs.set(key, doc);
          }
          if (m.score > doc.score) doc.score = m.score;
          if (
            chunk &&
            !doc.excerpts.includes(chunk) &&
            usedChars + chunk.length <= QUERY_LIMITS.maxResearchChars
          ) {
            doc.excerpts.push(chunk);
            usedChars += chunk.length;
          }
        }
        const documents = [...docs.values()]
          .filter((d) => d.excerpts.length > 0)
          .sort((a, b) => b.publish_date.localeCompare(a.publish_date));
        return text({ ts_code, name: name ?? null, documents, coverage: coverage ?? null });
      })
  );

  server.registerTool(
    "get_surveys",
    {
      description: QUANT_TOOL_DESCRIPTIONS.get_surveys,
      inputSchema: z.object({
        ts_code: z.string().describe(D.ts_code),
        limit: optInt(1, 50, 20, D.limit)
      })
    },
    async (args, callCtx) =>
      call("get_surveys", callCtx, async () => {
        const p = parseArgs("get_surveys", args);
        if (!p.ok) return p.result;
        const surveys = await rows(env, QUANT_QUERIES.surveys, [
          p.data.ts_code,
          p.data.limit
        ]);
        return text(capPayload({ ts_code: p.data.ts_code, surveys }, [{ rows: surveys }]));
      })
  );

  server.registerTool(
    "get_industry_chain",
    {
      description: QUANT_TOOL_DESCRIPTIONS.get_industry_chain,
      inputSchema: z.object({
        ts_code: z.string().optional().describe(D.ts_code),
        sector: z.string().min(1).max(20).optional().describe(D.sector),
        limit: optInt(1, 50, 30, D.limit)
      })
    },
    async (args, callCtx) =>
      call("get_industry_chain", callCtx, async () => {
        const p = parseArgs("get_industry_chain", args);
        if (!p.ok) return p.result;
        const { ts_code, sector, limit } = p.data;
        if ((ts_code === undefined) === (sector === undefined)) {
          return toolError({
            error: "invalid_arguments",
            message: "必须且只能提供 ts_code 或 sector 之一"
          });
        }
        if (ts_code) {
          const list = await rows(
            env,
            QUANT_QUERIES.chainByStock,
            [ts_code, limit],
            new Set(["remark", "ts_main_biz"])
          );
          return text(capPayload({ ts_code, rows: list }, [{ rows: list }]));
        }
        const list = await rows(
          env,
          QUANT_QUERIES.chainBySector,
          [`%${likeEscape(sector!)}%`, limit],
          new Set(["remark"])
        );
        return text(capPayload({ sector, rows: list }, [{ rows: list }]));
      })
  );

  server.registerTool(
    "query_data",
    {
      description: QUANT_TOOL_DESCRIPTIONS.query_data,
      inputSchema: z.object({
        sql: z.string().describe(D.sql),
        max_rows: optInt(1, 200, 50, D.max_rows)
      })
    },
    async (args, callCtx) =>
      call("query_data", callCtx, async () => {
        const p = parseArgs("query_data", args);
        if (!p.ok) return p.result;
        const guard = checkReadOnlySql(p.data.sql);
        if (!guard.ok) {
          return toolError({ error: "sql_rejected", reason: guard.reason });
        }
        const maxRows = p.data.max_rows;
        let resultRows: Row[];
        try {
          resultRows = await rows(env, `SELECT * FROM (${guard.sql}) LIMIT ?1`, [maxRows + 1]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return toolError({ error: "sql_error", message: message.slice(0, 300) });
        }
        const truncated = resultRows.length > maxRows;
        const limited = resultRows.slice(0, maxRows);
        const columns = limited.length > 0 ? Object.keys(limited[0]) : [];
        return text(
          capPayload(
            { columns, rows: limited, row_count: limited.length, truncated },
            [{ rows: limited }]
          )
        );
      })
  );

  server.registerTool(
    "run_analysis",
    {
      description: QUANT_TOOL_DESCRIPTIONS.run_analysis,
      inputSchema: z.object({
        ts_code: z.string().describe(D.ts_code)
      })
    },
    async (args, callCtx) =>
      call("run_analysis", callCtx, async () => {
        const p = parseArgs("run_analysis", args);
        if (!p.ok) return p.result;
        const ts_code = p.data.ts_code;
        const today = shanghaiCompactDate();
        const jobId = `${ts_code}:${today}`;
        const existing = await firstRow(env, QUANT_QUERIES.aiReportToday, [ts_code, today]);
        if (existing) {
          return text({ status: "exists", job_id: jobId, report: existing });
        }
        if (!env.ANALYSIS) {
          return toolError({ error: "analysis_unavailable" });
        }
        const stub = getContainer(env.ANALYSIS, jobId);
        try {
          const view = await stub.startJob({
            ts_code,
            date: today,
            requested_by: principal.actorId,
            // D1 is the source of truth for "already diagnosed today": no row
            // means a stale succeeded DO job must re-run, not replay.
            restart: true
          });
          const tl = analysisTimelineView(view);
          return text({
            status: view.status,
            job_id: jobId,
            phase: view.phase ?? null,
            timeline: tl?.timeline,
            total_s: tl?.total_s
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/capacity|instances|busy|rate.?limit/i.test(message)) {
            return text({
              status: "busy",
              job_id: jobId,
              message: "诊断任务容量已满，请稍后重试"
            });
          }
          return toolError({
            error: "analysis_start_failed",
            message: message.slice(0, 200)
          });
        }
      })
  );

  server.registerTool(
    "get_analysis_status",
    {
      description: QUANT_TOOL_DESCRIPTIONS.get_analysis_status,
      inputSchema: z.object({
        job_id: z.string().optional().describe(D.job_id),
        ts_code: z.string().optional().describe(D.ts_code)
      })
    },
    async (args, callCtx) =>
      call("get_analysis_status", callCtx, async () => {
        const p = parseArgs("get_analysis_status", args);
        if (!p.ok) return p.result;
        const { job_id, ts_code } = p.data;
        if ((job_id === undefined) === (ts_code === undefined)) {
          return toolError({
            error: "invalid_arguments",
            message: "必须且只能提供 job_id 或 ts_code 之一"
          });
        }
        const jobId = job_id ?? `${ts_code}:${shanghaiCompactDate()}`;
        if (!env.ANALYSIS) {
          return toolError({ error: "analysis_unavailable" });
        }
        const stub = getContainer(env.ANALYSIS, jobId);
        const view = await stub.status();
        const elapsed =
          view.started_at && view.status !== "not_found"
            ? Math.max(0, Math.round((Date.now() - Date.parse(view.started_at)) / 1000))
            : null;
        const tl = analysisTimelineView(view);
        return text({
          job_id: jobId,
          status: view.status,
          phase: view.phase,
          elapsed_s: elapsed,
          timeline: tl?.timeline,
          total_s: tl?.total_s,
          result_summary: view.result_summary ?? undefined,
          error: view.error ?? undefined
        });
      })
  );
}
