import streamlit as st
import pandas as pd
import os
import altair as alt
import requests

# 1. 页面配置
st.set_page_config(layout="wide", page_title="AI 投研分析 Dashboard")

# 配置区
STOCK_API_BASE = "https://stock-api.righttu.uk"
CF_ACCESS_CLIENT_ID = os.getenv("CF_ACCESS_CLIENT_ID")
CF_ACCESS_CLIENT_SECRET = os.getenv("CF_ACCESS_CLIENT_SECRET")

# ==============================================================================
# 🗄️ 数据库管理 (收藏夹功能)
# ==============================================================================

def init_db():
    """初始化数据库，确保存储收藏夹的表存在"""
    try:
        headers = {
            "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
            "Content-Type": "application/json"
        }
        resp = requests.post(
            f"{STOCK_API_BASE}/api/db/execute",
            headers=headers,
            json={"sql": '''CREATE TABLE IF NOT EXISTS favorites (
                ts_code TEXT PRIMARY KEY,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )'''}
        )
        if not resp.json().get("success"):
            st.error(f"初始化数据库失败: {resp.json().get('error')}")
    except Exception as e:
        st.error(f"初始化数据库失败: {e}")


def get_favorites():
    """获取所有已收藏的股票代码集合"""
    try:
        headers = {
            "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
            "Content-Type": "application/json"
        }
        resp = requests.post(
            f"{STOCK_API_BASE}/api/db/query",
            headers=headers,
            json={"sql": "SELECT ts_code FROM favorites"}
        )
        data = resp.json()
        if data.get("success") and data.get("results"):
            return set(r['ts_code'] for r in data["results"])
        return set()
    except:
        return set()

def toggle_favorite(ts_code):
    """切换收藏状态：存在则删除(取消)，不存在则插入(加入)"""
    try:
        headers = {
            "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
            "Content-Type": "application/json"
        }
        # 1. 检查是否存在
        check_resp = requests.post(
            f"{STOCK_API_BASE}/api/db/query",
            headers=headers,
            json={"sql": "SELECT 1 FROM favorites WHERE ts_code = ?", "params": [ts_code]}
        )
        exists = check_resp.json().get("success") and check_resp.json().get("results")
        
        # 2. 执行逻辑
        if exists:
            requests.post(
                f"{STOCK_API_BASE}/api/db/execute",
                headers=headers,
                json={"sql": "DELETE FROM favorites WHERE ts_code = ?", "params": [ts_code]}
            )
            msg = f"已取消收藏: {ts_code}"
        else:
            requests.post(
                f"{STOCK_API_BASE}/api/db/execute",
                headers=headers,
                json={"sql": "INSERT INTO favorites (ts_code) VALUES (?)", "params": [ts_code]}
            )
            msg = f"已加入收藏: {ts_code}"
            
        st.cache_data.clear()
        st.toast(msg) 
        return True
    except Exception as e:
        st.error(f"操作失败: {e}")
        return False


# ==============================================================================
# 📥 数据加载
# ==============================================================================
@st.cache_data
def load_data():
    try:
        headers = {
            "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
            "Content-Type": "application/json"
        }
        resp = requests.post(
            f"{STOCK_API_BASE}/api/db/query",
            headers=headers,
            json={"sql": "SELECT * FROM ai_analysis_result"}
        )
        data = resp.json()
        if data.get("success") and data.get("results"):
            return pd.DataFrame(data["results"])
        return pd.DataFrame()
    except Exception as e:
        st.error(f"数据库读取出错: {e}")
        return pd.DataFrame()

# ==============================================================================
# 🖥️ 主程序
# ==============================================================================
def main():
    # 初始化收藏表结构
    init_db()
    
    # --- 顶部区域 ---
    c1, c2, c3, c4 = st.columns([4, 3, 2, 1])
    with c1:
        st.title("📊 AI 股票分析 Dashboard")
    with c2:
        search_term = st.text_input("🔍 搜索股票", placeholder="代码/名称...")
    with c3:
        # 垂直居中对齐
        st.write("") 
        show_fav_only = st.toggle("⭐ 只看收藏", value=False)
    with c4:
        st.write("") 
        if st.button("🔄 刷新"):
            st.cache_data.clear()
            st.rerun()
    # ======================== 新增：手工单股分析入口 ========================
    with st.expander("🔧 手工单股深度审计 (点击展开)", expanded=False):
        col_m1, col_m2 = st.columns([3, 1])
        with col_m1:
            manual_code = st.text_input(
                "输入股票代码", 
                placeholder="如 300347 或 000810", 
                label_visibility="collapsed",
                key="manual_input"
            )
        with col_m2:
            if st.button("🚀 启动分析", type="primary", use_container_width=True):
                if manual_code and manual_code.strip():
                    code = manual_code.strip()
                    with st.spinner(f"正在对 {code} 执行穿透审计，请稍候..."):
                        try:
                            from manual import ManualAnalystEngine
                            m_engine = ManualAnalystEngine()
                            m_engine.run_diagnostic(code)
                            st.success(f"✅ {code} 分析完成并已入库！")
                            st.cache_data.clear()
                            st.rerun()
                        except Exception as e:
                            st.error(f"❌ 分析失败: {e}")
                else:
                    st.warning("请输入股票代码")

    # --- 数据处理 ---
    df_all_history = load_data()
    if df_all_history.empty:
        st.warning("⚠️ 数据库中没有数据。")
        return

    # 1. 获取当前收藏列表
    fav_set = get_favorites()

    # 2. 基础清洗：去后缀
    if 'source_strategy' in df_all_history.columns:
        df_all_history['source_strategy'] = df_all_history['source_strategy'].astype(str).str.replace('_hunter', '')

    # 3. 深度清洗：去单位转数字 (确保排序)
    # 包含所有需要排序的数值型字段
    cols_to_convert = [
        'current_price', 'target_price', 'upside_potential', 'score_certainty', 'final_score',
        'netprofit_margin', 'industry_heat', 'net_inflow_5d', 'org_count', 'survey_count', 
        'chip_cumu_change', 'chip_latest_change'
    ]
    for col in cols_to_convert:
        if col in df_all_history.columns:
            df_all_history[col] = (
                df_all_history[col].astype(str)
                .str.replace(r'[家次%,]', '', regex=True)
                .str.replace('None', '0', regex=False)
            )
            df_all_history[col] = pd.to_numeric(df_all_history[col], errors='coerce')

    # 4. 提取最新切片 (用于列表显示)
    if 'report_date' in df_all_history.columns:
        df_latest = df_all_history.sort_values('report_date').groupby('ts_code').tail(1)
    else:
        df_latest = df_all_history

    # 5. 标记收藏状态
    df_display = df_latest.copy()
    # is_fav 用于逻辑判断
    df_display['is_fav'] = df_display['ts_code'].isin(fav_set)
    # 收藏 列用于表格显示 (显示五角星)
    df_display['收藏'] = df_display['is_fav'].apply(lambda x: '★' if x else '')

    # --- 过滤逻辑 ---
    # 1. 收藏过滤
    if show_fav_only:
        df_display = df_display[df_display['is_fav'] == True]
    
    # 2. 搜索过滤
    if search_term:
        df_display = df_display[
            df_display['name'].astype(str).str.contains(search_term, case=False) | 
            df_display['ts_code'].astype(str).str.contains(search_term, case=False)
        ]

    # 初始化表格数据
    df_table_filtered = df_display.copy()

    # --- 模块 1: 图表可视化 ---
    if not df_display.empty:
        with st.expander("📈 市场全景可视化 (点击饼图可过滤下方表格)", expanded=True):
            col_chart1, col_chart2 = st.columns([2, 1])
            
            with col_chart1:
                # 散点图：收藏的点完全不透明(1.0)，非收藏的点半透明(0.3)
                scatter_chart = alt.Chart(df_display).mark_circle(size=100).encode(
                    x=alt.X('score_certainty', title='确定性评分', scale=alt.Scale(domain=[0, 100])),
                    y=alt.Y('upside_potential', title='上涨空间 %', scale=alt.Scale(zero=False)),
                    color=alt.Color('source_strategy', legend=alt.Legend(title="策略来源")),
                    tooltip=['name', 'ts_code', 'final_score', 'upside_potential', 'industry'],
                    opacity=alt.condition(alt.datum.is_fav, alt.value(1.0), alt.value(0.3)) 
                ).properties(height=300, title="风险-收益矩阵").interactive()
                st.altair_chart(scatter_chart, use_container_width=True)

            with col_chart2:
                # 饼图
                selection = alt.selection_point(fields=['industry'])
                pie_chart = alt.Chart(df_display).mark_arc(innerRadius=50).encode(
                    theta=alt.Theta("count()", stack=True),
                    color=alt.Color("industry", legend=None),
                    tooltip=["industry", "count()"],
                    opacity=alt.condition(selection, alt.value(1), alt.value(0.2))
                ).add_params(selection).properties(height=300, title="行业分布 (点击过滤)")
                event = st.altair_chart(pie_chart, use_container_width=True, on_select="rerun")

    # 处理饼图过滤交互
    selected_industry = None
    if event.selection:
        for key in event.selection:
            if event.selection[key]:
                selected_industry = event.selection[key][0].get("industry")
                break
    
    if selected_industry:
        st.info(f"🔍 已过滤行业: **{selected_industry}**")
        df_table_filtered = df_table_filtered[df_table_filtered['industry'] == selected_industry]

    # --- 模块 2: 数据表格 ---
    # 定义中文列名
    column_mapping = {
        "report_date": "报告日期", "name": "股票名称", "ts_code": "代码", "industry": "行业",
        "source_strategy": "策略来源", "current_price": "现价", "target_price": "目标价", 
        "upside_potential": "上涨空间", "score_certainty": "确定性", "final_score": "综合评分", 
        "industry_heat": "行业热度", "net_inflow_5d": "5日净流入",
        "chip_cumu_change": "累计筹码变动", "chip_latest_change": "当季筹码变动",
        "target_market_cap": "目标市值", "forecast_net_profit": "预期净利润", 
        "netprofit_margin": "净利率", "survey_count": "调研次数", "org_count": "机构家数", 
        "famous_orgs": "知名机构", "moat_summary": "护城河简述", "update_time": "更新时间", "tags": "标签" 
    }

    # 定义列显示顺序 (收藏在第一列)
    display_cols_order = [
        "收藏", 
        "report_date", "name", "ts_code", "industry", "source_strategy", 
        "final_score", 
        "current_price", "target_price", "upside_potential", "score_certainty",
        "tags", 
        "netprofit_margin", 
        "industry_heat",    
        "net_inflow_5d",    
        "org_count",        
        "survey_count",     
        "chip_cumu_change", "chip_latest_change"
    ]
    
    # 筛选有效列并重命名
    valid_cols = [col for col in display_cols_order if col in df_table_filtered.columns]
    df_table = df_table_filtered[valid_cols].rename(columns=column_mapping)

    st.subheader(f"📋 分析列表 (共 {len(df_table)} 条)")

    # 配置列显示格式 (保持纯数字)
    column_config = {
        "收藏": st.column_config.TextColumn(width="small", help="带★号为已收藏"),
        "标签": st.column_config.TextColumn(width="medium", help="双击单元格可查看完整内容"),
        "现价": st.column_config.NumberColumn(format="¥ %.2f"),
        "目标价": st.column_config.NumberColumn(format="¥ %.2f"),
        "上涨空间": st.column_config.NumberColumn(format="%.2f %%"),
        "确定性": st.column_config.NumberColumn(format="%d"),
        "综合评分": st.column_config.ProgressColumn(format="%d 分", min_value=0, max_value=100),
        "代码": st.column_config.TextColumn(width="small"),
        "策略来源": st.column_config.TextColumn(width="small"),
        
        # 纯数字显示
        "机构家数": st.column_config.NumberColumn(format="%d"), 
        "调研次数": st.column_config.NumberColumn(format="%d"),
        
        # 百分比和小数显示
        "累计筹码变动": st.column_config.NumberColumn(format="%.2f %%"),
        "当季筹码变动": st.column_config.NumberColumn(format="%.2f %%"),
        "净利率": st.column_config.NumberColumn(format="%.2f %%"),
        "行业热度": st.column_config.NumberColumn(format="%.2f"),
        "5日净流入": st.column_config.NumberColumn(format="%.2f")
    }

    table_event = st.dataframe(
        df_table,
        use_container_width=True,
        hide_index=True,
        column_config=column_config,
        selection_mode="single-row",
        on_select="rerun",
        height=400
    )

    # ======================== 新增：表格快速操作栏 ========================
    if len(table_event.selection.rows) > 0:
        selected_idx = table_event.selection.rows[0]
        row = df_table_filtered.iloc[selected_idx]
        current_code = row['ts_code']
        is_fav_now = current_code in fav_set
        
        st.markdown("---")
        q_cols = st.columns([3, 1, 1, 5])
        with q_cols[0]:
            st.markdown(f"**📌 当前选中: {row.get('name')} ({current_code})**")
        with q_cols[1]:
            fav_btn = "⭐ 取消收藏" if is_fav_now else "☆ 加入收藏"
            if st.button(fav_btn, key=f"quick_fav_{current_code}", use_container_width=True):
                toggle_favorite(current_code)
                st.rerun()
        with q_cols[2]:
            if st.button("🗑️ 删除记录", key=f"quick_del_{current_code}", use_container_width=True):
                try:
                    headers = {
                        "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
                        "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
                        "Content-Type": "application/json"
                    }
                    del_resp = requests.post(
                        f"{STOCK_API_BASE}/api/db/execute",
                        headers=headers,
                        json={"sql": "DELETE FROM ai_analysis_result WHERE ts_code = ?", "params": [current_code]}
                    )
                    if not del_resp.json().get("success"):
                        st.error(f"删除失败: {del_resp.json().get('error')}")
                    else:
                        st.cache_data.clear()
                        st.toast(f"已删除 {current_code}")
                        st.rerun()
                except Exception as e:
                    st.error(f"删除失败: {e}")

        with q_cols[3]:
            st.caption("💡 下方可查看完整 AI 深度报告")
    # =====================================================================
    # --- 模块 3: 详情区 (包含所有字段) ---
    st.markdown("---")
    st.subheader("📝 AI 深度分析报告详情")

    if len(table_event.selection.rows) > 0:
        selected_idx = table_event.selection.rows[0]
        row = df_table_filtered.iloc[selected_idx]
        current_code = row['ts_code']
        # 检查是否收藏
        is_fav_now = current_code in fav_set
        
        with st.container(border=True):
            # 头部：名称 + 收藏按钮
            col_h1, col_h2, col_h3 = st.columns([3, 2, 2])
            with col_h1:
                st.markdown(f"### {row.get('name')} ({current_code})")
                st.caption(f"📅 {row.get('report_date')} | 🏷️ {row.get('source_strategy')}")
                
                # 【取消/加入 收藏按钮】
                btn_text = "⭐ 取消收藏" if is_fav_now else "☆ 加入收藏"
                if st.button(btn_text, key=f"btn_fav_{current_code}"):
                    toggle_favorite(current_code) # 触发切换逻辑
                    st.rerun()

            with col_h2:
                st.metric("综合评分", f"{row.get('final_score', 0)} 分")
            with col_h3:
                 st.metric("确定性", f"{row.get('score_certainty', 0)} / 100")

            # 历史趋势图
            df_history_single = df_all_history[df_all_history['ts_code'] == current_code].sort_values('report_date')
            if len(df_history_single) > 1:
                st.markdown("#### 📈 AI 评分历史趋势")
                chart_trend = alt.Chart(df_history_single).mark_line(point=True).encode(
                    x=alt.X('report_date', title='日期'),
                    y=alt.Y('final_score', title='评分', scale=alt.Scale(domain=[0, 100])),
                    tooltip=['report_date', 'final_score', 'upside_potential']
                ).properties(height=200)
                st.altair_chart(chart_trend, use_container_width=True)
            
            st.divider()

            # 三栏详情 (覆盖所有业务字段)
            c1, c2, c3 = st.columns(3)
            with c1:
                st.markdown("#### 💸 资金/筹码")
                st.write(f"**行业热度:** {row.get('industry_heat', 0)}")
                st.write(f"**5日净流入:** {row.get('net_inflow_5d', 0)}")
                st.markdown("---")
                st.write(f"**累计筹码变动:** {row.get('chip_cumu_change', 0)}%")
                st.write(f"**当季筹码变动:** {row.get('chip_latest_change', 0)}%")

            with c2:
                st.markdown("#### 🏢 机构/财务")
                st.write(f"**机构家数:** {int(row.get('org_count', 0))}") 
                st.write(f"**调研次数:** {int(row.get('survey_count', 0))}")
                st.caption(f"知名机构: {row.get('famous_orgs', '-')}")
                st.markdown("---")
                st.write(f"**预期净利:** {row.get('forecast_net_profit', '-')}")
                st.write(f"**净利率:** {row.get('netprofit_margin', 0)}%")
                st.write(f"**目标市值:** {row.get('target_market_cap', '-')}")

            with c3:
                st.markdown("#### 🏰 护城河逻辑")
                st.warning(f"🏷️ **标签:** {row.get('tags', '无')}")
                st.info(row.get('moat_summary', '暂无内容'))
                st.write(f"**现价:** ¥{row.get('current_price', 0)}")
                st.write(f"**目标价:** ¥{row.get('target_price', 0)}")
            
            st.divider()
            
            # AI 报告 & 更新时间
            st.markdown("### 🧠 AI 深度分析报告")
            if row.get('ai_report'):
                st.markdown(row.get('ai_report'))
            else:
                st.warning("暂无详细报告内容")
            
            st.caption(f"Last Update: {row.get('update_time', '-')}")

    else:
        st.info("👈 请在上方表格中点击任意一行，以管理收藏或查看详情。")

if __name__ == "__main__":
    main()
