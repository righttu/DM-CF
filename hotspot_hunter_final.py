"""
==================================================
项目: Hotspot Hunter 数据生产引擎 (终极定稿版)
版本: 2026.03.01-V45.2-Final (NTM 估值 & 狙击网实装)
核心修复:
1. 单位对齐: 修正 (万元/千元) 换手逻辑，mf_intensity 恢复正常量级.
2. 覆盖逻辑: 使用 INSERT OR REPLACE 自动覆盖已有错误数据.
3. 30字段全补齐: 包含行业对比、筹码审计、EPS预测等.
==================================================
# 🔽🔽🔽 新增版本记录 🔽🔽🔽
4. NULL 语义重构: 严格区分0与缺失值，获取不到的数据全部转为 None(入库即为NULL)。
5. 预测源切换: 废弃 Tushare 滞后研报，改用 Akshare 纯数字代码精确提取当年/次年 EPS。
6. NTM 动态估值: 引入彭博同款 NTM (Next 12 Months) 线性插值法重构 G 与 PEG，解决时间缩水。
7. 效率拦截网: 强制拦截垃圾股！仅当 [基本面双正(预期盈利且增长)] 或 [3日换手率>8%(热钱异动)] 时才允许入库。
8. 数据库减负: 修复了原代码重复的 SQLite 连接；清洗了底层 Pandas NaN 穿透 Bug。
==================================================
"""
import os
import requests
import tushare as ts
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import time

# --- 1. 核心配置 ---
TS_TOKEN = os.getenv("MY_TUSHARE_TOKEN")
pro = ts.pro_api(TS_TOKEN)
#pro._DataApi__http_url = 'https://tushare.top/dataapi/' 

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

api = CloudAPIClient(D1_API_URL)

def get_accurate_hist_days(target_date, count=5):
    """获取 target_date 及其之前的 N 个交易日窗口"""
    start_lookback = (datetime.strptime(target_date, '%Y%m%d') - timedelta(days=30)).strftime('%Y%m%d')
    df = pro.trade_cal(is_open='1', start_date=start_lookback, end_date=target_date)
    return df['cal_date'].tail(count).tolist()

def get_sync_list():
    """计算需要同步的日期列表"""
    # 1. 如果表不存在则创建 (注意字段名已改为 scan_date)
    api._post('/api/db/execute', {'sql': '''CREATE TABLE IF NOT EXISTS hotspot_hunter (
        ts_code TEXT, trade_date TEXT, name TEXT, industry TEXT, sector TEXT, close REAL,
        turnover_rate_3d REAL, industry_turnover_rate_3d REAL, pe_ttm REAL, 
        pe_ttm_percentile REAL, industry_pe_ttm_median REAL, peg REAL, pb REAL, 
        pb_percentile REAL, industry_pb_median REAL, forecast_eps_fy1 REAL, 
        forecast_eps_fy2 REAL, net_inflow_5d REAL, total_mv REAL, ps_ttm REAL, 
        con_growth_rate REAL, chip_latest_change TEXT, chip_cumu_change TEXT,
        volume_ratio REAL, mf_intensity REAL, pct_chg REAL, net_mf_amount REAL,
        bias_60 REAL, is_institutional INTEGER, em_reason TEXT, scan_date TEXT, tags TEXT,
        PRIMARY KEY (ts_code, trade_date)
    )'''})
    # 检测数据库现有最后一天
    resp = api._post('/api/db/query', {'sql': "SELECT MAX(trade_date) AS max_date FROM hotspot_hunter"})
    res = resp.get('results', [])
    db_last_date = res[0].get('max_date') if res and res[0].get('max_date') else None
    
    today = datetime.now()
    today_str = today.strftime('%Y%m%d')
    
    # 🔥 [新增熔断机制] 计算半个月（15天）前的日期
    half_month_ago = (today - timedelta(days=15)).strftime('%Y%m%d')
    
    # 逻辑判断：如果数据库是空的，或者断更太久（早于15天前），强制从15天前开始拉取
    if not db_last_date or db_last_date < half_month_ago:
        last_date = half_month_ago
        print(f"⚠️ [防爆熔断] 数据库记录过旧或为空，强制截断，最多拉取近半个月（自 {last_date} 起）的数据。")
    else:
        last_date = db_last_date
        
    print(f"🔍 [STEP 1] 检查更新区间: 自 {last_date} 起至今日 {today_str}")
    
    df_cal = pro.trade_cal(is_open='1', start_date=last_date, end_date=today_str)
    sync_list = df_cal[df_cal['cal_date'] >= last_date]['cal_date'].tolist()
    return sync_list

def run_sync_v45_2():
    sync_list = get_sync_list()
    if not sync_list:
        print("✨ [INFO] 数据库已经是最新。")
        return
    
    # 🚀 [新增外挂] 一次性拉取全市场的机构一致预期
    import akshare as ak
    print("🌐 [INFO] 正在通过 Akshare 拉取东方财富全市场【机构一致预期】...")
    try:
        df_ak = ak.stock_profit_forecast_em()
        if df_ak is None or df_ak.empty:
            raise RuntimeError("Akshare 机构一致预期为空")
        df_ak['pure_code'] = df_ak['代码'].astype(str).str.zfill(6)
        df_ak = df_ak.set_index('pure_code')
        print("✅ 成功拉取机构盈利预测全量表！")
    except Exception as e:
        print(f"❌ Akshare 数据拉取失败，Hotspot Hunter 终止: {e}")
        return
    valid_forecast_codes = set(df_ak.index)

    # 🚀 全局 NTM 权重与动态年份列名初始化 (每天仅算一次)
    current_year = datetime.now().year
    day_of_year = datetime.now().timetuple().tm_yday
    w1 = (365 - day_of_year) / 365.0
    w2 = day_of_year / 365.0
    col_eps1 = f"{current_year}预测每股收益"
    col_eps2 = f"{current_year + 1}预测每股收益"
    col_eps_prev = f"{current_year - 1}预测每股收益"  # 🛡️ 新增：年报季错位嗅探列

    total_inserted = 0  # 🌟 新增：初始化本次任务的总入库计数器
    holdernumber_cache = {}

    for t_date in sync_list:
        print(f"\n🚀 [V45.2-Final] 正在执行深度审计: {t_date}")
        hist_days = get_accurate_hist_days(t_date, 5)
        
        try:
            # A. 抓取全市场快照
            df_b = pro.daily_basic(trade_date=t_date).set_index('ts_code')
            df_d = pro.daily(trade_date=t_date).set_index('ts_code')
            df_m = pro.moneyflow(trade_date=t_date).set_index('ts_code')
            
            if df_b.empty or df_d.empty:
                print(f"⚠️ {t_date} 行情未发布，跳过。")
                continue

            # B. 批量计算窗口均值 (3日换手, 5日流入)
            df_b_hist = pd.concat([pro.daily_basic(trade_date=d) for d in hist_days[-3:]])
            turnover_3d_map = df_b_hist.groupby('ts_code')['turnover_rate_f'].mean()
            
            df_m_hist = pd.concat([pro.moneyflow(trade_date=d) for d in hist_days])
            inflow_5d_map = df_m_hist.groupby('ts_code')['net_mf_amount'].sum()

            # C. 行业中位值对比
            df_info = pro.stock_basic(fields='ts_code,industry')
            df_market = df_b.reset_index().merge(df_info, on='ts_code')
            ind_pe_map = df_market.groupby('industry')['pe_ttm'].median().to_dict()
            ind_pb_map = df_market.groupby('industry')['pb'].median().to_dict()
            ind_to_avg = df_market.merge(turnover_3d_map.rename('to3d'), left_on='ts_code', right_index=True).groupby('industry')['to3d'].mean().to_dict()

        except Exception as e:
            print(f"❌ 批量行情抓取失败: {e}")
            break

        # D. 遍历审计库
        fetch_sql = """SELECT ts_code, name, sector, remark, em_reason, purity
FROM hotspot_registry
WHERE purity = '真题材'"""
        resp = api._post('/api/db/query', {'sql': fetch_sql})
        registry = [(
            row.get('ts_code'), row.get('name'), row.get('sector'),
            row.get('remark'), row.get('em_reason'), row.get('purity')
        ) for row in resp.get('results', [])]
        registry = [
            row for row in registry
            if str(row[0]).split('.')[0].zfill(6) in valid_forecast_codes
        ]
        success_count = 0

        for ts_code, name, sector, remark, em_reason, purity in registry:
            try:
                if ts_code not in df_b.index: continue
                b, d, m = df_b.loc[ts_code], df_d.loc[ts_code], df_m.loc[ts_code]
                ind = df_info[df_info['ts_code'] == ts_code]['industry'].iloc[0]

                # 1. 基础行情计算 (安全处理 amount 的 NaN)
                amount_val = d.get('amount')
                mf_i = (m['net_mf_amount'] * 10 / amount_val) * 100 if pd.notna(amount_val) and amount_val > 0 else None

                # 2. 筹码数据 (初始化为 None)
                if ts_code not in holdernumber_cache:
                    holdernumber_cache[ts_code] = pro.stk_holdernumber(ts_code=ts_code, limit=4)
                chips = holdernumber_cache[ts_code].copy()
                c_latest, c_cumu = None, None
                if len(chips) >= 2:
                    c_latest = f"{((chips.iloc[0]['holder_num']/chips.iloc[1]['holder_num']-1)*100):.2f}%"
                if len(chips) >= 4:
                    c_cumu = f"{((chips.iloc[0]['holder_num']/chips.iloc[3]['holder_num']-1)*100):.2f}%"

                # 3. 预测数据 (废弃 Tushare，改用 Akshare 纯数字提取 + 年报季错位修复)
                pure_code = ts_code.split('.')[0]
                eps1, eps2 = None, None
                if not df_ak.empty and pure_code in df_ak.index:
                    try:
                        if col_eps1 in df_ak.columns:
                            val1 = df_ak.loc[pure_code, col_eps1]
                            eps1 = float(val1) if pd.notna(val1) else None
                        if col_eps2 in df_ak.columns:
                            val2 = df_ak.loc[pure_code, col_eps2]
                            eps2 = float(val2) if pd.notna(val2) else None
                            
                        # 🛡️ 错位探测装甲：如果去年的列有数据，说明 Akshare 表头左移了，强制右移纠偏
                        if col_eps_prev in df_ak.columns:
                            val_prev = df_ak.loc[pure_code, col_eps_prev]
                            if pd.notna(val_prev) and float(val_prev) > 0:
                                eps2 = eps1            # 原来的当年列 实际上是次年(FY2)
                                eps1 = float(val_prev) # 原来的去年列 实际上是当年(FY1)
                    except Exception:
                        pass
                # ==========================================================
                # ✨ [深度修复区] 严格计算逻辑：不成功不入库
                # ==========================================================
                # A. 估值分位 (需回溯 5 年)
                start_5y = (datetime.now() - timedelta(days=5*365)).strftime('%Y%m%d')
                df_hist = pro.daily_basic(ts_code=ts_code, start_date=start_5y, fields='pe_ttm,pb')
                if df_hist.empty:
                    print(f"⚠️ {name} 历史数据获取失败(可能是积分限流)，跳过入库以便下次重试。")
                    continue 
                
                pe_pct = round((df_hist['pe_ttm'] < b['pe_ttm']).mean() * 100, 2) if pd.notna(b.get('pe_ttm')) else None
                pb_pct = round((df_hist['pb'] < b['pb']).mean() * 100, 2) if pd.notna(b.get('pb')) else None

                # B. 乖离率 (回溯 60 日)
                df_daily_60 = pro.daily(ts_code=ts_code, limit=60, fields='close')
                if len(df_daily_60) < 60:
                    print(f"⚠️ {name} 60日行情不足，跳过入库。")
                    continue 
                
                ma60 = df_daily_60['close'].mean()
                bias_60 = round((d['close'] - ma60) / ma60 * 100, 2) if pd.notna(ma60) and ma60 > 0 else None

                # C. 一致预期增速 & PEG (NTM 终极严谨版)
                con_growth = None
                actual_peg = None
                eps_ntm = None # 初始化，防止下方拦截网报错
                
                pe_ttm_val = b.get('pe_ttm')
                pe_ttm_val = float(pe_ttm_val) if pd.notna(pe_ttm_val) else None
                
                if pe_ttm_val is not None and pe_ttm_val != 0:
                    close_val = d.get('close')
                    if pd.notna(close_val):
                        base_eps = close_val / pe_ttm_val  # 允许 base_eps 为负
                        
                        if eps1 is not None and eps2 is not None:
                            eps_ntm = (eps1 * w1) + (eps2 * w2)
                            
                            if base_eps != 0:
                                con_growth = round(((eps_ntm - base_eps) / abs(base_eps)) * 100, 2)
                                
                                if eps_ntm > 0 and con_growth > 0:
                                    forward_pe = close_val / eps_ntm
                                    actual_peg = round(forward_pe / con_growth, 2)

                # D. 机构介入
                is_inst = 0 

                # ==========================================================
                # 🛑 [Step 3] 狙击手拦截网 (Efficiency Filter)
                # ==========================================================
                to_3d_val = turnover_3d_map.get(ts_code)
                to_3d_val = float(to_3d_val) if pd.notna(to_3d_val) else 0.0

                # 路线 A: 基本面优秀 (预期赚钱且预期正增长)
                is_fund_ok = (eps_ntm is not None and eps_ntm > 0) and (con_growth is not None and con_growth > 0)
                
                # 路线 B: 热钱极度活跃 (3日平均换手 > 8%)
                is_hot_ok = (to_3d_val > 8.0)

                # 最终裁决: 两路不通的垃圾股直接丢弃
                if not (is_fund_ok or is_hot_ok):
                    continue 

                # ==========================================================
                # 4. 执行写入（安全清洗 Pandas NaN 避免 SQLite 错误）
                # ==========================================================
                now_scan_date = datetime.now().strftime('%Y%m%d')
                combined_tags = remark 
                
                def safe_val(val):
                    return float(val) if pd.notna(val) else None

                api._post('/api/db/execute', {
                    'sql': '''INSERT OR REPLACE INTO hotspot_hunter (
    ts_code, trade_date, name, industry, sector, close,
    turnover_rate_3d, industry_turnover_rate_3d, pe_ttm,
    pe_ttm_percentile, industry_pe_ttm_median, peg, pb,
    pb_percentile, industry_pb_median, forecast_eps_fy1,
    forecast_eps_fy2, net_inflow_5d, total_mv, ps_ttm,
    con_growth_rate, chip_latest_change, chip_cumu_change,
    volume_ratio, mf_intensity, pct_chg, net_mf_amount,
    bias_60, is_institutional, em_reason, scan_date, tags
) VALUES (
    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
)''',
                    'params': [
                        ts_code, t_date, name, ind, sector, safe_val(d.get('close')),
                        safe_val(turnover_3d_map.get(ts_code)), safe_val(ind_to_avg.get(ind)),
                        pe_ttm_val, pe_pct, safe_val(ind_pe_map.get(ind)), actual_peg,
                        safe_val(b.get('pb')), pb_pct, safe_val(ind_pb_map.get(ind)), eps1, eps2,
                        safe_val(inflow_5d_map.get(ts_code)),
                        safe_val(b.get('total_mv'))/10000 if pd.notna(b.get('total_mv')) else None,
                        safe_val(b.get('ps_ttm')),
                        con_growth, c_latest, c_cumu, safe_val(b.get('volume_ratio')),
                        mf_i, safe_val(d.get('pct_chg')), safe_val(m.get('net_mf_amount')),
                        bias_60, is_inst, em_reason, now_scan_date, combined_tags
                    ]
                })
                success_count += 1
                
            except Exception as e:
                if "402" in str(e) or "每分钟最多访问" in str(e):
                    print(f"🚫 Tushare 频次限制，本次任务暂停，已入库 {success_count} 条。")
                    break
                #---------------
                else:
                    print(f"❌ 审计 {ts_code} {name} 遇到未知异常: {e}")
                    continue
        total_inserted += success_count  # 🌟 新增：把当天的数量累加到总池子里
        print(f"🚩 {t_date} 审计成功入库 {success_count} 条记录。")
    
    # 🌟 新增：打印醒目的最终战报
    print("\n" + "="*50)
    print(f"✨ [FINISH] 数据同步引擎任务结束。")
    print(f"📊 本次任务累计深度审计并入库标的: {total_inserted} 只")
    print("="*50 + "\n")

# 注意：下面这两行必须顶格写（前面不能有任何空格）
if __name__ == "__main__":
    # 这一行前面必须有 4 个空格的缩进
    run_sync_v45_2()
