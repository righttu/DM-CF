"""
模块名称：全市场基本面历史数据下载器 v3.5 [多线程+ROIC+增量版]
文件名：fetch_full_basic_data_v3_5.py
版本号：v3.5
修改日志：
1. [新增] 增加 roic 字段获取与存储。
2. [架构] 升级为 ThreadPoolExecutor 多线程并发模式。
3. [逻辑] 严格原子性事务：单一接口失败则回滚整条记录，杜绝残缺数据。
4. [配置] 默认下载时间窗口调整为近五年 (2020-01-01 起)。
"""

import os
import tushare as ts
import pandas as pd
import datetime
import time
import requests
# 引入线程池
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

# 配置区
D1_API_URL = 'https://stock-api.righttu.uk'
CF_ACCESS_CLIENT_ID = os.getenv("CF_ACCESS_CLIENT_ID")
CF_ACCESS_CLIENT_SECRET = os.getenv("CF_ACCESS_CLIENT_SECRET")

# 🌟 填入您的 18 位 Token
MY_TOKEN = os.getenv("MY_TUSHARE_TOKEN")
#新增 CloudAPIClient 类
class CloudAPIClient:
    """统一封装 HTTP 调用 + CF Access 认证"""
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

# ========================================================
# 数据库操作类
# ========================================================
class DBManager:
    """
    管理 D1 数据库 (via stock-api Worker)
    ⚠️ 偏差备注：旧代码用 SQLAlchemy ORM，新代码通过 HTTP API 调用 Worker
    旧代码的 ScreenResult 类和 save_screen_results 方法不再需要，不迁移
    """
    def __init__(self):
        # 旧代码：create_engine + Base.metadata.create_all + sessionmaker
        # 新代码：CloudAPIClient + 确保表存在
        self.api = CloudAPIClient(D1_API_URL)
        self._ensure_tables()
        print(f"🔌 [数据库 v10.0] 初始化完成：D1 via Worker API")

    def _ensure_tables(self):
        """确保 D1 中 stock_fundamentals 表存在"""
        # 旧代码：Base.metadata.create_all(self.engine) 自动建表
        # 新代码：手动 CREATE TABLE IF NOT EXISTS
        # chip_hunter 表不再需要，不创建
        self.api._post('/api/db/execute', {
            "sql": '''CREATE TABLE IF NOT EXISTS stock_fundamentals (
                ts_code TEXT, end_date TEXT, ann_date TEXT,
                revenue REAL, tr_yoy REAL, q_sales_yoy REAL,
                n_income_attr_p REAL, netprofit_yoy REAL, q_netprofit_yoy REAL,
                dt_netprofit_yoy REAL, q_dtprofit REAL, profit_dedt REAL,
                eps REAL, bps REAL, grossprofit_margin REAL, netprofit_margin REAL,
                roe REAL, roe_dt REAL, roic REAL,
                int_exp REAL, daa REAL, ebitda REAL, ebit REAL,
                debt_to_assets REAL, current_ratio REAL, quick_ratio REAL,
                assets_turn REAL, ar_turn REAL,
                accounts_receiv REAL, inventories REAL, rd_exp REAL,
                n_cashflow_act REAL,
                pe_ttm REAL, pb REAL, ps_ttm REAL, total_mv REAL, dv_ratio REAL,
                update_time TEXT,
                PRIMARY KEY (ts_code, end_date)
            )'''
        })


# 打印锁，防止多线程打印日志时文字乱序
print_lock = threading.Lock()

class HistoryFetcher:
    def __init__(self):
        print("🚛 [历史数据搬运工 v3.5 - 多线程版] 初始化...")
        # 旧代码：self.db = DBManager() → SQLAlchemy 连接池
        # 新代码：CloudAPIClient → HTTP API 调用 Worker
        self.api = CloudAPIClient(D1_API_URL)
        self.db = DBManager()  # 保留，用于建表
        self.token = MY_TOKEN

    def get_pro_client(self):
        """为每个线程创建一个独立的 Tushare 客户端"""
        pro = ts.pro_api(self.token)
       # pro._DataApi__http_url = 'https://tushare.top/dataapi/'
        try:
            pro._DataApi__timeout = 30 # 设置超时，防止卡死
        except: pass
        return pro

    def get_all_stocks(self):
        """获取全市场股票列表 (单线程执行)"""
        pro = self.get_pro_client()
        print("📋 正在获取全市场股票名单...")
        try:
            df = pro.stock_basic(exchange='', list_status='L', fields='ts_code,name')
            df = df[~df['ts_code'].str.contains('BJ')]
            print(f"✅ 获取成功，共 {len(df)} 只股票待处理。")
            return df
        except Exception as e:
            print(f"❌ 获取股票列表失败: {e}")
            return pd.DataFrame()
    def get_valuation_with_fallback(self, pro, ts_code, ann_date):
        """
        补丁逻辑：如果公告日当天拿不到数据（周末/停牌），往前追溯5天寻找最近交易日
        """
        # A. 尝试直接请求锚点日期
        df = pro.daily_basic(ts_code=ts_code, trade_date=ann_date, 
                            fields='pe_ttm,pb,ps_ttm,total_mv,dv_ratio')
        
        # B. 如果为空，则开启滑动窗口追溯最近交易日
        if df.empty:
            # 计算5天前的日期字符串
            start_search = (datetime.datetime.strptime(ann_date, '%Y%m%d') - datetime.timedelta(days=5)).strftime('%Y%m%d')
            df_range = pro.daily_basic(ts_code=ts_code, start_date=start_search, end_date=ann_date,
                                      fields='trade_date,pe_ttm,pb,ps_ttm,total_mv,dv_ratio')
            if not df_range.empty:
                # 排序取离锚点日期最近的一天
                df = df_range.sort_values('trade_date', ascending=False).head(1)
        return df

    def fetch_merged_data(self, pro, ts_code, start_date, end_date):
        """
        核心函数：抓取 5 个接口的数据并进行内存原子聚合
        修改逻辑：彻底废弃 pd.merge，改用 Buffer 聚合，解决空值覆盖问题
        """
        buffer = {}
        
        # 聚合工具：严格执行“非空才覆盖”逻辑
        def aggregate_data(df, label="Unknown"):
            if df is None or df.empty: return
            if 'ann_date' in df.columns:
                df = df.sort_values('ann_date', ascending=True)
            for _, row in df.iterrows():
                dt = str(row['end_date'])
                if dt not in buffer: buffer[dt] = {}
                for col, val in row.items():
                    # 只有当字段非空且非无效字符串时才记录
                    if pd.notna(val) and val != '' and str(val).lower() != 'nan':
                        # 🔥 核心修改：如果 buffer 里已经有这个字段了，且当前 col 不是 ann_date，
                        # 则不再覆盖。这样保证了 fina 表的专属指标（如 daa）绝对安全。
                        if col not in buffer[dt] or col == 'ann_date':
                            buffer[dt][col] = val

        # 1. 财务指标 (fina_indicator) - [100% 还原 v3.5 原映射字典]
        
        # 【新增】定义要请求的原生字段长字符串
        fina_f = 'ts_code,end_date,ann_date,tr_yoy,q_sales_yoy,netprofit_yoy,q_netprofit_yoy,dt_netprofit_yoy,q_dtprofit,grossprofit_margin,netprofit_margin,roe,roe_dt,roic,eps,bps,debt_to_assets,current_ratio,quick_ratio,assets_turn,ar_turn,profit_dedt,daa,ebitda,rd_exp,ebit'
        # 【修改】调用接口时显式传入 fields 参数
        df_fina = pro.fina_indicator(ts_code=ts_code, start_date=start_date, end_date=end_date, fields=fina_f)
        if df_fina is None or df_fina.empty: return None


        aggregate_data(df_fina, "Fina")

        # 2. 利润表 (income) - [新增 int_exp 补全字段]
        # 注意：此处包含了您 v3.5 获取的字段，并显式指定 report_type='1'
        # 【修改】利润表接口聚合调用
        df_income = pro.income(ts_code=ts_code, report_type='1', start_date=start_date, end_date=end_date, 
                               fields='ts_code,end_date,revenue,n_income_attr_p,int_exp')
        aggregate_data(df_income, "Income")

        # 3. 资产负债表 (balancesheet)
        # 【修改】资产负债表字段和聚合调用
        df_bal = pro.balancesheet(ts_code=ts_code, start_date=start_date, end_date=end_date, 
                               fields='ts_code,end_date,accounts_receiv,inventories')
        aggregate_data(df_bal, "Balance") # 删除原来的 {'inventories': 'inventory'}

        # 4. 现金流量表 (cashflow)
        # 【修改】现金流量表字段和聚合调用
        df_cash = pro.cashflow(ts_code=ts_code, report_type='1', start_date=start_date, end_date=end_date, 
                               fields='ts_code,end_date,n_cashflow_act')
        aggregate_data(df_cash, "Cashflow") # 删除原来的映射参数

        # 5. 每日估值 (daily_basic) - [性能优化，原逻辑迁移]
        df_daily_all = pro.daily_basic(ts_code=ts_code, start_date=start_date, end_date=end_date,
                                      fields='trade_date,pe_ttm,pb,ps_ttm,total_mv,dv_ratio')

        # --- 原子性拼装阶段 ---
        final_records = []
        for date, data in buffer.items():
            # 营收兜底：金融股适配逻辑
            if data.get('revenue') is None and data.get('total_revenue') is not None:
                data['revenue'] = data['total_revenue']
            
            # 1. 确定锚点日期用于匹配估值 (原有的上下文)
            target_date = data.get('ann_date', date)

            # ======================== 【此处新增插入】 ========================
            # 2. 普适性利息支出倒推回补逻辑 (EBITDA - EBIT - DAA)
            # 只有当原生 int_exp 为空或为 0 时，才尝试计算
            if data.get('int_exp') is None or data.get('int_exp') == 0:
                ebitda = data.get('ebitda')
                ebit = data.get('ebit')
                daa = data.get('daa')
                if all(v is not None for v in [ebitda, ebit, daa]):
                    calc_interest = ebitda - ebit - daa
                    if calc_interest > 1000: # 过滤极小尾差误差
                        data['int_exp'] = calc_interest
            # ================================================================
            # 内存估值匹配逻辑 (100% 保持 v3.5 计算方式)
            target_date = data.get('ann_date', date)
            if df_daily_all is not None and not df_daily_all.empty:
                match = df_daily_all[df_daily_all['trade_date'] <= target_date].sort_values('trade_date', ascending=False).head(1)
                if not match.empty:
                    data['pe_ttm'] = match.iloc[0]['pe_ttm']
                    data['pb'] = match.iloc[0]['pb']
                    data['ps_ttm'] = match.iloc[0]['ps_ttm']
                    data['total_mv'] = match.iloc[0]['total_mv']
                    data['dv_ratio'] = match.iloc[0]['dv_ratio']

            data['end_date'] = date
            data['update_time'] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            final_records.append(data)

        return final_records

    def process_single_stock(self, row, today_str):
        """
        线程工作函数：负责单只股票的增量检查、下载、入库
        """
        ts_code = row['ts_code']
        name = row['name']
        
        # 1. 创建独立的资源 (连接/客户端)
        pro = self.get_pro_client()
        # 旧代码：session = self.db.Session() → 每个线程单独创建 SQLAlchemy Session
        # 新代码：HTTP 请求天然线程安全，不需要 Session

        
        try:
            # 2. 增量检查 (移入线程内部，避免多线程共用 Session 冲突)
            # 旧代码：session.query(func.max(...)).filter(...).scalar() → 返回单个值
            # 新代码：POST /api/db/query → 返回 list[dict]
            try:
                resp = self.api._post('/api/db/query', {
                   "sql": "SELECT MAX(end_date) as max_date FROM stock_fundamentals WHERE ts_code = ?",
                   "params": [ts_code]
                })
                rows = resp.get('results', [])
                latest_date = rows[0]['max_date'] if rows and rows[0].get('max_date') else None
            except:
                latest_date = None

            
            # 3. 设定时间窗口 (近五年)
            DEFAULT_START_DATE = '20200101' # ✅ 已调整为近五年
            
            if latest_date:
                # 增量模式: 从库里最新日期的后一天开始
                start_date = (datetime.datetime.strptime(latest_date, '%Y%m%d') + datetime.timedelta(days=1)).strftime('%Y%m%d')
                mode = "增量"
            else:
                # 首次模式
                start_date = DEFAULT_START_DATE
                mode = "首次"
            
            # 如果不需要更新，直接返回
            if start_date > today_str:
                return

            # 4. 下载数据
            # 如果这里报错(网络/API)，直接跳到 except 回滚
            records = self.fetch_merged_data(pro, ts_code, start_date, today_str)
            
            if not records:
                with print_lock:
                    print(f"⚪ {ts_code} {name} 无新数据")
                return

            # 5. 入库
            # 旧代码：session.merge(obj) 逐条 upsert + session.commit() 事务提交
            # 新代码：POST /api/db/save 批量写入
            # ⚠️ 偏差备注：
            #   旧代码 session.merge 是 upsert（存在则更新，不存在则插入）
            #   新代码 /api/db/save 用 INSERT OR IGNORE（存在则跳过，不更新）
            #   增量模式下不会出现重复主键，两者等价
            #   D1 batch() 是事务性的，原子性和旧代码一致

            data = []
            for item in records:
                def safe_val(k):
                    v = item.get(k)
                    if pd.isna(v) or v == '': return None
                    return float(v)

                data.append({
                    'ts_code': item['ts_code'],
                    'end_date': item['end_date'],
                    'ann_date': item.get('ann_date'),
                    'revenue': safe_val('revenue'),
                    'tr_yoy': safe_val('tr_yoy'),
                    'q_sales_yoy': safe_val('q_sales_yoy'),
                    'n_income_attr_p': safe_val('n_income_attr_p'),
                    'netprofit_yoy': safe_val('netprofit_yoy'),
                    'q_netprofit_yoy': safe_val('q_netprofit_yoy'),
                    'dt_netprofit_yoy': safe_val('dt_netprofit_yoy'),
                    'q_dtprofit': safe_val('q_dtprofit'),
                    'eps': safe_val('eps'),
                    'bps': safe_val('bps'),
                    'grossprofit_margin': safe_val('grossprofit_margin'),
                    'netprofit_margin': safe_val('netprofit_margin'),
                    'roe': safe_val('roe'),
                    'roe_dt': safe_val('roe_dt'),
                    'roic': safe_val('roic'),
                    'debt_to_assets': safe_val('debt_to_assets'),
                    'current_ratio': safe_val('current_ratio'),
                    'quick_ratio': safe_val('quick_ratio'),
                    'assets_turn': safe_val('assets_turn'),
                    'ar_turn': safe_val('ar_turn'),
                    'accounts_receiv': safe_val('accounts_receiv'),
                    'inventories': safe_val('inventories'),
                    'int_exp': safe_val('int_exp'),
                    'profit_dedt': safe_val('profit_dedt'),
                    'daa': safe_val('daa'),
                    'ebitda': safe_val('ebitda'),
                    'rd_exp': safe_val('rd_exp'),
                    'n_cashflow_act': safe_val('n_cashflow_act'),
                    'pe_ttm': safe_val('pe_ttm'),
                    'pb': safe_val('pb'),
                    'ps_ttm': safe_val('ps_ttm'),
                    'total_mv': safe_val('total_mv'),
                    'dv_ratio': safe_val('dv_ratio'),
                    'ebit': safe_val('ebit'),
                    'update_time': item['update_time']
                })

            self.api._post('/api/db/save', {"table": "stock_fundamentals", "data": data})

            with print_lock:
                print(f"✅ {ts_code} {name} | {mode} | +{len(records)}条")
                
        except Exception as e:
            with print_lock:
                print(f"❌ {ts_code} {name} 失败: {e}")
            # 旧代码：finally session.close()
            # 新代码：不需要关闭连接
            # 旧代码：session.rollback() 回滚事务
            # 新代码：D1 batch() 也是事务性的，全成功或全失败，原子性和旧代码一致


    def run(self):
        # 1. 获取股票列表
        df_stocks = self.get_all_stocks()
        if df_stocks.empty: return
        
        total = len(df_stocks)
        TODAY = datetime.datetime.now().strftime('%Y%m%d')
        
        print(f"🚀 启动 v3.5 多线程更新 (并发数: 5, 起点: 20200101)...")
        
        # 使用线程池
        # max_workers=5 是 SQLite 的安全阈值
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = []
            for index, row in df_stocks.iterrows():
                # 将任务提交给线程池
                future = executor.submit(self.process_single_stock, row, TODAY)
                futures.append(future)
            
            # 等待所有任务完成
            for future in as_completed(futures):
                pass 

        print("🎉 全市场基本面历史数据 v3.5 更新完成！")

if __name__ == "__main__":
    fetcher = HistoryFetcher()
    fetcher.run()
