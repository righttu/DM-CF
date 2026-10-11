"""
==================================================
看板: hotspot_dashboard.py
版本: 2026.01.08-V39.0.8 (DB Mapping Calibration)
核心更新:
1. 废除代码预设: 联动逻辑完全遵循 registry 表中的 sector -> node -> name.
2. 修复逻辑错位: 商业航天下的环节绝不会出现灵巧手.
3. 聚合逻辑优化: 修复 name 冲突导致的 ValueError 报错.
==================================================
"""
import os
import requests
import streamlit as st
import pandas as pd
import plotly.graph_objects as go
import numpy as np

D1_API_URL = 'https://stock-api.righttu.uk'
CF_ACCESS_CLIENT_ID = os.getenv('CF_ACCESS_CLIENT_ID')
CF_ACCESS_CLIENT_SECRET = os.getenv('CF_ACCESS_CLIENT_SECRET')

# --- 1. 数据引擎：直接读取 Registry 的层级逻辑 ---
@st.cache_data(ttl=30)
def load_data():
    # 使用 r.sector 代替 h.industry，确保层级绝对正确
    resp = requests.post(
        f"{D1_API_URL}/api/db/query",
        json={'sql': """
            SELECT h.*, r.sector AS registry_sector, r.node, r.em_reason AS registry_em_reason
            FROM hotspot_hunter h
            JOIN hotspot_registry r ON h.ts_code = r.ts_code
        """},
        headers={
            'Content-Type': 'application/json',
            'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
            'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
        },
        timeout=30
    )
    data = resp.json()
    if not data.get('success'):
        raise Exception(data.get('error', 'API call failed: /api/db/query'))
    df = pd.DataFrame(data.get('results', []))
    if not df.empty:
        df['sector'] = df.pop('registry_sector')
        df['em_reason'] = df.pop('registry_em_reason')
    return df

st.set_page_config(layout="wide", page_title="Hotspot Hunter V39.0.8")
df_all = load_data()
if df_all.empty:
    st.warning("⚠️ 数据库中没有热点猎手数据。")
    st.stop()
latest_date = df_all['trade_date'].max()

# --- 2. 侧边栏：基于数据库 Registry 的三级下钻 ---
st.sidebar.header("🎯 审计穿透导航")
view_level = st.sidebar.radio("监控层级", ["全市场重心", "板块下钻", "个股级"])
lookback = st.sidebar.slider("轨迹深度", 3, 15, 7)

# 动态提取层级选项，绝不错位
if view_level == "全市场重心":
    plot_df, group_col = df_all.copy(), 'sector'
elif view_level == "板块下钻":
    sectors = sorted(df_all['sector'].unique().tolist())
    sel_sec = st.sidebar.selectbox("选择板块 (Sector)", sectors)
    # 严格过滤该板块下的环节
    plot_df = df_all[df_all['sector'] == sel_sec].copy()
    group_col = 'node'
else:
    # 个股级：严格执行 Sector -> Node -> Name 的三级联动
    sectors = sorted(df_all['sector'].unique().tolist())
    sel_sec = st.sidebar.selectbox("1. 选择板块 (Sector)", sectors)
    
    nodes = sorted(df_all[df_all['sector'] == sel_sec]['node'].unique().tolist())
    sel_node = st.sidebar.selectbox("2. 选择环节 (Node)", nodes)
    
    plot_df = df_all[(df_all['sector'] == sel_sec) & (df_all['node'] == sel_node)].copy()
    group_col = 'name'

# 聚焦功能
targets = sorted(plot_df[group_col].unique().tolist())
focus_target = st.sidebar.selectbox("🏹 聚焦目标 (去噪显示)", ["全部显示"] + targets)

# --- 3. 绘图引擎 (真头滑尾 + 动能箭头) ---
st.header(f"🌐 {view_level} 动能真相演进图 ({latest_date})")

# 修正聚合函数名，避免 reset_index 冲突
def agg_v39(x):
    # 市值加权强度坐标
    w = x['total_mv'] + 1
    return pd.Series({
        'mf_amt_sum': x['net_mf_amount'].sum(),
        'vol_rat_avg': x['volume_ratio'].mean(),
        'mf_int_weighted': np.average(x['mf_intensity'], weights=w)
    })

# 执行科学聚合
stats = plot_df.groupby(['trade_date', group_col]).apply(agg_v39).reset_index()

if not stats.empty:
    fig = go.Figure()
    fig.add_hline(y=1.0, line_dash="solid", line_color="gray", opacity=0.3)
    fig.add_vline(x=0.0, line_dash="solid", line_color="gray", opacity=0.3)

    for t in stats[group_col].unique():
        is_f = (focus_target == "全部显示" or t == focus_target)
        op = 1.0 if is_f else 0.05
        
        t_data = stats[stats[group_col] == t].sort_values('trade_date').tail(lookback + 2)
        t_data = t_data.dropna(subset=['mf_int_weighted', 'vol_rat_avg'])
        if t_data.empty:
            continue

        # 提取真实真相坐标
        x_raw, y_raw = t_data['mf_int_weighted'].values, t_data['vol_rat_avg'].values
        inflow_raw = t_data['mf_amt_sum'].iloc[-1]
        inflow = float(inflow_raw) if pd.notna(inflow_raw) else 0.0
        
        # WMA 计算滑尾 (5:3:2)
        w_x, w_y = [], []
        for i in range(2, len(x_raw)):
            w_x.append(x_raw[i]*0.5 + x_raw[i-1]*0.3 + x_raw[i-2]*0.2)
            w_y.append(y_raw[i]*0.5 + y_raw[i-1]*0.3 + y_raw[i-2]*0.2)

        if len(w_x) >= 2:
            # A. 丝滑 Spline 轨迹 (滑尾至昨日)
            fig.add_trace(go.Scatter(x=w_x[:-1], y=w_y[:-1], mode='lines',
                                     line=dict(width=2, shape='spline'),
                                     opacity=0.3 if is_f else 0.01, showlegend=False))

            # B. 动能虚线箭头 (昨日平滑重心 -> 今日真相点)
            fig.add_trace(go.Scatter(x=[w_x[-2], x_raw[-1]], y=[w_y[-2], y_raw[-1]],
                                     mode='lines+markers',
                                     marker=dict(symbol='arrow', size=12, angleref="previous"),
                                     line=dict(width=4 if is_f else 1, dash='dot'),
                                     opacity=op, showlegend=False))

        # C. 今日真实气泡 (Raw Head)
        # 面积映射资金量：半径 sqrt(abs(inflow))
        b_size = np.sqrt(abs(inflow)) / 7 + 12
        
        # 个股级显示具体流入值
        m_text = f"<b>{t}</b><br>{inflow:.0f}万" if (view_level == "个股级" and is_f) else t if is_f else ""

        fig.add_trace(go.Scatter(
            x=[x_raw[-1]], y=[y_raw[-1]], 
            mode='markers+text', 
            text=[m_text], textposition="top center",
            marker=dict(size=b_size, line=dict(width=1, color='white')), 
            opacity=op,
            hovertemplate=f"<b>{t}</b><br>真相强度(X): %{{x:.2f}}%<br>净流入: {inflow:.0f}万<extra></extra>"
        ))

    if fig.data:
        fig.update_layout(height=800, template="plotly_dark", xaxis=dict(title="资金强度 (X)"), yaxis=dict(title="量比 (Y)"))
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.warning("⚠️ 当前数据缺少有效的资金强度或量比，暂时无法绘图。")

# --- 4. 底部 30 字段全维度
