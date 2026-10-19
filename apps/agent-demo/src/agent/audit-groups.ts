// Correlation helpers for the admin audit page. Written as dependency-free
// functions: they are unit-tested directly in vitest AND serialized into the
// standalone /audit page via Function.prototype.toString (no imports allowed).
//
// Correlation, strongest first:
//  1. call_id — the Agent injects a per-call `_audit` argument (call_id,
//     request_id, conversation_id) that the Portal forwards verbatim; MCP-S
//     records it on its tool_call and data_access rows. Exact join.
//  2. request_id — rows carrying the same request id share a group.
//  3. Legacy fallback for rows written before call_id existed (the Portal
//     drops _meta, so old MCP rows have request_id NULL): the Agent runs one
//     in-flight chat turn per user (per-user DO busy lock), so
//     "same user + same tool + inside the turn's window" is unambiguous.
// Any MCP row matching nothing lands in 未关联 — never dropped silently.

export interface AuditRowLike {
  ts: number;
  source: string;
  event: string;
  user_email?: string | null;
  request_id?: string | null;
  call_id?: string | null;
  server?: string | null;
  tool?: string | null;
  job_id?: string | null;
  args_json?: string | null;
  reason?: string | null;
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

function isMcp(r: AuditRowLike): boolean {
  return r.source.startsWith("mcp-");
}

function hostAccess(host: AuditRowLike, access: AuditRowLike): void {
  (host._access as AuditRowLike[] | undefined) ?? (host._access = []);
  (host._access as AuditRowLike[]).push(access);
  access._nested = true;
}

// Pair the MCP rows inside a request group with the group's agent tool_calls.
// Exact call_id join first, then tool-name pairing in time order for rows
// written before call_id existed. Also nests each data_access under its
// MCP tool_call (same call_id), or directly under the agent tool_call when
// the MCP tool_call row itself is missing.
function pairInGroup(group: AuditGroup): void {
  const agentCalls = group.rows.filter(
    (r) => r.source === "agent" && r.event === "tool_call"
  );
  if (agentCalls.length === 0) return;
  const agentByCall = new Map<string, AuditRowLike>();
  const agentByTool = new Map<string, AuditRowLike[]>();
  for (const a of agentCalls) {
    if (a.call_id) agentByCall.set(a.call_id, a);
    const k = auditNormTool(a);
    if (!agentByTool.has(k)) agentByTool.set(k, []);
    agentByTool.get(k)!.push(a);
  }
  for (const l of agentByTool.values()) l.sort((x, y) => x.ts - y.ts);
  const used = new Map<string, number>();
  const mcpByCall = new Map<string, AuditRowLike>();
  for (const m of group.rows) {
    if (!isMcp(m) || m.event !== "tool_call" || m._pair) continue;
    if (m.call_id) mcpByCall.set(m.call_id, m);
    let target: AuditRowLike | undefined;
    if (m.call_id && agentByCall.has(m.call_id)) {
      target = agentByCall.get(m.call_id);
    } else {
      const k = auditNormTool(m);
      const cands = agentByTool.get(k);
      if (cands) {
        const i = used.get(k) ?? 0;
        if (i < cands.length) {
          used.set(k, i + 1);
          target = cands[i];
        }
      }
    }
    if (target) m._pair = (target.id as string | undefined) ?? "";
  }
  const paired = group.rows.filter((r) => r._pair);
  const user = group.rows.find((r) => r.source === "agent")?.user_email ?? null;
  for (const o of group.rows) {
    if (!isMcp(o) || o.event !== "data_access" || o._nested) continue;
    let host: AuditRowLike | undefined;
    if (o.call_id) {
      host = mcpByCall.get(o.call_id) ?? agentByCall.get(o.call_id);
    } else if ((o.user_email ?? null) === user) {
      host = paired.find(
        (mm) => auditNormTool(mm) === auditNormTool(o) && Math.abs(mm.ts - o.ts) <= 1000
      );
    }
    if (host) hostAccess(host, o);
  }
}

// Attach request_id-less MCP rows to the Agent request group they belong to.
// Legacy path (no call_id): same user + same tool + inside the turn window.
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
      isMcp(o) &&
      o.event === "tool_call" &&
      !o.request_id &&
      // Rows with a call_id either matched exactly or match nothing —
      // a fuzzy window attach would risk pairing to the wrong call.
      !o.call_id &&
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
      isMcp(o) &&
      o.event === "data_access" &&
      !o.request_id &&
      !o.call_id &&
      (o.user_email ?? null) === user &&
      pairedMcp.some(
        (m) => auditNormTool(m) === auditNormTool(o) && Math.abs(m.ts - o.ts) <= 1000
      )
    ) {
      const m = pairedMcp.find(
        (mm) => auditNormTool(mm) === auditNormTool(o) && Math.abs(mm.ts - o.ts) <= 1000
      )!;
      hostAccess(m, o);
      group.rows.push(o);
    } else {
      leftover.push(o);
    }
  }
  return leftover.concat(unpaired);
}

// Exact call_id attach for request_id-less MCP rows (the Portal drops _meta,
// so MCP-side rows carry call_id but not request_id): the row joins the agent
// tool_call that injected it, wherever that row lives.
function attachByCallId(
  groups: AuditGroup[],
  orphans: AuditRowLike[]
): AuditRowLike[] {
  const index = new Map<string, { row: AuditRowLike; group: AuditGroup }>();
  for (const g of groups) {
    for (const r of g.rows) {
      if (r.source === "agent" && r.event === "tool_call" && r.call_id) {
        index.set(r.call_id, { row: r, group: g });
      }
    }
  }
  if (index.size === 0) return orphans;
  const rest: AuditRowLike[] = [];
  // tool_calls before data_access so access rows find their MCP host.
  const matched = (o: AuditRowLike) =>
    isMcp(o) && o.call_id && index.has(o.call_id);
  for (const o of orphans) {
    if (matched(o) && o.event === "tool_call") {
      const { row, group } = index.get(o.call_id!)!;
      o._pair = (row.id as string | undefined) ?? "";
      group.rows.push(o);
    }
  }
  for (const o of orphans) {
    if (matched(o) && o.event === "data_access") {
      const { row, group } = index.get(o.call_id!)!;
      const mcpCall = group.rows.find(
        (m) => isMcp(m) && m.event === "tool_call" && m.call_id === o.call_id
      );
      hostAccess(mcpCall ?? row, o);
      group.rows.push(o);
    }
  }
  for (const o of orphans) {
    if (!(matched(o) && (o.event === "tool_call" || o.event === "data_access"))) {
      rest.push(o);
    }
  }
  return rest;
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

// Progress-card polling happens outside chat turns on both sides: the Agent
// writes a request_id-less tool_call with reason "poll" (+call_id), MCP-S
// writes its own request_id-less get_analysis_status tool_call. Both collapse
// into one line per user+job; same call_id counts once.
function isPollRow(o: AuditRowLike): boolean {
  if (o.event !== "tool_call" || o.request_id) return false;
  if (o.source === "agent") return o.reason === "poll";
  return isMcp(o) && auditNormTool(o) === "get_analysis_status";
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
  const groups = [...byReq.entries()].map(([id, rows]) => ({
    id,
    // ascending inside a group: question -> tool calls -> access -> reply
    rows: rows.sort((a, b) => a.ts - b.ts)
  }));
  // Exact call_id joins first (in-group pairing, then orphan attach), then
  // the legacy time-window matcher for rows written before call_id existed.
  for (const g of groups) pairInGroup(g);
  let rest = attachByCallId(groups, orphans);
  for (const g of groups) {
    rest = attachMcpRows(g, rest);
  }
  for (const g of groups) pairInGroup(g);
  for (const g of groups) g.rows.sort((a, b) => a.ts - b.ts);
  const polls = new Map<string, PollRow & { keys: Set<string> }>();
  const unmatched: AuditRowLike[] = [];
  for (const o of rest) {
    if (isPollRow(o)) {
      const job = pollJobId(o);
      const key = `${o.user_email ?? ""}|${job ?? ""}`;
      if (!polls.has(key)) {
        polls.set(key, {
          event: "poll_group",
          ts: o.ts,
          user_email: o.user_email ?? null,
          job_id: job,
          count: 0,
          keys: new Set()
        });
      }
      const p = polls.get(key)!;
      const callKey = (o.call_id as string | undefined) ?? (o.id as string | undefined) ?? "";
      if (!p.keys.has(callKey)) {
        p.keys.add(callKey);
        p.count += 1;
        p.ts = Math.max(p.ts, o.ts);
      }
    } else {
      unmatched.push(o);
    }
  }
  unmatched.sort((a, b) => a.ts - b.ts);
  groups.sort(
    (a, b) => Math.max(...b.rows.map((r) => r.ts)) - Math.max(...a.rows.map((r) => r.ts))
  );
  return {
    groups,
    unmatched,
    polls: [...polls.values()].map(({ keys: _k, ...p }) => p)
  };
}

// Serialized into the /audit page (functions must stay dependency-free).
export function auditGroupScriptSource(): string {
  return [
    auditNormTool,
    isMcp,
    hostAccess,
    pairInGroup,
    attachMcpRows,
    attachByCallId,
    pollJobId,
    isPollRow,
    groupAuditEvents
  ]
    .map((f) => f.toString())
    .join("\n\n");
}
