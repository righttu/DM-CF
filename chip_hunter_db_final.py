# ==============================================================================
# 📂 File: chip_hunter_db_final.py
# 📦 Version: 13.1 (NTM Valuation & Efficiency Filter - Strict Audit)
# 📝 Description: 筹码选股策略 (最终修复版)
#    1. [修复] 行业数据计算采用 "全市场拉取 + 本地内存过滤" 方案，彻底解决接口限制导致的空值。
#    2. [补全] 确保 industry_turnover_rate_3d, industry_pe_ttm_median, industry_pb_median 均有值。
#    3. [字段] 包含完整的 36+ 个核心分析字段。
# 🔽🔽🔽 新增版本记录 🔽🔽🔽
#    4. [重构] 严格区分0与缺失值，清洗所有入库的虚假0值标签为 None (NULL)。
#    5. [升级] 废弃 Tushare 预测，接入 Akshare，实装 NTM 动态估值与 PEG，解决时间缩水问题。
#    6. [实战] 增加狙击拦截网：仅当 (预期盈利且高增) 或 (日均换手率>8%) 时允许入库，净化数据库。
#    7. [审计] 修复 NaN 击穿 NTM 计算的 Bug，并对齐 3日换手率的绝对阈值(Sum > 24%)。
# ==============================================================================

import os
import requests
import tushare as ts
import pandas as pd
import numpy as np
import datetime
import time
import traceback
import warnings
import threading
from collections import deque
from dateutil.relativedelta import relativedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

warnings.simplefilter(action='ignore', category=FutureWarning)

# ================= 配置区 =================
MY_TOKEN = os.getenv('MY_TUSHARE_TOKEN') 
DB_PATH = 'sqlite:///quant_data.db'
D1_API_URL = 'https://stock-api.righttu.uk'
CF_ACCESS_CLIENT_ID = os.getenv('CF_ACCESS_CLIENT_ID')
CF_ACCESS_CLIENT_SECRET = os.getenv('CF_ACCESS_CLIENT_SECRET')
BATCH_SIZE = 50

# ================= 数据库定义 =================

class SlidingWindowRateLimiter:
    def __init__(self, max_calls, period_seconds):
        self.max_calls = max_calls
        self.period_seconds = period_seconds
        self.calls = deque()
        self.lock = threading.Lock()

    def acquire(self):
        while True:
            with self.lock:
                now = time.monotonic()
                while self.calls and now - self.calls[0] >= self.period_seconds:
                    self.calls.popleft()
                if len(self.calls) < self.max_calls:
                    self.calls.append(now)
                    return
                wait_seconds = self.period_seconds - (now - self.calls[0]) + 0.05
            time.sleep(max(wait_seconds, 0.05))

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

# ================= 策略引擎 =================

class ChipHunterStrategy:
    def __init__(self, token):
        print("🔌 初始化 Chip Hunter (V13.1 最终定稿版)...")
        self.token = token
        self.pro_main = ts.pro_api(self.token) 
        #self.pro_main._DataApi__http_url = 'https://tushare.top/dataapi/'  #第三方代理
        #######   注入抗干扰网络适配器 #######
        #import requests
        #from requests.adapters import HTTPAdapter
        #from urllib3.util.retry import Retry
        #_session = requests.Session()
        #_retries = Retry(total=5, backoff_factor=1, status_forcelist=[500, 502, 503, 504])
        # _session.mount('https://', HTTPAdapter(max_retries=_retries)) #第三方代理
        #self.pro_main._DataApi__session = _session  #第三方代理
        #####################################
        self.api = CloudAPIClient(D1_API_URL)
        try:
            self._ensure_table()
        except Exception as e:
            # 建表失败属于致命错误，直接抛出并终止程序，防止后续白跑
            raise RuntimeError(f"💥 数据库初始化失败，程序终止: {e}") from e
        self.rate_limiters = {
            'daily': SlidingWindowRateLimiter(450, 60),
            'daily_basic': SlidingWindowRateLimiter(450, 60),
            'stk_holdernumber': SlidingWindowRateLimiter(450, 60),
        }
        self.holdernumber_by_code = None


        import datetime
        now = datetime.datetime.now()
        day_of_year = now.timetuple().tm_yday
        self.w1, self.w2 = (365 - day_of_year) / 365.0, day_of_year / 365.0
        self.col_eps1, self.col_eps2, self.col_eps_prev = f"{now.year}预测每股收益", f"{now.year + 1}预测每股收益", f"{now.year - 1}预测每股收益"

    def _ensure_table(self):
        ddl_statements = [
            """
            CREATE TABLE IF NOT EXISTS chip_hunter (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scan_date TEXT, ts_code TEXT, name TEXT, industry TEXT,
                close REAL, pct_chg REAL, volume_ratio REAL, total_mv REAL,
                turnover_rate REAL, turnover_rate_3d REAL, industry_turnover_rate_3d REAL,
                score REAL, tags TEXT, holders_wan REAL, chip_cumu_change REAL, chip_latest_change REAL,
                net_mf_amount REAL, net_inflow_5d REAL,
                pe_ttm REAL, pe_ttm_percentile REAL, industry_pe_ttm_median REAL, peg REAL,
                pb REAL, pb_percentile REAL, industry_pb_median REAL,
                ratio_current REAL, ratio_prev_1 REAL, ps_ttm REAL,
                forecast_eps_fy1 REAL, forecast_eps_fy2 REAL, con_growth_rate REAL,
                roe REAL, grossprofit_margin REAL, netprofit_yoy REAL,
                concepts TEXT, top_list_reason TEXT,
                pattern TEXT, bias_60 REAL, vol_signal TEXT, create_time TEXT
            )
            """,
        ]
        self.api._post('/api/db/execute', {'sql': ddl_statements[0]})
        resp = self.api._post('/api/db/query', {'sql': """
            SELECT ts_code, scan_date, COUNT(*) AS duplicate_count
            FROM chip_hunter
            GROUP BY ts_code, scan_date
            HAVING COUNT(*) > 1
            LIMIT 10
        """})
        duplicates = resp.get('results', [])
        if duplicates:
            raise RuntimeError(f"❌ chip_hunter 存在重复的 (ts_code, scan_date) 记录，请先人工清理后再创建唯一索引: {duplicates}")
        self.api._post('/api/db/execute', {'sql': "CREATE INDEX IF NOT EXISTS idx_chip_ts_code ON chip_hunter(ts_code)"})
        self.api._post('/api/db/execute', {'sql': "CREATE INDEX IF NOT EXISTS idx_chip_scan_date ON chip_hunter(scan_date)"})
        self.api._post('/api/db/execute', {'sql': "CREATE UNIQUE INDEX IF NOT EXISTS idx_chip_code_scan_date ON chip_hunter(ts_code, scan_date)"})

    def _load_holdernumber_pool(self, start_date, end_date):
        page_size = 3000
        frames = []
        total_pages = 0
        range_start = datetime.datetime.strptime(start_date, '%Y%m%d')
        final_end = datetime.datetime.strptime(end_date, '%Y%m%d')

        while range_start <= final_end:
            range_end = min(range_start + datetime.timedelta(days=29), final_end)
            range_start_str = range_start.strftime('%Y%m%d')
            range_end_str = range_end.strftime('%Y%m%d')

            for page_no in range(34):
                offset = page_no * page_size
                df_page = self._request_with_retry(
                    self.pro_main.stk_holdernumber,
                    api_name='stk_holdernumber',
                    start_date=range_start_str,
                    end_date=range_end_str,
                    fields='ts_code,end_date,holder_num',
                    limit=page_size,
                    offset=offset
                )
                total_pages += 1
                if df_page is None:
                    raise RuntimeError(
                        f'stk_holdernumber 返回 None: {range_start_str}-{range_end_str}, offset={offset}'
                    )
                if not df_page.empty:
                    frames.append(df_page)
                if len(df_page) < page_size:
                    break
            else:
                raise RuntimeError(
                    f'stk_holdernumber 日期段 {range_start_str}-{range_end_str} 达到 offset 上限，拒绝使用截断数据'
                )

            range_start = range_end + datetime.timedelta(days=1)

        if not frames:
            raise RuntimeError('stk_holdernumber 全市场批量结果为空，拒绝将全市场误判为不合格')

        df_all = pd.concat(frames, ignore_index=True)
        self.holdernumber_by_code = {
            ts_code: group.copy()
            for ts_code, group in df_all.groupby('ts_code')
        }
        print(f"✅ 股东人数分段预取完成: {len(df_all)} 条，共 {total_pages} 页")

    def _get_pro_worker(self):
        #彻底复用单例
        #pro = ts.pro_api(self.token)
        #pro._DataApi__http_url = 'https://tushare.top/dataapi/'
        #try: pro._DataApi__timeout = 60
        #except: pass
        #return pro
        return self.pro_main

    def _request_with_retry(self, func, api_name=None, **kwargs):
        max_retries = 3
        for i in range(max_retries):
            try:
                limiter = self.rate_limiters.get(api_name)
                if limiter:
                    limiter.acquire()
                if 'timeout' not in kwargs: kwargs['timeout'] = 15
                return func(**kwargs)
            except Exception as e:
                error_message = str(e)
                if '次/天' in error_message:
                    print(f"⚠️ Tushare 每日调用额度已用完，本次不再重试: {e}")
                    raise
                if i == max_retries - 1:
                    raise
                if '频率超限' in error_message or '每分钟最多访问' in error_message:
                    print(f"⚠️ Tushare 分钟频率限制，等待 65 秒后重试: {e}")
                    time.sleep(65)
                else:
                    time.sleep(1 * (i + 1))
        return None

    # === [移植自 Alpha] 识别聪明钱身份 ===
    def identify_holder(self, holder_name):
        if '香港中央结算有限公司' in holder_name: return 'NORTH', '北向'
        state_smart = {'国新投资': '国新', '诚通金控': '诚通', '中国证券金融': '证金', '中央汇金': '汇金',
                       '全国社保基金': '社保', '基本养老保险': '养老', '全国军民融合': '军民'}
        for kw, short in state_smart.items():
            if kw in holder_name: return 'SMART', short
        qfii_smart = {'挪威中央银行': '挪威央行', '科威特政府投资': '科威特', '阿布达比': '阿布达比', 
                      '澳门金融管理局': '澳门金管', '淡马锡': '淡马锡', '新加坡政府投资': 'GIC',
                      '加拿大年金': 'CPPIB', '比尔及梅琳达': '盖茨'}
        for kw, short in qfii_smart.items():
            if kw in holder_name: return 'SMART', short
        insurance_names = {'中国人寿': '人寿', '中国平安': '平安', '太平洋保险': '太保', '泰康人寿': '泰康', '新华': '新华'}
        for kw, short in insurance_names.items():
            if kw in holder_name: return 'SMART', short
        return None, None

    # === [移植自 Alpha] 计算报告期比例 ===
    def get_smart_stats(self, df_holders):
        if df_holders is None or df_holders.empty: return 0.0
        total_ratio = 0.0
        for _, row in df_holders.iterrows():
            h_type, _ = self.identify_holder(row['holder_name'])
            if h_type: total_ratio += float(row['hold_ratio'])
        return total_ratio

    # ================= 1. 股票池 =================
    def get_valid_stock_list(self, mode='established'):
        print(f"📋 [1/6] 获取股票列表 | 当前模式: {mode} ...")
        try:
            df = self._request_with_retry(self.pro_main.stock_basic, exchange='', list_status='L', fields='ts_code,name,industry,list_date,market')
            df = df[~df['name'].str.contains('ST|退')]
            df = df[~df['market'].str.contains('北交')]
            today = datetime.datetime.now()
            
            if mode == 'sub_new':
                date_min = (today - datetime.timedelta(days=180)).strftime('%Y%m%d')
                date_max = (today - datetime.timedelta(days=330)).strftime('%Y%m%d')
                df = df[(df['list_date'] < date_min) & (df['list_date'] > date_max)]
            elif mode == 'established':
                one_year_plus = (today - datetime.timedelta(days=390)).strftime('%Y%m%d') 
                df = df[df['list_date'] < one_year_plus]
            return df
        #except: return pd.DataFrame()
        except Exception as e: 
            print(f"\n❌ [致命错误] 获取全市场股票基础列表失败！")
            print(f"❌ 详细报错原因: {e}")
            import traceback
            traceback.print_exc()
            return pd.DataFrame()

    # ================= 2. 筹码筛选 =================
    def _process_chip_single(self, stock_info, mode):
        pro = self._get_pro_worker()
        code = stock_info['ts_code']
        end_date = datetime.datetime.now().strftime('%Y%m%d')
        start_date = (datetime.datetime.now() - relativedelta(months=18)).strftime('%Y%m%d')
        try:
            if self.holdernumber_by_code is not None:
                df = self.holdernumber_by_code.get(code, pd.DataFrame()).copy()
            else:
                df = self._request_with_retry(pro.stk_holdernumber, api_name='stk_holdernumber', ts_code=code, start_date=start_date, end_date=end_date)
            if df is None or df.empty or len(df) < 2: return None
            df = df.sort_values('end_date', ascending=False).reset_index(drop=True)
            
            if mode == 'sub_new':
                idx_old = len(df) - 1; threshold = -15.0
            else:
                idx_old = -1 
                for i in range(len(df)):
                    days_diff = (pd.to_datetime(df.loc[0, 'end_date']) - pd.to_datetime(df.loc[i, 'end_date'])).days
                    if days_diff > 260: idx_old = i; break
                if idx_old == -1: idx_old = len(df) - 1
                threshold = -10.0
            
            h_now = df.loc[0, 'holder_num']; h_old = df.loc[idx_old]['holder_num']
            if h_old == 0: return None
            cumulative_change = (h_now - h_old) / h_old * 100
            if cumulative_change > threshold: return None 
            
            h_prev = df.loc[1, 'holder_num']
            if h_prev == 0: return None
            latest_change = (h_now - h_prev) / h_prev * 100
            if latest_change > 3.0: return None
            
            return {**stock_info, 'cumulative_change': cumulative_change, 'latest_change': latest_change, 'latest_holders': h_now}
        except: return None

    def get_chip_candidates(self, stock_df, mode):
        print(f"🔍 [2/6] 扫描筹码 (模式: {mode} | 多线程加速)...")
        end_date = datetime.datetime.now().strftime('%Y%m%d')
        start_date = (datetime.datetime.now() - relativedelta(months=18)).strftime('%Y%m%d')
        self._load_holdernumber_pool(start_date, end_date)
        candidates = []
        stock_list = stock_df.to_dict('records')
        total = len(stock_list); processed = 0
        
        with ThreadPoolExecutor(max_workers=5) as executor:
            future_to_stock = {executor.submit(self._process_chip_single, item, mode): item for item in stock_list}
            for future in as_completed(future_to_stock):
                processed += 1
                if processed % 100 == 0: print(f"   ...进度 {processed}/{total} | 筹码合格: {len(candidates)}    ", end='\r')
                result = future.result()
                if result: candidates.append(result)
        print(f"\n   ✅ 筹码筛选完成，入围: {len(candidates)} 只")
        return pd.DataFrame(candidates)

    # ================= 3. 技术面过滤 =================
    def _check_technicals_single(self, stock_info):
        pro = self._get_pro_worker()
        code = stock_info['ts_code']
        end_date = datetime.datetime.now().strftime('%Y%m%d')
        start_date = (datetime.datetime.now() - datetime.timedelta(days=600)).strftime('%Y%m%d')
        try:
            df = self._request_with_retry(pro.daily, api_name='daily', ts_code=code, start_date=start_date, end_date=end_date, fields='ts_code,trade_date,close,vol,pct_chg')
            if df is None or df.empty or len(df) < 60: return None
            df = df.sort_values('trade_date', ascending=False).reset_index(drop=True)
            current_close = df.loc[0, 'close']
            
            stock_info['pct_chg'] = df.loc[0, 'pct_chg']
            
            ma5 = df['close'].head(5).mean(); ma10 = df['close'].head(10).mean(); ma20 = df['close'].head(20).mean(); ma60 = df['close'].head(60).mean()
            if current_close < ma60: return None
            bias_60 = (current_close - ma60) / ma60 * 100
            if bias_60 > 25.0: return None
            
            try:
                idx_long_term = 350 if len(df) > 350 else len(df) - 1
                price_long_ago = df.loc[idx_long_term, 'close']
                long_term_gain = (current_close - price_long_ago) / price_long_ago * 100
                if long_term_gain > 120.0: return None 
            except: pass
            
            if ma20 <= ma60: pattern_status = "底部启动"
            else: pattern_status = "趋势主升"
            
            volume_signal = ""
            try:
                recent_5 = df.head(5)
                ma_vol_20 = df['vol'].head(20).mean()
                high_vol_days = sum(1 for _, r in recent_5.iterrows() if r['vol'] > ma_vol_20)
                total_ratio = (recent_5['vol'] / ma_vol_20).sum() if ma_vol_20 > 0 else 0
                if high_vol_days >= 3 and (total_ratio/5) < 3.0: volume_signal = "温和放量"
            except: pass
            
            stock_info['close'] = current_close; stock_info['bias_60'] = bias_60
            stock_info['pattern'] = pattern_status; stock_info['vol_signal'] = volume_signal
            return stock_info
        except: return None

    def apply_technical_filters(self, candidates_df):
        if candidates_df.empty: return pd.DataFrame()
        print("📉 [3/6] 技术面过滤...")
        filtered_list = []
        stock_list = candidates_df.to_dict('records')
        total = len(stock_list); processed = 0
        
        with ThreadPoolExecutor(max_workers=5) as executor:
            future_to_stock = {executor.submit(self._check_technicals_single, item): item for item in stock_list}
            for future in as_completed(future_to_stock):
                processed += 1
                if processed % 50 == 0: print(f"   ...验证进度 {processed}/{total} | 存活: {len(filtered_list)}    ", end='\r')
                result = future.result()
                if result: filtered_list.append(result)
        print(f"\n   ✅ 技术面验证结束，最终锁定: {len(filtered_list)} 只")
        return pd.DataFrame(filtered_list)

    # ================= 4. 断点续传 =================
    def filter_existing_in_db(self, df):
        if df.empty: return df
        print("🛑 数据库查重 (断点续传)...")
        today_str = datetime.datetime.now().strftime('%Y%m%d')
        try:
            resp = self.api._post('/api/db/query', {
                'sql': 'SELECT ts_code FROM chip_hunter WHERE scan_date = ?',
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

    # ================= 5. 重型计算 =================
    def _calculate_core_metrics(self, stock_info, bypass_efficiency_filter=False):
        pro = self._get_pro_worker()
        ts_code = stock_info['ts_code']
        industry = stock_info.get('industry')
        res = stock_info.copy()
        
        anchor_date = None

        # --- A. 行情与估值 (获取锚点日期) ---
        try:
            df_daily = self._request_with_retry(pro.daily_basic, api_name='daily_basic', ts_code=ts_code, limit=3,
                                                fields='ts_code,trade_date,turnover_rate,pe_ttm,pb,ps_ttm,total_mv,volume_ratio')
            if not df_daily.empty:
                #res['turnover_rate_3d'] = df_daily['turnover_rate'].mean() # 3日日均换手
                res['turnover_rate_3d'] = float(df_daily['turnover_rate'].mean()) #修正换手率计算（解决 0 成功问题）
                latest = df_daily.iloc[0]
                res['pe_ttm'] = latest['pe_ttm']
                res['pb'] = latest['pb']
                res['ps_ttm'] = latest['ps_ttm']
                res['total_mv'] = latest['total_mv'] / 10000.0 if pd.notna(latest['total_mv']) else None
                res['volume_ratio'] = latest['volume_ratio']
                res['turnover_rate'] = latest['turnover_rate']
                anchor_date = latest['trade_date']
            else: return None
        except: return None

        # --- B. 财务指标 ---
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

        # --- [100% Alpha 移植] 机构持仓识别与计算 ---
        try:
            # 1. 动态确定 Alpha 报告期
            # 用 top10_holders 范围查询取最新2期
            today_str = datetime.datetime.now().strftime('%Y%m%d')
            start_dt = (datetime.datetime.strptime(today_str, '%Y%m%d') - datetime.timedelta(days=450)).strftime('%Y%m%d')
            df_holder_all = self._request_with_retry(pro.top10_holders, ts_code=ts_code, start_date=start_dt, end_date=today_str)
            
            if df_holder_all is None or df_holder_all.empty:
                raise ValueError("无股东数据")
            
            available_periods = sorted(df_holder_all['end_date'].unique().tolist(), reverse=True)
            if len(available_periods) < 2:
                raise ValueError("可用期数不足2期")
            
            df_q_now = df_holder_all[df_holder_all['end_date'] == available_periods[0]]
            df_q_prev = df_holder_all[df_holder_all['end_date'] == available_periods[1]]
            
            # 3. 严格计算并转换为 Float (Chip 库定义要求)
            # self.get_smart_stats 内部已完成身份识别
            res['ratio_current'] = float(self.get_smart_stats(df_q_now))
            res['ratio_prev_1'] = float(self.get_smart_stats(df_q_prev))
            
        except Exception:
            # 失败则保持 NULL，避免存入脏数据
            res['ratio_current'] = None
            res['ratio_prev_1'] = None

        # --- C. 5年历史分位 ---
        try:
            start_date_5y = (datetime.datetime.now() - relativedelta(years=5)).strftime('%Y%m%d')
            df_hist = self._request_with_retry(pro.daily_basic, api_name='daily_basic', ts_code=ts_code, start_date=start_date_5y, fields='pe_ttm,pb')
            if not df_hist.empty and len(df_hist) > 100:
                cur_pe = res.get('pe_ttm')
                if pd.notna(cur_pe): res['pe_ttm_percentile'] = round((df_hist['pe_ttm'] < float(cur_pe)).mean() * 100, 2)
                cur_pb = res.get('pb')
                if pd.notna(cur_pb): res['pb_percentile'] = round((df_hist['pb'] < float(cur_pb)).mean() * 100, 2)
        except: pass

        # --- D. 行业中值 ---
        if industry and anchor_date:
            try:
                df_ind_stocks = self._request_with_retry(pro.stock_basic, industry=industry, list_status='L', fields='ts_code,industry')
                if not df_ind_stocks.empty:
                    df_ind_stocks = df_ind_stocks[df_ind_stocks['industry'] == industry]
                    ind_codes_list = df_ind_stocks['ts_code'].tolist()
                    if ind_codes_list:
                        df_market_daily = self._request_with_retry(pro.daily_basic, api_name='daily_basic', trade_date=anchor_date, fields='ts_code,pe_ttm,pb,turnover_rate')
                        if not df_market_daily.empty:
                            df_ind_daily = df_market_daily[df_market_daily['ts_code'].isin(ind_codes_list)]
                            if not df_ind_daily.empty:
                                res['industry_pe_ttm_median'] = df_ind_daily['pe_ttm'].median()
                                res['industry_pb_median'] = df_ind_daily['pb'].median()
                                res['industry_turnover_rate_3d'] = df_ind_daily['turnover_rate'].median() * 3 
            except: pass

        # --- E. 资金流 ---
        try:
            df_flow = self._request_with_retry(pro.moneyflow, ts_code=ts_code, limit=5, fields='trade_date,buy_lg_amount,buy_elg_amount,sell_lg_amount,sell_elg_amount')
            if not df_flow.empty:
                df_flow['net'] = (df_flow['buy_lg_amount'] + df_flow['buy_elg_amount']) - (df_flow['sell_lg_amount'] + df_flow['sell_elg_amount'])
                res['net_inflow_5d'] = df_flow['net'].sum()
                res['net_mf_amount'] = df_flow.iloc[0]['net']
        except: pass

        # --- F. 文本信息 ---
        try:
            df_cpt = self._request_with_retry(pro.concept_detail, ts_code=ts_code)
            if not df_cpt.empty:
                res['concepts'] = "; ".join(df_cpt['concept_name'].unique().tolist()[:10])
        except: pass
        
        try:
            if anchor_date:
                df_top = self._request_with_retry(pro.top_list, trade_date=anchor_date)
                if not df_top.empty:
                    row_top = df_top[df_top['ts_code'] == ts_code]
                    if not row_top.empty:
                        res['top_list_reason'] = row_top.iloc[0]['reason']
        except: pass

        # --- G. 一致预期 & PEG (NTM 严谨算法) ---
        #---------------------------------------------------------------------------------------
        # --- G. 一致预期 & PEG (NTM 严谨算法 - V13.1 加固版) ---
        # 🛡️ 核心修复：增加本地变量防御，确保即使计算异常也不干扰主程序流程
        eps_ntm = None
        con_growth = None
        try:
            pure_code = str(ts_code.split('.')[0])
            eps1, eps2 = None, None
            
            # 1. 提取 Akshare 利润预测 (增加强力类型转换防御)
            # 🛡️ [修改] 使用 hasattr 检查 self.df_ak 是否就绪，并确保索引匹配不报 TypeError
            if hasattr(self, 'df_ak') and not self.df_ak.empty and pure_code in self.df_ak.index:
                # 🛡️ [修改] 处理 loc 可能返回 Series 的极端情况，并强转原生 float
                def extract_val(col_name):
                    try:
                        val = self.df_ak.loc[pure_code, col_name]
                        # 如果同一个 pure_code 有多条记录，只取第一条
                        if isinstance(val, (pd.Series, np.ndarray)): val = val.iloc[0] if len(val)>0 else None
                        return float(val) if pd.notna(val) else None
                    except: return None

                eps1 = extract_val(self.col_eps1)
                eps2 = extract_val(self.col_eps2)
                
                # 🛡️ 错位探测装甲：纠偏逻辑 (原有注解保留)
                # 如果去年的列有数据，说明 Akshare 表头左移了，强制右移纠偏
                if hasattr(self, 'col_eps_prev') and self.col_eps_prev in self.df_ak.columns:
                    val_prev = extract_val(self.col_eps_prev)
                    # 🛡️ [关键修复] 增加对 None 的判定，防止 float(None) > 0 报错导致标的被误杀
                    if val_prev is not None and val_prev > 0:
                        eps2 = eps1            # 实际上是 FY2
                        eps1 = val_prev         # 实际上是 FY1
                    
            res['forecast_eps_fy1'] = eps1
            res['forecast_eps_fy2'] = eps2

            # 2. 计算动态 NTM (严格过滤 NaN)
            pe_ttm_raw = res.get('pe_ttm')
            close_raw = res.get('close')
            
            # 🛡️ [修改] 强转 float 防止 Tushare 接口返回的 numpy 对象参与运算时报错
            pe_ttm_val = float(pe_ttm_raw) if pd.notna(pe_ttm_raw) else None
            close_val = float(close_raw) if pd.notna(close_raw) else None
            
            # 🛡️ 逻辑对齐检查：
            # Base_EPS: 过去12月盈利 (TTM)
            # EPS_NTM: 未来12月盈利预测 (Rolling)
            if pe_ttm_val is not None and pe_ttm_val != 0 and close_val is not None:
                base_eps = close_val / pe_ttm_val
                
                if eps1 is not None and eps2 is not None:
                    # 分别读取 self.w1, self.w2 权重 (注意：需确保 run 方法中已赋值)
                    w1_val = getattr(self, 'w1', 1.0)
                    w2_val = getattr(self, 'w2', 0.0)
                    eps_ntm = (eps1 * w1_val) + (eps2 * w2_val)
                    
                    if base_eps != 0:
                        # G = (未来12月 - 过去12月) / 过去12月
                        con_growth = round(((eps_ntm - base_eps) / abs(base_eps)) * 100, 2)
                        res['con_growth_rate'] = con_growth
                        
                        # PEG = 前瞻PE / G (确保时空对齐)
                        if eps_ntm > 0 and con_growth > 0:
                            forward_pe = close_val / eps_ntm
                            res['peg'] = round(forward_pe / con_growth, 2)
        except Exception as e: 
            # 捕获异常但不返回 None，让标的通过其他条件(如换手率)也有入库机会
            # print(f"      ⚠️ DEBUG: {ts_code} NTM计算路径异常: {e}")
            pass
        
        # ==========================================================
        # 🛑 狙击手拦截网 (Efficiency Filter)
        # ==========================================================
        # 🚨 原有逻辑不动：仅当 (预期盈利且高增) 或 (日均换手率>8.0%) 时入库
        to_3d_val = res.get('turnover_rate_3d', 0.0)
        to_3d_val = float(to_3d_val) if pd.notna(to_3d_val) else 0.0

        is_fund_ok = (eps_ntm is not None and eps_ntm > 0) and (con_growth is not None and con_growth > 0)
        is_hot_ok = (to_3d_val > 8.0)

        if not bypass_efficiency_filter and not (is_fund_ok or is_hot_ok):
            # 💡 关键：我们在这里给 original_item 偷偷塞进这两个实测值，方便后面打印
            stock_info['_diag_g'] = con_growth 
            stock_info['_diag_to'] = to_3d_val
            return None 

        return res
        
    # ==========================================================
    # ✨ 在这里插入新方法：单股实时诊断入口
    # ==========================================================
    
    def get_single_stock_full_data(self, ts_code):
        """
        [手工模式核心接驳] 撇开筛选，执行主程序全套计算与字段映射逻辑
        """
        # 1. 代码格式修正
        if '.' not in ts_code:
            if ts_code.startswith(('6', '9')): ts_code = f"{ts_code}.SH"
            elif ts_code.startswith(('0', '3')): ts_code = f"{ts_code}.SZ"
            elif ts_code.startswith(('8', '4')): ts_code = f"{ts_code}.BJ"

        # 2. 检查预测库 (确保 zfill(6) 物理对齐)
        if not hasattr(self, 'df_ak') or self.df_ak is None or self.df_ak.empty:
            import akshare as ak
            try:
                _df = ak.stock_profit_forecast_em()
                _df['pure_code'] = _df['代码'].astype(str).str.zfill(6)
                self.df_ak = _df.set_index('pure_code')
            except: self.df_ak = pd.DataFrame()

        # 3. 抓取基础资料
        basic = self._request_with_retry(self.pro_main.stock_basic, ts_code=ts_code, fields='ts_code,name,industry')
        if basic is None or basic.empty: return {"error": "拦截", "reason": f"未找到代码: {ts_code}"}
        stock_info = basic.iloc[0].to_dict()

        # 4. 🔥 [关键补全] 抓取主程序技术面必需字段 (不拦截，只计算)
        # 只有抓了这步，字典里才有 close，核心计算里的 G 才能算出来
        try:
            end_date_t = datetime.datetime.now().strftime('%Y%m%d')
            start_date_t = (datetime.datetime.now() - datetime.timedelta(days=600)).strftime('%Y%m%d')
            df_tech = self._request_with_retry(self.pro_main.daily, api_name='daily', ts_code=ts_code, start_date=start_date_t, end_date=end_date_t, fields='ts_code,trade_date,close,vol,pct_chg')
            if not df_tech.empty:
                df_tech = df_tech.sort_values('trade_date', ascending=False).reset_index(drop=True)
                stock_info['close'] = df_tech.loc[0, 'close']  # 注入收盘价（计算 G 的生命线）
                stock_info['pct_chg'] = df_tech.loc[0, 'pct_chg']
                ma20 = df_tech['close'].head(20).mean()
                ma60 = df_tech['close'].head(60).mean()
                stock_info['bias_60'] = (stock_info['close'] - ma60) / ma60 * 100
                stock_info['pattern'] = "底部启动" if ma20 <= ma60 else "趋势主升"
                
                # 注入 vol_signal
                ma_vol_20 = df_tech['vol'].head(20).mean()
                recent_5 = df_tech.head(5)
                high_vol_days = sum(1 for _, r in recent_5.iterrows() if r['vol'] > ma_vol_20)
                total_ratio = (recent_5['vol'] / ma_vol_20).sum() if ma_vol_20 > 0 else 0
                stock_info['vol_signal'] = "温和放量" if (high_vol_days >= 3 and (total_ratio/5) < 3.0) else ""
        except: pass

        # 5. 驱动筹码穿透
        chip_results = self._process_chip_single(stock_info, mode='established')
        if chip_results: stock_info.update(chip_results)

        # 6. 驱动核心计算引擎 (算 PE, PB, G, PEG)
        final_res = self._calculate_core_metrics(stock_info, bypass_efficiency_filter=True)
        
        # 7. 处理拦截诊断
        if final_res is None:
            g_val = stock_info.get('_diag_g', 'N/A')
            to_val = stock_info.get('_diag_to', 0.0)
            return {"error": "拦截", "reason": f"未达标: G({g_val}%) 换手({to_val}%)"}

        # 8. 🔥 [字段对齐] 模拟主程序 save_to_db 里的字段重命名与标签合成
        # 这一步如果不做，数据库里的 tags, score, chip_cumu_change 永远是空！
        cumu_change = final_res.get('cumulative_change')
        last_change = final_res.get('latest_change')
        
        if cumu_change is not None and last_change is not None:
            final_res['tags'] = f"近三季股东户数变化{cumu_change:.1f}%，近一季股东户数变化{last_change:.1f}%"
            final_res['score'] = abs(cumu_change)
        
        holders = final_res.get('latest_holders')
        final_res['holders_wan'] = holders / 10000.0 if holders is not None else None
        
        # 物理重命名，对齐数据库表结构
        final_res['chip_cumu_change'] = cumu_change
        final_res['chip_latest_change'] = last_change
        final_res.pop('cumulative_change', None)
        final_res.pop('latest_change', None)
        final_res.pop('latest_holders', None)
        final_res.pop('last_eps', None)
            
        return final_res

    def run_heavy_analysis_parallel(self, df_candidates):
        if df_candidates.empty: return 0
        print("🏋️ [5/6] 启动重型计算 (全字段/多线程)...")
        pending_results = []
        selected_count = 0
        failed_list = []
        def format_pct(value, width):
            try:
                if value is None or pd.isna(value):
                    return "数据缺失"
                return f"{float(value):>{width}.2f}%"
            except (TypeError, ValueError):
                return "数据缺失"
        stock_list = df_candidates.to_dict('records')
        total = len(stock_list); processed = 0
        
        with ThreadPoolExecutor(max_workers=8) as executor:
            future_to_stock = {executor.submit(self._calculate_core_metrics, item): item for item in stock_list}
            for future in as_completed(future_to_stock):
                original_item = future_to_stock[future]
                processed += 1
                try:
                    result = future.result()
                    if result:
                        selected_count += 1
                        pending_results.append(result)
                        print(f"   ✅ 完成 {processed}/{total}: {original_item['name']} ", end='\r')
                    else:
                        failed_list.append(original_item['ts_code'])

                        g_val = original_item.get('_diag_g', 'N/A')
                        to_val = original_item.get('_diag_to', 0.0)
                    
                        # 格式化打印：一眼看出是哪项没达标
                        g_str = format_pct(g_val, 6)
                        to_str = format_pct(to_val, 5)
                        print(f"   🛡️ 拦截诊断 [{original_item['name']:<4}] | 实际 G: {g_str:>8} | 3日均换手: {to_str}")
                except Exception as e:
                    failed_list.append(original_item['ts_code'])
                    print(f"   ❌ 异常 {processed}/{total}: {original_item['name']} {e}   ", end='\r')

                if len(pending_results) >= BATCH_SIZE:
                    self.save_to_db(pd.DataFrame(pending_results))
                    pending_results.clear()

        if pending_results:
            self.save_to_db(pd.DataFrame(pending_results))
            pending_results.clear()

        print(f"\n   🎉 计算完成! 成功: {selected_count}, 失败/拦截: {len(failed_list)}")
        return selected_count

    # ================= 6. 存库 =================
    def save_to_db(self, df):
        if df.empty: return
        print(f"💾 [6/6] 写入数据库 (共 {len(df)} 条)...")
        
        df['scan_date'] = datetime.datetime.now().strftime('%Y%m%d')
        df['create_time'] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

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

        records = []
        try:
            for _, row in df.iterrows():
                cumu_change = safe_get(row, 'cumulative_change')
                last_change = safe_get(row, 'latest_change')
                
                c_val = f"{cumu_change:.1f}%" if cumu_change is not None else None
                l_val = f"{last_change:.1f}%" if last_change is not None else None
                
                if c_val is not None and l_val is not None:
                    dynamic_tags = f"近三季股东户数变化{c_val}，近一季股东户数变化{l_val}"
                else:
                    dynamic_tags = None
                    
                score_val = abs(cumu_change) if cumu_change is not None else None
                holders = safe_get(row, 'latest_holders')
                holders_wan_val = holders / 10000 if holders is not None else None

                record = {
                    'scan_date': safe_get(row, 'scan_date', is_float=False),
                    'ts_code': safe_get(row, 'ts_code', is_float=False),
                    'name': safe_get(row, 'name', is_float=False),
                    'industry': safe_get(row, 'industry', is_float=False),
                    
                    'close': safe_get(row, 'close'),
                    'pct_chg': safe_get(row, 'pct_chg'),
                    'turnover_rate': safe_get(row, 'turnover_rate'),
                    'volume_ratio': safe_get(row, 'volume_ratio'),
                    'total_mv': safe_get(row, 'total_mv'),
                    
                    'tags': dynamic_tags,
                    'score': score_val,
                    'holders_wan': holders_wan_val,
                    'chip_cumu_change': cumu_change,
                    'chip_latest_change': safe_get(row, 'latest_change'),
                    
                    'net_mf_amount': safe_get(row, 'net_mf_amount'),
                    'net_inflow_5d': safe_get(row, 'net_inflow_5d'),
                    
                    'turnover_rate_3d': safe_get(row, 'turnover_rate_3d'),
                    'industry_turnover_rate_3d': safe_get(row, 'industry_turnover_rate_3d'),
                    
                    'pe_ttm': safe_get(row, 'pe_ttm'),
                    'pe_ttm_percentile': safe_get(row, 'pe_ttm_percentile'),
                    'industry_pe_ttm_median': safe_get(row, 'industry_pe_ttm_median'),
                    'peg': safe_get(row, 'peg'),
                    'pb': safe_get(row, 'pb'),
                    'pb_percentile': safe_get(row, 'pb_percentile'),
                    'industry_pb_median': safe_get(row, 'industry_pb_median'),
                    'ratio_current': safe_get(row, 'ratio_current'),
                    'ratio_prev_1': safe_get(row, 'ratio_prev_1'),
                    'ps_ttm': safe_get(row, 'ps_ttm'),
                    
                    'forecast_eps_fy1': safe_get(row, 'forecast_eps_fy1'),
                    'forecast_eps_fy2': safe_get(row, 'forecast_eps_fy2'),
                    'con_growth_rate': safe_get(row, 'con_growth_rate'),
                    
                    'roe': safe_get(row, 'roe'),
                    'grossprofit_margin': safe_get(row, 'grossprofit_margin'),
                    'netprofit_yoy': safe_get(row, 'netprofit_yoy'),
                    'concepts': safe_get(row, 'concepts', is_float=False),
                    'top_list_reason': safe_get(row, 'top_list_reason', is_float=False),
                    
                    'pattern': safe_get(row, 'pattern', is_float=False),
                    'bias_60': safe_get(row, 'bias_60'),
                    'vol_signal': safe_get(row, 'vol_signal', is_float=False),
                    'create_time': safe_get(row, 'create_time', is_float=False)
                }
                records.append(record)
            resp = self.api._post('/api/db/save', {'table': 'chip_hunter', 'data': records})
            print(f"✅ 成功入库: {resp.get('count', len(records))} 条")
        except Exception as e:
            print(f"❌ 入库错误: {e}")
            traceback.print_exc()
            raise

    def run(self, mode='established'):
        print(f"🦁 [Chip Hunter V13.1] 启动 -> 模式: {mode}")
        df_stocks = self.get_valid_stock_list(mode=mode)
        if df_stocks.empty: return
        df_stocks = self.filter_existing_in_db(df_stocks)
        if df_stocks.empty:
            print("✅ 今日 Chip 结果已处理完毕。")
            return

        import akshare as ak
        print("🌐 [INFO] 正在通过 Akshare 拉取全市场【机构一致预期】...")
        try:
            self.df_ak = ak.stock_profit_forecast_em()
            if self.df_ak is None or self.df_ak.empty:
                raise RuntimeError("Akshare 机构一致预期为空")
            self.df_ak['pure_code'] = self.df_ak['代码'].astype(str).str.zfill(6)
            self.df_ak = self.df_ak.set_index('pure_code')
        except Exception as e:
            print(f"❌ Akshare 数据拉取失败，Chip Hunter 终止: {e}")
            return

        valid_forecast_codes = set(self.df_ak.index)
        initial_len = len(df_stocks)
        df_stocks = df_stocks[df_stocks['ts_code'].str.split('.').str[0].isin(valid_forecast_codes)].copy()
        print(f"🧹 [预清理] 已过滤掉 {initial_len - len(df_stocks)} 只无机构预测标的，剩余 {len(df_stocks)} 只。")
        if df_stocks.empty:
            print("❌ 机构预测过滤后无剩余标的")
            return

        df_chip = self.get_chip_candidates(df_stocks, mode=mode)
        if df_chip.empty: print("❌ 无筹码合格标的"); return
            
        df_tech = self.apply_technical_filters(df_chip)
        if df_tech.empty: print("❌ 技术面过滤后无剩余"); return

        self.run_heavy_analysis_parallel(df_tech)

if __name__ == "__main__":
    screener = ChipHunterStrategy(MY_TOKEN)
    screener.run(mode='established')
