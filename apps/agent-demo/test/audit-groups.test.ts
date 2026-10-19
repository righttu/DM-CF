import { describe, expect, it } from "vitest";
// @ts-expect-error vite ?raw import has no declared module type here
import pageSrc from "../src/agent/audit-page.ts?raw";
// @ts-expect-error vite ?raw import has no declared module type here
import groupsSrc from "../src/agent/audit-groups.ts?raw";
import {
  auditGroupSummary,
  auditNormTool,
  auditSwimlane,
  auditTimelineItems,
  groupAuditEvents,
  type AuditRowLike
} from "../src/agent/audit-groups.js";
import realRowsJson from "./evidence/audit-real-rows.json";
import previewRowsJson from "./evidence/audit-turn2-preview.json";
import v4RowsJson from "./evidence/audit-v4-turn.json";

const U = "a@example.com";
let n = 0;
const row = (e: Partial<AuditRowLike>): AuditRowLike => ({
  id: `r${++n}`,
  ts: 0,
  source: "agent",
  event: "tool_call",
  ...e
});

describe("auditNormTool", () => {
  it("strips the Portal server-id prefix per side", () => {
    expect(auditNormTool({ server: "abc-quant", tool: "abc-quant_find_stock" })).toBe("find_stock");
    expect(auditNormTool({ server: "abc-quant", tool: "find_stock" })).toBe("find_stock");
    expect(
      auditNormTool({ server: "research", tool: "research-demo_list_demo_companies" })
    ).toBe("list_demo_companies");
    expect(auditNormTool({ server: "research", tool: "list_demo_companies" })).toBe(
      "list_demo_companies"
    );
    expect(auditNormTool({ tool: "abc-quant_get_signals" })).toBe("get_signals");
  });
});

describe("groupAuditEvents", () => {
  it("keeps exact request_id matching first", () => {
    const rows = [
      row({ ts: 1000, event: "question", user_email: U, request_id: "r1" }),
      row({
        ts: 1100,
        source: "mcp-quant",
        event: "tool_call",
        user_email: U,
        request_id: "r1",
        tool: "find_stock"
      }),
      row({
        ts: 99000,
        source: "mcp-quant",
        event: "tool_call",
        user_email: U,
        request_id: null,
        tool: "find_stock"
      })
    ];
    const g = groupAuditEvents(rows);
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0].rows).toHaveLength(2);
    // outside the window -> stays unmatched (no flooding into the group)
    expect(g.unmatched).toHaveLength(1);
  });

  it("attaches _meta-less MCP rows inside the turn window by user+tool and nests access", () => {
    const agentCall = row({
      ts: 5000,
      event: "tool_call",
      user_email: U,
      request_id: "req-a",
      server: "abc-quant",
      tool: "abc-quant_find_stock",
      status: "ok"
    });
    const mcpCall = row({
      ts: 5100,
      source: "mcp-quant",
      event: "tool_call",
      user_email: U,
      request_id: null,
      server: "abc-quant",
      tool: "find_stock",
      status: "ok"
    });
    const access = row({
      ts: 5200,
      source: "mcp-quant",
      event: "data_access",
      user_email: U,
      request_id: null,
      tool: "find_stock",
      tables: "stock_basic",
      row_count: 2,
      sql_text: "SELECT * FROM stock_basic"
    });
    const g = groupAuditEvents([
      row({ ts: 1000, event: "question", user_email: U, request_id: "req-a" }),
      agentCall,
      row({ ts: 9000, event: "reply", user_email: U, request_id: "req-a" }),
      mcpCall,
      access
    ]);
    expect(g.groups).toHaveLength(1);
    expect(g.unmatched).toHaveLength(0);
    expect(mcpCall._pair).toBe(agentCall.id);
    expect(mcpCall._access).toHaveLength(1);
    expect((mcpCall._access as AuditRowLike[])[0].tables).toBe("stock_basic");
  });

  it("does not attach rows outside the window or for another user/tool", () => {
    const base = [
      row({ ts: 1000, event: "question", user_email: U, request_id: "req-a" }),
      row({
        ts: 2000,
        event: "tool_call",
        user_email: U,
        request_id: "req-a",
        server: "abc-quant",
        tool: "abc-quant_find_stock"
      }),
      row({ ts: 3000, event: "reply", user_email: U, request_id: "req-a" })
    ];
    const wrongUser = row({
      ts: 2500,
      source: "mcp-quant",
      event: "tool_call",
      user_email: "b@example.com",
      request_id: null,
      tool: "find_stock"
    });
    const wrongTool = row({
      ts: 2500,
      source: "mcp-quant",
      event: "tool_call",
      user_email: U,
      request_id: null,
      tool: "get_signals"
    });
    const outside = row({
      ts: 1000 + 3000 + 3000 + 5000,
      source: "mcp-quant",
      event: "tool_call",
      user_email: U,
      request_id: null,
      tool: "find_stock"
    });
    const g = groupAuditEvents([...base, wrongUser, wrongTool, outside]);
    expect(g.unmatched).toHaveLength(3);
    expect(g.groups[0].rows).toHaveLength(3);
  });

  it("pairs repeated same-name tool calls in time order", () => {
    const a1 = row({
      id: "A1",
      ts: 2000,
      event: "tool_call",
      user_email: U,
      request_id: "req-a",
      tool: "abc-quant_find_stock"
    });
    const a2 = row({
      id: "A2",
      ts: 6000,
      event: "tool_call",
      user_email: U,
      request_id: "req-a",
      tool: "abc-quant_find_stock"
    });
    const m1 = row({
      ts: 2100,
      source: "mcp-quant",
      event: "tool_call",
      user_email: U,
      request_id: null,
      tool: "find_stock"
    });
    const m2 = row({
      ts: 6100,
      source: "mcp-quant",
      event: "tool_call",
      user_email: U,
      request_id: null,
      tool: "find_stock"
    });
    const g = groupAuditEvents([
      row({ ts: 1000, event: "question", user_email: U, request_id: "req-a" }),
      a2,
      a1,
      row({ ts: 8000, event: "reply", user_email: U, request_id: "req-a" }),
      m2,
      m1
    ]);
    expect(m1._pair).toBe("A1");
    expect(m2._pair).toBe("A2");
    // rows render ascending inside the group
    const group = g.groups[0];
    expect(group.rows[0].event).toBe("question");
    expect(group.rows.map((r) => r.ts)).toEqual([...group.rows.map((r) => r.ts)].sort((x, y) => x - y));
  });

  it("joins MCP rows by exact call_id, incl. two calls of the same tool", () => {
    const a1 = row({
      id: "A1",
      ts: 2000,
      event: "tool_call",
      user_email: U,
      request_id: "req-a",
      server: "abc-quant",
      tool: "abc-quant_find_stock",
      call_id: "call-1"
    });
    const a2 = row({
      id: "A2",
      ts: 6000,
      event: "tool_call",
      user_email: U,
      request_id: "req-a",
      server: "abc-quant",
      tool: "abc-quant_find_stock",
      call_id: "call-2"
    });
    // NULL request_id (Portal drops _meta) but exact call_id — and the
    // second call's ts order is deliberately swapped in the input.
    const m2 = row({
      ts: 6100,
      source: "mcp-quant",
      event: "tool_call",
      user_email: U,
      request_id: null,
      tool: "find_stock",
      call_id: "call-2"
    });
    const m1 = row({
      ts: 2100,
      source: "mcp-quant",
      event: "tool_call",
      user_email: U,
      request_id: null,
      tool: "find_stock",
      call_id: "call-1"
    });
    const acc = row({
      ts: 2200,
      source: "mcp-quant",
      event: "data_access",
      user_email: U,
      request_id: null,
      tool: "find_stock",
      call_id: "call-1",
      tables: "stock_basic"
    });
    const g = groupAuditEvents([
      row({ ts: 1000, event: "question", user_email: U, request_id: "req-a" }),
      a2,
      a1,
      row({ ts: 8000, event: "reply", user_email: U, request_id: "req-a" }),
      m2,
      acc,
      m1
    ]);
    expect(g.groups).toHaveLength(1);
    expect(g.unmatched).toHaveLength(0);
    // call_id wins over time order: m1->A1, m2->A2 (time order alone would
    // still hold here, so also check the access is nested under m1)
    expect(m1._pair).toBe("A1");
    expect(m2._pair).toBe("A2");
    expect((m1._access as AuditRowLike[])?.[0]?.tables).toBe("stock_basic");
    expect(acc._nested).toBe(true);
    const group = g.groups[0];
    expect(group.rows).toContain(m1);
    expect(group.rows).toContain(acc);
    expect(group.rows.map((r) => r.ts)).toEqual(
      [...group.rows.map((r) => r.ts)].sort((x, y) => x - y)
    );
  });

  it("call_id joins even outside the legacy window; unmatched call_id rows are kept", () => {
    const agentCall = row({
      id: "A1",
      ts: 2000,
      event: "tool_call",
      user_email: U,
      request_id: "req-a",
      server: "abc-quant",
      tool: "abc-quant_find_stock",
      call_id: "call-x"
    });
    const farButExact = row({
      ts: 999000,
      source: "mcp-quant",
      event: "tool_call",
      user_email: "other@example.com", // email mismatch impossible in prod but
      request_id: null,                 // call_id is the join, not user/window
      tool: "find_stock",
      call_id: "call-x"
    });
    const unknownCall = row({
      ts: 2500,
      source: "mcp-quant",
      event: "tool_call",
      user_email: U,
      request_id: null,
      tool: "find_stock",
      call_id: "call-unknown"
    });
    const g = groupAuditEvents([
      row({ ts: 1000, event: "question", user_email: U, request_id: "req-a" }),
      agentCall,
      row({ ts: 3000, event: "reply", user_email: U, request_id: "req-a" }),
      farButExact,
      unknownCall
    ]);
    expect(farButExact._pair).toBe("A1");
    expect(g.unmatched).toContain(unknownCall);
    expect(g.groups[0].rows).toContain(farButExact);
  });

  it("nests a data_access on the agent call when its MCP tool_call row is absent", () => {
    const agentCall = row({
      id: "A1",
      ts: 2000,
      event: "tool_call",
      user_email: U,
      request_id: "req-a",
      server: "abc-quant",
      tool: "abc-quant_find_stock",
      call_id: "call-1"
    });
    const acc = row({
      ts: 2200,
      source: "mcp-quant",
      event: "data_access",
      user_email: U,
      request_id: null,
      tool: "find_stock",
      call_id: "call-1",
      tables: "stock_basic"
    });
    const g = groupAuditEvents([
      row({ ts: 1000, event: "question", user_email: U, request_id: "req-a" }),
      agentCall,
      row({ ts: 3000, event: "reply", user_email: U, request_id: "req-a" }),
      acc
    ]);
    expect(g.unmatched).toHaveLength(0);
    expect(acc._nested).toBe(true);
    expect((agentCall._access as AuditRowLike[])?.[0]).toBe(acc);
  });

  it("correlates the real production turn (verbatim fixture) by call_id", () => {
    const rows = structuredClone(realRowsJson) as unknown as AuditRowLike[];
    const g = groupAuditEvents(rows);
    expect(g.groups).toHaveLength(1);
    expect(g.unmatched).toHaveLength(0);
    expect(g.polls).toHaveLength(0);
    const group = g.groups[0];
    const agentCalls = group.rows.filter(
      (r) => r.source === "agent" && r.event === "tool_call"
    );
    // 3 cards in turn order; the two same-ts parallel calls keep input order.
    expect(agentCalls.map((r) => auditNormTool(r))).toEqual([
      "find_stock",
      "get_fundamentals",
      "get_ai_report"
    ]);
    // Every MCP tool_call paired to its agent row by call_id — none left
    // top-level, including the parallel same-ts pair.
    const paired = new Map(
      group.rows
        .filter((r) => r._pair)
        .map((r) => [r.call_id, r._pair] as const)
    );
    expect(paired.size).toBe(3);
    for (const a of agentCalls) {
      expect(paired.get(a.call_id)).toBe(a.id);
    }
    const byCall = (cid: string) =>
      group.rows.find((r) => r.call_id === cid && r.event === "tool_call" && r.source.startsWith("mcp-"))!;
    // get_ai_report's access is ai_analysis_result 0 rows — not the
    // get_fundamentals tables (the time-order bug this rework fixes).
    const aiRep = byCall("1ca5aeaf-fdda-48ee-8815-cf17f71ab674");
    const fund = byCall("b6acdc92-1c62-443a-81b0-b22cc611837f");
    const find = byCall("6a590633-5af4-4fb8-bf3b-8f962d451bc1");
    expect(
      (aiRep._access as AuditRowLike[]).map((r) => `${r.tables}:${r.row_count}`)
    ).toEqual(["ai_analysis_result:0"]);
    expect(
      (fund._access as AuditRowLike[]).map((r) => `${r.tables}:${r.row_count}`).sort()
    ).toEqual(["stock_basic:null", "stock_fundamentals:6"]);
    expect(
      (find._access as AuditRowLike[]).map((r) => `${r.tables}:${r.row_count}`)
    ).toEqual(["stock_basic:1"]);
  });

  it("collapses agent poll rows and their MCP rows once per call_id", () => {
    const mk = (ts: number, cid: string, source: string) =>
      row({
        ts,
        source,
        event: "tool_call",
        user_email: U,
        request_id: null,
        server: "abc-quant",
        tool: source === "agent" ? "abc-quant_get_analysis_status" : "get_analysis_status",
        reason: source === "agent" ? "poll" : null,
        call_id: cid,
        args_json: '{"job_id":"600000.SH:20261018"}'
      });
    const g = groupAuditEvents([
      mk(100, "pc-1", "agent"),
      mk(110, "pc-1", "mcp-quant"),
      mk(200, "pc-2", "agent"),
      mk(210, "pc-2", "mcp-quant"),
      mk(300, "pc-3", "mcp-quant")
    ]);
    expect(g.polls).toHaveLength(1);
    expect(g.polls[0].count).toBe(3);
    expect(g.polls[0].job_id).toBe("600000.SH:20261018");
    expect(g.unmatched).toHaveLength(0);
  });

  it("collapses polling get_analysis_status orphans per user+job", () => {
    const poll = (ts: number) =>
      row({
        ts,
        source: "mcp-quant",
        event: "tool_call",
        user_email: U,
        request_id: null,
        tool: "get_analysis_status",
        args_json: '{"job_id":"600000.SH:20261018"}'
      });
    const other = row({
      ts: 500,
      source: "mcp-research",
      event: "tool_call",
      user_email: U,
      request_id: null,
      tool: "list_demo_companies"
    });
    const g = groupAuditEvents([poll(100), poll(200), poll(300), other]);
    expect(g.polls).toHaveLength(1);
    expect(g.polls[0].count).toBe(3);
    expect(g.polls[0].job_id).toBe("600000.SH:20261018");
    expect(g.unmatched).toHaveLength(1);
    expect(g.unmatched[0].tool).toBe("list_demo_companies");
  });
});

describe("auditTimelineItems", () => {
  const model = (ts: number, step: number, tools: string[]) =>
    row({
      ts,
      event: "model_call",
      request_id: "r1",
      tool: "dynamic/abc-agent",
      reason: tools.length ? "tool-calls" : "stop",
      args_json: JSON.stringify({ step, tools, input_tokens: 10, output_tokens: 5 })
    });

  it("assigns tool calls to the latest earlier round and marks parallel calls", () => {
    const q = row({ ts: 1000, event: "question", request_id: "r1", text_excerpt: "q" });
    const m1 = model(1100, 1, ["find_stock"]);
    const c1 = row({ ts: 1200, request_id: "r1", tool: "abc-quant_find_stock", call_id: "k1" });
    const m2 = model(2000, 2, ["get_fundamentals", "get_ai_report"]);
    const c2 = row({ ts: 2100, request_id: "r1", tool: "abc-quant_get_fundamentals", call_id: "k2" });
    const c3 = row({ ts: 2100, request_id: "r1", tool: "abc-quant_get_ai_report", call_id: "k3" });
    const m3 = model(3000, 3, []);
    const reply = row({ ts: 4000, event: "reply", request_id: "r1", text_excerpt: "a" });
    const rows = [q, m1, c1, m2, c2, c3, m3, reply];
    const g = groupAuditEvents(rows);
    const items = auditTimelineItems(g.groups[0].rows, new Map());
    expect(items.map((i) => i.kind)).toEqual([
      "event", "round", "send", "recv", "tool",
      "round", "send", "recv", "tool", "tool",
      "round", "send", "recv", "event"
    ]);
    const t = items.filter((i) => i.kind === "tool");
    expect(t[0].row).toBe(c1);
    expect(t[1].row).toBe(c2);
    expect(t[2].row).toBe(c3);
    expect(t[0].parallel).toBe(false);
    expect(t[1].parallel).toBe(true);
    expect(t[2].parallel).toBe(true);
    expect(t[1].conn).toBe("├");
    expect(t[2].conn).toBe("└");
    expect(items.filter((i) => i.kind === "round").map((i) => i.idx)).toEqual([0, 1, 2]);
  });

  it("renders legacy turns (no model rows) under the question with a note", () => {
    const q = row({ ts: 1000, event: "question", request_id: "r1" });
    const c1 = row({ ts: 1100, request_id: "r1", tool: "abc-quant_find_stock" });
    const reply = row({ ts: 1200, event: "reply", request_id: "r1" });
    const g = groupAuditEvents([q, c1, reply]);
    const items = auditTimelineItems(g.groups[0].rows, new Map());
    expect(items.map((i) => i.kind)).toEqual(["event", "note", "tool", "event"]);
    expect(items[1].text).toContain("模型轮次审计");
    expect(items[2].row).toBe(c1);
  });

  it("keeps a tool call that precedes every round under the legacy note", () => {
    const c0 = row({ ts: 500, request_id: "r1", tool: "abc-quant_find_stock" });
    const q = row({ ts: 1000, event: "question", request_id: "r1" });
    const m1 = model(1100, 1, ["find_stock"]);
    const g = groupAuditEvents([c0, q, m1]);
    const items = auditTimelineItems(g.groups[0].rows, new Map());
    // c0.ts < first round ts -> legacy bucket (emitted after the question)
    expect(items.map((i) => i.kind)).toEqual([
      "event", "note", "tool", "round", "send", "recv"
    ]);
    expect(items[2].row).toBe(c0);
  });
});

describe("auditSwimlane", () => {
  // Mirror the page: group rows, build pairMap from _pair marks, drop paired rows.
  const laneSetup = (rows: AuditRowLike[]) => {
    const g = groupAuditEvents(rows);
    const grp = g.groups[0];
    const pairMap = new Map<string, AuditRowLike[]>();
    for (const m of grp.rows) {
      const p = m._pair as string | undefined;
      if (p) {
        if (!pairMap.has(p)) pairMap.set(p, []);
        pairMap.get(p)!.push(m);
      }
    }
    grp.rows = grp.rows.filter((r) => !(r._pair && r.event === "tool_call"));
    return { grp, pairMap };
  };

  it("derives lanes from actor/target: distinct names, stores collapse to one 数据源 lane", () => {
    const q = row({ ts: 1000, event: "question", request_id: "r1", actor: "agent:svc/ResearchAgent" });
    const m1 = row({
      ts: 1100, event: "model_call", request_id: "r1", tool: "dynamic/x",
      actor: "agent:svc/ResearchAgent", target: "ai-gateway:gw1", duration_ms: 500,
      args_json: JSON.stringify({ step: 1, tools: ["find_stock"], tools_count: 3 })
    });
    const c1 = row({
      ts: 1600, request_id: "r1", tool: "srv_find_stock", call_id: "k1", duration_ms: 200,
      actor: "agent:svc/ResearchAgent", target: "mcp-portal:p.example"
    });
    const mc1 = row({
      ts: 1650, source: "mcp-x", event: "tool_call", call_id: "k1", tool: "find_stock",
      actor: "mcp-server:s1", duration_ms: 80
    });
    const a1 = row({
      ts: 1700, source: "mcp-x", event: "data_access", call_id: "k1", tool: "find_stock",
      actor: "mcp-server:s1", target: "d1:db1", tables: "t1", row_count: 2, status: "ok"
    });
    const a2 = row({
      ts: 1750, source: "mcp-x", event: "data_access", call_id: "k1", tool: "find_stock",
      actor: "mcp-server:s1", target: "vectorize:v1", tables: "t2", row_count: 1, status: "ok"
    });
    const reply = row({ ts: 3000, event: "reply", request_id: "r1", actor: "agent:svc/ResearchAgent", target: "user:u@x" });
    const { grp, pairMap } = laneSetup([q, m1, c1, mc1, a1, a2, reply]);
    const sw = auditSwimlane(grp.rows, pairMap);
    expect(sw.lanes.map((l) => l.role)).toEqual([
      "AI Gateway", "Agent", "MCP Portal", "MCP Server", "数据源"
    ]);
    expect(sw.lanes.map((l) => l.name)).toEqual(["gw1", "svc/ResearchAgent", "p.example", "s1", null]);
    // kinds in strict order incl. round section and full-width reply row
    expect(sw.arrows.map((a) => a.kind)).toEqual([
      "sect", "send", "recv", "exec", "query", "query", "ret", "reply"
    ]);
    const exec = sw.arrows.find((a) => a.kind === "exec")!;
    expect(exec.via).toBe("mcp-portal:p.example");
    const ret = sw.arrows.find((a) => a.kind === "ret")!;
    expect(ret.ts).toBe(1750); // max(mcp end, last access ts)
    // non-decreasing offsets
    const tss = sw.arrows.map((a) => a.ts);
    expect([...tss].sort((x, y) => x - y)).toEqual(tss);
  });

  it("gives two MCP servers two lanes", () => {
    const q = row({ ts: 1000, event: "question", request_id: "r1", actor: "agent:svc" });
    const m1 = row({
      ts: 1100, event: "model_call", request_id: "r1", actor: "agent:svc", target: "ai-gateway:gw",
      duration_ms: 100, args_json: JSON.stringify({ step: 1, tools: ["t1", "t2"], tools_count: 2 })
    });
    const c1 = row({ ts: 1200, request_id: "r1", tool: "s1_t1", call_id: "k1", actor: "agent:svc", target: "mcp-portal:p" });
    const c2 = row({ ts: 1200, request_id: "r1", tool: "s2_t2", call_id: "k2", actor: "agent:svc", target: "mcp-portal:p" });
    const mc1 = row({ ts: 1250, source: "mcp-a", event: "tool_call", call_id: "k1", tool: "t1", actor: "mcp-server:srv1" });
    const mc2 = row({ ts: 1250, source: "mcp-b", event: "tool_call", call_id: "k2", tool: "t2", actor: "mcp-server:srv2" });
    const { grp, pairMap } = laneSetup([q, m1, c1, c2, mc1, mc2]);
    const sw = auditSwimlane(grp.rows, pairMap);
    expect(sw.lanes.filter((l) => l.kind === "mcp-server").map((l) => l.name)).toEqual(["srv1", "srv2"]);
    const execs = sw.arrows.filter((a) => a.kind === "exec");
    expect(execs.map((a) => a.to)).toEqual(["mcp-server:srv1", "mcp-server:srv2"]);
    expect(execs.every((a) => a.parallel)).toBe(true);
  });

  it("legacy rows yield role-only lanes and always include MCP Portal when calls exist", () => {
    const q = row({ ts: 1000, event: "question", request_id: "r1" });
    const c1 = row({ ts: 1100, request_id: "r1", tool: "srv_t1", call_id: "k1" });
    const mc1 = row({ ts: 1150, source: "mcp-x", event: "tool_call", call_id: "k1", tool: "t1" });
    const { grp, pairMap } = laneSetup([q, c1, mc1]);
    const sw = auditSwimlane(grp.rows, pairMap);
    expect(sw.lanes.map((l) => l.role)).toEqual(["Agent", "MCP Portal", "MCP Server"]);
    expect(sw.lanes.every((l) => l.name == null)).toBe(true);
  });

  it("orders arrows on the augmented preview turn (发送→回复→执行→查询→返回 ×3)", () => {
    const rows = previewRowsJson as AuditRowLike[];
    const { grp, pairMap } = laneSetup(rows);
    const sw = auditSwimlane(grp.rows, pairMap);
    expect(sw.lanes.map((l) => l.role)).toEqual([
      "AI Gateway", "Agent", "MCP Portal", "MCP Server", "数据源"
    ]);
    const kinds = sw.arrows.filter((a) => a.kind !== "sect").map((a) => a.kind);
    expect(kinds).toEqual([
      "send", "recv", "exec", "query", "ret",
      "send", "recv", "exec", "query", "query", "ret",
      "send", "recv", "reply"
    ]);
    const tss = sw.arrows.map((a) => a.ts);
    expect([...tss].sort((x, y) => x - y)).toEqual(tss);
  });

  it("corrects legacy (pre-timing:2) model durations via the round's first tool call", () => {
    const rows = v4RowsJson as AuditRowLike[];
    const { grp, pairMap } = laneSetup(rows);
    const sw = auditSwimlane(grp.rows, pairMap);
    const base = rows[0].ts;
    const off = (a: { ts: number }) => (a.ts - base) / 1000;
    const ar = sw.arrows.filter((a) => a.kind !== "sect");
    expect(ar.map((a) => a.kind)).toEqual([
      "send", "recv", "exec", "query", "ret",
      "send", "recv", "exec", "query", "query", "ret",
      "send", "recv", "reply"
    ]);
    // round 1: model decided at the tool-call time (2.9 s), not finish-step
    const recv1 = ar[1];
    expect(off(recv1)).toBeCloseTo(2.9, 1);
    expect(recv1.est).toBe(true);
    expect(recv1.modelMs).toBeCloseTo(2909, -2);
    // recv before exec even though their ts tie (479026)
    expect(ar[2].ts).toBe(recv1.ts);
    // round 2: corrected to ~3.2 s
    const recv2 = ar[6];
    expect(off(recv2)).toBeCloseTo(7.2, 1);
    expect(recv2.modelMs).toBeCloseTo(3212, -2);
    expect(off(ar[5])).toBeCloseTo(4.0, 1); // send2
    expect(off(ar[7])).toBeCloseTo(7.2, 1); // exec2
    expect(off(ar[8])).toBeCloseTo(7.7, 1); // query
    expect(off(ar[10])).toBeCloseTo(7.7, 1); // ret
    // round 3 has no tool calls: keep recorded duration (53.6 s)
    const recv3 = ar[12];
    expect(recv3.est).toBeFalsy();
    expect(recv3.modelMs).toBeUndefined();
    expect(off(recv3)).toBeCloseTo(61.3, 1);
    const tss = sw.arrows.map((a) => a.ts);
    expect([...tss].sort((x, y) => x - y)).toEqual(tss);
  });
});

describe("auditGroupSummary", () => {
  it("computes table chips, rounds, tokens, risk flags and total", () => {
    const q = row({ ts: 1000, event: "question", request_id: "r1" });
    const m1 = row({ ts: 1100, event: "model_call", request_id: "r1",
      args_json: JSON.stringify({ input_tokens: 100, output_tokens: 20 }) });
    const m2 = row({ ts: 2000, event: "model_call", request_id: "r1",
      args_json: JSON.stringify({ input_tokens: 200, output_tokens: 30 }) });
    const a1 = row({ ts: 1500, source: "mcp-x", event: "data_access", request_id: "r1",
      tables: "t1", row_count: 3, status: "ok" });
    const a2 = row({ ts: 1600, source: "mcp-x", event: "data_access", request_id: "r1",
      tables: "t1", row_count: null, status: "ok" });
    const a3 = row({ ts: 1700, source: "mcp-x", event: "data_access", request_id: "r1",
      tables: "t2", row_count: null, status: "denied" });
    const d = row({ ts: 1800, event: "dlp_block", request_id: "r1", status: "blocked" });
    const s = auditGroupSummary([q, m1, a1, a2, a3, d, m2]);
    expect(s.rounds).toBe(2);
    expect(s.tokens).toBe(350);
    expect(s.denied).toBe(1);
    expect(s.dlp).toBe(true);
    expect(s.total_ms).toBe(1000);
    const t1 = s.tables.find((t) => t.table === "t1")!;
    expect(t1.rows).toBe(3);
    expect(t1.count).toBe(2);
    const t2 = s.tables.find((t) => t.table === "t2")!;
    expect(t2.rows).toBe(0);
    expect(t2.count).toBe(1);
  });
});

describe("audit page env neutrality", () => {
  // Every concrete environment name shown in the page must come from recorded
  // row data (actor/target), never from a literal in page code.
  it("audit-page.ts and audit-groups.ts contain no environment name literals", () => {
    const sources = `${pageSrc}\n${groupsSrc}`;
    for (const literal of [
      "agent-demo",
      "portal-demo",
      "quant-data",
      "stock-knowledge",
      "stock-infor",
      "righttu.uk",
      "GLM",
      "glm-"
    ]) {
      expect(sources, `literal ${literal} must not appear in page code`).not.toContain(literal);
    }
  });
});
