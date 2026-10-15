import { DOCUMENT_IDS, QUERIES, COMPANY_IDS } from "../research-policy.js";

export type CanonicalTool =
  | "list_demo_companies"
  | "get_latest_analysis"
  | "read_research_document";

export const CANONICAL_TOOLS: CanonicalTool[] = [
  "list_demo_companies",
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

export async function listDemoCompanies(db: DemoDb) {
  const { results } = await db.prepare(QUERIES.listCompanies).bind().all();
  return { is_demo: true, source: "demo_db", companies: results };
}

export async function getLatestAnalysis(db: DemoDb, companyId: string) {
  if (!(COMPANY_IDS as readonly string[]).includes(companyId)) {
    return {
      is_demo: true,
      source: "demo_db",
      error: "invalid_company_id",
      allowed: [...COMPANY_IDS]
    };
  }
  const row = await db.prepare(QUERIES.latestReport).bind(companyId).first();
  if (!row) {
    return { is_demo: true, source: "demo_db", error: "not_found", company_id: companyId };
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
