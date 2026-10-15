import { describe, expect, it } from "vitest";
import {
  AGENT_AUD,
  ANALYST_EMAIL,
  authedFetch,
  connectAgentMcp,
  signJwt
} from "./helpers.js";

describe("end-to-end connect flow", () => {
  it("connect -> OAuth consent -> callback -> tools ready over real MCP transport", async () => {
    const agentJwt = await signJwt({ sub: "sub-e2e", email: ANALYST_EMAIL, aud: AGENT_AUD });
    await connectAgentMcp({ sub: "sub-e2e", email: ANALYST_EMAIL });

    const session = await authedFetch("/api/session", { jwt: agentJwt });
    const sessionData = (await session.json()) as {
      mcp: { connected: boolean; state: string };
      tools: string[];
    };
    expect(sessionData.mcp.connected).toBe(true);
    expect(sessionData.tools).toContain("list_demo_companies");

    const toolTest = await authedFetch("/api/tool-test", {
      jwt: agentJwt,
      method: "POST",
      body: { tool: "get_latest_analysis", args: { company_id: "DEMO001" } }
    });
    const toolData = (await toolTest.json()) as { status: string; result?: { report?: { report_date?: string } } };
    expect(toolData.status).toBe("ok");
    expect(toolData.result?.report?.report_date).toBe("2026-10-12");

    const docTest = await authedFetch("/api/tool-test", {
      jwt: agentJwt,
      method: "POST",
      body: { tool: "read_research_document", args: { document_id: "research-note-a" } }
    });
    const docData = (await docTest.json()) as { status: string };
    expect(docData.status).toBe("ok");
  });
});
