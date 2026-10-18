# ==============================================================================
# 📂 File: AI_Analyst_Brain_final.py
# 📦 Version: Ollama+Bailian v1.2 (Strict SDK & Prompt Integrity)
# 📅 Last Updated: 2026-02-16
# ==============================================================================

import json
import datetime
import re
import os
import pandas as pd
import math
from tqdm import tqdm
from openai import OpenAI  # 标准 SDK 迁移
import requests

try:
    from ai_analyst_infra_final import DBLoader, RAGRetriever
except ImportError:
    print("❌ 错误: 找不到 ai_analyst_infra_final.py")
    exit(1)

# ================= 配置区 =================
# AI_ENGINE = "BAILIAN"  # 开关: "OLLAMA" 或 "BAILIAN" 或 "WORKERS_AI"；改回 BAILIAN 用下面这行并注释掉 WORKERS_AI
AI_ENGINE = "WORKERS_AI"
OLLAMA_MODEL = "qwen3:14b"
BAILIAN_MODEL = "qwen3.8-2.4t-a95b"
WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.6"
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY") # 从环境变量读取
AI_BASE_URL = os.getenv("AI_BASE_URL")  # 容器内走出站处理器（ai.internal）；未设置时直连 AI Gateway
AI_API_KEY = os.getenv("AI_API_KEY") or os.getenv("CLOUDFLARE_API_TOKEN") or ""
CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID")
CF_AIG_TOKEN = os.getenv("CF_AIG_TOKEN")
CF_ACCESS_CLIENT_ID = os.getenv("CF_ACCESS_CLIENT_ID")
CF_ACCESS_CLIENT_SECRET = os.getenv("CF_ACCESS_CLIENT_SECRET")
STOCK_API_BASE = os.getenv("D1_API_URL", "https://stock-api.righttu.uk")



class AnalystBrain:
    def __init__(self):
        print(f"🤖 初始化 AI 分析师 (Brain v1.2 - Engine: {AI_ENGINE})...")
        self.init_db()
        self._init_ai_client()

    def _init_ai_client(self):
        """标准化 SDK 初始化"""
        if AI_ENGINE == "WORKERS_AI":
            base_url = AI_BASE_URL or f"https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/ai-gateway/workers-ai/v1"
            if not AI_BASE_URL and not AI_API_KEY:
                print("❌ 错误: 未设置 AI_API_KEY / CLOUDFLARE_API_TOKEN（直连 AI Gateway 需要）")
                exit(1)
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
                print("❌ 错误: 未设置环境变量 DASHSCOPE_API_KEY")
                exit(1)
            if not CF_AIG_TOKEN:
                print("❌ 错误: 未设置环境变量 CF_AIG_TOKEN")
                exit(1)

            self.client = OpenAI(
                api_key=DASHSCOPE_API_KEY,
                base_url=f"https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/ai-gateway/custom-dashscope/compatible-mode/v1",
                default_headers={
                    "cf-aig-authorization": f"Bearer {CF_AIG_TOKEN}",
                    "cf-aig-metadata": json.dumps({"project": "PoC"})  #请求metadata中插入标签用于ai gateway中过虑分析
                }
            )

            self.active_model = BAILIAN_MODEL
        else:
            self.client = OpenAI(
                api_key="ollama",
                base_url="http://localhost:11434/v1"
            )
            self.active_model = OLLAMA_MODEL

    def init_db(self):
        headers = {
            "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
            "Content-Type": "application/json"
        }
        create_sql = '''
            CREATE TABLE IF NOT EXISTS ai_analysis_result (
                report_date TEXT, name TEXT, ts_code TEXT, industry TEXT, source_strategy TEXT,
                industry_heat TEXT, net_inflow_5d TEXT, current_price REAL, target_price REAL,
                upside_potential REAL, score_certainty INTEGER, final_score INTEGER,
                target_market_cap TEXT, forecast_net_profit TEXT, survey_count INTEGER,
                org_count INTEGER, famous_orgs TEXT, moat_summary TEXT, 
                chip_cumu_change TEXT, chip_latest_change TEXT, netprofit_margin TEXT, 
                ai_report TEXT, update_time TEXT, tags TEXT,
                PRIMARY KEY (report_date, ts_code)
            )
        '''
        resp = requests.post(
            f"{STOCK_API_BASE}/api/db/execute",
            headers=headers,
            json={"sql": create_sql}
        )
        if not resp.json().get("success"):
            print(f"❌ D1 建表失败: {resp.json().get('error')}")
        else:
            print("✅ D1 建表成功 (ai_analysis_result)")

    def _save_prompt_log(self, ts_code, name, content):
        timestamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        key = f"prompt_logs/{timestamp}_{ts_code}_{name}_data.txt"
        try:
            headers = {
                "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
                "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
            }
            resp = requests.post(
                f"{STOCK_API_BASE}/api/r2/upload",
                headers=headers,
                files={"file": (key, content.encode("utf-8"), "text/plain")},
                data={"key": key}
            )
            if not resp.json().get("success"):
                print(f"⚠️ Prompt日志上传R2失败: {resp.json().get('error')}")
        except Exception as e:
            print(f"⚠️ Prompt日志上传R2异常: {e}")

    def _safe_float(self, val):
        try:
            if val is None: return 0.0
            f = float(val)
            return 0.0 if math.isnan(f) else f
        except: return 0.0

    def _safe_fmt(self, val, suffix="", is_price=False):
        if val is None: return "N/A"
        try:
            if isinstance(val, float) and math.isnan(val): return "N/A"
        except: pass
        s_val = str(val).lower()
        if s_val == 'nan' or s_val == 'none': return "N/A"
        if is_price:
            try: return f"{float(val):.2f}{suffix}"
            except: pass
        return f"{val}{suffix}"

    def _safe_yi(self, val):
         """将巨额的'元'转化为'亿元'，防止 AI 产生数字幻觉"""
         try:
             if val is None: return "N/A"
             f = float(val)
             if math.isnan(f): return "N/A"
             return f"{f / 100000000:.2f}亿"
         except: return "N/A"

    def calculate_trends(self, ts_code):
        try:
            headers = {
                "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
                "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
                "Content-Type": "application/json"
            }
            query = "SELECT end_date, q_sales_yoy, q_netprofit_yoy FROM stock_fundamentals WHERE ts_code=? ORDER BY end_date DESC LIMIT 5"
            resp = requests.post(
                f"{STOCK_API_BASE}/api/db/query",
                headers=headers,
                json={"sql": query, "params": [ts_code]}
            )
            data = resp.json()
            if not data.get("success") or not data.get("results"):
                return "暂无数据", "暂无数据"
            df = pd.DataFrame(data["results"])
            if df.empty: return "暂无数据", "暂无数据"
            df = df.iloc[::-1]
            rev_list, prof_list = [], []
            q_map = {'03':'Q1', '06':'Q2', '09':'Q3', '12':'Q4'}
            for _, r in df.iterrows():
                raw_date = str(r['end_date'])
                if len(raw_date) == 8:
                    label = f"{raw_date[2:4]}{q_map.get(raw_date[4:6], raw_date[4:6])}"
                else: label = raw_date
                rev_list.append(f"{label}({self._safe_fmt(r['q_sales_yoy'], '%', True)})")
                prof_list.append(f"{label}({self._safe_fmt(r['q_netprofit_yoy'], '%', True)})")
            return " -> ".join(rev_list), " -> ".join(prof_list)
        except Exception as e:
            print(f"趋势计算出错: {e}"); return "计算错误", "计算错误"

    def generate_analysis(self, hunter_data, fund_data, context, survey_data, current_date):
        rev_trend, prof_trend = self.calculate_trends(hunter_data['ts_code'])
        curr_p_raw = self._safe_float(hunter_data.get('close'))
        pe_t_raw = self._safe_float(hunter_data.get('pe_ttm'))
        raw_mv = self._safe_float(hunter_data.get('total_mv'))
        mv_yi = raw_mv / 10000 if raw_mv > 10000 else raw_mv
        eps_ttm_val = curr_p_raw / pe_t_raw if pe_t_raw != 0 else None
        
        # 🌟 终极进化：计算 NTM_EPS，抹除自然年概念
        try:
            day_of_year = datetime.datetime.now().timetuple().tm_yday
            w1 = (365 - day_of_year) / 365.0
            w2 = day_of_year / 365.0
            eps1 = self._safe_float(hunter_data.get('forecast_eps_fy1'))
            eps2 = self._safe_float(hunter_data.get('forecast_eps_fy2'))
            eps_ntm = (eps1 * w1) + (eps2 * w2) if eps1 > 0 and eps2 > 0 else None
        except:
            eps_ntm = None

        d = {
            "name": hunter_data['name'], "ts_code": hunter_data['ts_code'], "industry": hunter_data['industry'],
            "close": self._safe_fmt(hunter_data.get('close'), is_price=True), 
            "total_mv": self._safe_fmt(mv_yi, is_price=True), 
            "pe_ttm": self._safe_fmt(hunter_data.get('pe_ttm'), is_price=True),
            "pe_ttm_percentile": self._safe_fmt(hunter_data.get('pe_ttm_percentile'), is_price=True),
            "eps_ttm": self._safe_fmt(eps_ttm_val, is_price=True), # <-- 字典里加这一行
            "industry_pe_ttm_median": self._safe_fmt(hunter_data.get('industry_pe_ttm_median'), is_price=True),
            "pb": self._safe_fmt(hunter_data.get('pb'), is_price=True),
            "pb_percentile": self._safe_fmt(hunter_data.get('pb_percentile'), is_price=True),
            "industry_pb_median": self._safe_fmt(hunter_data.get('industry_pb_median'), is_price=True),
            "ps_ttm": self._safe_fmt(hunter_data.get('ps_ttm'), is_price=True),
            "peg": self._safe_fmt(hunter_data.get('peg'), is_price=True),
            "con_growth_rate": self._safe_fmt(hunter_data.get('con_growth_rate'), is_price=True),
            #"forecast_eps_fy1": self._safe_fmt(hunter_data.get('forecast_eps_fy1'), is_price=True), ----not used
            #"forecast_eps_fy2": self._safe_fmt(hunter_data.get('forecast_eps_fy2'), is_price=True),-----not used
            "eps_ntm": self._safe_fmt(eps_ntm, is_price=True),
            "turnover_rate_3d": self._safe_fmt(hunter_data.get('turnover_rate_3d'), is_price=True),
            "net_inflow_5d": self._safe_fmt(hunter_data.get('net_inflow_5d'), is_price=True),
            "industry_turnover_rate_3d": self._safe_fmt(hunter_data.get('industry_turnover_rate_3d'), is_price=True),
            "roe": self._safe_fmt(fund_data.get('roe'), is_price=True), 
            "roic": self._safe_fmt(fund_data.get('roic'), is_price=True),
            "grossprofit_margin": self._safe_fmt(fund_data.get('grossprofit_margin'), is_price=True),
            "netprofit_margin": self._safe_fmt(fund_data.get('netprofit_margin'), is_price=True),
            "tr_yoy": self._safe_fmt(fund_data.get('tr_yoy'), is_price=True),           # 累计营收同比,暂时未使用该指标
            "netprofit_yoy": self._safe_fmt(fund_data.get('netprofit_yoy'), is_price=True), # 累计净利同比,暂时未使用该指标
            "q_sales_yoy": self._safe_fmt(fund_data.get('q_sales_yoy'), is_price=True), # 单季营收同比 (核心动能)
            "q_netprofit_yoy": self._safe_fmt(fund_data.get('q_netprofit_yoy'), is_price=True), # 单季净利同比
            "debt_to_assets": self._safe_fmt(fund_data.get('debt_to_assets'), is_price=True),
            #"n_cashflow_act": self._safe_fmt(fund_data.get('n_cashflow_act'), is_price=True), #多余，待删除
            "n_cashflow_act": self._safe_yi(fund_data.get('n_cashflow_act')),        #绝对金额的单位转换亿元防幻觉
            # 【新增】增加 Schema 中的核心绝对值和风险指标
            "revenue": self._safe_yi(fund_data.get('revenue')),              # 营收规模  #绝对金额的单位转换亿元防幻觉 
            "q_dtprofit": self._safe_yi(fund_data.get('q_dtprofit')),        # 单季扣非  #绝对金额的单位转换亿元防幻觉
            "profit_dedt": self._safe_yi(fund_data.get('profit_dedt')),      # 全年扣非  #绝对金额的单位转换亿元防幻觉
            "ebitda": self._safe_yi(fund_data.get('ebitda')),                # 全年扣非  #绝对金额的单位转换亿元防幻觉
            "int_exp": self._safe_yi(fund_data.get('int_exp')),              # 利息压力  #绝对金额的单位转换亿元防幻觉
            "rd_exp": self._safe_yi(fund_data.get('rd_exp')),                # 研发护城河  #绝对金额的单位转换亿元防幻觉
            "eps": self._safe_fmt(fund_data.get('eps'), is_price=True),                   # 每股收益 (原 basic_eps)
            "ar_turn": self._safe_fmt(fund_data.get('ar_turn'), is_price=True),           # 应收周转
            "quick_ratio": self._safe_fmt(fund_data.get('quick_ratio'), is_price=True),    # 风险红线
            "dv_ratio": self._safe_fmt(fund_data.get('dv_ratio'), suffix="%", is_price=True), # 分红
            "report_summary": context,
            "rev_trend_str": rev_trend,
            "profit_trend_str": prof_trend,
            "survey_date": survey_data.get('active_days', 0),
            "org_count": survey_data.get('total_orgs', 0),
            "org_names": survey_data.get('famous_orgs', '无')
        }

        industry_anchors_str = f"行业PE中位数: {d['industry_pe_ttm_median']}, 行业PB中位数: {d['industry_pb_median']}"

        # 🚀 100% 完整继承 V9.6 提示符
        full_prompt = f"""
# Role: 资深基金经理 (Senior Portfolio Manager)
## 🕒 当前分析基准日: {current_date}

## 🎯 任务
基于提供的【财务数据】、【一致预测】和【资金博弈】数据，对目标公司 `{d['name']}` ({d['ts_code']}) 进行深度投资价值分析。

## 📊 输入数据 

**1. 标的画像**
* **基本信息**: {d['name']} ({d['ts_code']}) | 行业: {d['industry']}
* **当前价格**: {d['close']} 元 | 总市值: {d['total_mv']} 亿
* **研报摘要**: {d['report_summary']}

**2. 估值锚点**
* **PE-TTM (动态市盈率)**: {d['pe_ttm']} (处于近5年 {d['pe_ttm_percentile']}% 分位) | 行业中位数: {d['industry_pe_ttm_median']}
* **PB (市净率)**: {d['pb']} (处于近5年 {d['pb_percentile']}% 分位) | 行业中位数: {d['industry_pb_median']}
* **PS-TTM (市销率)**: {d['ps_ttm']}

**3. 未来预期 (基于动态滚动 12 个月 NTM 算法)**
* **基础盈利 EPS_ttm**: {d['eps_ttm']} 元
    （注：计算逻辑为 EPS_ttm = Close / PE_ttm）
* **动态滚动预期 EPS_ntm**: {d['eps_ntm']} 元
* **预期增长率 G_ntm**: {d['con_growth_rate']}%
    （注：计算逻辑为 G_ntm = (EPS_ntm - EPS_ttm) / abs(EPS_ttm)，已处理基数反转逻辑）
* **当前市场隐含 PEG (Implied PEG)**: {d['peg']}
    （注：计算逻辑为 PEG = (Close / EPS_ntm) / G_ntm。该值客观反映了当前股价对未来增长预期的兑现程度）

**4. 公司体质**
* **规模与真实盈利**: 本年累计营收: {d['revenue']} | 累计扣非净利: {d['profit_dedt']} | 单季扣非净利: {d['q_dtprofit']}  | EPS {d['eps']} 元
* **核心质量**: ROE {d['roe']}% | ROIC {d['roic']}% | 毛利率: {d['grossprofit_margin']}% | 净利率: {d['netprofit_margin']}%
* **风控与造血**: 资产负债率: {d['debt_to_assets']}% | 速动比率: {d['quick_ratio']} | 经营现金净流量: {d['n_cashflow_act']} 
* **估值调节因子**: 研发投入: {d['rd_exp']}  | EBITDA: {d['ebitda']}  | 利息支出: {d['int_exp']}  | 股息率: {d['dv_ratio']} | 应收账款周转率: {d['ar_turn']}

**5. 趋势侦探 (连续5个季度)**
* **营收动能 (单季营收同比)**: {d['rev_trend_str']}
* **利润动能 (单季净利同比)**: {d['profit_trend_str']}
   *(注: 格式为 '年份季度(同比增速)'。请重点观察序列的**斜率变化**：例如从 -20% 变为 -5% 视为"降幅收窄/边际改善"；从 10% 变为 5% 视为"增长失速")*

**6. 市场情绪与资金 (Sentiment)**
* **个股热度**: 3日换手率: {d['turnover_rate_3d']}% | 5日主力净流入: {d['net_inflow_5d']}万。（注：如数据反映有资金强力介入请在分析报告中特别指出，比如3日换手率>8%。）
* **板块热度**: 行业3日换手率: {d['industry_turnover_rate_3d']}%
* **机构调研**: 近90日机构调研情况: {d['survey_date']} (次数/日期) | 共有{d['org_count']}家机构 | 知名机构: {d['org_names']}

## 📝 分析指令
**重要提示：当你的分析结论引用了上述【输入数据】（特别是研报摘要、调研纪要）时，必须显式标注该信息的时间（例如：“据2025年10月研报...”），以佐证时效性。**
务必利用以上信息充分研读，逐一回答以下11大问题（不可跳过，内容越详实越好）：

1) 公司质地如何？
2) 行业前景及当前处于位置（底部、顶部、平稳、拐点）；
3) 公司处于产业链哪个环节，该环节在产业链中的占比如何，空间有多大，本公司市场份额如何，如果公司跨多个行业应分别看每个行的情况；
4) 未来12个月有无新增长点？（扩产、新业务、放量节奏）。
   **关键要求：** - 必须测算该增长点对营收、毛利润、净利润的贡献。
   - **预测EPS默认已包含这部分增长，若未包含这部分增长（比如受非预期、当初未知事件影响）,请按如下原则计算新的EPS：
      * **股本摊薄警报(Dilution Warning)**: 若涉及**“发行股份购买资产”**（如重大重组），**必须估算新增股本**（新增股数≈交易对价/当前股价）。
      * **计算公式**: 合并后EPS = (原利润+新增利润) / (**原股本+新增股本**)。**严禁**只加利润不加股本，防止EPS虚高。
5) 未来12个月内可见天花板？
6) 未来12个月内催化剂（事件、时点）；
7) 机构动向（调研频率、知名机构）;
8) 公司护城河是什么，坚固程度如何？公司产品属国产化替代吗，当前国产化替代率如何？
9) 是否发生质变（变好/变坏、诱因、解除预期）？
10) 其他风险及严重程度？
11) 综合结论（必须包含以下 A/B/C/D/E）：
   
   A. 计算前置规则：
   估值计算必须先执行此步，否则后续计算无效：
   - **常识性校验**: 在计算前，必须先验证输入数据的合理性，避开各类数据失真陷阱（比如在行业周期底的“高PE陷阱”、 行业周期顶的“低PE陷阱”、行业中位数明显偏离正常值等）。
     * **容错机制**: 若数据显著失真，请先以你的专业经验进行修正或切换至更合理的模型再计算，并说明纠正逻辑。
     * **硬性约束**: 若第4问存在“EPS 修正”，必须使用修正后的 EPS，严禁使用输入数据中的原始 EPS。
   - **溢折价硬约束**:
     * **溢价**: 若 ROE 或毛利率领先行业，可给予溢价。
     * **折价 (硬红线)**:
       * **负债红线**: “资产负债率” > 70%，必须折价。
       * **造血红线**: 若现金流为负或 N/A，必须额外折价。


   B. 估算路径选择 (基于行业常识与企业生命周期)： 
   请结合财务数据、研报内容以及行业常识在以下路径中选择最匹配的一种，并说明选择理由及拟采用的锚点，严禁在此处直接输出目标价。

   - **路径 A：重资产/周期复苏路径 (PB 锚定)**
     * **需同时满足**:
       1. 周期性行业，如航空、海运、光伏、猪肉、面板等。
       2. PB 分位数低（如 < 20%），且PE 为负或极高，或研报中明确指出处于底部反转。
       3. “经营现金净流量”已转正。
       4. “营收动能”边际向好。
      * **逻辑**: 以 PB 为主锚，给予 2-3倍 PB。
   - **路径 B：高成长/扩张期路径 (PS/PEG 复合)**
     * **需同时满足**:
       1. 标的处于渗透率提升期，属于轻资产行业如半导体、软件、新材料、创新药等。
       2. “营收动能”最近两个季度的数值均大于 25%，且毛利率>30%；“利润动能”稳中有升。
     * **逻辑**: PS为主，PEG 辅助核验增长成本。
   - **路径 C：平稳期/现金牛 (PE 锚定)**
     * **适用**: 营收增速平稳，相对处于稳定期。
     * **逻辑**: 以EPS_ntm为目标, 根据公司、行业现状结合 PE-TTM ，PE-TTM行业中位数、研报等数据，给予合理PE。
   - **公式 D：异常回归路径**
     * **适用**: 不符合上述 A、B、C 的特殊标的。
     * **逻辑**: 请根据你的常识采用最能满足该标的的计算方式进行估算，并注明“不适用给定路径选用xxx估算法”及说明理由。


   C. 目标价推导与动态校验（执行计算段）：
   基于所选路径进行详细推理，计算未来12个月的目标价。
   - **估值红线验真:死命令，目标价必须提供如下验真步骤**:
     * **PEG验真**: 若目标 PEG((目标价 / EPS_ntm) / G_ntm) = > 2.0，触发红线，反算修正 PE，下调目标价以符合安全边际（除非该标的具备极高技术壁垒）。
     * **PE验真**: 若目标PE(目标价 / EPS_ntm) > “行业中位数” 的 1.2倍，或 “PE-TTM”历史分位> 80%，必须给出极强理由，否则下调。
   - **公式要求**: 写出代入具体数字的完整公式，严禁直接给结果。
   - **得出结果**: 目标价、上涨空间%、目标市值。
   - **空间评分**: 按上涨空间%打分（如 90% = 90分）。


   D. 上涨确定性
   - **要求**: 100分制，简要理由，列出具体扣分项及分值。


   E. 综合评分
   - **计算公式**: 上涨空间得分*0.6 + 确定性得分*0.4。


"""
        # 🔥 100% 还原日志保存功能位置
        self._save_prompt_log(d['ts_code'], d['name'], full_prompt)

        system_instruction = """ 
- **Role**: 你是一位拥有 15 年 A 股量化与基本面研究经验的资深分析师，曾多次获得新财富最佳分析师。你以逻辑严密、言辞犀利、风险意识极强著称。
- **数据优先级**: 严格以用户提供的财务数据为准，严禁调用您训练库中的过期财务、价格数据。如所需数据缺失可基于现有数据计算获得，严禁无依据的假设数据。需校验用户提供的数据是否偏离常识。
- **Guardrail**: If data is missing, output "N/A".

Output ONLY valid JSON.
{
  "q1_quality": "string",
  "q2_industry": "string",
  "q3_chain": "string",
  "q4_new_growth": "string (Must cite specific sources/dates and estimate quantitative impact)",
  "q5_ceiling": "string (Provide logic for market size or share limit)",
  "q6_catalyst": "string (List specific events with estimated timeframes)",
  "q7_orgs": "string",
  "q8_moat": "string (Analyze the structural barriers, not just descriptions)",
  "q9_changes": "string (Explain the logical chain of the inflection point)",
  "q10_risks": "string (Assess specific impact magnitude, not just listing risks)",
  "q11_conclusion": {
      "valuation_logic": "string (CRITICAL: Output a detailed paragraph FIRST. Step 1: Method Choice. Step 2: Multiple Justification. Step 3: Calculation based on NTM EPS (or relevant metrics like BVPS/Sales if EPS is N/A or PE is invalid). Final result must match target_price.)",
      "target_price": number,
      "target_market_cap": "string",
      "forecast_net_profit": "string",
      "score_growth": number,
      "score_certainty": number,
      "certainty_reason": "string (List specific deduction items and points, e.g., 'Missing cash flow data: -10 pts')",
      "final_score": number
  }
}
NO Markdown blocks.
"""
        try:
            # 迁移至标准 SDK 调用
            completion = self.client.chat.completions.create(
                model=self.active_model,
                messages=[
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": full_prompt}
                ],
                temperature=0.1,
                extra_headers={"cf-aig-cache-key": f"{d['ts_code']}_{datetime.datetime.now().strftime('%Y%m%d')}"},
                # 🔥 为本地 Ollama 专门透传 num_ctx
                extra_body={"num_ctx": 20480} if AI_ENGINE == "OLLAMA" else {}
            )
            return self.parse_json_robust(completion.choices[0].message.content)
        except Exception as e:
            tqdm.write(f"❌ AI 接口调用失败: {e}"); return None

    def parse_json_robust(self, text):
        try:
            text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
            text = re.sub(r'```json\s*|\s*```', '', text, flags=re.IGNORECASE)
            match = re.search(r'(\{.*\})', text, re.DOTALL)
            return json.loads(match.group(1).replace('“', '"').replace('”', '"')) if match else None
        except: return None

    def analyze_and_save(self, hunter_data, db, rag, skip_if_exists=False, current_date=None):
        today = datetime.datetime.now().strftime('%Y%m%d')
        current_date = current_date or datetime.datetime.now().strftime('%Y年%m月%d日')
        ts_code = hunter_data['ts_code']
        stock_name = hunter_data['name']

        d1_headers = {
            "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
            "Content-Type": "application/json"
        }
        d1_query_url = f"{STOCK_API_BASE}/api/db/query"
        d1_execute_url = f"{STOCK_API_BASE}/api/db/execute"

        if skip_if_exists:
            dup_resp = requests.post(
                d1_query_url,
                headers=d1_headers,
                json={"sql": "SELECT 1 FROM ai_analysis_result WHERE report_date=? AND ts_code=?",
                      "params": [today, ts_code]}
            )
            dup_data = dup_resp.json()
            if not dup_data.get("success"):
                raise RuntimeError(f"查重失败 {ts_code}: {dup_data.get('error')}")
            if dup_data.get("results"):
                return {'status': 'skipped', 'ts_code': ts_code}

        # 🔥 [修复关键点1] 在循环内对每个标的实时提取资金/筹码变量，防止 None/nan
        ind_heat = self._safe_fmt(hunter_data.get('industry_turnover_rate_3d'), is_price=True)
        net_inflow = self._safe_fmt(hunter_data.get('net_inflow_5d'), is_price=True)
        chip_cumu = self._safe_fmt(hunter_data.get('chip_cumu_change'), is_price=True)
        chip_last = self._safe_fmt(hunter_data.get('chip_latest_change'), is_price=True)
        tags_val = hunter_data.get('tags', '') # 🔥 获取来自 hunter 表的 tags

        # 4. 获取背景数据
        fund_data = db.get_fundamentals(ts_code)
        surveys = db.get_survey_heat(ts_code)
        context = rag.retrieve_context(ts_code, stock_name)

        # 5. 调用 AI 分析 (generate_analysis 内部会自动保存 TXT 日志)
        res = self.generate_analysis(hunter_data, fund_data, context, surveys, current_date=current_date)

        if not res or 'q11_conclusion' not in res:
            return {'status': 'error', 'ts_code': ts_code, 'error': 'AI 分析未返回有效结论'}

        conc = res['q11_conclusion']

        # 计算上涨空间与得分
        curr_price = self._safe_float(hunter_data.get('close'))
        target_price = self._safe_float(conc.get('target_price'))
        upside_val = 0.0
        if curr_price > 0 and target_price > 0:
            upside_val = round(((target_price - curr_price) / curr_price) * 100, 2)

        score_growth = upside_val
        score_certainty = self._safe_float(conc.get('score_certainty', 0))
        # 兼容 10 分制和 100 分制
        if 0 < score_certainty <= 10:
            score_certainty *= 10

        final_score = int(round((score_growth * 0.6) + (int(score_certainty) * 0.4)))

        # 🔥 [修复关键点2] 显式拼接报告正文，确保文字内容不落空
        q11_detail = f"🎯 目标价: {target_price:.2f}元 (空间 {upside_val}%)\n⚖️ 综合评分: {final_score}\n🛡️ 确定性: {int(score_certainty)}分 - {conc.get('certainty_reason', '无理由')}\n🧮 估值逻辑: {conc.get('valuation_logic', '无')}"

        report_parts = [
            f"【Q1 质地】{res.get('q1_quality', '')}",
            f"【Q2 行业】{res.get('q2_industry', '')}",
            f"【Q3 产业链】{res.get('q3_chain', '')}",
            f"【Q4 新增长】{res.get('q4_new_growth', '')}",
            f"【Q5 天花板】{res.get('q5_ceiling', '')}",
            f"【Q6 催化剂】{res.get('q6_catalyst', '')}",
            f"【Q7 机构】{res.get('q7_orgs', '')}",
            f"【Q8 护城河】{res.get('q8_moat', '')}",
            f"【Q9 质变】{res.get('q9_changes', '')}",
            f"【Q10 风险】{res.get('q10_risks', '')}",
            f"【Q11 结论】\n{q11_detail}"
        ]
        full_ai_report = "\n\n".join(report_parts)

        # 🔥 [修复关键点3] 显式提取净利率变量
        npm = self._safe_fmt(fund_data.get('netprofit_margin'), is_price=True)

        # 🔥 [核心审计] 23 个字段物理对齐，请勿随意改动顺序
        db_data = (
            today,                      # 1. report_date
            stock_name,                 # 2. name
            ts_code,                    # 3. ts_code
            hunter_data['industry'],    # 4. industry
            hunter_data.get('source_strategy',''), # 5. source_strategy
            ind_heat,                   # 6. industry_heat (对应 nan 修复)
            net_inflow,                 # 7. net_inflow_5d (对应 nan 修复)
            curr_price,                 # 8. current_price
            target_price,               # 9. target_price
            upside_val,                 # 10. upside_potential
            int(score_certainty),       # 11. score_certainty
            final_score,                # 12. final_score
            conc.get('target_market_cap', ''), # 13. target_market_cap
            conc.get('forecast_net_profit', ''), # 14. forecast_net_profit
            surveys['active_days'],     # 15. survey_count
            surveys['total_orgs'],      # 16. org_count
            surveys['famous_orgs'],     # 17. famous_orgs
            res.get('q8_moat',''),      # 18. moat_summary
            chip_cumu,                  # 19. chip_cumu_change (对应 nan 修复)
            chip_last,                  # 20. chip_latest_change (对应 nan 修复)
            npm,                        # 21. netprofit_margin (对应 None 修复)
            full_ai_report,             # 22. ai_report
            datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'), # 23. update_time
            tags_val                    # 24 🔥 新增：将 tags 写入第 24 列
        )

        # 插入或替换记录
        sql = "INSERT OR REPLACE INTO ai_analysis_result VALUES (" + ",".join(["?"]*24) + ")"
        params_list = [str(p) if p is not None else None for p in db_data]
        write_resp = requests.post(d1_execute_url, headers=d1_headers, json={"sql": sql, "params": params_list})
        write_data = write_resp.json()
        if not write_data.get("success"):
            raise RuntimeError(f"D1 写入失败 {ts_code}: {write_data.get('error')}")

        return {'status': 'success', 'ts_code': ts_code, 'final_score': final_score, 'target_price': target_price}

def main():
    print(f"🚀 启动 Brain v1.2 (Engine: {AI_ENGINE})...")
    db = DBLoader(STOCK_API_BASE)
    rag = RAGRetriever()
    brain = AnalystBrain()
    
    d1_headers = {
        "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
        "Content-Type": "application/json"
    }
    d1_query_url = f"{STOCK_API_BASE}/api/db/query"
    d1_execute_url = f"{STOCK_API_BASE}/api/db/execute"

    # 1. 扫描待处理任务清单 (lookback 设为 5 天确保覆盖)从 hunter/策略筛选表中，拉出最近 5 天内被策略命中的股票作为待分析池
    all_tasks = db.get_pending_stocks(lookback_days=0)
    
    # 2. 查重逻辑：仅保留今日尚未分析过的记录
    # 显式查询今天已经存入数据库的 ts_code 名单
    today = datetime.datetime.now().strftime('%Y%m%d')
    dup_resp = requests.post(d1_query_url, headers=d1_headers, json={"sql": "SELECT ts_code FROM ai_analysis_result WHERE report_date=?", "params": [today]})
    done = set()
    if dup_resp.json().get("success") and dup_resp.json().get("results"):
        done = {r['ts_code'] for r in dup_resp.json()["results"]}


    # 过滤任务：只保留剩下没跑的
    tasks = [s for s in all_tasks if s['ts_code'] not in done]
    
    print(f"📋 原始扫描池: {len(all_tasks)} 只 | 今日已处理: {len(done)} 只 | 本次待分析: {len(tasks)} 只")

    current_date_str = datetime.datetime.now().strftime('%Y年%m月%d日')

    # 3. 进入核心处理循环
    for s in tqdm(tasks, desc="AI Processing"):
        try:
            result = brain.analyze_and_save(
                s, db, rag, skip_if_exists=False, current_date=current_date_str
            )
            if result.get('status') == 'error':
                tqdm.write(f"❌ AI 分析失败 {s['ts_code']}: {result.get('error')}")
        except Exception as e:
            tqdm.write(f"❌ 分析或数据库写入失败 {s['ts_code']}: {e}")

    print("✨ 所有任务处理完毕。")

if __name__ == "__main__":
    main()
