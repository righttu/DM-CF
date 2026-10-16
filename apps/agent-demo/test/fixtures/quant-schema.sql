CREATE TABLE ai_analysis_result (
                report_date TEXT, name TEXT, ts_code TEXT, industry TEXT, source_strategy TEXT,
                industry_heat TEXT, net_inflow_5d TEXT, current_price REAL, target_price REAL,
                upside_potential REAL, score_certainty INTEGER, final_score INTEGER,
                target_market_cap TEXT, forecast_net_profit TEXT, survey_count INTEGER,
                org_count INTEGER, famous_orgs TEXT, moat_summary TEXT, 
                chip_cumu_change TEXT, chip_latest_change TEXT, netprofit_margin TEXT, 
                ai_report TEXT, update_time TEXT, tags TEXT,
                PRIMARY KEY (report_date, ts_code)
            );
CREATE TABLE alpha_hunter (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_code TEXT, name TEXT, industry TEXT, close REAL,
                turnover_rate_3d REAL, industry_turnover_rate_3d REAL,
                pe_ttm REAL, pe_ttm_percentile REAL, industry_pe_ttm_median REAL,
                peg REAL, pb REAL, pb_percentile REAL, industry_pb_median REAL,
                forecast_eps_fy1 REAL, net_inflow_5d REAL, total_mv REAL,
                ps_ttm REAL, forecast_eps_fy2 REAL, con_growth_rate REAL,
                roe REAL, grossprofit_margin REAL, netprofit_yoy REAL,
                scan_date TEXT, score REAL, tags TEXT,
                industry_heat_status TEXT, main_business TEXT,
                ratio_current TEXT, ratio_prev_1 TEXT, ratio_prev_2 TEXT,
                accel_ratio REAL, hold_mv_billion REAL,
                chip_latest_change TEXT, chip_cumu_change TEXT, create_time TEXT
            );
CREATE TABLE chip_hunter (
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
            );
CREATE TABLE favorites (
                ts_code TEXT PRIMARY KEY,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE hotspot_hunter (
        ts_code TEXT, trade_date TEXT, name TEXT, industry TEXT, sector TEXT, close REAL,
        turnover_rate_3d REAL, industry_turnover_rate_3d REAL, pe_ttm REAL, 
        pe_ttm_percentile REAL, industry_pe_ttm_median REAL, peg REAL, pb REAL, 
        pb_percentile REAL, industry_pb_median REAL, forecast_eps_fy1 REAL, 
        forecast_eps_fy2 REAL, net_inflow_5d REAL, total_mv REAL, ps_ttm REAL, 
        con_growth_rate REAL, chip_latest_change TEXT, chip_cumu_change TEXT,
        volume_ratio REAL, mf_intensity REAL, pct_chg REAL, net_mf_amount REAL,
        bias_60 REAL, is_institutional INTEGER, em_reason TEXT, scan_date TEXT, tags TEXT,
        PRIMARY KEY (ts_code, trade_date)
    );
CREATE TABLE hotspot_registry (
        ts_code TEXT, name TEXT, sector TEXT, node TEXT, purity TEXT, 
        em_reason TEXT, ts_main_biz TEXT, volume_node TEXT, remark TEXT, create_date TEXT,
        PRIMARY KEY (ts_code, sector, node)
    );
CREATE TABLE institutional_surveys (
                ts_code TEXT,
                survey_date TEXT,
                org_count INTEGER,
                org_names TEXT,
                reception_place TEXT,
                PRIMARY KEY (ts_code, survey_date, org_names)
            );
CREATE TABLE stock_basic (
    ts_code TEXT PRIMARY KEY, symbol TEXT, name TEXT, fullname TEXT, cnspell TEXT,
    area TEXT, industry TEXT, market TEXT, exchange TEXT, list_status TEXT,
    list_date TEXT, delist_date TEXT, is_hs TEXT, update_time TEXT
);
CREATE TABLE stock_fundamentals (
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
            );
CREATE TABLE sync_status (
                ts_code TEXT PRIMARY KEY,
                last_report_sync TEXT,
                last_news_sync TEXT
            );
CREATE UNIQUE INDEX idx_alpha_code_scan_date ON alpha_hunter(ts_code, scan_date);
CREATE INDEX idx_alpha_scan_date ON alpha_hunter(scan_date);
CREATE INDEX idx_alpha_ts_code ON alpha_hunter(ts_code);
CREATE UNIQUE INDEX idx_chip_code_scan_date ON chip_hunter(ts_code, scan_date);
CREATE INDEX idx_chip_scan_date ON chip_hunter(scan_date);
CREATE INDEX idx_chip_ts_code ON chip_hunter(ts_code);
CREATE INDEX idx_stock_basic_cnspell ON stock_basic(cnspell);
CREATE INDEX idx_stock_basic_name ON stock_basic(name);
CREATE INDEX idx_stock_basic_symbol ON stock_basic(symbol);
