import { describe, expect, it } from "vitest";
import {
  auditNormTool,
  auditTimelineItems,
  groupAuditEvents,
  type AuditRowLike
} from "../src/agent/audit-groups.js";
import realRowsJson from "./evidence/audit-real-rows.json";

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
      "event", "model", "tool", "model", "tool", "tool", "model", "event"
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
    expect(items.filter((i) => i.kind === "model").map((i) => i.idx)).toEqual([0, 1, 2]);
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
    expect(items.map((i) => i.kind)).toEqual(["event", "note", "tool", "model"]);
    expect(items[2].row).toBe(c0);
  });
});
