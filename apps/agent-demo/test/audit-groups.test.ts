import { describe, expect, it } from "vitest";
import {
  auditNormTool,
  groupAuditEvents,
  type AuditRowLike
} from "../src/agent/audit-groups.js";

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
