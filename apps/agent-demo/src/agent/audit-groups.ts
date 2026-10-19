// Correlation helpers for the admin audit page. Written as dependency-free
// functions: they are unit-tested directly in vitest AND serialized into the
// standalone /audit page via Function.prototype.toString (no imports allowed).
//
// Why this matching is safe: the Portal does not forward our MCP _meta
// request/conversation ids, so MCP-side rows arrive with request_id NULL.
// The Agent (per-user Durable Object) runs one in-flight chat turn per user
// at a time (busy lock), so "same user + same tool + inside the turn's time
// window" is unambiguous.

export interface AuditRowLike {
  ts: number;
  source: string;
  event: string;
  user_email?: string | null;
  request_id?: string | null;
  server?: string | null;
  tool?: string | null;
  job_id?: string | null;
  args_json?: string | null;
  [key: string]: unknown;
}

export interface AuditGroup {
  id: string;
  rows: AuditRowLike[];
}

export interface PollRow {
  event: "poll_group";
  ts: number;
  user_email: string | null;
  job_id: string | null;
  count: number;
}

export interface GroupedAudit {
  groups: AuditGroup[];
  unmatched: AuditRowLike[];
  polls: PollRow[];
}

// Normalize a tool name across both sides: Agent sees Portal-namespaced
// names ("abc-quant_find_stock"), MCP sees bare names ("find_stock").
// NOTE: PORTAL_PREFIXES lives inside the function — this source is
// serialized into the /audit page, module scope does not travel.
export function auditNormTool(e: { server?: string | null; tool?: string | null }): string {
  const PORTAL_PREFIXES = ["abc-quant_", "research-demo_"];
  let name = e.tool ?? "";
  // A prefix equal to the row's own server mapping always counts first
  // (server "research" writes via Portal namespace "research-demo_").
  const serverPrefixes =
    e.server === "research" || e.server === "research-demo"
      ? ["research-demo_", ...PORTAL_PREFIXES]
      : e.server
        ? [`${e.server}_`, ...PORTAL_PREFIXES]
        : PORTAL_PREFIXES;
  for (const p of serverPrefixes) {
    if (name.startsWith(p)) {
      name = name.slice(p.length);
      break;
    }
  }
  return name;
}

// Attach _meta-less MCP rows to the Agent request group they belong to.
// Mutates group rows: matched MCP tool_calls get _pair = the agent row's
// index within the group; their data_access rows get nested as _access.
function attachMcpRows(group: AuditGroup, orphans: AuditRowLike[]): AuditRowLike[] {
  const agentRows = group.rows.filter((r) => r.source === "agent");
  if (agentRows.length === 0) return orphans;
  const user = agentRows[0].user_email ?? null;
  const start = Math.min(...agentRows.map((r) => r.ts)) - 1000;
  const end = Math.max(...agentRows.map((r) => r.ts)) + 3000;
  const agentCalls = group.rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.source === "agent" && r.event === "tool_call");
  const byTool = new Map<string, { r: AuditRowLike; i: number }[]>();
  for (const c of agentCalls) {
    const key = auditNormTool(c.r);
    if (!byTool.has(key)) byTool.set(key, []);
    byTool.get(key)!.push(c);
  }
  for (const list of byTool.values()) list.sort((a, b) => a.r.ts - b.r.ts);
  const rest: AuditRowLike[] = [];
  const mcpCalls: AuditRowLike[] = [];
  for (const o of orphans) {
    if (
      o.source.startsWith("mcp-") &&
      o.event === "tool_call" &&
      !o.request_id &&
      (o.user_email ?? null) === user &&
      o.ts >= start &&
      o.ts <= end &&
      byTool.has(auditNormTool(o))
    ) {
      mcpCalls.push(o);
    } else {
      rest.push(o);
    }
  }
  // Pair in time order when several agent tool_calls share the tool name.
  mcpCalls.sort((a, b) => a.ts - b.ts);
  const used = new Map<string, number>();
  const pairedMcp: AuditRowLike[] = [];
  const unpaired: AuditRowLike[] = [];
  for (const m of mcpCalls) {
    const key = auditNormTool(m);
    const cands = byTool.get(key)!;
    const idx = used.get(key) ?? 0;
    if (idx < cands.length) {
      used.set(key, idx + 1);
      m._pair = (cands[idx].r.id as string | undefined) ?? "";
      group.rows.push(m);
      pairedMcp.push(m);
    } else {
      unpaired.push(m);
    }
  }
  // Nest the paired MCP tool_call's data_access rows (same user+tool, ±1 s).
  const leftover: AuditRowLike[] = [];
  for (const o of rest) {
    if (
      o.source.startsWith("mcp-") &&
      o.event === "data_access" &&
      !o.request_id &&
      (o.user_email ?? null) === user &&
      pairedMcp.some(
        (m) => auditNormTool(m) === auditNormTool(o) && Math.abs(m.ts - o.ts) <= 1000
      )
    ) {
      const m = pairedMcp.find(
        (mm) => auditNormTool(mm) === auditNormTool(o) && Math.abs(mm.ts - o.ts) <= 1000
      )!;
      (m._access as AuditRowLike[] | undefined) ?? (m._access = []);
      (m._access as AuditRowLike[]).push(o);
    } else {
      leftover.push(o);
    }
  }
  return leftover.concat(unpaired);
}

function pollJobId(o: AuditRowLike): string | null {
  if (o.job_id) return o.job_id;
  try {
    const a = JSON.parse(o.args_json ?? "{}") as { job_id?: unknown };
    return typeof a.job_id === "string" ? a.job_id : null;
  } catch {
    return null;
  }
}

export function groupAuditEvents(events: AuditRowLike[]): GroupedAudit {
  const byReq = new Map<string, AuditRowLike[]>();
  const orphans: AuditRowLike[] = [];
  for (const e of events) {
    if (e.request_id) {
      if (!byReq.has(e.request_id)) byReq.set(e.request_id, []);
      byReq.get(e.request_id)!.push(e);
    } else {
      orphans.push(e);
    }
  }
  let rest = orphans;
  for (const rows of byReq.values()) {
    rest = attachMcpRows({ id: "", rows }, rest);
  }
  // Progress-card polling calls are user-triggered outside chat turns:
  // collapse them into one line per user+job instead of flooding 未关联.
  const polls = new Map<string, PollRow & { rows: AuditRowLike[] }>();
  const unmatched: AuditRowLike[] = [];
  for (const o of rest) {
    if (
      o.event === "tool_call" &&
      auditNormTool(o) === "get_analysis_status" &&
      !o.request_id
    ) {
      const job = pollJobId(o);
      const key = `${o.user_email ?? ""}|${job ?? ""}`;
      if (!polls.has(key)) {
        polls.set(key, {
          event: "poll_group",
          ts: o.ts,
          user_email: o.user_email ?? null,
          job_id: job,
          count: 0,
          rows: []
        });
      }
      const p = polls.get(key)!;
      p.count += 1;
      p.ts = Math.max(p.ts, o.ts);
      p.rows.push(o);
    } else {
      unmatched.push(o);
    }
  }
  const groups = [...byReq.entries()].map(([id, rows]) => ({
    id,
    // ascending inside a group: question -> tool calls -> access -> reply
    rows: rows.sort((a, b) => a.ts - b.ts)
  }));
  unmatched.sort((a, b) => a.ts - b.ts);
  groups.sort(
    (a, b) => Math.max(...b.rows.map((r) => r.ts)) - Math.max(...a.rows.map((r) => r.ts))
  );
  return {
    groups,
    unmatched,
    polls: [...polls.values()].map(({ rows: _r, ...p }) => p)
  };
}

// Serialized into the /audit page (functions must stay dependency-free).
export function auditGroupScriptSource(): string {
  return [auditNormTool, attachMcpRows, pollJobId, groupAuditEvents]
    .map((f) => f.toString())
    .join("\n\n");
}
