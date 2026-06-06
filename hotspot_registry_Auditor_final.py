import sqlite3
import os
import json
import time
from openai import OpenAI

# --- 配置提取 ---
AI_ENGINE = "BAILIAN"  # 开关: "OLLAMA" 或 "BAILIAN"
OLLAMA_MODEL = "qwen3:14b"
BAILIAN_MODEL = "qwen3.5-flash"
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY")

class RegistryAuditor:
    def __init__(self):
        self.db_path = 'quant_data.db'
        self._init_ai_client()
        
    def _init_ai_client(self):
        if AI_ENGINE == "BAILIAN":
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
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        # 提取复合主键(ts_code, sector, node)及素材
        cursor.execute("""
            SELECT ts_code, sector, node, name, em_reason, ts_main_biz 
            FROM hotspot_registry 
            WHERE purity = '' OR purity IS NULL
        """)
        tasks = cursor.fetchall()
        conn.close()
        return tasks

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
                response_format={ "type": "json_object" } # 强制要求 JSON
            )
            res_content = response.choices[0].message.content
            return json.loads(res_content)
        except Exception as e:
            print(f"❌ AI 推理失败 ({name}): {e}")
            return None

    def update_db(self, ts_code, sector, node, purity, ai_remark):
        """精准回写回数据库"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        # 按照要求格式：真题材|node|ai_remark
        combined_content = f"{purity}|{node}|{ai_remark}"
        cursor.execute("""
            UPDATE hotspot_registry 
            SET purity = ?, remark = ? 
            WHERE ts_code = ? AND sector = ? AND node = ?
        """, (purity, combined_content, ts_code, sector, node))
        conn.commit()
        conn.close()

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
