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

// ---------- ai.internal: containers reach Workers AI only through here ----------

export const AI_OUTBOUND_HOST = "ai.internal";
export const AI_CHAT_MODEL = "@cf/moonshotai/kimi-k2.6";
const AI_CHAT_PATH = "/v1/chat/completions";
const AI_FORWARD_FIELDS = [
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "response_format",
  "chat_template_kwargs"
] as const;

export type AiRunLike = {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { gateway?: { id?: string; metadata?: Record<string, string> } }
  ): Promise<unknown>;
};

export interface AiJobMeta {
  source: string;
  script?: string;
  run_date?: string;
  ts_code?: string;
}

function normalizeAiResult(result: unknown): Record<string, unknown> {
  const r = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (Array.isArray(r.choices)) return r;
  // Workers AI text-generation shape: {response: string | {content, reasoning_content}, usage}
  const resp = r.response;
  let content = "";
  let reasoning: unknown;
  if (typeof resp === "string") {
    content = resp;
  } else if (resp && typeof resp === "object") {
    const o = resp as Record<string, unknown>;
    content = typeof o.content === "string" ? o.content : "";
    reasoning = o.reasoning_content;
  }
  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning !== undefined) message.reasoning_content = reasoning;
  const out: Record<string, unknown> = {
    id: "chatcmpl-workers-ai",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: AI_CHAT_MODEL,
    choices: [{ index: 0, message, finish_reason: "stop" }]
  };
  if (r.usage && typeof r.usage === "object") out.usage = r.usage;
  return out;
}

// Shared POST /v1/chat/completions handler: fixed model, whitelisted fields,
// AI Gateway metadata carries only job identifiers -- never message content.
export async function aiChatOutboundHandler(
  request: Request,
  ai: AiRunLike | undefined,
  meta: AiJobMeta,
  event: string
): Promise<Response> {
  const url = new URL(request.url);
  const hash = await sha256Short(`ai:${url.pathname}`);
  if (request.method !== "POST") return outboundDeny(event, "ai_method", hash);
  if (url.pathname !== AI_CHAT_PATH) return outboundDeny(event, "ai_path", hash);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > DEFAULT_MAX_BODY) return outboundDeny(event, "ai_size", hash);
  const body = await readJsonBody(request, DEFAULT_MAX_BODY);
  if (!body) return outboundDeny(event, "ai_body", hash);
  if (body.model !== AI_CHAT_MODEL) return outboundDeny(event, "ai_model", hash);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return outboundDeny(event, "ai_messages", hash);
  }
  if (!ai?.run) return outboundDeny(event, "ai_unavailable", hash);
  const input: Record<string, unknown> = { stream: false };
  for (const key of AI_FORWARD_FIELDS) {
    if (body[key] !== undefined) input[key] = body[key];
  }
  const metadata: Record<string, string> = { source: meta.source };
  if (meta.script) metadata.script = meta.script;
  if (meta.run_date) metadata.run_date = meta.run_date;
  if (meta.ts_code) metadata.ts_code = meta.ts_code;
  console.info(
    JSON.stringify({ event, action: "ai_chat", model: AI_CHAT_MODEL, prompt_bytes: length })
  );
  try {
    const result = await ai.run(AI_CHAT_MODEL, input, {
      gateway: { id: "ai-gateway", metadata }
    });
    return Response.json(normalizeAiResult(result));
  } catch (error) {
    return Response.json(
      { error: { message: `ai_error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200), type: "server_error" } },
      { status: 502 }
    );
  }
}
