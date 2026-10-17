// Shared helpers for container outbound allowlist handlers (quant analysis +
// batch pipeline). Audit log lines carry kind + sha256, never SQL text or bodies.

export const TS_CODE_PATTERN = /^\d{6}\.(SH|SZ|BJ)$/;
export const VECTOR_DIM = 512;
export const DEFAULT_MAX_BODY = 2 * 1024 * 1024;

export function bjCompactDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(now)
    .replaceAll("-", "");
}

export function outboundDeny(event: string, kind: string, hash?: string): Response {
  console.info(
    JSON.stringify({
      event,
      action: "deny",
      kind,
      sha256: hash ?? null
    })
  );
  return Response.json({ success: false, error: "operation_not_allowed" }, { status: 403 });
}

export function outboundAllow(
  event: string,
  kind: string,
  hash: string | null,
  body: unknown
): Response {
  console.info(
    JSON.stringify({
      event,
      action: "allow",
      kind,
      sha256: hash
    })
  );
  return Response.json(body);
}

export function normalizeSql(raw: string): string {
  let sql = raw.replace(/\s+/g, " ").trim();
  while (sql.endsWith(";")) sql = sql.slice(0, -1).trimEnd();
  return sql;
}

export async function sha256Short(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

const READONLY_FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b/i;
const READONLY_FORBIDDEN_OBJECTS = /\b(sqlite_\w+|_cf_\w+|d1_\w+|pragma_\w+)\b/i;

export function checkReadOnlyOutbound(sql: string): boolean {
  if (sql.length === 0 || sql.length > 4000) return false;
  if (sql.includes(";") || sql.includes("--") || sql.includes("/*")) return false;
  if (!/^(select|with)\b/i.test(sql)) return false;
  if (READONLY_FORBIDDEN.test(sql)) return false;
  if (READONLY_FORBIDDEN_OBJECTS.test(sql)) return false;
  return true;
}

export function validVector(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === VECTOR_DIM &&
    (v as unknown[]).every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export async function readJsonBody(
  request: Request,
  maxBody = DEFAULT_MAX_BODY
): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBody) return null;
  try {
    const text = await request.text();
    if (text.length > maxBody) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
