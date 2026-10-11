# ==============================================================================
# 📂 File: knowledge_miner_final.py
# 📦 Version: 5.1 (Scraper Edition + Infra Integration + 90-Day Limit)
# 📝 Description: 东方财富/新浪爬虫，调用 Infra 获取动态股票池，仅抓取90天
# ==============================================================================

import os
import logging
import requests
import pdfplumber
import io
import datetime
import time
import random
import re
import hashlib
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from tqdm import tqdm
from langchain_huggingface import HuggingFaceEmbeddings

# 🔥 核心修改 1: 引入 Infra 模块 (实现单一数据源)
try:
    from ai_analyst_infra_final import DBLoader
except ImportError:
    print("❌ 错误: 无法导入 ai_analyst_infra。请确保它在同一目录下。")
    exit(1)

# 🔇 屏蔽 pdfminer 的解析警告
logging.getLogger("pdfminer").setLevel(logging.ERROR)
# 🚀 强制使用 HuggingFace 国内镜像
os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'

# ================= 配置区 =================
D1_API_URL = 'https://stock-api.righttu.uk'
CF_ACCESS_CLIENT_ID = os.getenv("CF_ACCESS_CLIENT_ID")
CF_ACCESS_CLIENT_SECRET = os.getenv("CF_ACCESS_CLIENT_SECRET")

# 🔥 核心修改 2: 限制为 90 天 (省空间、更精准)
LOOKBACK_DAYS = 90
CHUNK_SIZE = 500
CHUNK_OVERLAP = 50

# 🚀 允许打印详细错误
# logging.getLogger("chromadb").setLevel(logging.ERROR) 

def find_local_embedding_model():
    base_dir = os.path.join(os.getcwd(), "models")
    if not os.path.exists(base_dir): return "BAAI/bge-small-zh-v1.5"
    for root, dirs, files in os.walk(base_dir):
        if "config.json" in files: return root
    return "BAAI/bge-small-zh-v1.5"

EMBEDDING_MODEL_PATH = find_local_embedding_model()

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
]

# ================= 核心类定义 =================
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

class DBManager:
    """
    管理 D1 数据库 (via stock-api Worker)
    ⚠️ 偏差备注：旧代码用 sqlite3 本地直连，新代码通过 HTTP API 调用 Worker
    所有 SQL 逻辑不变，只是执行方式从本地变为远程
    """
    def __init__(self, api_url=None):
        # 旧代码：self.conn = sqlite3.connect(db_path)
        self.api = CloudAPIClient(api_url or D1_API_URL)
        self.create_tables()
        self.check_and_upgrade_tables()

    def create_tables(self):
        # 旧代码：cursor.execute(CREATE TABLE ...) + self.conn.commit()
        # 新代码：POST /api/db/execute，SQL 语句完全一致
        self.api._post('/api/db/execute', {
            "sql": '''CREATE TABLE IF NOT EXISTS sync_status (
                ts_code TEXT PRIMARY KEY,
                last_report_sync TEXT,
                last_news_sync TEXT
            )'''
        })
        self.api._post('/api/db/execute', {
            "sql": '''CREATE TABLE IF NOT EXISTS institutional_surveys (
                ts_code TEXT,
                survey_date TEXT,
                org_count INTEGER,
                org_names TEXT,
                reception_place TEXT,
                PRIMARY KEY (ts_code, survey_date, org_names)
            )'''
        })

    def check_and_upgrade_tables(self):
        # 旧代码：cursor.execute("PRAGMA table_info(sync_status)") + cursor.fetchall()
        # 新代码：POST /api/db/query，返回格式从 tuple 变为 dict
        results = self.api._post('/api/db/query', {
            "sql": "PRAGMA table_info(sync_status)"
        })
        # 旧代码：columns = [info[1] for info in cursor.fetchall()]
        # 新代码：D1 返回 dict 格式，用 key 'name' 取列名
        columns = [row['name'] for row in results.get('results', [])]
        if 'last_news_sync' not in columns:
            self.api._post('/api/db/execute', {
                "sql": "ALTER TABLE sync_status ADD COLUMN last_news_sync TEXT"
            })

    def get_sync_status(self, ts_code):
        # 旧代码：cursor.execute(SELECT ..., (ts_code,)) + cursor.fetchone()
        # 新代码：POST /api/db/query，参数通过 params 传递（参数化绑定）
        results = self.api._post('/api/db/query', {
            "sql": "SELECT last_report_sync, last_news_sync FROM sync_status WHERE ts_code = ?",
            "params": [ts_code]
        })
        rows = results.get('results', [])
        # 旧代码：res = cursor.fetchone() → 返回 tuple (report, news)
        # 新代码：D1 返回 list[dict]，取第一行的字段值
        if rows:
            return {
                'report': rows[0].get('last_report_sync') or None,
                'news': rows[0].get('last_news_sync') or None
            }
        return {'report': None, 'news': None}

    def update_sync_status(self, ts_code, type_key, date_str):
        # 旧代码：cursor.execute(INSERT ... ON CONFLICT DO UPDATE, (ts_code, date_str)) + commit()
        # 新代码：POST /api/db/execute，SQL 和参数完全一致
        col_map = {'report': 'last_report_sync', 'news': 'last_news_sync'}
        col = col_map.get(type_key)
        if not col: return
        self.api._post('/api/db/execute', {
            "sql": f'''INSERT INTO sync_status (ts_code, {col}) VALUES (?, ?)
                      ON CONFLICT(ts_code) DO UPDATE SET {col}=excluded.{col}''',
            "params": [ts_code, date_str]
        })

    def save_surveys(self, surveys):
        # 旧代码：cursor.executemany(INSERT OR IGNORE INTO ..., surveys) + commit()
        # surveys 是 list[tuple]，格式：(ts_code, survey_date, org_count, org_names, reception_place)
        # 新代码：POST /api/db/save，将 tuple 转为 dict 列表
        if not surveys: return
        data = []
        for s in surveys:
            data.append({
                'ts_code': str(s[0]) if s[0] is not None else '',
                'survey_date': str(s[1]) if s[1] is not None else '',
                'org_count': int(s[2]) if s[2] is not None else 0,
                'org_names': str(s[3]) if s[3] is not None else '',
                'reception_place': str(s[4]) if s[4] is not None else '未披露'
            })
        self.api._post('/api/db/save', {"table": "institutional_surveys", "data": data})

class VectorDBManager:
    """
    管理 Vectorize (via stock-api Worker)
    ⚠️ 偏差备注：
    1. 旧代码用 ChromaDB HttpClient 直连，新代码通过 HTTP API 调用 Worker
    2. 旧代码 collection.upsert(documents=...) 会存原文，新代码把切片原文存入 metadata（chunk_text 字段）
    3. 旧代码 check_exists 用 collection.get(where=...) 精确元数据查询，
       新代码用 getByIds() 按确定性 ID 查询，功能等价
    """
    def __init__(self):
        # 旧代码：self.client = chromadb.HttpClient(...) + self.collection = client.get_or_create_collection(...)
        # 新代码：通过 CloudAPIClient 调用 Worker API，不需要直连 Vectorize
        self.api = CloudAPIClient(D1_API_URL)
        print(f"🧠 加载 Embedding 模型 (CPU): {EMBEDDING_MODEL_PATH}")
        self.embedding_fn = HuggingFaceEmbeddings(
            model_name=EMBEDDING_MODEL_PATH,
            model_kwargs={'device': 'cpu'},
            encode_kwargs={'normalize_embeddings': True}
        )

    def check_exists(self, title, publish_date, ts_code):
        """
        检查文档是否已存在
        旧代码：collection.get(where={title, publish_date}, limit=1) → 精确元数据查询
        新代码：构造第一片切片的确定性 ID，用 getByIds 查询
        ⚠️ 偏差备注：查询方式不同，但功能等价——只要第一片存在，就说明整篇文档已入库
        """
        try:
            # 构造第一片切片的 ID，和 chunk_text 里的 ID 生成逻辑完全一致
            raw_id_str = f"{title}_{publish_date}"
            title_hash = hashlib.md5(raw_id_str.encode()).hexdigest()[:8]
            first_chunk_id = f"{ts_code}_{publish_date}_{title_hash}_0"
            
            data = self.api._post('/api/vector/check', {
                "id": first_chunk_id
            })
            return data.get('exists', False)
        except:
            return False

    def add_documents(self, documents, metadatas, ids):
        """
        旧代码：collection.upsert(documents=documents, embeddings=embeddings, metadatas=metadatas, ids=ids)
        新代码：POST /api/vector/upsert，发送 ids + embeddings + metadatas
        ⚠️ 偏差备注：旧代码 documents 参数存原文到 ChromaDB，新代码切片原文已在 metadata.chunk_text 中，
        不需要单独传 documents 参数
        """
        if not documents: return
        embeddings = self.embedding_fn.embed_documents(documents)

        # metadatas 值清洗：Vectorize 要求 metadata 值不能为 null，只支持 string
        # 旧代码 ChromaDB 允许 null，这里将 null → ''，空字符串
        # ⚠️ 偏差备注：null 变空字符串，读取时 if meta['org'] 行为一致（都是 False），不影响逻辑
        clean_metadatas = []
        for meta in metadatas:
            clean = {}
            for k, v in meta.items():
                if v is None:
                    clean[k] = ''
                else:
                    clean[k] = str(v)
            clean_metadatas.append(clean)

        # 分批写入，每批最多 100 条
        # 旧代码：collection.upsert 一次写入所有，ChromaDB 无此限制
        # 新代码：Vectorize Workers API 单次 upsert 上限 1000 条，Python 端分 100 条一批更稳妥
        BATCH_SIZE = 100
        for i in range(0, len(ids), BATCH_SIZE):
            batch = {
                "ids": ids[i:i+BATCH_SIZE],
                "embeddings": embeddings[i:i+BATCH_SIZE],
                "metadatas": clean_metadatas[i:i+BATCH_SIZE]
            }
            try:
                self.api._post('/api/vector/upsert', batch)
            except Exception as e:
                print(f"❌ [Vectorize Error] 写入失败 (batch {i}): {e}")
                raise RuntimeError(f"Vectorize 写入失败 (batch {i})") from e

class Crawler:
    """数据抓取 (保持不变，功能非常强大)"""
    def __init__(self):
        self.session = requests.Session()
        retries = Retry(total=3, backoff_factor=1, status_forcelist=[500, 502, 503, 504])
        adapter = HTTPAdapter(max_retries=retries)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
    
    def _get_headers(self):
        return {
            "User-Agent": random.choice(USER_AGENTS),
            "Connection": "keep-alive"
        }

    def fetch_report_list(self, ts_code, start_date):
        code = ts_code.split('.')[0]
        url = "http://reportapi.eastmoney.com/report/list"
        reports = []
        page = 1
        while True:
            params = {
                "cb": "datatable", "code": code, "pageSize": 50,
                "beginTime": start_date, "endTime": datetime.datetime.now().strftime('%Y-%m-%d'),
                "pageNo": page, "qType": 0
            }
            try:
                resp = self.session.get(url, params=params, headers=self._get_headers(), timeout=10)
                text = resp.text
                import json
                json_str = text[text.find('(')+1 : text.rfind(')')]
                data = json.loads(json_str)
                if not data.get('data'): break
                for item in data['data']:
                    reports.append({
                        'title': item['title'], 'date': item['publishDate'][:10],
                        'info_code': item['infoCode'], 'org': item['orgSName']
                    })
                if page >= 3: break 
                page += 1
                time.sleep(0.5)
            except: break
        return reports

    def fetch_pdf_text(self, info_code, date_str):
        pdf_url = f"https://pdf.dfcfw.com/pdf/H3_{info_code}_1.pdf"
        try:
            resp = self.session.get(pdf_url, stream=True, headers=self._get_headers(), timeout=15)
            if resp.status_code != 200: return None
            with pdfplumber.open(io.BytesIO(resp.content)) as pdf:
                full_text = "\n".join([p.extract_text() or "" for p in pdf.pages])
            return full_text
        except Exception: return None

    def fetch_survey_data(self, ts_code, start_date):
        code = ts_code.split('.')[0]
        url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
        records = []
        page = 1
        while True:
            params = {
                "sortColumns": "NOTICE_DATE,RECEIVE_START_DATE", "sortTypes": "-1,-1",
                "pageSize": 50, "pageNumber": page, "reportName": "RPT_ORG_SURVEYNEW", 
                "columns": "ALL", "filter": f"(SECURITY_CODE=\"{code}\")"
            }
            try:
                resp = self.session.get(url, params=params, headers=self._get_headers(), timeout=10)
                data = resp.json()
                if not data.get('result') or not data['result'].get('data'): break
                
                has_new = False
                for item in data['result']['data']:
                    s_date = item['RECEIVE_START_DATE'][:10]
                    if s_date < start_date: continue
                    has_new = True
                    raw_names = item.get('ORG_NAME_LIST') or item.get('RECEIVE_OBJECT', '')
                    if raw_names is None: raw_names = ""
                    org_count = int(item.get('ORG_LINENUM', 0))
                    if org_count == 0 and raw_names:
                        org_count = len([n for n in raw_names.replace('，', ',').split(',') if n.strip()])
                    if org_count == 0 and not raw_names: continue
                    records.append((ts_code, s_date, org_count, raw_names, item.get('RECEIVE_PLACE', '未披露')))
                if not has_new or page >= 5: break
                page += 1
                time.sleep(1)
            except: break
        return records

    def fetch_notices(self, ts_code, start_date):
        code = ts_code.split('.')[0]
        url = "https://np-anotice-stock.eastmoney.com/api/security/ann"
        notices = []
        page = 1
        while True:
            params = {
                "sr": "-1", "page_size": 20, "page_index": page,
                "ann_type": "A", "client_source": "web", "stock_list": code,
                "f_node": "0", "s_node": "0"
            }
            try:
                resp = self.session.get(url, params=params, headers=self._get_headers(), timeout=10)
                data = resp.json()
                if not data.get('data') or not data['data'].get('list'): break
                
                has_new = False
                for item in data['data']['list']:
                    n_date = (item.get('notice_date') or item.get('ann_date'))[:10]
                    if n_date < start_date: continue
                    has_new = True
                    
                    title = item.get('title') or item.get('ann_title')
                    if not title: continue 
                    if any(x in title for x in ['辞职', '会议通知', '提示性公告']): continue
                    
                    notices.append({
                        'title': title, 'date': n_date,
                        'content': title,
                        'type': '公告'
                    })
                if not has_new or page >= 3: break
                page += 1
                time.sleep(1)
            except: break
        return notices

    def fetch_news(self, ts_code, start_date):
        code_num = ts_code.split('.')[0]
        url = "https://feed.mix.sina.com.cn/api/roll/get_page"
        news_list = []
        page = 1
        while True:
            params = {
                "pageid": "153", "lid": "2509", 
                "k": code_num, "num": 20, "page": page
            }
            try:
                resp = self.session.get(url, params=params, headers=self._get_headers(), timeout=10)
                data = resp.json()
                if not data.get('result') or not data['result'].get('data'): break
                
                has_new = False
                for item in data['result']['data']:
                    try:
                        timestamp = int(item['ctime'])
                        n_date = datetime.datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d')
                    except:
                        n_date = datetime.datetime.now().strftime('%Y-%m-%d')
                    if n_date < start_date: continue
                    has_new = True
                    title = item.get('title')
                    content = f"{title}。{item.get('intro', '')}" 
                    news_list.append({
                        'title': title, 'date': n_date,
                        'content': content, 'type': '新闻'
                    })
                if not has_new or page >= 3: break
                page += 1
                time.sleep(1)
            except: break
        return news_list

class KnowledgeMiner:
    def __init__(self):
        print("🚀 [Knowledge Miner v6.0] 启动 (Status-->D1 +Scraperer--> Vectorize 云端版+ DBLoader<--Infra)...")
        # 旧代码：DBManager(SQLITE_DB_PATH) → 本地 SQLite
        # 新代码：DBManager(D1_API_URL) → 远程 D1 via Worker API
        self.db_mgr = DBManager(D1_API_URL)
        # ⚠️ 偏差备注：DBLoader 仍用本地 SQLite（Infra 模块未迁移），后续再改
        self.infra_loader = DBLoader(D1_API_URL)
        self.vec_mgr = VectorDBManager()
        self.crawler = Crawler()

    def chunk_text(self, text, metadata_base):
        chunks = []
        metadatas = []
        ids = []
        text = re.sub(r'\s+', ' ', text).strip()
        step = CHUNK_SIZE - CHUNK_OVERLAP
        for i in range(0, len(text), step):
            chunk = text[i:i+CHUNK_SIZE]
            if len(chunk) > 20: 
                chunks.append(chunk)
                meta = metadata_base.copy()
                # ⚠️ 偏差备注：旧代码 ChromaDB 通过 documents 参数单独存原文
                # 新代码把切片原文存入 metadata.chunk_text，查询时 returnMetadata:"all" 即可取出
                # CHUNK_SIZE=500，500中文字≈1.5KB，远小于 metadata 10KB 限制
                meta['chunk_text'] = chunk
                metadatas.append(meta)
                raw_id_str = f"{metadata_base['title']}_{metadata_base['publish_date']}"
                title_hash = hashlib.md5(raw_id_str.encode()).hexdigest()[:8]
                ids.append(f"{metadata_base['ts_code']}_{metadata_base['publish_date']}_{title_hash}_{i}")
        return chunks, metadatas, ids

    def execute_mining_task(self, ts_code, name, rpt_start, news_start):
        """
        [核心引擎] 物理级对齐原 run() 内部的抓取逻辑
        """
        # 1. 调研 (原代码 247-248 行)
        surveys = self.crawler.fetch_survey_data(ts_code, rpt_start)
        if surveys: self.db_mgr.save_surveys(surveys)
        
        new_docs, new_metas, new_ids = [], [], []
        latest_rpt_date, latest_news_date = rpt_start, news_start

        # 2. 研报 (原代码 254-275 行)
        reports = self.crawler.fetch_report_list(ts_code, rpt_start)
        if reports:
            for rpt in reports:
                if rpt['date'] <= rpt_start: continue
                # ⚠️ 偏差备注：新增 ts_code 参数，用于构造确定性 ID 做 getByIds 查询
                if self.vec_mgr.check_exists(rpt['title'], rpt['date'], ts_code): continue
                text = self.crawler.fetch_pdf_text(rpt['info_code'], rpt['date'])
                if text and len(text) > 100:
                    meta = {
                        "ts_code": ts_code, "stock_name": name,
                        "publish_date": rpt['date'], "source_type": "研报",
                        "title": rpt['title'], "org": rpt['org']
                    }
                    c_docs, c_metas, c_ids = self.chunk_text(text, meta)
                    new_docs.extend(c_docs); new_metas.extend(c_metas); new_ids.extend(c_ids)
                    if rpt['date'] > latest_rpt_date: latest_rpt_date = rpt['date']

        # 3. 新闻 & 公告 (原代码 277-295 行)
        combined_news = self.crawler.fetch_notices(ts_code, news_start) + self.crawler.fetch_news(ts_code, news_start)
        if combined_news:
            for item in combined_news:
                if item['date'] <= news_start: continue
                if self.vec_mgr.check_exists(item['title'], item['date'], ts_code): continue
                meta = {
                    "ts_code": ts_code, "stock_name": name, "publish_date": item['date'], 
                    "source_type": item['type'], "title": item['title'], "org": "官方/媒体"
                }
                c_docs, c_metas, c_ids = self.chunk_text(item['content'], meta)
                new_docs.extend(c_docs); new_metas.extend(c_metas); new_ids.extend(c_ids)
                if item['date'] > latest_news_date: latest_news_date = item['date']

        # 4. 统一入库 (原代码 305-316 行)
        if new_docs:
            dedup_map = {i: (d, m) for d, m, i in zip(new_docs, new_metas, new_ids)}
            self.vec_mgr.add_documents([v[0] for v in dedup_map.values()], 
                                     [v[1] for v in dedup_map.values()], 
                                     list(dedup_map.keys()))
            
        # 5. 更新同步状态 (原代码 318-319 行)
        self.db_mgr.update_sync_status(ts_code, 'report', latest_rpt_date)
        self.db_mgr.update_sync_status(ts_code, 'news', latest_news_date)
        return len(new_docs)

    def mine_single_stock(self, ts_code, name):
        """[手工模式入口] 调用核心引擎"""
        limit_date = (datetime.datetime.now() - datetime.timedelta(days=LOOKBACK_DAYS)).strftime('%Y-%m-%d')
        return self.execute_mining_task(ts_code, name, limit_date, limit_date)
    #以上为核心逻辑爬虫函数逻辑execute_mining_task
    def run(self):
        # 🔥 核心修改 4: 通过 Infra 获取动态股票池 (3天内有信号的)
        print("📞 正在呼叫 Infra 获取待挖掘名单...")
        targets = self.infra_loader.get_pending_stocks()
        
        if not targets:
            print("💤 Infra 返回空名单，今日无目标股票，休息。")
            return
        
        print(f"📋 今日待处理任务: {len(targets)} 只标的 (来自所有 Hunter 策略)")
        
        for stock in tqdm(targets, desc="挖掘进度"):
            ts_code = stock['ts_code']
            name = stock['name']
            
            # 获取同步状态
            sync_status = self.db_mgr.get_sync_status(ts_code)
            
            # 计算起始日期：取 (上次同步时间) 和 (90天前) 的较晚者
            limit_date = (datetime.datetime.now() - datetime.timedelta(days=LOOKBACK_DAYS)).strftime('%Y-%m-%d')
            
            rpt_start = sync_status['report'] or limit_date
            if rpt_start < limit_date: rpt_start = limit_date
                
            news_start = sync_status['news'] or limit_date
            if news_start < limit_date: news_start = limit_date
            # 直接驱动核心引擎，实现逻辑归一化
            added_count = self.execute_mining_task(ts_code, name, rpt_start, news_start)
            if added_count > 0:
                tqdm.write(f"   ✅ [{name}] 处理完成，新增 {added_count} 个切片") 

            

if __name__ == "__main__":
    miner = KnowledgeMiner()
    miner.run()
