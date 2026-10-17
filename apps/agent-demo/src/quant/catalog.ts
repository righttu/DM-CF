export const QUANT_SERVER_NAME = "abc-quant-mcp-s";

export const QUANT_TABLES = [
  "stock_basic",
  "stock_fundamentals",
  "chip_hunter",
  "alpha_hunter",
  "hotspot_hunter",
  "hotspot_registry",
  "ai_analysis_result",
  "institutional_surveys"
] as const;
export type QuantTable = (typeof QUANT_TABLES)[number];

export const STRATEGIES = ["chip", "alpha", "hotspot"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const SOURCE_TYPES = ["研报", "公告", "新闻"] as const;

export const TS_CODE_PATTERN = /^\d{6}\.(SH|SZ|BJ)$/;
export const COMPACT_DATE_PATTERN = /^\d{8}$/;
export const DASHED_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface TableDoc {
  description: string;
  grain: string;
  notes: string[];
  columns: Record<string, string>;
}

const VALUATION_COLUMNS = {
  pe_ttm: "市盈率 TTM（倍，扫描日的最新值）",
  pe_ttm_percentile: "PE 近 5 年历史分位（0-100，越低越便宜）",
  industry_pe_ttm_median: "所属行业 PE TTM 中位数（倍）",
  peg: "PEG = 前瞻 PE / 一致预期复合增速，<1 通常视为低估",
  pb: "市净率（倍）",
  pb_percentile: "PB 近 5 年历史分位（0-100）",
  industry_pb_median: "所属行业 PB 中位数（倍）",
  ps_ttm: "市销率 TTM（倍），亏损股和科技股的估值锚",
  forecast_eps_fy1: "分析师一致预期每股收益，当年（元）",
  forecast_eps_fy2: "分析师一致预期每股收益，明年（元）",
  con_growth_rate: "一致预期复合增速（%），PEG 的分母"
} as const;

export const DATA_DICTIONARY: Record<QuantTable, TableDoc> = {
  stock_basic: {
    description: "A 股基础信息，用于把股票名称、拼音缩写或 6 位代码对应到 ts_code。",
    grain: "每只股票一行，含已退市股票。",
    notes: [
      "cnspell 为大写拼音首字母，如 贵州茅台 = GZMT。",
      "list_status：L 上市，D 退市，P 暂停上市。list_date、delist_date 格式 YYYYMMDD。"
    ],
    columns: {
      ts_code: "股票代码，如 600519.SH（主键）",
      symbol: "6 位数字代码",
      name: "股票简称",
      fullname: "公司全称",
      cnspell: "简称拼音首字母（大写）",
      area: "所在地区",
      industry: "所属行业",
      market: "市场：主板、创业板、科创板、北交所等",
      exchange: "交易所：SSE、SZSE、BSE",
      list_status: "上市状态 L/D/P",
      list_date: "上市日期 YYYYMMDD",
      delist_date: "退市日期 YYYYMMDD",
      is_hs: "沪深港通标的：N 否，H 沪股通，S 深股通",
      update_time: "本表同步时间"
    }
  },
  stock_fundamentals: {
    description: "全市场财务基本面，按报告期一行，约 5,200 只股票，2016 年起。",
    grain: "每只股票每个报告期一行（主键 ts_code + end_date）。本表没有股票名称，需要关联 stock_basic。",
    notes: [
      "end_date 为报告期 YYYYMMDD：0331 一季报、0630 半年报、0930 三季报、1231 年报。",
      "revenue、n_income_attr_p、profit_dedt、n_cashflow_act 等金额为年初至报告期末的累计值，单位元；比较单季要用 q_ 开头的单季字段，或相邻报告期相减。",
      "百分比字段（*_yoy、*_margin、roe、roic、debt_to_assets、dv_ratio）单位为 %。",
      "total_mv 单位为万元（与 Hunter 表的亿元不同）。pe_ttm、pb、ps_ttm、total_mv 是数据抓取时的估值快照，不是实时行情。"
    ],
    columns: {
      ts_code: "股票代码",
      end_date: "报告期 YYYYMMDD",
      ann_date: "公告日期 YYYYMMDD",
      revenue: "营业收入（元，累计）",
      tr_yoy: "营业总收入同比（%）",
      q_sales_yoy: "单季营业收入同比（%）",
      n_income_attr_p: "归母净利润（元，累计）",
      netprofit_yoy: "归母净利润同比（%）",
      q_netprofit_yoy: "单季归母净利润同比（%）",
      dt_netprofit_yoy: "扣非归母净利润同比（%）",
      q_dtprofit: "单季扣非净利润（元）",
      profit_dedt: "扣非净利润（元，累计）",
      eps: "基本每股收益（元）",
      bps: "每股净资产（元）",
      grossprofit_margin: "销售毛利率（%）",
      netprofit_margin: "销售净利率（%）",
      roe: "净资产收益率 ROE（%）",
      roe_dt: "扣非净资产收益率（%）",
      roic: "投入资本回报率 ROIC（%）",
      int_exp: "利息支出（元）",
      daa: "折旧与摊销（元）",
      ebitda: "息税折旧摊销前利润（元）",
      ebit: "息税前利润（元）",
      debt_to_assets: "资产负债率（%）",
      current_ratio: "流动比率（倍）",
      quick_ratio: "速动比率（倍）",
      assets_turn: "总资产周转率（次）",
      ar_turn: "应收账款周转率（次）",
      accounts_receiv: "应收账款（元）",
      inventories: "存货（元）",
      rd_exp: "研发费用（元）",
      n_cashflow_act: "经营活动现金流量净额（元，累计）",
      pe_ttm: "市盈率 TTM（倍）",
      pb: "市净率（倍）",
      ps_ttm: "市销率 TTM（倍）",
      total_mv: "总市值（万元）",
      dv_ratio: "股息率（%）",
      update_time: "抓取时间"
    }
  },
  chip_hunter: {
    description: "筹码选股策略（Chip Hunter）每日扫描命中的股票：股东户数持续下降、筹码集中，并叠加估值、资金和技术形态过滤。",
    grain: "每只股票每个扫描日一行。目前只保留最近一次扫描。",
    notes: [
      "scan_date 格式 YYYYMMDD。total_mv 单位亿元；net_mf_amount、net_inflow_5d 单位万元。",
      "chip_cumu_change 为负表示股东户数减少、筹码集中；score 为其绝对值，越大越集中。"
    ],
    columns: {
      id: "自增 ID",
      scan_date: "扫描日期 YYYYMMDD",
      ts_code: "股票代码",
      name: "股票名称",
      industry: "所属行业",
      close: "最新收盘价（元）",
      pct_chg: "当日涨跌幅（%）",
      volume_ratio: "量比",
      total_mv: "总市值（亿元）",
      turnover_rate: "当日换手率（%）",
      turnover_rate_3d: "个股近 3 日累计换手率（%）",
      industry_turnover_rate_3d: "行业 3 日换手率中位数（%）",
      score: "筹码评分 = 筹码累计变动的绝对值",
      tags: "策略标签，描述近三季和近一季股东户数变化",
      holders_wan: "股东户数（万户）",
      chip_cumu_change: "近三季股东户数累计变化（%，负值为筹码集中）",
      chip_latest_change: "最近一季股东户数变化（%）",
      net_mf_amount: "当日主力净额（万元）",
      net_inflow_5d: "近 5 日主力净流入（万元）",
      ...VALUATION_COLUMNS,
      ratio_current: "本期聪明资金持股占比",
      ratio_prev_1: "上期聪明资金持股占比",
      roe: "净资产收益率（%）",
      grossprofit_margin: "毛利率（%）",
      netprofit_yoy: "净利润同比（%）",
      concepts: "所属概念（前 10 个）",
      top_list_reason: "近期龙虎榜上榜理由",
      pattern: "技术形态：底部启动、趋势主升",
      bias_60: "60 日乖离率（%），>25 视为过热",
      vol_signal: "量能信号，如 温和放量",
      create_time: "记录创建时间"
    }
  },
  alpha_hunter: {
    description: "阿尔法猎手（Alpha Hunter）：追踪长线机构资金（社保、险资、北向等）加仓的选股结果。",
    grain: "每只股票每个扫描日一行。目前只保留最近一次扫描。",
    notes: [
      "ratio_current、ratio_prev_1、ratio_prev_2、chip_latest_change、chip_cumu_change 是带 % 的文本，比较大小前需要去掉 % 再转数字。",
      "total_mv 单位亿元；hold_mv_billion 单位亿元；net_inflow_5d 单位万元。"
    ],
    columns: {
      id: "自增 ID",
      ts_code: "股票代码",
      name: "股票名称",
      industry: "所属行业",
      close: "最新收盘价（元）",
      turnover_rate_3d: "个股 3 日累计换手率（%）",
      industry_turnover_rate_3d: "行业 3 日换手率（%）",
      ...VALUATION_COLUMNS,
      net_inflow_5d: "近 5 日主力净流入（万元）",
      total_mv: "总市值（亿元）",
      roe: "净资产收益率（%）",
      grossprofit_margin: "毛利率（%）",
      netprofit_yoy: "净利润同比（%）",
      scan_date: "扫描日期 YYYYMMDD",
      score: "综合评分（策略打分）",
      tags: "策略标签，如 长线机构:2家|北向增104.4%|人寿新进",
      industry_heat_status: "行业热度，如 极热、活跃、冷门",
      main_business: "主营业务",
      ratio_current: "本期聪明资金持股占比（文本，带 %）",
      ratio_prev_1: "上期聪明资金持股占比（文本，带 %）",
      ratio_prev_2: "上上期聪明资金持股占比（文本，带 %）",
      accel_ratio: "资金加速比，机构加仓的加速度",
      hold_mv_billion: "聪明资金持仓市值（亿元）",
      chip_latest_change: "最近一期股东户数变化（文本，带 %）",
      chip_cumu_change: "近三季股东户数累计变化（文本，带 %）",
      create_time: "记录创建时间"
    }
  },
  hotspot_hunter: {
    description: "热点猎手（Hotspot Hunter）：热门题材板块（如具身智能）产业链个股的逐日资金与估值数据，含题材真伪判断。",
    grain: "每只股票每个交易日一行（主键 ts_code + trade_date）。",
    notes: [
      "trade_date 为交易日、scan_date 为扫描日，均为 YYYYMMDD。",
      "total_mv 单位亿元；net_mf_amount、net_inflow_5d 单位万元；mf_intensity 为主力资金强度（%，策略脚本口径）。",
      "tags 以 真题材|环节|分析 的形式给出题材真伪、所属环节和理由。"
    ],
    columns: {
      ts_code: "股票代码",
      trade_date: "交易日 YYYYMMDD",
      name: "股票名称",
      industry: "所属行业",
      sector: "题材板块，如 具身智能",
      close: "收盘价（元）",
      turnover_rate_3d: "个股 3 日累计换手率（%）",
      industry_turnover_rate_3d: "行业 3 日换手率（%）",
      ...VALUATION_COLUMNS,
      net_inflow_5d: "近 5 日主力净流入（万元）",
      total_mv: "总市值（亿元）",
      chip_latest_change: "最近一季股东户数变化（%）",
      chip_cumu_change: "近三季股东户数累计变化（%）",
      volume_ratio: "量比",
      mf_intensity: "主力资金强度（%）",
      pct_chg: "当日涨跌幅（%）",
      net_mf_amount: "当日主力净额（万元）",
      bias_60: "60 日乖离率（%）",
      is_institutional: "是否有机构参与：1 是，0 否",
      em_reason: "东方财富给出的题材入选理由",
      scan_date: "扫描日期 YYYYMMDD",
      tags: "题材真伪判断：真题材|环节|分析理由"
    }
  },
  hotspot_registry: {
    description: "热点题材产业链登记表：个股在某题材中所属的产业链环节，以及 AI 对题材纯度的审计结论。",
    grain: "每只股票每个题材环节一行（主键 ts_code + sector + node）。",
    notes: ["purity 为纯度结论，如 真题材、待观察；remark 为完整审计理由。"],
    columns: {
      ts_code: "股票代码",
      name: "股票名称",
      sector: "题材板块",
      node: "产业链环节，如 4. 六维力矩传感器",
      purity: "题材纯度结论",
      em_reason: "东方财富入选理由",
      ts_main_biz: "主营业务",
      volume_node: "预计放量时间节点，如 26Q1",
      remark: "AI 审计结论与理由",
      create_date: "登记日期 YYYYMMDD"
    }
  },
  ai_analysis_result: {
    description: "AI 分析师对策略命中股票的综合诊断结果：整合 Hunter 数据、财务趋势、机构调研和研报后给出目标价、评分和完整报告。",
    grain: "每只股票每个报告日一行（主键 report_date + ts_code）。",
    notes: [
      "report_date 格式 YYYYMMDD。source_strategy 为来源策略：chip_hunter、alpha_hunter、hotspot_hunter 或 Manual（手工诊断）。",
      "final_score = 0.6 × upside_potential + 0.4 × score_certainty，取整，可以为负数。",
      "industry_heat、net_inflow_5d（万元）、chip_*、netprofit_margin 以文本保存。ai_report 是完整报告长文本。"
    ],
    columns: {
      report_date: "报告日期 YYYYMMDD",
      name: "股票名称",
      ts_code: "股票代码",
      industry: "所属行业",
      source_strategy: "来源策略",
      industry_heat: "行业热度（文本数值）",
      net_inflow_5d: "近 5 日主力净流入（文本，万元）",
      current_price: "分析时股价（元）",
      target_price: "AI 目标价（元）",
      upside_potential: "上涨空间（%，可为负）",
      score_certainty: "确定性评分（0-100）",
      final_score: "综合评分",
      target_market_cap: "目标市值（文本）",
      forecast_net_profit: "预测净利润及口径（文本）",
      survey_count: "机构调研次数",
      org_count: "调研机构数",
      famous_orgs: "知名调研机构",
      moat_summary: "护城河摘要",
      chip_cumu_change: "近三季股东户数变化（文本）",
      chip_latest_change: "最近一季股东户数变化（文本）",
      netprofit_margin: "净利率（文本）",
      ai_report: "完整 AI 分析报告（长文本）",
      update_time: "生成时间",
      tags: "策略标签"
    }
  },
  institutional_surveys: {
    description: "机构调研记录（来自东方财富）。",
    grain: "每只股票每个调研日期每组机构一行。",
    notes: ["survey_date 格式为 YYYY-MM-DD（与其他表的 YYYYMMDD 不同）。"],
    columns: {
      ts_code: "股票代码",
      survey_date: "调研日期 YYYY-MM-DD",
      org_count: "参与机构数",
      org_names: "参与机构名称",
      reception_place: "接待地点"
    }
  }
};

export const RESEARCH_DOC = {
  description: "研报、公告、新闻正文切片，存在 Vectorize 索引 stock-knowledge 中，只覆盖知识库已抓取的股票（约近 90 天）。",
  notes: [
    "每个切片约 500 字，元数据含 ts_code、stock_name、publish_date（YYYY-MM-DD）、source_type（研报/公告/新闻）、title、org。",
    "检索按股票代码过滤后做语义匹配，返回的是最相关的片段，不是全文；摘要和判断只能基于返回的片段。",
    "研报评级没有单独保存，观点倾向需要从正文判断。"
  ]
};

export const QUERY_LIMITS = {
  defaultRows: 50,
  maxRows: 200,
  maxSqlLength: 4000,
  maxCellChars: 2000,
  maxReportChars: 8000,
  maxResearchChars: 12000,
  maxResearchTopK: 50,
  defaultResearchTopK: 20
} as const;

const CHIP_COLUMNS =
  "scan_date, ts_code, name, industry, close, pct_chg, total_mv, score, tags, chip_cumu_change, chip_latest_change, holders_wan, turnover_rate_3d, net_mf_amount, net_inflow_5d, pe_ttm, pe_ttm_percentile, peg, pb, roe, netprofit_yoy, con_growth_rate, pattern, vol_signal, bias_60, concepts, top_list_reason";
const ALPHA_COLUMNS =
  "scan_date, ts_code, name, industry, close, total_mv, score, tags, industry_heat_status, substr(main_business, 1, 200) AS main_business, ratio_current, ratio_prev_1, ratio_prev_2, accel_ratio, hold_mv_billion, chip_latest_change, chip_cumu_change, net_inflow_5d, pe_ttm, pe_ttm_percentile, peg, roe, netprofit_yoy, con_growth_rate";
const HOTSPOT_COLUMNS =
  "trade_date, scan_date, ts_code, name, industry, sector, close, pct_chg, total_mv, mf_intensity, net_mf_amount, net_inflow_5d, volume_ratio, turnover_rate_3d, is_institutional, pe_ttm, peg, chip_cumu_change, substr(tags, 1, 400) AS tags";
const AI_SUMMARY_COLUMNS =
  "report_date, ts_code, name, industry, source_strategy, industry_heat, current_price, target_price, upside_potential, score_certainty, final_score, target_market_cap, forecast_net_profit, survey_count, org_count, famous_orgs, moat_summary, chip_cumu_change, chip_latest_change, netprofit_margin, net_inflow_5d, tags, update_time";

export const QUANT_QUERIES = {
  findStock:
    "SELECT ts_code, name, industry, market, list_status, list_date FROM stock_basic WHERE ts_code = ?1 OR symbol = ?2 OR upper(cnspell) = ?1 OR name LIKE ?3 ESCAPE '\\' ORDER BY (name = ?4) DESC, (list_status = 'L') DESC, ts_code LIMIT 10",
  stockName: "SELECT name, industry FROM stock_basic WHERE ts_code = ?1",
  signals: {
    chip: {
      byStock: `SELECT ${CHIP_COLUMNS} FROM chip_hunter WHERE ts_code = ?1 ORDER BY scan_date DESC LIMIT ?2`,
      latest: `SELECT ${CHIP_COLUMNS} FROM chip_hunter WHERE scan_date = COALESCE(?1, (SELECT MAX(scan_date) FROM chip_hunter)) ORDER BY score DESC LIMIT ?2`
    },
    alpha: {
      byStock: `SELECT ${ALPHA_COLUMNS} FROM alpha_hunter WHERE ts_code = ?1 ORDER BY scan_date DESC LIMIT ?2`,
      latest: `SELECT ${ALPHA_COLUMNS} FROM alpha_hunter WHERE scan_date = COALESCE(?1, (SELECT MAX(scan_date) FROM alpha_hunter)) ORDER BY score DESC LIMIT ?2`
    },
    hotspot: {
      byStock: `SELECT ${HOTSPOT_COLUMNS} FROM hotspot_hunter WHERE ts_code = ?1 ORDER BY trade_date DESC LIMIT ?2`,
      latest: `SELECT ${HOTSPOT_COLUMNS} FROM hotspot_hunter WHERE scan_date = COALESCE(?1, (SELECT MAX(scan_date) FROM hotspot_hunter)) ORDER BY trade_date DESC, mf_intensity DESC LIMIT ?2`
    }
  },
  fundamentals:
    "SELECT end_date, ann_date, revenue, tr_yoy, q_sales_yoy, n_income_attr_p, netprofit_yoy, q_netprofit_yoy, dt_netprofit_yoy, profit_dedt, q_dtprofit, eps, bps, grossprofit_margin, netprofit_margin, roe, roe_dt, roic, debt_to_assets, current_ratio, quick_ratio, assets_turn, ar_turn, rd_exp, n_cashflow_act, pe_ttm, pb, ps_ttm, total_mv, dv_ratio FROM stock_fundamentals WHERE ts_code = ?1 ORDER BY end_date DESC LIMIT ?2",
  aiReportLatest: `SELECT ${AI_SUMMARY_COLUMNS}, substr(ai_report, 1, ${QUERY_LIMITS.maxReportChars}) AS ai_report, length(ai_report) AS ai_report_length FROM ai_analysis_result WHERE ts_code = ?1 ORDER BY report_date DESC LIMIT 1`,
  aiReportHistory: `SELECT ${AI_SUMMARY_COLUMNS} FROM ai_analysis_result WHERE ts_code = ?1 ORDER BY report_date DESC LIMIT ?2`,
  aiReportList:
    "SELECT report_date, ts_code, name, industry, source_strategy, current_price, target_price, upside_potential, score_certainty, final_score, tags FROM ai_analysis_result WHERE (?1 IS NULL OR report_date = ?1) ORDER BY report_date DESC, final_score DESC LIMIT ?2",
  researchCoverage: "SELECT last_report_sync, last_news_sync FROM sync_status WHERE ts_code = ?1",
  aiReportToday:
    "SELECT report_date, ts_code, name, source_strategy, final_score, target_price, upside_potential FROM ai_analysis_result WHERE ts_code = ?1 AND report_date = ?2 LIMIT 1",
  surveys:
    "SELECT survey_date, org_count, org_names, reception_place FROM institutional_surveys WHERE ts_code = ?1 ORDER BY survey_date DESC LIMIT ?2",
  chainByStock:
    "SELECT ts_code, name, sector, node, purity, volume_node, substr(remark, 1, 600) AS remark, substr(ts_main_biz, 1, 300) AS ts_main_biz, create_date FROM hotspot_registry WHERE ts_code = ?1 ORDER BY sector, node LIMIT ?2",
  chainBySector:
    "SELECT ts_code, name, sector, node, purity, volume_node, substr(remark, 1, 300) AS remark, create_date FROM hotspot_registry WHERE sector LIKE ?1 ESCAPE '\\' ORDER BY node, ts_code LIMIT ?2"
} as const;

export const QUANT_TOOL_DESCRIPTIONS = {
  describe_data:
    "返回 ABC 量化数据库的数据字典：每张表的用途、粒度、日期格式、单位和每个字段的中文含义，以及研报知识库的说明。不确定该查哪张表、哪个字段时先调用它；可传 table 只看一张表。",
  find_stock:
    "按股票名称（可模糊）、6 位代码、ts_code 或拼音首字母（如 GZMT）查找股票，返回 ts_code、名称、行业、市场和上市状态。用户用名称提问时，先用它确定 ts_code。",
  get_signals:
    "查询量化策略选股信号。strategy：chip 筹码集中、alpha 长线机构资金、hotspot 热点题材，或 all。传 ts_code 时返回该股被各策略选中的记录；不传 ts_code 时返回最近一次（或 scan_date 指定日期）扫描命中的股票，按评分排序。",
  get_fundamentals:
    "查询某只股票最近若干个报告期的财务基本面：营收与利润及同比、单季增速、毛利率、净利率、ROE、ROIC、负债率、现金流、估值和股息率。金额为累计值（元），总市值单位万元。",
  get_ai_report:
    "查询 AI 分析师的诊断结果。传 ts_code 时返回最新一期的目标价、上涨空间、确定性评分、综合评分、护城河摘要和完整报告（history=true 时改为返回历史各期摘要，不含全文）；不传 ts_code 时列出最近的诊断结果，按综合评分排序。",
  search_research:
    "在研报、公告和新闻知识库中检索某只股票的相关内容。query 填写用户关心的主题（如 业绩预期、产能、竞争格局、风险），返回按文档归组的相关片段（标题、机构、日期、类型、正文片段）。可用 since（YYYY-MM-DD）限定日期、source_type 限定类型。只覆盖知识库已抓取的股票；返回的是片段而非全文。",
  get_surveys: "查询某只股票的机构调研记录：日期、参与机构数、机构名称和接待地点，按日期倒序。",
  get_industry_chain:
    "查询热点题材产业链登记信息。传 ts_code 返回该股所属的题材、产业链环节、纯度结论和审计理由；传 sector（如 具身智能）返回该题材下的个股及环节。",
  query_data:
    "对 ABC 量化数据库执行一条只读 SQL（SQLite 语法，仅 SELECT 或 WITH），用于其他工具无法回答的筛选、排序、统计和跨表关联，例如“最近被两个以上策略同时选中且 ROE>15% 的股票”。先用 describe_data 确认表名、字段和单位；结果最多返回 max_rows 行。不能写入或修改数据。",
  run_analysis:
    "对一只股票发起深度诊断：运行手工分析引擎（筹码与估值计算、抓取近 90 天研报/公告/机构调研写入知识库、AI 分析师生成目标价、评分和完整报告），结果写入 AI 诊断结果表。只在用户明确要求诊断、深度分析或重新分析某只股票时调用。任务耗时通常数分钟，调用后立即返回任务编号；同一股票当天已有诊断时直接说明已有结果。",
  get_analysis_status:
    "查询深度诊断任务的进度和结果。传 job_id（run_analysis 返回的任务编号）或 ts_code（查询该股票当天的任务）。返回 timeline：各阶段名称、开始时间（北京时间）和耗时，回答时用简短列表展示这条时间线。任务完成后用 get_ai_report 读取完整报告。"
} as const;

export const QUANT_PARAM_DESCRIPTIONS = {
  table: "只看某一张表的字典；research 表示研报知识库。不传则返回全部",
  find_query: "股票名称（可只写一部分）、6 位代码、ts_code 或拼音首字母，如 茅台、600519、GZMT",
  ts_code: "股票代码，格式如 600519.SH、000550.SZ、920346.BJ；不知道代码时先用 find_stock",
  strategy: "chip 筹码集中，alpha 长线机构资金，hotspot 热点题材，all 全部（默认）",
  scan_date: "扫描日期，格式 YYYYMMDD；不传则取最近一次扫描",
  limit: "最多返回的行数",
  periods: "返回最近几个报告期，默认 8",
  history: "true 时返回该股历史各期诊断摘要（不含全文），默认 false 返回最新一期含全文",
  report_date: "只列出该报告日期（YYYYMMDD）的诊断结果，仅在不传 ts_code 时有效",
  research_query: "检索主题，直接用用户关心的方面，如 业绩预期、产能扩张、竞争格局、主要风险",
  since: "只要该日期及之后发布的文档，格式 YYYY-MM-DD",
  source_type: "文档类型：研报、公告或新闻",
  top_k: "最多返回的相关片段数，默认 20，最大 50",
  sector: "题材板块名称，可部分匹配，如 具身智能",
  sql: "一条只读 SQLite 查询，以 SELECT 或 WITH 开头，不要带分号和注释",
  max_rows: "最多返回的行数，默认 50，最大 200",
  job_id: "run_analysis 返回的任务编号，格式为 <ts_code>:<YYYYMMDD>，如 600519.SH:20261017"
} as const;

export const QUANT_SYSTEM_PROMPT_ADDENDUM = `当可用工具中有 ABC 量化数据（工具名以 abc-quant_ 开头）时：这些是 A 股真实市场与财务数据、量化策略结果和 AI 分析结论，不是实时行情，不构成投资建议。
用户用股票名称提问时，先用 find_stock 确定 ts_code。按问题选择数据：选股和策略信号用 get_signals，财务基本面用 get_fundamentals，AI 诊断用 get_ai_report，研报、公告和新闻用 search_research，机构调研用 get_surveys，题材产业链用 get_industry_chain。现成工具不能回答的筛选、排序、统计和跨表问题，先用 describe_data 了解字段和单位，再用 query_data 写只读 SQL。
回答时注明数据日期（扫描日、报告期、报告日或发布日期）和来源表；注意不同表的单位不同，例如基本面表的总市值是万元，Hunter 表的总市值是亿元。研报检索返回的是片段，概括时说明依据的是哪些文档。
用户明确要求对某只股票做深度诊断时，用 run_analysis 发起任务，告诉用户任务已提交、通常需要数分钟；用户询问进度时再用 get_analysis_status，不要在同一次回答里反复轮询；任务完成后用 get_ai_report 读取报告。`;
