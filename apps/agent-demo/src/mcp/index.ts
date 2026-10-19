import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveRole } from "../shared/access.js";
import {
  createMcpWorker,
  checkMcpScope,
  ConsentTransaction,
  type McpAuthShape,
  type McpKitEnv,
  type ToolCall,
  type ToolTextResult
} from "../shared/mcp-kit.js";
import {
  getLatestAnalysis,
  listDemoCompanies,
  readResearchDocument,
  type DemoDb
} from "../shared/demo-tools.js";
import { DOCUMENT_IDS, COMPANY_IDS, TOOL_DESCRIPTIONS } from "../research-policy.js";

export { ConsentTransaction, checkMcpScope };
export type { McpAuthShape };

interface McpEnv extends McpKitEnv {
  DEMO_DB: D1Database;
  OAUTH_KV: KVNamespace;
  CONSENT_KV: KVNamespace;
  CONSENT_TRANSACTIONS: DurableObjectNamespace<ConsentTransaction>;
}

const text = (value: unknown): ToolTextResult =>
  ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

function registerResearchTools(
  server: McpServer,
  ctx: { env: McpEnv; email: string; call: ToolCall }
): void {
  const { env, email, call } = ctx;
  const db: DemoDb = env.DEMO_DB;

  server.registerTool(
    "list_demo_companies",
    {
      description: TOOL_DESCRIPTIONS.list_demo_companies,
      inputSchema: z.looseObject({})
    },
    async (args, callCtx) =>
      call("list_demo_companies", callCtx, async (audit) => {
        if (!resolveRole(env, email)) {
          return { isError: true, ...text({ error: "permission_denied" }) };
        }
        const r = await listDemoCompanies(db);
        audit.access({
          store: "d1" as const,
          tables: ["demo_reports"],
          rowCount: Array.isArray(r.companies) ? r.companies.length : 0,
          status: "ok"
        });
        return text(r);
      }, { args })
  );

  server.registerTool(
    "get_latest_analysis",
    {
      description: TOOL_DESCRIPTIONS.get_latest_analysis,
      inputSchema: z.looseObject({ company_id: z.enum(COMPANY_IDS) })
    },
    async (args, callCtx) =>
      call("get_latest_analysis", callCtx, async (audit) => {
        if (!resolveRole(env, email)) {
          return { isError: true, ...text({ error: "permission_denied" }) };
        }
        const r = await getLatestAnalysis(db, args.company_id);
        audit.access({
          store: "d1" as const,
          tables: ["demo_reports"],
          rowCount: r.report ? 1 : 0,
          status: r.error ? "error" : "ok",
          reason: typeof r.error === "string" ? r.error : undefined
        });
        return text(r);
      }, { args })
  );

  if (resolveRole(env, email) === "analyst") {
    server.registerTool(
      "read_research_document",
      {
        description: TOOL_DESCRIPTIONS.read_research_document,
        inputSchema: z.looseObject({ document_id: z.enum(DOCUMENT_IDS) })
      },
      async (args, callCtx) =>
        call("read_research_document", callCtx, async (audit) => {
          if (resolveRole(env, email) !== "analyst") {
            return { isError: true, ...text({ error: "permission_denied" }) };
          }
          const r = await readResearchDocument(db, args.document_id);
          audit.access({
          store: "d1" as const,
            tables: ["demo_documents"],
            rowCount: r.document ? 1 : 0,
            status: r.error ? "error" : "ok",
            reason: typeof r.error === "string" ? r.error : undefined
          });
          return text(r);
        }, { args })
    );
  }
}

export default createMcpWorker<McpEnv>({
  serverName: "demo-research-mcp",
  serverVersion: "0.1.0",
  auditServer: "research",
  consent: {
    title: "ABC MCP 访问授权",
    resourceDescription: "请求访问隔离的模拟研究数据。"
  },
  allowedRoles: ["analyst", "viewer"],
  registerTools: registerResearchTools
});
