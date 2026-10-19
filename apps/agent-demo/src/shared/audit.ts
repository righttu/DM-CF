export type AuditSource = "agent" | "mcp-research" | "mcp-quant" | "quant-outbound";
export type AuditEventKind =
  | "question"
  | "model_call"
  | "tool_call"
  | "data_access"
  | "reply"
  | "dlp_block";
export type AuditStatus = "ok" | "denied" | "error" | "stopped";

export interface AuditEvent {
  source: AuditSource;
  event: AuditEventKind;
  ts?: number;
  user_email?: string | null;
  actor_id?: string | null;
  role?: string | null;
  conversation_id?: string | null;
  request_id?: string | null;
  server?: string | null;
  tool?: string | null;
  args_json?: string | null;
  sql_text?: string | null;
  tables?: string | null;
  row_count?: number | null;
  status?: AuditStatus | string | null;
  reason?: string | null;
  duration_ms?: number | null;
  job_id?: string | null;
  text_excerpt?: string | null;
  call_id?: string | null;
}

const COLUMNS = [
  "id",
  "ts",
  "source",
  "event",
  "user_email",
  "actor_id",
  "role",
  "conversation_id",
  "request_id",
  "server",
  "tool",
  "args_json",
  "sql_text",
  "tables",
  "row_count",
  "status",
  "reason",
  "duration_ms",
  "job_id",
  "text_excerpt",
  "call_id"
] as const;

const SECRET_KEY = /token|secret|password|api[_-]?key|authorization/i;

export function sanitizeArgs(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > 500 ? v.slice(0, 500) : v;
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY.test(k)) continue;
        out[k] = scrub(val);
      }
      return out;
    }
    return v;
  };
  let json: string;
  try {
    json = JSON.stringify(scrub(value));
  } catch {
    return null;
  }
  return json.length > 2000 ? json.slice(0, 2000) : json;
}

export function excerpt(s: unknown, max = 300): string | null {
  if (typeof s !== "string" || s.length === 0) return null;
  return s.slice(0, max);
}

export function truncateSql(s: string): string {
  return s.length > 4000 ? s.slice(0, 4000) : s;
}

// Conservative table extraction: collects bare identifiers after FROM / JOIN
// (plus JOIN targets inside nested parentheses). Used only for audit labels —
// the executed SQL is decided by the read-only validator, not this parser.
export function extractTables(sql: string): string[] {
  const found = new Set<string>();
  const re = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].toLowerCase();
    if (name !== "select" && name !== "unnest") found.add(name);
  }
  return [...found];
}

const INSERT_SQL = `INSERT INTO audit_events (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`;

export async function recordAudit(
  db: D1Database | undefined,
  ev: AuditEvent | AuditEvent[]
): Promise<void> {
  if (!db) return;
  const list = Array.isArray(ev) ? ev : [ev];
  if (list.length === 0) return;
  try {
    const statements = list.map((e) =>
      db.prepare(INSERT_SQL).bind(
        crypto.randomUUID(),
        e.ts ?? Date.now(),
        e.source,
        e.event,
        e.user_email ?? null,
        e.actor_id ?? null,
        e.role ?? null,
        e.conversation_id ?? null,
        e.request_id ?? null,
        e.server ?? null,
        e.tool ?? null,
        e.args_json ?? null,
        e.sql_text ?? null,
        e.tables ?? null,
        e.row_count ?? null,
        e.status ?? null,
        e.reason ?? null,
        e.duration_ms ?? null,
        e.job_id ?? null,
        e.text_excerpt ?? null,
        e.call_id ?? null
      )
    );
    await db.batch(statements);
  } catch {
    console.warn(JSON.stringify({ event: "audit_write_failed" }));
  }
}

export function isAuditAdmin(env: { AUDIT_ADMIN_EMAILS?: string }, email: string): boolean {
  const list = (env.AUDIT_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return list.includes(email.trim().toLowerCase());
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function beijingDayMs(date: string, end = false): number | null {
  if (!DATE_PATTERN.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00+08:00`);
  return Number.isFinite(ms) ? (end ? ms + 24 * 3600 * 1000 - 1 : ms) : null;
}
