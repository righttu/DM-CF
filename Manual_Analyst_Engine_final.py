import datetime
import sqlite3
import pandas as pd
from sqlalchemy import create_engine
import traceback

# 导入原有模块
from chip_hunter_db_final import ChipHunterStrategy, MY_TOKEN, DB_PATH

class ManualAnalystEngine:
    def __init__(self):
        print("🔧 [System] 初始化手动诊断引擎...")
        self.hunter = ChipHunterStrategy(MY_TOKEN)
        # 提取数据库路径字符串 (处理 sqlite:/// 协议头)
        self.db_file = 'quant_data.db' 
        self.engine = create_engine(DB_PATH)
        # 自动初始化影子表
        self._init_manual_table()

    def _init_manual_table(self):
        """克隆 chip_hunter 结构创建 manual_hunter 影子表"""
        try:
            conn = sqlite3.connect(self.db_file)
            # 检查 manual_hunter 是否存在，不存在则根据 chip_hunter 克隆结构
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='manual_hunter'")
            if not cursor.fetchone():
                print("📝 [Database] 正在创建 manual_hunter 影子表...")
                conn.execute("CREATE TABLE manual_hunter AS SELECT * FROM chip_hunter WHERE 1=0")
                conn.execute("CREATE UNIQUE INDEX idx_manual_ts_code ON manual_hunter (ts_code)")
            conn.close()
        except Exception as e:
            print(f"⚠️ [Database] 初始化影子表提示: {e}")

    def run_diagnostic(self, ts_code):
        """执行单股全流程穿透分析"""
        print(f"\n{'='*50}\n🎯 开始对 {ts_code} 进行深度诊断\n{'='*50}")
        
        # ---------------------------------------------------------
        # 1. 获取数据 (调用重构后的 Hunter)
        # ---------------------------------------------------------
        data_dict = self.hunter.get_single_stock_full_data(ts_code)
        
        # 拦截检查：如果 Hunter 返回了错误字典 (G增速或换手不达标)
        if isinstance(data_dict, dict) and "error" in data_dict:
            print(f"❌ [Logic] {data_dict['error']}")
            return data_dict

        # 获取格式化后的 ts_code (防止用户输入不带后缀的情况)
        final_code = data_dict['ts_code']

        # ---------------------------------------------------------
        # 2. 影子入库 (写入 manual_hunter)
        # ---------------------------------------------------------
        try:
            with sqlite3.connect(self.db_file) as conn:
                # 预清理：确保该股在影子表中只有一份最新快照
                conn.execute("DELETE FROM manual_hunter WHERE ts_code = ?", (final_code,))
            
            # 补充必要元数据
            data_dict['source_strategy'] = "Manual"
            data_dict['scan_date'] = datetime.datetime.now().strftime('%Y%m%d')
            data_dict['create_time'] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            
            # 写入数据库
            df = pd.DataFrame([data_dict])
            df.to_sql('manual_hunter', self.engine, if_exists='append', index=False)
            print(f"✅ [Step 1/3] 核心数据已计入影子表 (Source: Manual)")
        except Exception as e:
            error_msg = f"写入影子表失败: {str(e)}"
            print(f"❌ {error_msg}")
            return {"error": error_msg}

        # ---------------------------------------------------------
        # 3. 驱动 Miner (知识库补全)
        # ---------------------------------------------------------
        print(f"🕵️ [Step 2/3] 启动 KnowledgeMiner 抓取最新研报...")
        try:
            # 动态导入防止循环依赖
            from knowledge_miner_final import KnowledgeMiner
            miner = KnowledgeMiner()
            # 执行单股抓取与向量化 (假设函数名为 mine_single_stock)
            miner.mine_single_stock(final_code)
        except Exception as e:
            print(f"⚠️ [Miner] 研报抓取环节非致命异常: {e}")

        # ---------------------------------------------------------
        # 4. 驱动 Brain (AI 生成报告)
        # ---------------------------------------------------------
        print(f"🧠 [Step 3/3] 启动 AnalystBrain 生成深度诊断报告...")
        try:
            from analyst_brain_v5 import AnalystBrain
            brain = AnalystBrain()
            # 强制 Brain 分析影子表中的数据
            # 假设你的 Brain 接受指定代码和来源参数
            brain_res = brain.run_analysis(specified_code=final_code, source="Manual")
            print(f"✅ [Brain] AI 分析完成")
        except Exception as e:
            traceback.print_exc()
            error_msg = f"AI分析执行失败: {str(e)}"
            print(f"❌ {error_msg}")
            return {"error": error_msg}

        print(f"\n✨ {final_code} 穿透诊断圆满完成！")
        return {"success": True, "msg": f"{final_code} 诊断成功，请在结果列表中查阅。"}

if __name__ == "__main__":
    # 测试脚本
    engine = ManualAnalystEngine()
    # 你可以修改下面的代码进行直接测试
    test_code = "600031" # 自动补全为 600031.SH
    res = engine.run_diagnostic(test_code)
    print(res)
