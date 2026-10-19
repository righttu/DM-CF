// Admin audit view: /audit page + /api/audit query over the shared AUDIT_DB
// (audit_events). Visibility is gated by AUDIT_ADMIN_EMAILS — a secret-set
// comma list, independent of the Analyst/Viewer role. Non-admins get 404.

export interface AuditQueryEnv {
  AUDIT_DB?: D1Database;
  AUDIT_ADMIN_EMAILS?: string;
}

export function isAuditAdmin(
  env: AuditQueryEnv,
  email: string | undefined
): boolean {
  if (!env.AUDIT_DB || !env.AUDIT_ADMIN_EMAILS || !email) return false;
  const admins = env.AUDIT_ADMIN_EMAILS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}

// Beijing-calendar-day filter: "YYYY-MM-DD" -> UTC ms bounds ([from, to+1d)).
function bjDayMs(d: string, end: boolean): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = Date.parse(`${d}T00:00:00+08:00`);
  if (!Number.isFinite(t)) return null;
  return end ? t + 24 * 3600 * 1000 : t;
}

const AUDIT_COLUMNS =
  "id, ts, source, event, user_email, actor_id, role, conversation_id, " +
  "request_id, server, tool, args_json, sql_text, tables, row_count, status, " +
  "reason, duration_ms, job_id, text_excerpt, call_id";

export async function queryAuditEvents(
  env: AuditQueryEnv,
  params: URLSearchParams
): Promise<Record<string, unknown>[]> {
  if (!env.AUDIT_DB) return [];
  const conds: string[] = [];
  const binds: unknown[] = [];
  const job = params.get("job");
  if (job) {
    conds.push("job_id = ?", "source = 'quant-outbound'");
    binds.push(job);
  } else {
    const user = params.get("user")?.trim();
    if (user) {
      conds.push("user_email = ?");
      binds.push(user);
    }
    const from = params.get("from");
    if (from) {
      const ms = bjDayMs(from, false);
      if (ms !== null) {
        conds.push("ts >= ?");
        binds.push(ms);
      }
    }
    const to = params.get("to");
    if (to) {
      const ms = bjDayMs(to, true);
      if (ms !== null) {
        conds.push("ts < ?");
        binds.push(ms);
      }
    }
    const conv = params.get("conversation")?.trim();
    if (conv) {
      conds.push("conversation_id = ?");
      binds.push(conv);
    }
    const req = params.get("request")?.trim();
    if (req) {
      conds.push("request_id = ?");
      binds.push(req);
    }
  }
  const limitParam = Number(params.get("limit") ?? "200");
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), 1000)
      : 200;
  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  const { results } = await env.AUDIT_DB.prepare(
    `SELECT ${AUDIT_COLUMNS} FROM audit_events${where} ORDER BY ts DESC LIMIT ?`
  )
    .bind(...binds, limit)
    .all();
  return (results ?? []) as Record<string, unknown>[];
}
