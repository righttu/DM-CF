# ==============================================================================
# 📂 File: ai_analyst_infra.py
# 📦 Version: 5.4 (Added Chip Data)
# 📅 Last Updated: 2025-12-28
#  def get_pending_stocks(self, lookback_days=43), modify lookback_days to change start date
# 📝 Description: 
#    1. [Source 1] _hunter: 交易 + 估值 + 预测 + 筹码(新增)
#    2. [Source 2] fundamentals: 财务三张表数据
#    3. [Source 3] surveys: 机构调研数据
# ==============================================================================

import pandas as pd
import datetime
import requests
from langchain_huggingface import HuggingFaceEmbeddings

# ================= 配置区 =================
D1_API_URL = 'https://stock-api.righttu.uk'
CF_ACCESS_CLIENT_ID = os.getenv('CF_ACCESS_CLIENT_ID')
CF_ACCESS_CLIENT_SECRET = os.getenv('CF_ACCESS_CLIENT_SECRET')
EMBEDDING_MODEL_PATH = "/home/righttu/ai-finance/CloudFlare/models/bge-small-zh-v1.5/BAAI/bge-small-zh-v1___5"

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

    def _get(self, path):
        resp = requests.get(f'{self.base_url}{path}', headers=self.headers, timeout=30)
        data = resp.json()
        if not data.get('success'):
            raise Exception(data.get('error', f'API call failed: {path}'))
        return data

class DBLoader:
    def __init__(self, api_url=None):
        # 旧代码：self.conn = sqlite3.connect(db_path)
        # 新代码：通过 HTTP API 调用 Worker
        self.api = CloudAPIClient(api_url or D1_API_URL)

    
    def _get_hunter_tables(self):
        # 旧代码：cursor.execute(SELECT sqlite_master ...) + cursor.fetchall()
        # 新代码：POST /api/db/query，D1 返回 dict 格式，用 key 'name' 取值
        results = self.api._post('/api/db/query', {
            "sql": "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_hunter'"
        })
        return [row['name'] for row in results.get('results', [])]


    def _get_stocks_from_table(self, table_name, start_dt):
        """
        [Source 1: Hunter 表]
        严格对应你提供的字段列表：
        ts_code, name, industry, close, turnover_rate_3d, industry_turnover_rate_3d,
        pe_ttm, pe_ttm_percentile, industry_pe_ttm_median, peg, pb, pb_percentile,
        industry_pb_median, forecast_eps_fy1, net_inflow_5d, total_mv, ps_ttm,
        forecast_eps_fy2, con_growth_rate
        🔥 新增: chip_cumu_change, chip_latest_change
        """
        fields = [
            "ts_code", "name", "industry", "close", 
            "turnover_rate_3d", "industry_turnover_rate_3d",
            "pe_ttm", "pe_ttm_percentile", "industry_pe_ttm_median",
            "peg", "pb", "pb_percentile", "industry_pb_median",
            "ps_ttm", "total_mv", "net_inflow_5d",
            "chip_cumu_change", "chip_latest_change", # 🔥 [修改清单] 新增这两个筹码字段
            "forecast_eps_fy1", "forecast_eps_fy2", "con_growth_rate",
            "tags", "scan_date" # 辅助字段
        ]
        col_str = ", ".join(fields)

        # 🔥 [新增] 行业黑名单定义
        # 这些行业的PE中位数常年失真，或处于重资产微利状态，干扰 AI 估值
        blacklist = [
            '普钢', '特钢', '钢铁',                 # 钢铁
            '煤炭开采', '煤炭加工',                 # 煤炭
            '房地产开发', '住宅开发', '商业地产', '全国地产', '区域地产', '房产服务',    # 房地产
            '百货', '超市', '一般零售', '百货零售',  # 商贸零售 (导致PE 53倍的元凶)
            '水泥制造', '玻璃制造', '建材',         # 水泥建材
            '高速公路', '路桥'                      # 高速公路
        ]
        # 构造 SQL 的 IN 查询字符串: '普钢','特钢',...
        blacklist_str = "'" + "','".join(blacklist) + "'"

        try:
            
            # 旧代码：pd.read_sql_query(query, self.conn) → 直接返回 DataFrame
            # 新代码：POST /api/db/query → 返回 list[dict] → 转 DataFrame
            query = f"""
                SELECT {col_str}
                FROM {table_name}
                WHERE scan_date >= '{start_dt}'
                AND industry NOT IN ({blacklist_str}) 
                ORDER BY scan_date DESC
            """
            resp = self.api._post('/api/db/query', {"sql": query})
            df = pd.DataFrame(resp.get('results', []))

            # 回溯逻辑
            if df.empty:
                # 旧代码：cursor.execute(SELECT MAX...) + cursor.fetchone() → 返回 tuple
                # 新代码：POST /api/db/query → 返回 list[dict]
                resp = self.api._post('/api/db/query', {
                    "sql": f"SELECT MAX(scan_date) as max_date FROM {table_name}"
                })
                rows = resp.get('results', [])
                if rows and rows[0].get('max_date') and rows[0]['max_date'] >= start_dt:
                    query = f"""
                        SELECT {col_str} 
                        FROM {table_name} 
                        WHERE scan_date = '{rows[0]['max_date']}' 
                        AND industry NOT IN ({blacklist_str})
                    """
                    resp2 = self.api._post('/api/db/query', {"sql": query})
                    df = pd.DataFrame(resp2.get('results', []))

            if not df.empty:
                df['source_strategy'] = table_name
                return df.drop_duplicates(subset=['ts_code'])
            return pd.DataFrame()
        except Exception as e:
            print(f"❌ 读取表 {table_name} 出错: {e}")
            return pd.DataFrame()
     #change lookback_days to change start date

    def get_pending_stocks(self, lookback_days=2):
        start_dt = (datetime.datetime.now() - datetime.timedelta(days=lookback_days)).strftime('%Y%m%d')
        hunter_tables = self._get_hunter_tables()
        if not hunter_tables: return []

        all_dfs = []
        for tbl in hunter_tables:
            df = self._get_stocks_from_table(tbl, start_dt)
            if not df.empty: all_dfs.append(df)
        
        if not all_dfs: return []
        
        df_total = pd.concat(all_dfs, ignore_index=True)
        aggregated_data = []
        
        # 合并不同策略表来源
        for ts_code, group in df_total.groupby('ts_code'):
            record = group.iloc[0].to_dict()
            sources = sorted(group['source_strategy'].unique())
            record['source_strategy'] = " + ".join(sources)
            aggregated_data.append(record)
            
        return aggregated_data

    def get_fundamentals(self, ts_code):
        # 旧代码：pd.read_sql_query(query, self.conn) → 直接返回 DataFrame
        # 新代码：POST /api/db/query → 返回 list[dict] → 转 DataFrame
        query = f"SELECT * FROM stock_fundamentals WHERE ts_code = '{ts_code}' ORDER BY end_date DESC LIMIT 1"
        resp = self.api._post('/api/db/query', {"sql": query})
        df = pd.DataFrame(resp.get('results', []))
        return df.iloc[0].to_dict() if not df.empty else {}
    def get_survey_heat(self, ts_code, days=90):
        """[Source 3: Institutional Surveys 表]"""
        start_date = (datetime.datetime.now() - datetime.timedelta(days=days)).strftime('%Y-%m-%d')
        try:
            # 旧代码：pd.read_sql_query(query, self.conn) → 直接返回 DataFrame
            # 新代码：POST /api/db/query → 返回 list[dict] → 转 DataFrame
            query = f"""
                SELECT survey_date, org_count, org_names 
                FROM institutional_surveys 
                WHERE ts_code = '{ts_code}' AND survey_date >= '{start_date}'
            """
            resp = self.api._post('/api/db/query', {"sql": query})
            df = pd.DataFrame(resp.get('results', []))

            if df.empty: return {"active_days": 0, "total_orgs": 0, "famous_orgs": "无", "details": "暂无调研"}
            
            active_days = df['survey_date'].nunique()
            total_orgs = df['org_count'].sum()
            all_names = ",".join([str(x) for x in df['org_names'].tolist() if x])
            
            famous_keywords = ['社保','养老','汇金','证金','高瓴','红杉','淡马锡','摩根','高盛','贝莱德','易方达','中欧','汇添富','广发','富国','嘉实','景顺','睿远','景林','高毅','星石']
            found = list(set([kw for kw in famous_keywords if kw in all_names]))
            
            return {
                "active_days": int(active_days),
                "total_orgs": int(total_orgs),
                "famous_orgs": ",".join(found) if found else "无",
                "details": f"近90日调研{active_days}次"
            }
        except:
            return {"active_days": 0, "total_orgs": 0, "famous_orgs": "无", "details": "数据缺失"}

class RAGRetriever:
    """
    ⚠️ 偏差备注：
    1. 旧代码用 ChromaDB HttpClient 直连，新代码通过 HTTP API 调用 Worker
    2. 旧代码 collection.query() 返回 documents + metadatas 两个分离的列表
       新代码 Vectorize query 返回 matches，切片原文在 metadata.chunk_text 中
    3. 旧代码 where={"ts_code": ts_code}，新代码用 filter: {"ts_code": {"$eq": ts_code}}
    """
    def __init__(self):
        # 旧代码：chromadb.HttpClient + get_collection
        # 新代码：CloudAPIClient 调用 Worker API
        self.api = CloudAPIClient(D1_API_URL)
        print(f"🧠 [Infra] 加载 Embedding 模型 (CPU): {EMBEDDING_MODEL_PATH}")
        self.embedding_fn = HuggingFaceEmbeddings(
            model_name=EMBEDDING_MODEL_PATH,
            model_kwargs={'device': 'cpu'},
            encode_kwargs={'normalize_embeddings': True}
        )

    def retrieve_context(self, ts_code, stock_name, limit=18):
        # 关键词不变
        base_keywords = ["业绩", "风险", "增长", "下滑", "暴雷"]
        competition = ["市场份额", "竞争格局", "行业地位", "市占率", "排名"]
        chain = ["产业链", "客户", "供应商", "上下游", "大客户"]
        future = ["新业务", "扩产", "产能", "催化剂", "订单", "放量"]
        moat = ["护城河", "技术壁垒", "核心竞争力", "研发", "专利"]
        management = ["股权激励", "回购", "战略转型", "管理层", "增持"]

        combined_keywords = base_keywords + competition + chain + future + moat + management
        query_text = f"{stock_name} " + " ".join(combined_keywords)

        # 旧代码：
        #   results = self.collection.query(
        #       query_embeddings=self.embedding_fn.embed_documents([query_text]),
        #       n_results=limit,
        #       where={"ts_code": ts_code}
        #   )
        #   返回格式：{'documents': [[doc1, doc2, ...]], 'metadatas': [[meta1, meta2, ...]]}
        #
        # 新代码：
        #   POST /api/vector/query → Worker 调 Vectorize.query(vector, {topK, filter, returnMetadata})
        #   返回格式：{matches: [{id, score, metadata: {chunk_text, title, ...}}, ...]}
        #
        # ⚠️ 偏差备注：
        #   1. 旧代码 where={"ts_code": ts_code} → 新代码 filter: {"ts_code": {"$eq": ts_code}}
        #   2. 旧代码 documents 列表存原文 → 新代码原文在 metadata.chunk_text 中
        #   3. 旧代码 metadatas 是独立列表 → 新代码 metadata 是 matches 内的字段

        query_embedding = self.embedding_fn.embed_documents([query_text])[0]
        # ⚠️ 偏差备注：旧代码 ChromaDB where={"ts_code": ts_code} 先过滤再搜索
        # 新代码用 namespace 先过滤再搜索（Vectorize namespace 是先过滤再搜索的）
        # filter 里保留 ts_code，Worker 端会自动提取为 namespace
        resp = self.api._post('/api/vector/query', {
            "vector": query_embedding,
            "topK": limit,
            "filter": {"ts_code": {"$eq": ts_code}}
        })

        # 旧代码遍历：zip(results['documents'], results['metadatas'])
        # 新代码遍历：resp['results']['matches']
        matches = resp.get('results', {}).get('matches', [])

        docs = []
        MAX_CONTEXT = 4000
        current_len = 0
        seen = set()

        for match in matches:
            meta = match.get('metadata', {})
            # 旧代码：doc = documents 列表中的原文
            # 新代码：doc = metadata.chunk_text
            doc = meta.get('chunk_text', '')
            if doc not in seen and len(doc) > 30:
                header = f"【{meta.get('source_type', '研报')}|{meta.get('publish_date', '')}|{meta.get('title', '')}】"
                entry = f"{header}\n{doc}"
                if current_len + len(entry) < MAX_CONTEXT:
                    docs.append(entry)
                    current_len += len(entry)
                    seen.add(doc)

        return "\n\n".join(docs) if docs else "暂无详细研报数据，请基于行业常识分析。"


if __name__ == "__main__":
    db = DBLoader(D1_API_URL)
