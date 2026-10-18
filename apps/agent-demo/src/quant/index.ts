import { Container } from "@cloudflare/containers";

export { ContainerProxy } from "@cloudflare/containers";
import {
  createMcpWorker,
  ConsentTransaction,
  type McpKitEnv
} from "../shared/mcp-kit.js";
import { registerQuantTools } from "./tools.js";
import { QuantAnalysisContainer } from "./analysis.js";

export { ConsentTransaction };
export { __setEmbeddingForTests } from "./tools.js";
export { QuantAnalysisContainer, __setAnalysisTransportForTests } from "./analysis.js";

export interface QuantEnv extends McpKitEnv {
  QUANT_DB: D1Database;
  VECTORIZE?: Vectorize;
  EMBEDDING?: DurableObjectNamespace<QuantEmbeddingContainer>;
  ANALYSIS?: DurableObjectNamespace<QuantAnalysisContainer>;
  R2_STOCK_INFOR?: R2Bucket;
  MY_TUSHARE_TOKEN?: string;
  DASHSCOPE_API_KEY?: string;
  CF_AIG_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

export class QuantEmbeddingContainer extends Container<QuantEnv> {
  defaultPort = 8080;
  sleepAfter = "15m";
}

export default createMcpWorker<QuantEnv>({
  serverName: "abc-quant-mcp-s",
  serverVersion: "0.1.0",
  auditServer: "abc-quant",
  consent: {
    title: "ABC Quant MCP-S 访问授权",
    resourceDescription:
      "请求以你的身份只读访问 ABC 量化数据（行情数据、财务数据、量化策略结果、AI 分析与研报知识库）。"
  },
  allowedRoles: ["analyst"],
  registerTools: registerQuantTools
});
