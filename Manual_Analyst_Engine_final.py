import datetime
import math
import traceback
import pandas as pd

# 导入原有模块
from chip_hunter_db_final import ChipHunterStrategy, MY_TOKEN, CloudAPIClient, D1_API_URL

class ManualAnalystEngine:
    def __init__(self):
        print("🔧 [System] 初始化手动诊断引擎...")
        self.hunter = ChipHunterStrategy(MY_TOKEN)
        self.api = CloudAPIClient(D1_API_URL)
        self._init_manual_table()

    def _init_manual_table(self):
        """创建 manual_hunter 影子表 (每代码仅保留一份最新快照)"""
        create_sql = """
            CREATE TABLE IF NOT EXISTS manual_hunter (
                ts_code TEXT PRIMARY KEY, name TEXT, industry TEXT, close REAL,
                turnover_rate_3d REAL, industry_turnover_rate_3d REAL,
                pe_ttm REAL, pe_ttm_percentile REAL, industry_pe_ttm_median REAL,
                peg REAL, pb REAL, pb_percentile REAL, industry_pb_median REAL,
                ps_ttm REAL, total_mv REAL, net_inflow_5d REAL,
                chip_cumu_change REAL, chip_latest_change REAL,
                forecast_eps_fy1 REAL, forecast_eps_fy2 REAL, con_growth_rate REAL,
                tags TEXT, scan_date TEXT, create_time TEXT
            )
        """
        try:
            self.api._post('/api/db/execute', {'sql': create_sql})
        except Exception as e:
            print(f"⚠️ [Database] 初始化影子表提示: {e}")
            raise RuntimeError(f"manual_hunter D1 建表失败: {e}") from e

    def _normalize_ts_code(self, ts_code):
        ts_code = str(ts_code).strip()
        if '.' in ts_code:
            return ts_code
        if ts_code.startswith(('6', '9')):
            return f"{ts_code}.SH"
        if ts_code.startswith(('0', '3')):
            return f"{ts_code}.SZ"
        if ts_code.startswith(('8', '4')):
            return f"{ts_code}.BJ"
        return ts_code

    def _analysis_exists(self, ts_code):
        today = datetime.datetime.now().strftime('%Y%m%d')
        try:
            resp = self.api._post('/api/db/query', {
                'sql': 'SELECT 1 FROM ai_analysis_result WHERE report_date = ? AND ts_code = ?',
                'params': [today, ts_code]
            })
        except Exception as e:
            if 'no such table' in str(e):
                return False
            raise
        return bool(resp.get('results'))

    def _safe_value(self, value):
        if value is None:
            return None
        try:
            if pd.isna(value):
                return None
        except (TypeError, ValueError):
            pass
        if hasattr(value, 'item'):
            try:
                value = value.item()
            except (TypeError, ValueError):
                pass
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value

    def _save_manual_record(self, data_dict):
        columns = [
            'ts_code', 'name', 'industry', 'close',
            'turnover_rate_3d', 'industry_turnover_rate_3d',
            'pe_ttm', 'pe_ttm_percentile', 'industry_pe_ttm_median',
            'peg', 'pb', 'pb_percentile', 'industry_pb_median',
            'ps_ttm', 'total_mv', 'net_inflow_5d',
            'chip_cumu_change', 'chip_latest_change',
            'forecast_eps_fy1', 'forecast_eps_fy2', 'con_growth_rate',
            'tags', 'scan_date', 'create_time'
        ]
        params = [self._safe_value(data_dict.get(col)) for col in columns]
        sql = (
            f"INSERT OR REPLACE INTO manual_hunter ({', '.join(columns)}) "
            f"VALUES ({','.join(['?'] * len(columns))})"
        )
        self.api._post('/api/db/execute', {'sql': sql, 'params': params})

    def run_diagnostic(self, ts_code):
        """执行单股全流程穿透分析"""
        print(f"\n{'='*50}\n🎯 开始对 {ts_code} 进行深度诊断\n{'='*50}")

        normalized = self._normalize_ts_code(ts_code)

        if self._analysis_exists(normalized):
            print(f"⏭️ [Skip] {normalized} 今日已存在 AI 报告，跳过全流程。")
            return {'status': 'skipped', 'success': False, 'ts_code': normalized, 'msg': '今日已有AI报告'}

        # ---------------------------------------------------------
        # 1. 获取数据 (调用重构后的 Hunter)
        # ---------------------------------------------------------
        data_dict = self.hunter.get_single_stock_full_data(normalized)

        # 拦截检查：如果 Hunter 返回了错误字典 (G增速或换手不达标)
        if isinstance(data_dict, dict) and "error" in data_dict:
            print(f"❌ [Logic] {data_dict['error']}")
            return {'status': 'error', 'success': False, 'ts_code': normalized,
                    'error': data_dict.get('reason', data_dict['error'])}

        if not isinstance(data_dict, dict) or not data_dict.get('ts_code') or not data_dict.get('name'):
            return {'status': 'error', 'success': False, 'ts_code': normalized,
                    'error': 'Hunter 未返回有效的标的字典'}

        # 获取格式化后的 ts_code (防止用户输入不带后缀的情况)
        final_code = data_dict['ts_code']
        stock_name = data_dict['name']

        # ---------------------------------------------------------
        # 2. 驱动 Miner (知识库补全) - 失败即终止
        # ---------------------------------------------------------
        print(f"🕵️ [Step 2/3] 启动 KnowledgeMiner 抓取最新研报...")
        try:
            from knowledge_miner_final import KnowledgeMiner
            miner = KnowledgeMiner()
            added_count = miner.mine_single_stock(final_code, stock_name)
        except Exception as e:
            traceback.print_exc()
            error_msg = f"Miner 抓取失败，终止本次诊断: {e}"
            print(f"❌ {error_msg}")
            return {'status': 'error', 'success': False, 'ts_code': final_code, 'error': error_msg}

        # ---------------------------------------------------------
        # 3. 影子入库 (写入 manual_hunter)
        # ---------------------------------------------------------
        data_dict['source_strategy'] = "Manual"
        data_dict['scan_date'] = datetime.datetime.now().strftime('%Y%m%d')
        data_dict['create_time'] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        try:
            self._save_manual_record(data_dict)
            print(f"✅ [Step 1/3] 核心数据已计入影子表 (Source: Manual)")
        except Exception as e:
            error_msg = f"写入影子表失败: {str(e)}"
            print(f"❌ {error_msg}")
            return {'status': 'error', 'success': False, 'ts_code': final_code, 'error': error_msg}

        # ---------------------------------------------------------
        # 4. 驱动 Brain (AI 生成报告)
        # ---------------------------------------------------------
        print(f"🧠 [Step 3/3] 启动 AnalystBrain 生成深度诊断报告...")
        try:
            from ai_analyst_infra_final import DBLoader, RAGRetriever
            from ai_analyst_Brain_final import AnalystBrain
            db = DBLoader(D1_API_URL)
            rag = RAGRetriever()
            brain = AnalystBrain()
            brain_result = brain.analyze_and_save(data_dict, db, rag, skip_if_exists=True)
        except Exception as e:
            traceback.print_exc()
            error_msg = f"AI分析执行失败: {str(e)}"
            print(f"❌ {error_msg}")
            return {'status': 'error', 'success': False, 'ts_code': final_code, 'error': error_msg}

        if brain_result.get('status') == 'success':
            print(f"\n✨ {final_code} 穿透诊断圆满完成！")
            return {'status': 'success', 'success': True, 'ts_code': final_code,
                    'brain': brain_result, 'miner_chunks': added_count}
        if brain_result.get('status') == 'skipped':
            print(f"⏭️ [Skip] {final_code} 今日已存在 AI 报告 (竞态命中)。")
            return {'status': 'skipped', 'success': False, 'ts_code': final_code, 'msg': '今日已有AI报告'}
        return {'status': 'error', 'success': False, 'ts_code': final_code,
                'error': brain_result.get('error', 'AI 分析未返回有效结论')}

if __name__ == "__main__":
    # 测试脚本
    engine = ManualAnalystEngine()
    # 你可以修改下面的代码进行直接测试
    test_code = "600031" # 自动补全为 600031.SH
    res = engine.run_diagnostic(test_code)
    print(res)
