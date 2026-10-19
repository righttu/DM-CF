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

export interface TimelineItem {
  kind: "event" | "round" | "send" | "recv" | "model" | "tool" | "mcp" | "access" | "note";
  row?: AuditRowLike;
  idx?: number;
  conn?: string;
  parallel?: boolean;
  mcp?: AuditRowLike | null;
  accesses?: AuditRowLike[];
  depth?: number;
  text?: string;
}

// Flatten a group into strict chronological timeline items: model rounds at
// depth 0, each agent tool_call under the latest round whose start <= its ts
// (>=2 calls in one round are marked parallel, joined with ├/└), data_access
// nested under its call, legacy turns (no model_call rows) hang their calls
// under the question behind a note. pairMap: agent row id -> paired MCP rows.
export function auditTimelineItems(
  rows: AuditRowLike[],
  pairMap: Map<string, AuditRowLike[]>
): TimelineItem[] {
  const sorted = rows.slice().sort((a, b) => a.ts - b.ts);
  const rounds = sorted.filter((r) => r.event === "model_call");
  const buckets = new Map<number, AuditRowLike[]>();
  const legacy: AuditRowLike[] = [];
  for (const c of sorted) {
    if (c.event !== "tool_call" || c.source !== "agent" || c._pair) continue;
    let ri = -1;
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (rounds[i].ts <= (c.ts as number)) {
        ri = i;
        break;
      }
    }
    if (ri >= 0) {
      if (!buckets.has(ri)) buckets.set(ri, []);
      buckets.get(ri)!.push(c);
    } else {
      legacy.push(c);
    }
  }
  const out: TimelineItem[] = [];
  let legacyDone = false;
  const emitTool = (c: AuditRowLike, j: number, n: number) => {
    const mcpRows = pairMap.get((c.id as string | undefined) ?? "") ?? [];
    out.push({
      kind: "tool",
      row: c,
      conn: j < n - 1 ? "├" : "└",
      parallel: n > 1,
      mcp: mcpRows[0] ?? null,
      accesses: [
        ...mcpRows.flatMap((m) => (m._access as AuditRowLike[] | undefined) ?? []),
        ...((c._access as AuditRowLike[] | undefined) ?? [])
      ]
    });
  };
  const emitLegacy = () => {
    if (legacyDone || legacy.length === 0) return;
    legacyDone = true;
    out.push({ kind: "note", text: "（此记录早于模型轮次审计）" });
    legacy.forEach((c, j) => emitTool(c, j, legacy.length));
  };
  for (const r of sorted) {
    if (r._pair && r.event === "tool_call") continue;
    if (r.event === "tool_call" && r.source === "agent") continue;
    if (r.event === "data_access") {
      if (r._nested) continue;
      out.push({ kind: "access", row: r, depth: 1 });
      continue;
    }
    if (r.event === "model_call") {
      const ri = rounds.indexOf(r);
      // Round section + two interaction lines (send / recv) per model step.
      out.push({ kind: "round", row: r, idx: ri });
      out.push({ kind: "send", row: r, idx: ri });
      out.push({ kind: "recv", row: r, idx: ri });
      const calls = buckets.get(ri) ?? [];
      calls.forEach((c, j) => emitTool(c, j, calls.length));
      continue;
    }
    if (r.event === "tool_call") {
      out.push({
        kind: "mcp",
        row: r,
        accesses: (r._access as AuditRowLike[] | undefined) ?? []
      });
      continue;
    }
    out.push({ kind: "event", row: r });
    if (r.event === "question") emitLegacy();
  }
  emitLegacy();
  return out;
}


export interface SwimLane {
  key: string;
  kind: string;
  role: string;
  name: string | null;
}

export interface SwimArrow {
  kind: "sect" | "send" | "recv" | "exec" | "query" | "ret" | "dlp" | "reply" | "note" | "poll";
  ts: number;
  from?: string;
  to?: string;
  via?: string;
  rows: AuditRowLike[];
  idx?: number;
  calls?: AuditRowLike[];
  modelMs?: number;
  est?: boolean;
  parallel?: boolean;
  count?: number;
  job?: string | null;
  text?: string | null;
}

export interface Swimlane {
  lanes: SwimLane[];
  arrows: SwimArrow[];
}

// Swimlane view of one request group. Lanes are derived from the rows'
// recorded actor/target "<kind>:<name>" strings only — the code knows just the
// lane-category order and role labels, never a concrete name. Categories:
// ai-gateway | agent | mcp-portal | mcp-server | 数据源 (all data-store kinds
// — d1/vectorize/r2/… — collapse into ONE 数据源 lane; the concrete store is
// shown on each arrow). Distinct recorded names within a category get their
// own lane. Legacy rows without actor/target get a role-only lane
// (kind: empty name). When the group has tool calls the MCP Portal lane is
// always present even if its name was never recorded.
// jobMode: for run_analysis job rows (model_call + data_access only) emit
// single arrows actor -> ai-gateway / actor -> 数据源.
export function auditSwimlane(
  rows: AuditRowLike[],
  pairMap: Map<string, AuditRowLike[]>,
  jobMode = false
): Swimlane {
  const ROLES: Record<string, string> = {
    "ai-gateway": "AI Gateway",
    agent: "Agent",
    "mcp-portal": "MCP Portal",
    "mcp-server": "MCP Server",
    store: "数据源"
  };
  const ORDER = ["ai-gateway", "agent", "mcp-portal", "mcp-server", "store"];
  const STORE = new Set(["d1", "vectorize", "r2", "kv"]);
  const lanes = new Map<string, SwimLane>();
  const kname = (v: unknown): [string | null, string | null] => {
    if (v == null || v === "") return [null, null];
    const i = String(v).indexOf(":");
    return i > 0 ? [String(v).slice(0, i), String(v).slice(i + 1)] : [null, String(v)];
  };
  const laneOf = (kind: string | null, name: string | null): string => {
    const k = kind ?? "agent";
    if (k === "store" || STORE.has(k)) {
      if (!lanes.has("store")) {
        lanes.set("store", { key: "store", kind: "store", role: ROLES.store, name: null });
      }
      return "store";
    }
    const key = `${k}:${name ?? ""}`;
    if (!lanes.has(key)) {
      lanes.set(key, { key, kind: k, role: ROLES[k] ?? k, name: name ?? null });
    }
    return key;
  };
  const actorLane = (r?: AuditRowLike | null): string => {
    const [k, n] = kname(r?.actor);
    return laneOf(k, n);
  };
  const agentLane = (r?: AuditRowLike | null): string => {
    const [k, n] = kname(r?.actor);
    return k === "agent" ? laneOf(k, n) : laneOf("agent", null);
  };
  const gwLane = (r?: AuditRowLike | null): string => {
    const [k, n] = kname(r?.target);
    return k === "ai-gateway" ? laneOf(k, n) : laneOf("ai-gateway", null);
  };
  const portalLane = (r?: AuditRowLike | null): string => {
    const [k, n] = kname(r?.target);
    return k === "mcp-portal" ? laneOf(k, n) : laneOf("mcp-portal", null);
  };
  const mcpLane = (r?: AuditRowLike | null): string => {
    const [k, n] = kname(r?.actor);
    return k === "mcp-server" ? laneOf(k, n) : laneOf("mcp-server", null);
  };
  const lastTs = () => (arrows.length ? arrows[arrows.length - 1].ts : 0);
  const arrows: SwimArrow[] = [];

  if (jobMode) {
    for (const r of rows.slice().sort((a, b) => a.ts - b.ts)) {
      if (r.event === "model_call") {
        arrows.push({ kind: "send", ts: r.ts, from: actorLane(r), to: gwLane(r), rows: [r] });
      } else if (r.event === "data_access") {
        arrows.push({ kind: "query", ts: r.ts, from: actorLane(r), to: laneOf("store", null), rows: [r] });
      } else if (r.event === "tool_call") {
        const [k, n] = kname(r.target);
        arrows.push({ kind: "exec", ts: r.ts, from: actorLane(r), to: laneOf(k ?? "mcp-server", n), rows: [r] });
      }
    }
  } else {
    for (const it of auditTimelineItems(rows, pairMap)) {
      const r = it.row;
      if (it.kind === "round" && r) {
        arrows.push({ kind: "sect", ts: r.ts, idx: it.idx, rows: [r] });
      } else if (it.kind === "send" && r) {
        arrows.push({ kind: "send", ts: r.ts, from: agentLane(r), to: gwLane(r), idx: it.idx, rows: [r] });
      } else if (it.kind === "recv" && r) {
        arrows.push({
          kind: "recv",
          ts: r.ts + (typeof r.duration_ms === "number" ? r.duration_ms : 0),
          from: gwLane(r),
          to: agentLane(r),
          idx: it.idx,
          rows: [r]
        });
      } else if (it.kind === "tool" && r) {
        const al = agentLane(r);
        const pl = portalLane(r);
        const ml = it.mcp ? mcpLane(it.mcp) : laneOf("mcp-server", null);
        const toolRows = it.mcp ? [r, it.mcp] : [r];
        arrows.push({ kind: "exec", ts: r.ts, from: al, to: ml, via: pl, rows: toolRows, parallel: it.parallel });
        for (const a of it.accesses ?? []) {
          arrows.push({ kind: "query", ts: a.ts, from: mcpLane(a.actor ? a : it.mcp), to: laneOf("store", null), rows: [a] });
        }
        // anchor the return at the call's last recorded access (the MCP-side
        // end can sit a few ms past the next round's send); fall back to the
        // MCP row end when no access was recorded
        const back =
          (it.accesses?.length
            ? Math.max(...it.accesses.map((a) => a.ts))
            : ((it.mcp?.ts as number | undefined) ?? r.ts) +
              ((it.mcp?.duration_ms as number | undefined) ??
                (r.duration_ms as number | undefined) ??
                0));
        arrows.push({ kind: "ret", ts: back, from: ml, to: al, via: pl, rows: toolRows });
      } else if (it.kind === "mcp" && r) {
        const ml = mcpLane(r);
        arrows.push({ kind: "exec", ts: r.ts, from: laneOf("agent", null), to: ml, rows: [r] });
        for (const a of it.accesses ?? []) {
          arrows.push({ kind: "query", ts: a.ts, from: mcpLane(a.actor ? a : r), to: laneOf("store", null), rows: [a] });
        }
      } else if (it.kind === "access" && r) {
        arrows.push({ kind: "query", ts: r.ts, from: mcpLane(r), to: laneOf("store", null), rows: [r] });
      } else if (it.kind === "note") {
        arrows.push({ kind: "note", ts: lastTs(), text: it.text, rows: [] });
      } else if (it.kind === "event" && r) {
        if (r.event === "reply") {
          arrows.push({ kind: "reply", ts: r.ts, rows: [r] });
        } else if (r.event === "dlp_block") {
          arrows.push({ kind: "dlp", ts: r.ts, from: laneOf("ai-gateway", null), to: agentLane(r), rows: [r] });
        } else if (r.event === "poll_group") {
          arrows.push({ kind: "poll", ts: r.ts, count: r.count as number | undefined, job: (r.job_id as string | undefined) ?? null, rows: [r] });
        }
        // question rows are not arrows — the group header carries the question
      }
    }
    for (let i = 0; i < arrows.length; i++) {
      if (arrows[i].kind !== "recv") continue;
      const calls: AuditRowLike[] = [];
      for (let j = i + 1; j < arrows.length; j++) {
        const k = arrows[j].kind;
        if (k === "sect" || k === "send" || k === "recv") break;
        if (k === "exec") {
          for (const c of arrows[j].rows) {
            if (c.event === "tool_call" && c.source === "agent") calls.push(c);
          }
        }
      }
      arrows[i].calls = calls;
      // Legacy rows (recorded before timing:2) have finish-step AFTER tool
      // execution, so ts+duration_ms overshoots: fall back to the first agent
      // tool_call of the round as the model's decision time.
      const m = arrows[i].rows[0];
      let timing2 = false;
      try {
        const p = JSON.parse(String(m?.args_json ?? "{}")) as Record<string, unknown>;
        timing2 = p.timing === 2;
      } catch {
        timing2 = false;
      }
      if (!timing2 && calls.length) {
        const firstCall = Math.min(...calls.map((c) => c.ts));
        if (firstCall < arrows[i].ts) {
          arrows[i].modelMs = firstCall - (m?.ts ?? firstCall);
          arrows[i].ts = firstCall;
          arrows[i].est = true;
        }
      }
    }
    if (
      rows.some((r) => r.event === "tool_call" && r.source === "agent") &&
      ![...lanes.values()].some((l) => l.kind === "mcp-portal")
    ) {
      laneOf("mcp-portal", null);
    }
  }
  // arrows render strictly top-down by time (stable: emission order breaks ties,
  // so sect/send/recv and exec/query/ret at equal ts keep their natural order)
  arrows.sort((a, b) => a.ts - b.ts);
  const order = (l: SwimLane) => {
    const i = ORDER.indexOf(l.kind);
    return i < 0 ? ORDER.length : i;
  };
  const laneList = [...lanes.values()].sort(
    (a, b) => order(a) - order(b) || String(a.name ?? "").localeCompare(String(b.name ?? ""))
  );
  return { lanes: laneList, arrows };
}

export interface GroupSummary {
  tables: { table: string; rows: number; count: number }[];
  rounds: number;
  tokens: number;
  denied: number;
  dlp: boolean;
  total_ms: number;
}

// Collapsed-group summary chips: per-table access counts, model rounds and
// summed tokens, risk flags, total duration. Derived only from recorded rows.
export function auditGroupSummary(rows: AuditRowLike[]): GroupSummary {
  const sorted = rows.slice().sort((a, b) => a.ts - b.ts);
  const base = (sorted.find((r) => r.event === "question") ?? sorted[0])?.ts ?? 0;
  const tables = new Map<string, { table: string; rows: number; count: number }>();
  let rounds = 0;
  let tokens = 0;
  let denied = 0;
  let dlp = false;
  let max = base;
  for (const r of sorted) {
    if (r.ts > max) max = r.ts;
    if (r.event === "model_call") {
      rounds += 1;
      try {
        const a = JSON.parse(String(r.args_json ?? "{}")) as Record<string, unknown>;
        tokens +=
          (typeof a.input_tokens === "number" ? a.input_tokens : 0) +
          (typeof a.output_tokens === "number" ? a.output_tokens : 0);
      } catch {
        /* unparsed args */
      }
    }
    if (r.event === "data_access" && r.tables) {
      const t = tables.get(String(r.tables)) ?? { table: String(r.tables), rows: 0, count: 0 };
      t.count += 1;
      t.rows += typeof r.row_count === "number" ? r.row_count : 0;
      tables.set(String(r.tables), t);
    }
    if (r.status === "denied") denied += 1;
    if (r.event === "dlp_block" || r.reason === "dlp_blocked") dlp = true;
  }
  return {
    tables: [...tables.values()],
    rounds,
    tokens,
    denied,
    dlp,
    total_ms: Math.max(0, max - base)
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
    groupAuditEvents,
    auditTimelineItems,
    auditSwimlane,
    auditGroupSummary
  ]
    .map((f) => f.toString())
    .join("\n\n");
}
