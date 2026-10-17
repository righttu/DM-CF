// TypeScript port of stock_basic_sync_final.py (runs in the pipeline Worker,
// not in a container): Tushare stock_basic for L/D/P, dedupe by ts_code,
// abort < 4000 rows, INSERT OR REPLACE with bound params via D1 batch.

export const STOCK_BASIC_FIELDS = [
  "ts_code", "symbol", "name", "fullname", "cnspell", "area", "industry",
  "market", "exchange", "list_status", "list_date", "delist_date", "is_hs"
] as const;

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS stock_basic (
    ts_code TEXT PRIMARY KEY, symbol TEXT, name TEXT, fullname TEXT, cnspell TEXT,
    area TEXT, industry TEXT, market TEXT, exchange TEXT, list_status TEXT,
    list_date TEXT, delist_date TEXT, is_hs TEXT, update_time TEXT
)`;
const INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_stock_basic_name ON stock_basic(name)",
  "CREATE INDEX IF NOT EXISTS idx_stock_basic_symbol ON stock_basic(symbol)",
  "CREATE INDEX IF NOT EXISTS idx_stock_basic_cnspell ON stock_basic(cnspell)"
];

const TUSHARE_URL = "http://api.tushare.pro";
const MIN_ROWS = 4000;
const BATCH_SIZE = 100;

export type TushareFetcher = (apiName: string, params: Record<string, unknown>, token: string, fields?: string) => Promise<{ fields: string[]; items: unknown[][] }>;

export const httpTushare: TushareFetcher = async (apiName, params, token, fields) => {
  const resp = await fetch(TUSHARE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_name: apiName, token, params, ...(fields ? { fields } : {}) })
  });
  const body = (await resp.json()) as {
    code?: number;
    msg?: string;
    data?: { fields?: string[]; items?: unknown[][] };
  };
  if (body.code !== 0) {
    throw new Error(`tushare_${apiName}: code=${body.code} ${String(body.msg ?? "").slice(0, 200)}`);
  }
  return {
    fields: (body.data?.fields ?? []) as string[],
    items: (body.data?.items ?? []) as unknown[][]
  };
};

function toNull(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (s === "" || s === "nan" || s === "None") return null;
  return s;
}

export function beijingNow(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export async function fetchStockBasicRows(
  token: string,
  fetcher: TushareFetcher = httpTushare
): Promise<Record<string, unknown>[]> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const status of ["L", "D", "P"]) {
    const { fields, items } = await fetcher(
      "stock_basic",
      { exchange: "", list_status: status },
      token,
      STOCK_BASIC_FIELDS.join(",")
    );
    for (const item of items) {
      const rec: Record<string, unknown> = {};
      fields.forEach((f, i) => (rec[f] = item[i]));
      if (typeof rec.ts_code === "string") rows.set(rec.ts_code, rec);
    }
  }
  return [...rows.values()];
}

export async function syncStockBasic(
  env: { QUANT_DB: D1Database; MY_TUSHARE_TOKEN?: string },
  opts: { fetcher?: TushareFetcher; now?: Date } = {}
): Promise<{ fetched: number; written: number; total: number; listed: number }> {
  if (!env.MY_TUSHARE_TOKEN) throw new Error("missing_env MY_TUSHARE_TOKEN");
  const rows = await fetchStockBasicRows(env.MY_TUSHARE_TOKEN, opts.fetcher);
  if (rows.length < MIN_ROWS) {
    throw new Error(`stock_basic_rows_abnormal: ${rows.length}`);
  }
  const db = env.QUANT_DB;
  await db.prepare(CREATE_SQL).run();
  for (const sql of INDEX_SQL) await db.prepare(sql).run();
  const now = beijingNow(opts.now);
  const columns = [...STOCK_BASIC_FIELDS, "update_time"];
  const insertSql = `INSERT OR REPLACE INTO stock_basic (${columns.join(",")}) VALUES (${columns
    .map(() => "?")
    .join(",")})`;
  const statements = rows.map((r) =>
    db.prepare(insertSql).bind(...STOCK_BASIC_FIELDS.map((f) => toNull(r[f])), now)
  );
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
  const count = await db
    .prepare("SELECT COUNT(*) AS n, SUM(list_status='L') AS listed FROM stock_basic")
    .first<{ n: number; listed: number | null }>();
  return {
    fetched: rows.length,
    written: rows.length,
    total: count?.n ?? 0,
    listed: count?.listed ?? 0
  };
}
