# ==============================================================================
# 📂 File: stock_basic_sync_final.py
# 📝 Description: 同步 A 股基础信息（代码、名称、拼音缩写、行业、上市状态）到 D1 quant-data.stock_basic
#    1. 数据源：Tushare pro.stock_basic，上市(L)、退市(D)、暂停上市(P) 全量拉取。
#    2. 写入：Cloudflare D1 REST API，INSERT OR REPLACE，可重复执行（幂等）。
#    3. 用途：Agent 通过股票名称、拼音缩写或代码定位 ts_code。
# 🔑 环境变量：MY_TUSHARE_TOKEN, CLOUDFLARE_API_TOKEN
# ==============================================================================
import os
import sys
import json
import datetime
import requests
import tushare as ts

ACCOUNT_ID = "ebc4f70211dc33165a239c6018da8e2d"
D1_DATABASE_ID = "85914a38-2ba4-4e85-b229-e1e1a043a266"
D1_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{D1_DATABASE_ID}/query"
FIELDS = ["ts_code", "symbol", "name", "fullname", "cnspell", "area", "industry",
          "market", "exchange", "list_status", "list_date", "delist_date", "is_hs"]
ROWS_PER_REQUEST = 300

CREATE_SQL = """CREATE TABLE IF NOT EXISTS stock_basic (
    ts_code TEXT PRIMARY KEY, symbol TEXT, name TEXT, fullname TEXT, cnspell TEXT,
    area TEXT, industry TEXT, market TEXT, exchange TEXT, list_status TEXT,
    list_date TEXT, delist_date TEXT, is_hs TEXT, update_time TEXT
)"""
INDEX_SQL = [
    "CREATE INDEX IF NOT EXISTS idx_stock_basic_name ON stock_basic(name)",
    "CREATE INDEX IF NOT EXISTS idx_stock_basic_symbol ON stock_basic(symbol)",
    "CREATE INDEX IF NOT EXISTS idx_stock_basic_cnspell ON stock_basic(cnspell)",
]


def d1(sql):
    resp = requests.post(
        D1_URL,
        headers={"Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}"},
        json={"sql": sql},
        timeout=60,
    )
    body = resp.json()
    if not body.get("success"):
        raise RuntimeError(f"D1 error: {json.dumps(body.get('errors'), ensure_ascii=False)[:300]}")
    return body["result"]


def literal(value):
    if value is None:
        return "NULL"
    text = str(value)
    if text in ("", "nan", "None"):
        return "NULL"
    return "'" + text.replace("'", "''") + "'"


def fetch_all():
    pro = ts.pro_api(os.environ["MY_TUSHARE_TOKEN"])
    frames = []
    for status in ("L", "D", "P"):
        df = pro.stock_basic(exchange="", list_status=status, fields=",".join(FIELDS))
        print(f"📥 list_status={status}: {len(df)} 只")
        frames.append(df)
    rows = {}
    for df in frames:
        for record in df.to_dict(orient="records"):
            rows[record["ts_code"]] = record
    return list(rows.values())


def main():
    for key in ("MY_TUSHARE_TOKEN", "CLOUDFLARE_API_TOKEN"):
        if not os.environ.get(key):
            print(f"❌ 缺少环境变量 {key}")
            sys.exit(1)
    rows = fetch_all()
    if len(rows) < 4000:
        print(f"❌ 只拉到 {len(rows)} 只，数量异常，终止写入")
        sys.exit(1)
    d1(CREATE_SQL)
    for sql in INDEX_SQL:
        d1(sql)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    columns = FIELDS + ["update_time"]
    written = 0
    for start in range(0, len(rows), ROWS_PER_REQUEST):
        chunk = rows[start:start + ROWS_PER_REQUEST]
        values = ",".join(
            "(" + ",".join([literal(r.get(c)) for c in FIELDS] + [literal(now)]) + ")" for r in chunk
        )
        d1(f"INSERT OR REPLACE INTO stock_basic ({','.join(columns)}) VALUES {values}")
        written += len(chunk)
    count = d1("SELECT COUNT(*) AS n, SUM(list_status='L') AS listed FROM stock_basic")[0]["results"][0]
    print(f"✅ 写入 {written} 行；表内共 {count['n']} 只，其中上市 {count['listed']} 只")


if __name__ == "__main__":
    main()
