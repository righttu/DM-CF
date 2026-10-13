import { DOCUMENT_IDS, QUERIES, STOCK_IDS } from "../research-policy.js";

export type CanonicalTool =
  | "list_demo_stocks"
  | "get_latest_analysis"
  | "read_research_document";

export const CANONICAL_TOOLS: CanonicalTool[] = [
  "list_demo_stocks",
  "get_latest_analysis",
  "read_research_document"
];

export interface DemoDb {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

export async function listDemoStocks(db: DemoDb) {
  const { results } = await db.prepare(QUERIES.listStocks).bind().all();
  return { is_demo: true, source: "demo_db", stocks: results };
}

export async function getLatestAnalysis(db: DemoDb, stockId: string) {
  if (!(STOCK_IDS as readonly string[]).includes(stockId)) {
    return {
      is_demo: true,
      source: "demo_db",
      error: "invalid_stock_id",
      allowed: [...STOCK_IDS]
    };
  }
  const row = await db.prepare(QUERIES.latestReport).bind(stockId).first();
  if (!row) {
    return { is_demo: true, source: "demo_db", error: "not_found", stock_id: stockId };
  }
  return { is_demo: true, source: "demo_db", report: row };
}

export async function readResearchDocument(db: DemoDb, documentId: string) {
  if (!(DOCUMENT_IDS as readonly string[]).includes(documentId)) {
    return {
      is_demo: true,
      source: "demo_db",
      error: "invalid_document_id",
      allowed: [...DOCUMENT_IDS]
    };
  }
  const row = await db.prepare(QUERIES.document).bind(documentId).first();
  if (!row) {
    return {
      is_demo: true,
      source: "demo_db",
      error: "not_found",
      document_id: documentId
    };
  }
  return { is_demo: true, source: "demo_db", document: row };
}
