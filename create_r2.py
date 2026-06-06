# 用之前的 Python 脚本方式
import requests

ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID")
API_TOKEN = os.getenv("R2_API_TOKEN")
headers = {"Authorization": f"Bearer {API_TOKEN}"}

resp = requests.post(
    f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/r2/buckets",
    headers=headers,
    json={"name": "stock-documents"}
)
print(resp.json())
