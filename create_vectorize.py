import os
import requests

ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID")
API_TOKEN = os.getenv("CF_API_TOKEN")  # 从 dashboard 获取

headers = {"Authorization": f"Bearer {API_TOKEN}"}

# 1. 创建索引
resp = requests.post(
    f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/vectorize/v2/indexes",
    headers=headers,
    json={
        "name": "stock-knowledge",
        "description": "Stock knowledge base",
        "config": {"dimensions": 384, "metric": "cosine"}
    }
)
print("创建索引:", resp.json())

# 2. 创建元数据索引
for prop, ptype in [
    ("ts_code", "string"),
    ("title", "string"),
    ("publish_date", "string"),
    ("source_type", "string"),
    ("stock_name", "string"),
]:
    resp = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/stock-knowledge/metadata_index/create",
        headers=headers,
        json={"propertyName": prop, "indexType": ptype}
    )
    print(f"元数据索引 {prop}: {resp.status_code} - {resp.text}")
