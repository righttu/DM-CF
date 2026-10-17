"""
==================================================
项目: Hotspot Hunter 产业链自动化审计系统
版本: 2026.01.03-V20.0 (Tushare API 穿透版)
更新日志:
1. 确认逻辑：通过“理由”内容实时判定 Keynode 归属.
2. 约束增强：数据库主键锁定 (ts_code, sector, node)，支持一标多节点.
3. 颗粒化跳过：在 INSERT 前执行精准查重，显示 [node](EXIST).
4. 严格锁死 30 个环节指纹词及放量时间，未经同意不得修改.
5. [架构升级] 彻底废弃 Akshare，换装 Tushare 同花顺高速接口，彻底解决 IP 封锁阻断问题。
6. [风控逻辑] 实现 THS(同花顺成分) + EM(东方财富理由) 双重交叉验证。
==================================================
"""
import os
import requests
import akshare as ak
import datetime
import pandas as pd
import tushare as ts
from playwright.sync_api import sync_playwright
import time
import sys
from tqdm import tqdm

# --- 1. 配置 ---
TS_TOKEN = os.getenv("MY_TUSHARE_TOKEN") 
pro = ts.pro_api(TS_TOKEN)
#pro._DataApi__http_url = 'https://tushare.top/dataapi/' # 镜像站

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

MARKERS = ["核心", "量产", "采购"]

# 严格对齐 image_32e102.jpg 锁死指纹库
NODES_CONFIG = {
    "具身智能": {"board": "人形机器人", "nodes": {
        "1. 行星滚柱丝杠": {"kws": ["滚柱丝杠", "行星丝杠", "丝杠"], "time": "26Q2"},
        "2. 灵巧手": {"kws": ["灵巧手", "空心杯", "触觉传感"], "time": "26Q4"},
        "3. 无框力矩电机": {"kws": ["无框电机", "力矩电机"], "time": "26Q4"},
        "4. 六维力矩传感器": {"kws": ["六维力", "力矩传感"], "time": "26Q3"},
        "5. 具身AI OS/推理平台": {"kws": ["AI OS", "推理平台"], "time": "27Q1"},
        "6. 3D视觉/激光雷达": {"kws": ["3D视觉", "激光雷达"], "time": "26Q1"},
        "7. 端侧 AI 芯片 (NPU)": {"kws": ["NPU", "AI芯片"], "time": "26Q2"},
        "8. 仿真环境与数据标注": {"kws": ["仿真", "数据标注"], "time": "26Q2"}}},
    "商业航天": {"board": "商业航天", "nodes": {
        "9. 星间激光通信终端": {"kws": ["激光通信", "星间", "激光终端"], "time": "26Q3"},
        "10. 相控阵 T/R 芯片": {"kws": ["TR", "相控阵", "T/R"], "time": "26Q2"},
        "11. 可回收火箭发动机": {"kws": ["火箭发动机", "可回收"], "time": "26Q2"},
        "12. 地面终端基带芯片": {"kws": ["基带", "终端芯片"], "time": "26Q1"},
        "13. 星载处理与存储器": {"kws": ["星载处理", "星载存储"], "time": "26Q2"},
        "14. 卫星霍尔电推进系统": {"kws": ["霍尔电推", "卫星推进"], "time": "26Q3"}}},
    "低空经济": {"board": "低空经济", "nodes": {
        "15. 适航级飞控系统": {"kws": ["飞控系统", "适航飞控"], "time": "26Q4"},
        "16. 航空级碳纤维复合材料": {"kws": ["碳纤维"], "time": "26Q4"},
        "17. 低空空域管理系统": {"kws": ["空域管理", "空管系统"], "time": "26Q4"},
        "18. 机载避障雷达": {"kws": ["避障雷达", "毫米波雷达"], "time": "26Q4"},
        "19. 高性能驱动电机": {"kws": ["驱动电机", "高性能电机"], "time": "26Q1"},
        "20. 降落伞/安全应急系统": {"kws": ["降落伞", "应急系统"], "time": "26Q4"}}},
    "全固态电池": {"board": "固态电池", "nodes": {
        "21. 硫化物固态电解质": {"kws": ["硫化物", "固态电解质"], "time": "26Q4"},
        "22. 干法电极生产设备": {"kws": ["干法电极", "干法", "辊压机", "成膜设备"], "time": "26Q2"},
        "23. 硅碳负极材料": {"kws": ["硅碳负极"], "time": "26Q3"},
        "24. 专用压力结构/包材": {"kws": ["压力结构", "电池包材"], "time": "26Q4"},
        "25. 导电剂 (碳纳米管)": {"kws": ["碳纳米管", "导电剂"], "time": "26Q1"}}},
    "AI 液冷": {"board": "液冷概念", "nodes": {
        "26. 特种氟化液 (冷媒)": {"kws": ["氟化液", "冷媒", "冷却液"], "time": "26Q3"},
        "27. 芯片级液冷板模组": {"kws": ["液冷板", "冷板模组"], "time": "26Q1"},
        "28. 微网管理 (EMS)": {"kws": ["微网", "EMS"], "time": "27Q1"},
        "29. 冷却分发单元 (CDU)": {"kws": ["CDU", "冷却分发"], "time": "26Q1"},
        "30. 储能热管理系统": {"kws": ["储能热管理", "热管理", "储能温控"], "time": "26Q2"}}}
}

def clean_reason_v19(raw_text):
    if not raw_text: return ""
    text = raw_text.replace("入选理由", "").strip()
    if "人气龙头" in text:
        text = text.split("人气龙头")[0]
    return text.strip()

def init_db():
    api = CloudAPIClient(D1_API_URL)
    api._post('/api/db/execute', {'sql': '''CREATE TABLE IF NOT EXISTS hotspot_registry (
        ts_code TEXT, name TEXT, sector TEXT, node TEXT, purity TEXT, 
        em_reason TEXT, ts_main_biz TEXT, volume_node TEXT, remark TEXT, create_date TEXT,
        PRIMARY KEY (ts_code, sector, node)
    )'''})
    return api

def run_registry():
    api = init_db()
    print(">>> 正在加载 Tushare 主营档案库...")
    biz_df = pro.stock_company(fields='ts_code,main_business,business_scope')
    biz_dict = biz_df.set_index('ts_code').to_dict('index')

    # 🧹 [V20.1] 预清理：一次性拉取 Akshare 机构一致预期
    print("🧹 [预清理] 正在加载全市场【机构一致预期】...")
    valid_forecast_codes = set()
    try:
        df_ak = ak.stock_profit_forecast_em()
        if not df_ak.empty:
            valid_forecast_codes = set(df_ak['代码'].astype(str).str.zfill(6))
            print(f"   ✅ 已加载 {len(valid_forecast_codes)} 只有预测标的。")
    except Exception as e:
        print(f"   ⚠️ Akshare 拉取失败 ({e})，跳过研报过滤。")

    # 🚀 [新增] 提前加载同花顺概念总目录
    print(">>> 正在拉取同花顺全市场概念板块目录...")
    df_index = pro.ths_index(exchange='A', type='N')
    if df_index is None or df_index.empty:
        print("❌ 概念板块目录拉取失败！请检查 Tushare 接口。")
        return

    today_str = datetime.datetime.now().strftime('%Y%m%d')

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        try:
            for sector_label, config in NODES_CONFIG.items():
                board_name = config['board']
                print(f"\n🚀 正在审计板块: 【{board_name}】")
                
                # ---------------------------------------------------------
                # 🚀 [核心升级]：使用 Tushare 匹配 THS 概念代码并获取成分股
                # ---------------------------------------------------------
                match = df_index[df_index['name'] == board_name]
                if match.empty:
                    # 柔性匹配兜底：如果精确匹配不到，尝试包含关键词的板块
                    match = df_index[df_index['name'].str.contains(board_name.replace("概念", ""), na=False)]
                    if match.empty:
                        print(f"  ❌ 未找到名为【{board_name}】的同花顺板块，跳过。")
                        continue
                
                ths_code = match.iloc[0]['ts_code']
                
                try: 
                    df_cons = pro.ths_member(ts_code=ths_code)
                    if df_cons is None or df_cons.empty:
                        print(f"  ❌ 获取到的成分股为空，跳过。")
                        continue
                    print(f"  ✅ 成功获取【{board_name}】成分股: {len(df_cons)} 只")
                except Exception as e:
                    print(f"  ❌ 拉取成分股明细失败: {e}")
                    continue

                for _, row in df_cons.iterrows():
                    # 解析 Tushare 格式的代码 (如 000009.SZ)
                    ts_code = row['con_code'] 
                    name = row['con_name']
                    code = ts_code.split('.')[0]
                    
                    # ==========================================================
                    # 🚀 [新增前置筛选]：不破坏下方抓取逻辑，仅做入选拦截
                    # ==========================================================
                    try:
                        # 1. 研报/预测门槛：检查纯代码是否在 Akshare 预测池中
                        pure_code = ts_code.split('.')[0].zfill(6)
                        if valid_forecast_codes and pure_code not in valid_forecast_codes:
                            print(f"  [SKIPPED] {name} | 无机构一致预期(Akshare)")
                            continue
                        
                        # 2. 技术面三重过滤
                        df_daily = pro.daily(ts_code=ts_code, limit=60)
                        if df_daily is None or df_daily.empty or len(df_daily) < 60:
                            continue
                        
                        df_daily = df_daily.sort_values('trade_date', ascending=True)
                        close_now = df_daily.iloc[-1]['close']
                        ma60 = df_daily['close'].rolling(60).mean().iloc[-1]

                        # A. 股价 < 60日线则拦截
                        if close_now < ma60:
                            print(f"  [SKIPPED] {name} | 股价 < 60日线")
                            continue
                            
                        # B. 60日乖离率 > 25% 则拦截 (防止追高)
                        bias_60 = (close_now - ma60) / ma60
                        if bias_60 > 0.25:
                            print(f"  [SKIPPED] {name} | 乖离率 > 25% ({bias_60*100:.1f}%)")
                            continue

                        # C. MA5 < MA10 死叉 (按要求注解掉，暂不启用)
                        """
                        ma5 = df_daily['close'].rolling(5).mean().iloc[-1]
                        ma10 = df_daily['close'].rolling(10).mean().iloc[-1]
                        if ma5 < ma10:
                            print(f"  [SKIPPED] {name} | MA5 < MA10 (死叉)")
                            continue
                        """
                    except Exception as e:
                        print(f"  [ERROR] {name} 预校验跳过: {e}")
                        continue
                    # ==========================================================
                    # 以上前置筛选
                    # --- 1. 抓取理由 (原本难调试的代码从这里开始，完全不动) ---
                    symbol = f"SZ{code}" if ts_code.endswith("SZ") else f"SH{code}"
                    url = f"https://emweb.securities.eastmoney.com/pc_hsf10/pages/index.html?type=web&code={symbol}&color=b#/hxtc/gntc"
                    
                    try:
                        page.goto(url, wait_until="networkidle", timeout=12000)
                        # 这里起到了交叉验证的作用，如果东财网页没有这个板块，会触发Timeout并被except拦截
                        btn = page.locator("li").filter(has_text=board_name).first
                        btn.wait_for(state="visible", timeout=8000)
                        btn.click()
                        time.sleep(2.5) # AJX 缓冲
                        
                        content_raw = page.evaluate("""() => {
                            const el = Array.from(document.querySelectorAll('*')).find(x => x.innerText.trim() === '入选理由');
                            return el ? el.parentElement.innerText : "";
                        }""")
                        reason = clean_reason_v19(content_raw)
                    except KeyboardInterrupt: raise KeyboardInterrupt
                    except:
                        # 东方财富没有这个概念标签，交叉验证失败，踢出
                        print(f"  [FAILED] {name}({ts_code}) | 东财网页未找到概念或访问失败")
                        continue

                    if not reason: continue

                    # --- 2. 基于理由内容确定 Keynode 归属 ---
                    matched_markers = [m for m in MARKERS if m in reason]
                    remark = ",".join(matched_markers) if matched_markers else ""
                    
                    matched_nodes_list = []
                    for node_name, node_info in config['nodes'].items():
                        # --- 3. 精准查重：标的代码 + Keynode ---
                        #下面注释查重代码无意义，去掉，因为不管是否在库中已存在，实际都要跑一遍爬虫以确认node。
                        #cursor.execute('SELECT 1 FROM hotspot_registry WHERE ts_code=? AND sector=? AND node=?', (ts_code, sector_label, node_name))
                        #if cursor.fetchone():
                        #    matched_nodes_list.append(f"{node_name}(EXIST)")
                        #    continue
                        #
                        #if any(kw in reason for kw in node_info['kws']):
                        #    biz = biz_dict.get(ts_code, {})
                        #    full_biz = str(biz.get('main_business','')) + str(biz.get('business_scope',''))
                            
                        #    cursor.execute('INSERT OR IGNORE INTO hotspot_registry VALUES (?,?,?,?,?,?,?,?,?,?)',
                        #                  (ts_code, name, sector_label, node_name, "", reason, full_biz[:400], node_info['time'], "", today_str))
                        #    matched_nodes_list.append(node_name)

                        
                        if any(kw in reason for kw in node_info['kws']):
                            biz = biz_dict.get(ts_code, {})
                            full_biz = str(biz.get('main_business','')) + str(biz.get('business_scope',''))
                            
                            # 🚀 [V20.1] 使用 UPSERT 语法：存在则更新理由/主营/日期，不存在则插入
                            sql_upsert = """
                                INSERT INTO hotspot_registry (ts_code, name, sector, node, purity, em_reason, ts_main_biz, volume_node, remark, create_date)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(ts_code, sector, node) DO UPDATE SET
                                    em_reason = excluded.em_reason,
                                    ts_main_biz = excluded.ts_main_biz,
                                    create_date = excluded.create_date
                            """
                            api._post('/api/db/execute', {
                                'sql': sql_upsert,
                                'params': [ts_code, name, sector_label, node_name, "", reason, full_biz[:400], node_info['time'], "", today_str]
                            })
                            matched_nodes_list.append(node_name)

                    # --- 4. 兜底逻辑 (同步改为 UPSERT) ---
                    if not matched_nodes_list and matched_markers:
                        biz = biz_dict.get(ts_code, {})
                        full_biz = str(biz.get('main_business','')) + str(biz.get('business_scope',''))
                        
                        sql_upsert_fallback = """
                            INSERT INTO hotspot_registry (ts_code, name, sector, node, purity, em_reason, ts_main_biz, volume_node, remark, create_date)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(ts_code, sector, node) DO UPDATE SET
                                em_reason = excluded.em_reason,
                                ts_main_biz = excluded.ts_main_biz,
                                create_date = excluded.create_date
                        """
                        api._post('/api/db/execute', {
                            'sql': sql_upsert_fallback,
                            'params': [ts_code, name, sector_label, f"{sector_label}兜底", "", reason, full_biz[:400], "26Q1", "", today_str]
                        })
                        matched_nodes_list.append(f"{sector_label}兜底")

                    '''if not matched_nodes_list and matched_markers:
                        cursor.execute('SELECT 1 FROM hotspot_registry WHERE ts_code=? AND sector=? AND node=?', (ts_code, sector_label, f"{sector_label}兜底"))
                        if not cursor.fetchone():
                            biz = biz_dict.get(ts_code, {})
                            full_biz = str(biz.get('main_business','')) + str(biz.get('business_scope',''))
                            
                            cursor.execute('INSERT OR IGNORE INTO hotspot_registry VALUES (?,?,?,?,?,?,?,?,?,?)',
                                          (ts_code, name, sector_label, f"{sector_label}兜底", "", reason, full_biz[:400], "26Q1", "", today_str))
                            matched_nodes_list.append(f"{sector_label}兜底")'''
                    
                    if matched_nodes_list:
                        print(f"  [SUCCESS] {name}({ts_code}) | 命中: {', '.join(matched_nodes_list)}")
                    else:
                        print(f"  [FILTERED] {name}({ts_code}) | 理由未命中任何指纹")

        except KeyboardInterrupt:
            print("\n🛑 操作已由 Control+C 终止，正在安全退出...")
            browser.close()
            sys.exit(0)

        browser.close()
    print("\n✅ V20.0 产业链审计完成！")

if __name__ == "__main__":
    run_registry()
