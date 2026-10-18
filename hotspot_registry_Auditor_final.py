import os
import json
import time
import requests
from openai import OpenAI

# --- 配置提取 ---
# AI_ENGINE = "BAILIAN"  # 开关: "OLLAMA" 或 "BAILIAN" 或 "WORKERS_AI"；改回 BAILIAN 用下面这行并注释掉 WORKERS_AI
AI_ENGINE = "WORKERS_AI"
OLLAMA_MODEL = "qwen3:14b"
BAILIAN_MODEL = "qwen3.5-flash"
WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.6"
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY")
CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID")
CF_AIG_TOKEN = os.getenv("CF_AIG_TOKEN")
AI_BASE_URL = os.getenv("AI_BASE_URL")  # 容器内走出站处理器（ai.internal）；未设置时直连 AI Gateway
AI_API_KEY = os.getenv("AI_API_KEY") or os.getenv("CLOUDFLARE_API_TOKEN") or ""

D1_API_URL = os.getenv("D1_API_URL", "https://stock-api.righttu.uk")
CF_ACCESS_CLIENT_ID = os.getenv('CF_ACCESS_CLIENT_ID')
CF_ACCESS_CLIENT_SECRET = os.getenv('CF_ACCESS_CLIENT_SECRET')

class CloudAPIClient:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip('/')
        self.headers = {
            'Content-Type': 'application/json',
            'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
            'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
        }

    def _post(self, path, payload):
        resp = requests.post(f'{self.base_url}{path}', json=payload, headers=self.headers, timeout=30)
        data = resp.json()
        if not data.get('success'):
            raise Exception(data.get('error', f'API call failed: {path}'))
        return data

class RegistryAuditor:
    def __init__(self):
        self.api = CloudAPIClient(D1_API_URL)
        self._init_ai_client()
        
    def _init_ai_client(self):
        if AI_ENGINE == "WORKERS_AI":
            base_url = AI_BASE_URL or f"https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/ai-gateway/workers-ai/v1"
            if not AI_BASE_URL and not AI_API_KEY:
                print("❌ 未设置 AI_API_KEY / CLOUDFLARE_API_TOKEN（直连 AI Gateway 需要）"); exit(1)
            self.client = OpenAI(
                api_key=AI_API_KEY or "unused",
                base_url=base_url,
                timeout=1800,
                max_retries=0,
                default_headers=(
                    {"cf-aig-authorization": f"Bearer {CF_AIG_TOKEN}"} if CF_AIG_TOKEN else {}
                )
            )
            self.active_model = WORKERS_AI_MODEL
        elif AI_ENGINE == "BAILIAN":
            if not DASHSCOPE_API_KEY:
                print("❌ 未设置环境变量 DASHSCOPE_API_KEY"); exit(1)
            self.client = OpenAI(
                api_key=DASHSCOPE_API_KEY,
                base_url="https://dashscope.aliyuncs.com/compatible-mode/v1"
            )
            self.active_model = BAILIAN_MODEL
        else:
            self.client = OpenAI(api_key="ollama", base_url="http://localhost:11434/v1")
            self.active_model = OLLAMA_MODEL

    def get_pending_tasks(self):
        """取出所有 purity 字段为空的标的"""
        resp = self.api._post('/api/db/query', {
            'sql': """
                SELECT ts_code, sector, node, name, em_reason, ts_main_biz
                FROM hotspot_registry
                WHERE purity = '' OR purity IS NULL
            """
        })
        return [(
            row.get('ts_code'), row.get('sector'), row.get('node'),
            row.get('name'), row.get('em_reason'), row.get('ts_main_biz')
        ) for row in resp.get('results', [])]

    def audit_one(self, name, reason, biz, node):
        """执行 AI 启发式审计"""
        prompt = f"""
你是一名资深的科技股分析师，擅长穿透表面的概念，识别产业链标的的真实业务深度。
请对比提供的【主营业务】与【入选理由】，对该标的进行深度审计。

【公司名称】：{name}
【主营业务】：{biz}
【入选理由】：{reason}
【题材】：{node}

【启发式审计准则】:
1. 证据权重高于文字游戏：留意理由中是否包含“量产”、“送样”、“验证”、“中标”或“协同研发”等实质性动作。
2. 逻辑一致性评估：利用你对行业的了解，评估入选理由提到的产品是否与公司原有技术积累存在逻辑关联。
3. 含金量分类:
   - 真题材: 已产生业务实质（供货/量产/核心环节/小批量出货/已通过客户验证）。
   - 待观察: 正在攻关核心技术、联合研发或处于验证期，有明确动作但尚未贡献营收。
   - 蹭热点: 仅关注、表态、或入选理由纯是蹭热点与题材无实质相关性也无题材相关的产品

请务必分析该题材是否由原主营迁移而来，迁移难度，对业绩影响，是否适合炒预期。

请严格按以下 JSON 格式输出:
{{"purity": "真题材/待观察/蹭热点", "remark": "你的推导理由"}}
"""
        try:
            response = self.client.chat.completions.create(
                model=self.active_model,
                messages=[{"role": "user", "content": prompt}],
                # Workers AI/Kimi 不支持 response_format，提示词已要求 JSON；
                # thinking 关闭以保证输出稳定与时延
                **({"response_format": {"type": "json_object"}} if AI_ENGINE != "WORKERS_AI" else {}),
                extra_body=(
                    {"chat_template_kwargs": {"thinking": False}}
                    if AI_ENGINE == "WORKERS_AI" else {}
                )
            )
            res_content = response.choices[0].message.content
            if AI_ENGINE == "WORKERS_AI":
                res_content = res_content.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            return json.loads(res_content)
        except Exception as e:
            print(f"❌ AI 推理失败 ({name}): {e}")
            return None

    def update_db(self, ts_code, sector, node, purity, ai_remark):
        """精准回写回数据库"""
        # 按照要求格式：真题材|node|ai_remark
        combined_content = f"{purity}|{node}|{ai_remark}"
        self.api._post('/api/db/execute', {
            'sql': """
                UPDATE hotspot_registry
                SET purity = ?, remark = ?
                WHERE ts_code = ? AND sector = ? AND node = ?
            """,
            'params': [purity, combined_content, ts_code, sector, node]
        })

    def run(self):
        tasks = self.get_pending_tasks()
        if not tasks:
            print("✨ 没有待审计的任务。")
            return

        print(f"🚀 开始审计 {len(tasks)} 条记录 (Engine: {AI_ENGINE})...")
        for ts_code, sector, node, name, reason, biz in tasks:
            print(f"🔍 正在审计: {name} | {node}...", end="\r")
            
            result = self.audit_one(name, reason, biz, node)
            if result:
                self.update_db(ts_code, sector, node, result['purity'], result['remark'])
                print(f"✅ {name} 审计完成: {result['purity']}      ")
            
            # 阿里接口建议稍微留点间隔，避免QPS过载
            if AI_ENGINE == "BAILIAN": time.sleep(0.5)

if __name__ == "__main__":
    auditor = RegistryAuditor()
    auditor.run()
