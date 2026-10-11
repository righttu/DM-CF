# ==============================================================================
# alpha_hunter : 追踪长线资金来选股。
# ==============================================================================
# 📂 File: alpha_hunter_v2.py
# 📦 Version: 3.1 (NTM Valuation & Efficiency Filter - Strict Audit)
# 📝 Description: 阿尔法猎手 (V3.1 最终定稿版)
#    1. [回滚] 修正了导致 "Truth value of a DataFrame is ambiguous" 的逻辑错误。
#    2. [核心] 选股逻辑与原有 Alpha Hunter 完全一致，未做修改。
#    3. [数据] 行业数据补全采用 V12.9 的全量拉取方案。
# 🔽🔽🔽 新增版本记录 🔽🔽🔽
#    4. [清洗] 严格区分0与缺失值，将 "--"、1.0、0.0 等占位符清洗为 None (NULL)。
#    5. [升级] 保留机构关注度情绪，废弃 Tushare 的盈利预测，改用 Akshare 的 NTM 估值算法。
#    6. [实战] 实装狙击拦截网：仅当 (预期盈利且高增) 或 (日均换手率>8%) 时允许入库。
#    7. [审计] 修复格式化 None 引发的 TypeError，及 NaN 击穿 NTM 逻辑的隐患。
# ==============================================================================
import os
import requests as http_requests
import tushare as ts
import pandas as pd
import numpy as np
import datetime
import time
import traceback
import warnings
from dateutil.relativedelta import relativedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

warnings.simplefilter(action='ignore', category=FutureWarning)

# ================= 配置区 =================
#MY_TOKEN = '787294025173438464'
MY_TOKEN = os.getenv('MY_TUSHARE_TOKEN')
# D1 Worker API 配置
D1_API_URL = 'https://stock-api.righttu.uk'
CF_ACCESS_CLIENT_ID = os.getenv('CF_ACCESS_CLIENT_ID')
CF_ACCESS_CLIENT_SECRET = os.getenv('CF_ACCESS_CLIENT_SECRET')
BATCH_SIZE = 50

# ================= 数据库定义 =================

class CloudAPIClient:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip('/')
        self.headers = {
            'Content-Type': 'application/json',
            'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
            'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
        }

    def _post(self, path, payload):
        resp = http_requests.post(f'{self.base_url}{path}', json=payload, headers=self.headers, timeout=30)
        data = resp.json()
        if not data.get('success'):
            raise Exception(data.get('error', f'API call failed: {path}'))
        return data

# ================= 策略引擎 =================

class AlphaHunterStrategy:
    def __init__(self, token):
        print("🔌 初始化 Alpha Hunter v3.1 (NTM 终极定稿版)...")
        self.token = token
        self.pro_main = ts.pro_api(self.token)
        #self.pro_main._DataApi__http_url = 'https://tushare.top/dataapi/'
        self.api = CloudAPIClient(D1_API_URL)
        self._ensure_table()
        self.current_date_str = datetime.datetime.now().strftime('%Y%m%d')

    def _ensure_table(self):
        self.api._post('/api/db/execute', {'sql': """
            CREATE TABLE IF NOT EXISTS alpha_hunter (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_code TEXT, name TEXT, industry TEXT, close REAL,
                turnover_rate_3d REAL, industry_turnover_rate_3d REAL,
                pe_ttm REAL, pe_ttm_percentile REAL, industry_pe_ttm_median REAL,
                peg REAL, pb REAL, pb_percentile REAL, industry_pb_median REAL,
                forecast_eps_fy1 REAL, net_inflow_5d REAL, total_mv REAL,
                ps_ttm REAL, forecast_eps_fy2 REAL, con_growth_rate REAL,
                roe REAL, grossprofit_margin REAL, netprofit_yoy REAL,
                scan_date TEXT, score REAL, tags TEXT,
                industry_heat_status TEXT, main_business TEXT, market_sentiment TEXT,
                ratio_current TEXT, ratio_prev_1 TEXT, ratio_prev_2 TEXT,
                accel_ratio REAL, hold_mv_billion REAL,
                chip_latest_change TEXT, chip_cumu_change TEXT, create_time TEXT
            )
        """})
        resp = self.api._post('/api/db/query', {'sql': """
            SELECT ts_code, scan_date, COUNT(*) AS duplicate_count
            FROM alpha_hunter
            GROUP BY ts_code, scan_date
            HAVING COUNT(*) > 1
            LIMIT 10
        """})
        duplicates = resp.get('results', [])
        if duplicates:
            raise RuntimeError(f"❌ alpha_hunter 存在重复的 (ts_code, scan_date) 记录，请先人工清理后再创建唯一索引: {duplicates}")
        self.api._post('/api/db/execute', {'sql': "CREATE INDEX IF NOT EXISTS idx_alpha_ts_code ON alpha_hunter(ts_code)"})
        self.api._post('/api/db/execute', {'sql': "CREATE INDEX IF NOT EXISTS idx_alpha_scan_date ON alpha_hunter(scan_date)"})
        self.api._post('/api/db/execute', {'sql': "CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha_code_scan_date ON alpha_hunter(ts_code, scan_date)"})

    def _get_pro_worker(self):
        pro = ts.pro_api(self.token)
        # ⚠️ 注释掉代理，使用官方直连
        #pro._DataApi__http_url = 'https://tushare.top/dataapi/'
        try: pro._DataApi__timeout = 60
        except: pass
        return pro

    def _request_with_retry(self, func, **kwargs):
        max_retries = 3
        for i in range(max_retries):
            try:
                if 'timeout' not in kwargs: kwargs['timeout'] = 15
                return func(**kwargs)
            except Exception as e:
                if i == max_retries - 1: raise e
                if '频率超限' in str(e) or '每分钟最多访问' in str(e):
                    print(f"⚠️ Tushare 频率限制，等待 65 秒后重试: {e}")
                    time.sleep(65)
                else:
                    time.sleep(1 * (i + 1))
        return None

    def filter_existing_in_db(self, df):
        if df.empty: return df
        print("🛑 数据库查重 (断点续传)...")
        today_str = datetime.datetime.now().strftime('%Y%m%d')
        try:
            resp = self.api._post('/api/db/query', {
                'sql': 'SELECT ts_code FROM alpha_hunter WHERE scan_date = ?',
                'params': [today_str]
            })
            existing_set = {r['ts_code'] for r in resp.get('results', [])}
            if not existing_set:
                print("   ⚪ 今日尚无记录，全量处理。")
                return df
            original_count = len(df)
            df_new = df[~df['ts_code'].isin(existing_set)].copy()
            skipped_count = original_count - len(df_new)
            if skipped_count > 0: print(f"   ⚠️ 跳过 {skipped_count} 条，剩余 {len(df_new)} 条。")
            else: print("   ⚪ 无重复记录。")
            return df_new
        except Exception as e:
            print(f"   ❌ 查重失败: {e}")
            return df

    # ================= 1. 股票池 =================
    def get_valid_stock_list(self):
        print("📋 [1/3] 获取股票列表 (市值50亿-800亿, 上市>1年)...")
        try:
            df_basic = self._request_with_retry(self.pro_main.stock_basic, list_status='L', fields='ts_code,name,list_date,industry')
            
            one_year_ago = (datetime.datetime.now() - datetime.timedelta(days=365)).strftime('%Y%m%d')
            df_basic = df_basic[df_basic['list_date'] < one_year_ago]
            
            today = datetime.datetime.now().strftime('%Y%m%d')
            df_mv = self._request_with_retry(self.pro_main.daily_basic, trade_date=today, fields='ts_code,trade_date,close,total_mv')
            
            if df_mv is None or df_mv.empty:
                start_back = (datetime.datetime.now() - datetime.timedelta(days=5)).strftime('%Y%m%d')
                df_mv = self._request_with_retry(self.pro_main.daily_basic, start_date=start_back, end_date=today, fields='ts_code,trade_date,close,total_mv')
                if not df_mv.empty:
                    df_mv = df_mv.sort_values('trade_date', ascending=False).drop_duplicates('ts_code')

            if df_mv.empty: return pd.DataFrame()

            df = pd.merge(df_basic, df_mv, on='ts_code', how='inner')
            df = df[(df['total_mv'] > 500000) & (df['total_mv'] < 8000000)]
            df = df[~df['name'].str.contains('ST|退')]
            df = df[~df['ts_code'].str.contains('BJ')]
            
            print(f"✅ 基础池锁定: {len(df)} 只")
            return df
        except Exception as e:
            print(f"❌ 获取股票池失败: {e}")
            traceback.print_exc()
            return pd.DataFrame()

    # ================= 2. 辅助函数 =================
    def identify_holder(self, holder_name):
        if '香港中央结算有限公司' in holder_name: 
            return 'NORTH', '北向'
        
        state_smart = {
            '国新投资': '国新', '诚通金控': '诚通', '中国证券金融': '证金', '中央汇金': '汇金',
            '全国社保基金': '社保', '基本养老保险': '养老', '全国军民融合': '军民'
        }
        for kw, short in state_smart.items():
            if kw in holder_name: return 'SMART', short
            
        qfii_smart = {
            '挪威中央银行': '挪威央行', '科威特政府投资': '科威特', '阿布达比': '阿布达比', 
            '澳门金融管理局': '澳门金管', '淡马锡': '淡马锡', '新加坡政府投资': 'GIC',
            '加拿大年金': 'CPPIB', '比尔及梅琳达': '盖茨'
        }
        for kw, short in qfii_smart.items():
            if kw in holder_name: return 'SMART', short
            
        insurance_names = {
            '中国人寿': '人寿', '中国平安': '平安', '太平洋保险': '太保', 
            '泰康人寿': '泰康', '新华保险': '新华', '新华人寿': '新华'
        }
        for kw, short in insurance_names.items():
            if kw in holder_name: return 'SMART', short
            
        return None, None

    def get_smart_stats(self, df_holders):
        if df_holders.empty: return 0.0, []
        total_ratio = 0.0
        details = []
        for _, row in df_holders.iterrows():
            h_type, h_short = self.identify_holder(row['holder_name'])
            if h_type:
                total_ratio += row['hold_ratio']
                details.append({
                    'type': h_type, 'name': h_short, 'full': row['holder_name'],
                    'vol': row['hold_amount'], 'ratio': row['hold_ratio']
                })
        return total_ratio, details

    # ================= 3. 核心筛选逻辑 =================
    def _check_alpha_logic(self, pro, ts_code, name, price, industry):
        current_date = self.current_date_str
        
        # --- # 0. MA60 & 技术位置 ---
        start_dt = (datetime.datetime.strptime(current_date, '%Y%m%d') - datetime.timedelta(days=150)).strftime('%Y%m%d')
        df_daily = self._request_with_retry(pro.daily, ts_code=ts_code, start_date=start_dt, end_date=current_date)
        if df_daily is None or df_daily.empty or len(df_daily) < 60: return False, {}
        
        df_daily = df_daily.sort_values('trade_date').reset_index(drop=True)
        current_close = df_daily.iloc[-1]['close']
        ma60 = df_daily['close'].rolling(60).mean().iloc[-1]
        
        if current_close <= ma60: return False, {}
        if (current_close - ma60) / ma60 > 0.25: return False, {}

        # --- # 1. 3年涨幅熔断 ---
        start_3y = (datetime.datetime.strptime(current_date, '%Y%m%d') - datetime.timedelta(days=1095)).strftime('%Y%m%d')
        df_3y = self._request_with_retry(pro.monthly, ts_code=ts_code, start_date=start_3y, end_date=current_date)
        if df_3y is not None and not df_3y.empty:
            price_old = df_3y.iloc[-1]['close']
            if price_old > 0 and (price - price_old) / price_old > 3.0: return False, {}

        # --- # 2. 机构数据拉取 ---
        # 用 top10_holders 范围查询取最新3期
        start_dt = (datetime.datetime.strptime(current_date, '%Y%m%d') - datetime.timedelta(days=450)).strftime('%Y%m%d')
        df_holder_all = self._request_with_retry(pro.top10_holders, ts_code=ts_code, start_date=start_dt, end_date=current_date)
        
        if df_holder_all is None or df_holder_all.empty:
            return False, {}
        
        available_periods = sorted(df_holder_all['end_date'].unique().tolist(), reverse=True)
        if len(available_periods) < 2:
            return False, {}
        
        df_q3_raw = df_holder_all[df_holder_all['end_date'] == available_periods[0]]
        df_q2_raw = df_holder_all[df_holder_all['end_date'] == available_periods[1]]
        df_q1_raw = df_holder_all[df_holder_all['end_date'] == available_periods[2]] if len(available_periods) >= 3 else pd.DataFrame()
        
        if df_q3_raw is None or df_q3_raw.empty: return False, {}
        
        ratio_q3, details_q3 = self.get_smart_stats(df_q3_raw)
        if not details_q3: return False, {}
        
        ratio_q2, details_q2 = self.get_smart_stats(df_q2_raw if df_q2_raw is not None else pd.DataFrame())
        ratio_q1, _ = self.get_smart_stats(df_q1_raw if df_q1_raw is not None else pd.DataFrame())

        # --- # 3. 前三名动向过滤与阶梯评分 ---
        tag_list = [f"长线机构:{len(details_q3)}家"]
        top_3_details = details_q3[:3]
        stay_count = 0        
        is_strong_gate = False 
        score = 0             
        
        for idx, h3 in enumerate(top_3_details):
            if (h3['vol'] * price) >= 800000000 or h3['ratio'] >= 8.0:
                is_strong_gate = True
            
            found_q2 = False
            change_pct = 0.0
            for h2 in details_q2:
                if h3['full'] == h2['full']:
                    found_q2 = True
                    change_pct = (h3['vol'] - h2['vol']) / h2['vol'] * 100
                    if h3['vol'] >= h2['vol']: stay_count += 1
                    break
            if not found_q2: 
                change_pct = 100.0 
                stay_count += 1
            
            h_score = 0
            if change_pct >= 80: h_score = 100
            elif change_pct >= 50: h_score = 80
            elif change_pct >= 20: h_score = 50
            
            if h_score > score: score = h_score
            
            mark = "💎" if h_score > 0 else ""
            act = "新进" if change_pct == 100 else f"增{change_pct:.1f}%" if change_pct > 0 else "平" if change_pct == 0 else f"减{abs(change_pct):.1f}%"
            tag_list.append(f"{mark}{h3['name']}{act}")

        # --- # 4. 前三名硬筛选逻辑 ---
        if not is_strong_gate or stay_count < 2: return False, {}

        # --- # 5. 季度动向熔断 ---
        if ratio_q2 > 1.0 and (ratio_q2 - ratio_q3) / ratio_q2 > 0.3: return False, {}
        
        # --- # 6. 筹码集中度 ---
        start_check = (datetime.datetime.strptime(available_periods[0], '%Y%m%d') - datetime.timedelta(days=500)).strftime('%Y%m%d')

        df_chips = self._request_with_retry(pro.stk_holdernumber, ts_code=ts_code, start_date=start_check)
        
        # 🔴 [修改内容1] 将假 0.0 清洗为 None
        chg_q = None; chg_3q = None 
        if df_chips is not None and not df_chips.empty:
            df_chips = df_chips.drop_duplicates(subset=['end_date']).sort_values('end_date', ascending=False).reset_index(drop=True)
            def get_n(target):
                t = df_chips[df_chips['end_date'] <= target]
                return t.iloc[0]['holder_num'] if not t.empty else None
            # 🛡️ 安全兼容：若数据源仅返回2期，第3期顺延复用第2期，防止 Index 越界
            n3 = get_n(available_periods[0])
            n2 = get_n(available_periods[1])
            n1 = get_n(available_periods[2] if len(available_periods) >= 3 else available_periods[1])

            if n3 and n2:
                chg_q = (n3 - n2) / n2
                if chg_q > 0.03: return False, {} 
            if n3 and n1: 
                chg_3q = (n3 - n1) / n1 

        # --- # 7. 最终打包返回 ---
        # 🔴 [修改内容1] 将 "--"、1.0 等假数据全部替换为 None，并增加安全防御
        return True, {
            'score': score,
            'tags': "|".join(tag_list),
            'ratio_current': f"{ratio_q3:.1f}%",
            'ratio_prev_1': f"{ratio_q2:.1f}%" if ratio_q2 > 0 else None,
            'ratio_prev_2': f"{ratio_q1:.1f}%" if ratio_q1 > 0 else None, 
            'accel_ratio': round(ratio_q3 / ratio_q2, 2) if ratio_q2 > 0 else None,
            'hold_mv_billion': round(sum(d['vol'] * price for d in details_q3) / 100000000, 2),
            'chip_latest_change': f"{chg_q * 100:.1f}%" if chg_q is not None else None,
            'chip_cumu_change': f"{chg_3q * 100:.1f}%" if chg_3q is not None else None 
        }

    # ================= 4. 全字段数据补全 =================
    def _enrich_and_save(self, stock_info, alpha_data):
        pro = self._get_pro_worker()
        ts_code = stock_info['ts_code']
        industry = stock_info.get('industry')
        
        res = {**stock_info, **alpha_data}
        res['scan_date'] = datetime.datetime.now().strftime('%Y%m%d')
        res['create_time'] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 1. 基础行情
        anchor_date = None
        try:
            df_daily = self._request_with_retry(pro.daily_basic, ts_code=ts_code, limit=3, 
                                                fields='ts_code,trade_date,turnover_rate,pe_ttm,pb,ps_ttm,total_mv,close')
            if not df_daily.empty:
                # 🔴 [修改微调] 对齐换手率量纲：改为 mean() 日均换手，以适配 > 8 条件
                res['turnover_rate_3d'] = df_daily['turnover_rate'].mean()
                latest = df_daily.iloc[0]
                res['pe_ttm'] = latest['pe_ttm']
                res['pb'] = latest['pb']
                res['ps_ttm'] = latest['ps_ttm']
                res['total_mv'] = latest['total_mv'] / 10000.0 if pd.notna(latest['total_mv']) else None
                anchor_date = latest['trade_date']
            else: return None
        except: return None

        # 2. 财务指标
        try:
            start_fin = (datetime.datetime.now() - datetime.timedelta(days=180)).strftime('%Y%m%d')
            df_fin = self._request_with_retry(pro.fina_indicator, ts_code=ts_code, start_date=start_fin, 
                                              fields='end_date,roe,grossprofit_margin,netprofit_yoy,eps')
            if not df_fin.empty:
                fin_latest = df_fin.sort_values('end_date', ascending=False).iloc[0]
                res['roe'] = fin_latest['roe']
                res['grossprofit_margin'] = fin_latest['grossprofit_margin']
                res['netprofit_yoy'] = fin_latest['netprofit_yoy']
                res['last_eps'] = fin_latest.get('eps')
        except: pass

        # 3. 历史分位
        try:
            start_5y = (datetime.datetime.now() - relativedelta(years=5)).strftime('%Y%m%d')
            df_hist = self._request_with_retry(pro.daily_basic, ts_code=ts_code, start_date=start_5y, fields='pe_ttm,pb')
            if not df_hist.empty and len(df_hist) > 100:
                cur_pe = res.get('pe_ttm')
                if pd.notna(cur_pe): res['pe_ttm_percentile'] = round((df_hist['pe_ttm'] < float(cur_pe)).mean() * 100, 2)
                cur_pb = res.get('pb')
                if pd.notna(cur_pb): res['pb_percentile'] = round((df_hist['pb'] < float(cur_pb)).mean() * 100, 2)
        except: pass

        # 4. 行业中值
        if industry and anchor_date:
            try:
                df_ind_stocks = self._request_with_retry(pro.stock_basic, industry=industry, list_status='L', fields='ts_code,industry')
                if not df_ind_stocks.empty:
                    df_ind_stocks = df_ind_stocks[df_ind_stocks['industry'] == industry]
                    ind_codes_list = df_ind_stocks['ts_code'].tolist()
                    
                    if ind_codes_list:
                        df_market = self._request_with_retry(pro.daily_basic, trade_date=anchor_date, fields='ts_code,pe_ttm,pb,turnover_rate')
                        if not df_market.empty:
                            df_ind_daily = df_market[df_market['ts_code'].isin(ind_codes_list)]
                            if not df_ind_daily.empty:
                                res['industry_pe_ttm_median'] = df_ind_daily['pe_ttm'].median()
                                res['industry_pb_median'] = df_ind_daily['pb'].median()
                                res['industry_turnover_rate_3d'] = df_ind_daily['turnover_rate'].median() * 3
                                
                                val = df_ind_daily['turnover_rate'].mean()
                                status = "❄️冷门"
                                if val > 5.0: status = "🔥极热"
                                elif val > 3.0: status = "☀️活跃"
                                elif val > 1.0: status = "☁️温和"
                                res['industry_heat_status'] = status
            except: pass

        # 5. 资金流
        try:
            df_flow = self._request_with_retry(pro.moneyflow, ts_code=ts_code, limit=5, fields='trade_date,buy_lg_amount,buy_elg_amount,sell_lg_amount,sell_elg_amount')
            if not df_flow.empty:
                df_flow['net'] = (df_flow['buy_lg_amount'] + df_flow['buy_elg_amount']) - (df_flow['sell_lg_amount'] + df_flow['sell_elg_amount'])
                res['net_inflow_5d'] = df_flow['net'].sum()
        except: pass

        # 6. 一致预期与机构情绪
        try:
            start_rc = (datetime.datetime.now() - datetime.timedelta(days=180)).strftime('%Y%m%d')
            df_rc = self._request_with_retry(pro.report_rc, ts_code=ts_code, start_date=start_rc, fields='report_date,quarter,eps,rating')
            if not df_rc.empty:
                rpt_count = len(df_rc)
                buy_count = len(df_rc[df_rc['rating'].str.contains('买入|推荐|增持', na=False)])
                res['market_sentiment'] = f"180天{rpt_count}家关注({buy_count}家看多)"
        except: pass
        
        # 🔴 [修改内容2] NTM 动态估值算法 (基于 Akshare 且严格防御 NaN)
        # 🛡️ 错位探测装甲：如果去年的列有数据，说明 Akshare 表头左移了，强制右移纠偏
        # 🔴 [修改位置2]：同步 Chip Hunter 的工业级加固 NTM 算法
        eps_ntm = None
        con_growth = None
        try:
            pure_code = ts_code.split('.')[0].zfill(6)
            eps1, eps2 = None, None
            
            if hasattr(self, 'df_ak') and not self.df_ak.empty and pure_code in self.df_ak.index:
                # 🛡️ 强力类型转换防御函数
                def extract_val(col_name):
                    try:
                        val = self.df_ak.loc[pure_code, col_name]
                        if isinstance(val, (pd.Series, np.ndarray)): val = val.iloc[0] if len(val)>0 else None
                        return float(val) if pd.notna(val) else None
                    except: return None

                eps1 = extract_val(self.col_eps1)
                eps2 = extract_val(self.col_eps2)
                
                # 🛡️ 错位纠偏逻辑
                if hasattr(self, 'col_eps_prev') and self.col_eps_prev in self.df_ak.columns:
                    val_prev = extract_val(self.col_eps_prev)
                    if val_prev is not None and val_prev > 0:
                        eps2 = eps1            # 实际上是 FY2
                        eps1 = val_prev         # 实际上是 FY1
                        
            res['forecast_eps_fy1'] = eps1
            res['forecast_eps_fy2'] = eps2

            pe_ttm_raw = res.get('pe_ttm')
            close_raw = res.get('close')
            
            pe_ttm_val = float(pe_ttm_raw) if pd.notna(pe_ttm_raw) else None
            close_val = float(close_raw) if pd.notna(close_raw) else None
            
            if pe_ttm_val and pe_ttm_val != 0 and close_val:
                base_eps = close_val / pe_ttm_val # TTM EPS
                
                if eps1 is not None and eps2 is not None:
                    eps_ntm = (eps1 * getattr(self, 'w1', 1.0)) + (eps2 * getattr(self, 'w2', 0.0))
                    if base_eps != 0:
                        # G = (未来12月 - 过去12月) / 过去12月
                        con_growth = round(((eps_ntm - base_eps) / abs(base_eps)) * 100, 2)
                        res['con_growth_rate'] = con_growth
                        
                        # 前瞻 PEG = (Close/EPS_NTM) / G
                        if eps_ntm > 0 and con_growth > 0:
                            forward_pe = close_val / eps_ntm
                            res['peg'] = round(forward_pe / con_growth, 2)
        except Exception: 
            pass

        # 7. 主营
        try:
            df_info = self._request_with_retry(pro.stock_company, ts_code=ts_code, fields='main_business')
            if not df_info.empty:
                mb = df_info.iloc[0]['main_business']
                res['main_business'] = mb[:50] + "..." if len(mb) > 50 else mb
        except: pass

        # ==========================================================
        # 🛑 [修改内容3] 狙击手拦截网 (Efficiency Filter)
        # ==========================================================
        # 🔴 [修改位置3]：同步拦截逻辑与诊断标记
        to_3d_val = res.get('turnover_rate_3d', 0.0)
        to_3d_val = float(to_3d_val) if pd.notna(to_3d_val) else 0.0

        is_fund_ok = (eps_ntm is not None and eps_ntm > 0) and (con_growth is not None and con_growth > 0)
        is_hot_ok = (to_3d_val > 8.0)

        # 纯垃圾股（不增长且不活跃）直接丢弃
        if not (is_fund_ok or is_hot_ok):
            # 将诊断值塞入原 stock_info 供主程序打印诊断结果
            stock_info['_diag_g'] = con_growth
            stock_info['_diag_to'] = to_3d_val
            return None 

        return res


    def process_stock_task(self, row_dict):
        pro = self._get_pro_worker()
        passed, alpha_data = self._check_alpha_logic(
            pro, 
            row_dict['ts_code'], 
            row_dict['name'], 
            row_dict['close'], 
            row_dict['industry']
        )
        
        if passed:
            full_data = self._enrich_and_save(row_dict, alpha_data)
            return full_data
        return None

    # ================= 主运行流程 =================
    def run(self):
        df_base = self.get_valid_stock_list()
        if df_base.empty: return
        df_base = self.filter_existing_in_db(df_base)
        if df_base.empty:
            print("✅ 今日 Alpha 结果已处理完毕。")
            return
        
        # 🔴 [修改位置1]：在并发扫描前，必须先初始化所有 NTM 变量
        import akshare as ak
        print(f"\n🌐 [INFO] 正在通过 Akshare 拉取全市场【机构一致预期】...")
        try:
            self.df_ak = ak.stock_profit_forecast_em()
            self.df_ak['pure_code'] = self.df_ak['代码'].astype(str).str.zfill(6)
            self.df_ak = self.df_ak.set_index('pure_code')
        except Exception as e:
            print(f"⚠️ Akshare 数据拉取失败: {e}")
            self.df_ak = pd.DataFrame()
            
        current_year = datetime.datetime.now().year
        day_of_year = datetime.datetime.now().timetuple().tm_yday
        self.w1 = (365 - day_of_year) / 365.0
        self.w2 = day_of_year / 365.0
        self.col_eps1 = f"{current_year}预测每股收益"
        self.col_eps2 = f"{current_year + 1}预测每股收益"
        self.col_eps_prev = f"{current_year - 1}预测每股收益" # 🛡️ 错位嗅探列

        print(f"\n🔍 [Step 2] 深度扫描 (多线程并发: 2)...")
        stock_list = df_base.to_dict('records')
        pending_results = []
        selected_count = 0

        def format_pct(value, width):
            try:
                if value is None or pd.isna(value):
                    return "数据缺失"
                return f"{float(value):>{width}.2f}%"
            except (TypeError, ValueError):
                return "数据缺失"

        with ThreadPoolExecutor(max_workers=2) as executor:
            future_to_stock = {executor.submit(self.process_stock_task, item): item for item in stock_list}
            
            processed = 0
            total = len(stock_list)
            for future in as_completed(future_to_stock):
                # 💡 核心改动：必须拿到 original_item，否则拦截时拿不到股票名字
                original_item = future_to_stock[future] 
                processed += 1
                try:
                    res = future.result()
                    if res:
                        selected_count += 1
                        pending_results.append(res)
                        # ✅ 入围显示：对齐 Chip Hunter 的显示风格
                        g_str = format_pct(res.get('con_growth_rate'), 6)
                        to_str = format_pct(res.get('turnover_rate_3d'), 5)
                        print(f"   ✅ 入围: {res['name']:<4} | G: {g_str:>8} | 换手: {to_str} | 分: {res.get('score',0)}")
                    else:
                        # 🛡️ 拦截显示：让你看清为什么没入围
                        g_val = original_item.get('_diag_g', 'N/A')
                        to_val = original_item.get('_diag_to', 0.0)
                        
                        # 格式化 G 值，防止 None 报错
                        g_str = format_pct(g_val, 6)
                        to_str = format_pct(to_val, 5)
                        print(f"   🛡️ 拦截诊断 [{original_item['name']:<4}] | 实际 G: {g_str:>8} | 换手: {to_str}")
                        
                except Exception as e:
                    # 打印具体哪只标的出了异常
                    print(f"   ❌ 异常 [{original_item.get('name')}]: {e}")

                if len(pending_results) >= BATCH_SIZE:
                    self.save_to_db(pd.DataFrame(pending_results))
                    pending_results.clear()

        if pending_results:
            self.save_to_db(pd.DataFrame(pending_results))
            pending_results.clear()

        print(f"\n🎉 扫描完成! 共筛选出 {selected_count} 只优质标的")
    def save_to_db(self, df):
        
        print(f"💾 [Step 3] 正在写入 D1 (via Worker API)...")

        def safe_get(row, key, is_float=True):
            val = row.get(key)
            if pd.isna(val) or val == '' or val is None: return None
            if is_float:
                try: 
                    f_val = float(val)
                    if not np.isfinite(f_val): return None
                    return f_val
                except: return None
            return val
        
        try:
            records = []
            for _, row in df.iterrows():
                
                record = {
                    "ts_code": safe_get(row, 'ts_code', is_float=False),
                    "name": safe_get(row, 'name', is_float=False),
                    "industry": safe_get(row, 'industry', is_float=False),
                    "close": safe_get(row, 'close'),
                    "turnover_rate_3d": safe_get(row, 'turnover_rate_3d'),
                    "industry_turnover_rate_3d": safe_get(row, 'industry_turnover_rate_3d'),
                    "pe_ttm": safe_get(row, 'pe_ttm'),
                    "pe_ttm_percentile": safe_get(row, 'pe_ttm_percentile'),
                    "industry_pe_ttm_median": safe_get(row, 'industry_pe_ttm_median'),
                    "peg": safe_get(row, 'peg'),
                    "pb": safe_get(row, 'pb'),
                    "pb_percentile": safe_get(row, 'pb_percentile'),
                    "industry_pb_median": safe_get(row, 'industry_pb_median'),
                    "forecast_eps_fy1": safe_get(row, 'forecast_eps_fy1'),
                    "net_inflow_5d": safe_get(row, 'net_inflow_5d'),
                    "total_mv": safe_get(row, 'total_mv'),
                    "ps_ttm": safe_get(row, 'ps_ttm'),
                    "forecast_eps_fy2": safe_get(row, 'forecast_eps_fy2'),
                    "con_growth_rate": safe_get(row, 'con_growth_rate'),
                    "roe": safe_get(row, 'roe'),
                    "grossprofit_margin": safe_get(row, 'grossprofit_margin'),
                    "netprofit_yoy": safe_get(row, 'netprofit_yoy'),
                    "scan_date": safe_get(row, 'scan_date', is_float=False),
                    "score": safe_get(row, 'score'),
                    "tags": safe_get(row, 'tags', is_float=False),
                    "industry_heat_status": safe_get(row, 'industry_heat_status', is_float=False),
                    "main_business": safe_get(row, 'main_business', is_float=False),
                    "market_sentiment": safe_get(row, 'market_sentiment', is_float=False),
                    "ratio_current": safe_get(row, 'ratio_current', is_float=False),
                    "ratio_prev_1": safe_get(row, 'ratio_prev_1', is_float=False),
                    "ratio_prev_2": safe_get(row, 'ratio_prev_2', is_float=False),
                    "accel_ratio": safe_get(row, 'accel_ratio'),
                    "hold_mv_billion": safe_get(row, 'hold_mv_billion'),
                    "chip_latest_change": safe_get(row, 'chip_latest_change', is_float=False),
                    "chip_cumu_change": safe_get(row, 'chip_cumu_change', is_float=False),
                    "create_time": safe_get(row, 'create_time', is_float=False)
                }

                records.append(record)
            resp = self.api._post('/api/db/save', {'table': 'alpha_hunter', 'data': records})
            print(f"✅ 本批成功入库: {resp.get('count', len(records))} 条")
            return resp.get('count', len(records))
        except Exception as e:
            print(f"❌ 入库失败: {e}")
            traceback.print_exc()
            raise


if __name__ == "__main__":
    hunter = AlphaHunterStrategy(MY_TOKEN)
    hunter.run()
