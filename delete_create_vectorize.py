import os
import requests
import json

# ================= 配置 =================
ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID")
API_TOKEN = os.getenv("CF_API_TOKEN")  # 需要有 Vectorize 编辑权限
INDEX_NAME = 'stock-knowledge'
BASE_URL = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/vectorize/v2/indexes'

HEADERS = {
    'Authorization': f'Bearer {API_TOKEN}',
    'Content-Type': 'application/json'
}

def delete_index():
    """删除旧的 384 维索引"""
    print(f"🗑️ 正在删除索引: {INDEX_NAME} ...")
    resp = requests.delete(f'{BASE_URL}/{INDEX_NAME}', headers=HEADERS)
    data = resp.json()
    if data.get('success'):
        print(f"✅ 索引 {INDEX_NAME} 已删除")
    else:
        errors = data.get('errors', [])
        print(f"❌ 删除失败: {errors}")

def create_index():
    """创建新的 512 维索引"""
    print(f"🆕 正在创建索引: {INDEX_NAME} (512维, cosine) ...")
    payload = {
        "name": INDEX_NAME,
        "description": "Stock knowledge vector database",
        "config": {
            "dimensions": 512,
            "metric": "cosine"
        }
    }
    resp = requests.post(BASE_URL, headers=HEADERS, json=payload)
    data = resp.json()
    if data.get('success'):
        print(f"✅ 索引 {INDEX_NAME} 创建成功")
        print(f"   详情: {json.dumps(data.get('result'), indent=2, ensure_ascii=False)}")
    else:
        errors = data.get('errors', [])
        print(f"❌ 创建失败: {errors}")

def create_metadata_indexes():
    """创建 metadata 索引（filter 查询必须）"""
    metadata_indexes = [
        {"propertyName": "title", "indexType": "string"},
        {"propertyName": "publish_date", "indexType": "string"},
        {"propertyName": "ts_code", "indexType": "string"},
    ]
    for mi in metadata_indexes:
        prop = mi['propertyName']
        print(f"📇 正在创建 metadata 索引: {prop} ...")
        resp = requests.post(
            f'{BASE_URL}/{INDEX_NAME}/metadata_index/create',
            headers=HEADERS,
            json=mi
        )
        data = resp.json()
        if data.get('success'):
            print(f"   ✅ metadata 索引 {prop} 创建成功")
        else:
            errors = data.get('errors', [])
            print(f"   ❌ metadata 索引 {prop} 创建失败: {errors}")

if __name__ == '__main__':
    # 1. 删除旧索引
    delete_index()
    
    # 2. 创建新索引
    create_index()
    
    # 3. 创建 metadata 索引
    create_metadata_indexes()
    
    print("\n🎉 全部完成！")
