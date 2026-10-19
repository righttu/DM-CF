import { auditGroupScriptSource } from "./audit-groups.js";

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>审计 · ABC 投研 Agent</title>
<style>
:root{--bg:#f7f6f2;--panel:#ffffff;--panel-2:#f0eee7;--text:#20242b;--muted:#6b7280;
--line:#e3dfd3;--accent:#8a671d;--brand-bg:#111827;--brand-text:#f9fafb;--deny:#b42318;
--radius:14px}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
background:var(--bg);color:var(--text);font-size:14px}
.top{display:flex;align-items:center;gap:12px;padding:14px 22px;border-bottom:1px solid var(--line);
background:var(--panel)}
.top .logo{width:30px;height:30px;border-radius:50%;background:#1d4ed8;color:#fff;
display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700}
.top h1{font-size:15px;margin:0}
.top a.back{margin-left:auto;color:var(--accent);text-decoration:none;font-size:13px}
.note{padding:8px 22px 4px;color:var(--muted);font-size:12.5px}
.note.legend{padding-bottom:10px;border-bottom:1px solid var(--line)}
.filters{display:flex;flex-wrap:wrap;gap:10px;padding:14px 22px;align-items:end}
.filters label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);gap:4px}
.filters input{padding:7px 10px;border:1px solid var(--line);border-radius:9px;font:inherit;
background:var(--panel);color:var(--text);min-width:170px}
.filters button{padding:8px 16px;border:none;border-radius:10px;background:var(--brand-bg);
color:var(--brand-text);font:inherit;cursor:pointer}
#list{padding:16px 22px 60px;display:flex;flex-direction:column;gap:12px}
.group{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);
overflow:hidden}
.group>summary{padding:12px 16px;cursor:pointer;list-style:none;display:flex;gap:10px;
align-items:baseline;flex-wrap:wrap}
.group>summary::-webkit-details-marker{display:none}
.group .q{color:var(--text)}
.group .meta{color:var(--muted);font-size:12px}
.group .rows{border-top:1px solid var(--line);padding:8px 16px 12px}
.row{display:flex;gap:10px;padding:7px 0;border-bottom:1px dashed var(--line);
align-items:baseline;flex-wrap:wrap}
.row:last-child{border-bottom:none}
.row .t{color:var(--muted);font-size:12px;min-width:86px}
.row .srv{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
.row .tool{font-weight:600}
.st{font-size:11px;border:1px solid var(--line);border-radius:6px;padding:1px 7px;
background:var(--panel-2);color:var(--muted)}
.st.ok{color:#0f766e;border-color:#99d5ce}
.st.denied,.st.error{color:var(--deny);border-color:#f0b8b2}
.sub{margin:2px 0 8px 96px;padding:8px 12px;border-left:3px solid var(--line);
background:var(--panel-2);border-radius:0 8px 8px 0;font-size:12.5px}
.tl{display:flex;gap:8px;align-items:baseline;padding:4px 0;flex-wrap:wrap;
border-bottom:1px dashed var(--line)}
.tl:last-child{border-bottom:none}
.tl.d1{padding-left:26px}
.tl.d2{padding-left:56px}
.tl .off{color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:12px;
min-width:52px;flex:none}
.tl .conn{color:var(--muted);min-width:12px;flex:none}
.muted{color:var(--muted)}
.sqld.inl{display:inline-block}
.sqld.inl .sql{display:block;margin:4px 0 4px 60px}
.sub .sql{font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;
word-break:break-all;display:block;margin:4px 0}
.sub .deny{color:var(--deny)}
.card{margin:6px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;
background:var(--panel)}
.card .l1{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.card .step{color:var(--accent);font-weight:700}
.card .l2{color:var(--muted);font-size:12px;margin-top:3px}
.card .warn{color:#9a6a00}
.acct{font-size:12px;color:var(--muted);margin:8px 0 3px}
table.acc{border-collapse:collapse;font-size:12px;min-width:55%}
.acc th{font-weight:600;color:var(--muted);text-align:left;padding:2px 10px 2px 0}
.acc td{padding:2px 10px 2px 0;border-top:1px dashed var(--line);vertical-align:top}
.acc tr.sqltr td{border-top:none;padding-top:0}
.sqld summary{cursor:pointer;color:var(--accent);font-size:12px}
.sqld .sql{font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;
word-break:break-all;display:block;margin:4px 0}
.noacc{color:var(--muted);font-size:12px;margin-top:6px}
.deny{color:var(--deny)}
.dlp{color:var(--deny);font-weight:600}
.args{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);
max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reply-text{display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;
-webkit-box-orient:vertical;overflow:hidden;white-space:normal;flex:1;min-width:200px}
.reply-text.open{-webkit-line-clamp:unset}
button.link{background:none;border:none;color:var(--accent);cursor:pointer;font:inherit;
font-size:12px;padding:0}
#empty,#err{padding:40px;text-align:center;color:var(--muted)}
</style>
</head>
<body>
<div class="top"><div class="logo">ABC</div><h1>审计视图</h1>
<a class="back" href="/">← 返回对话</a></div>
<div class="note legend">最新的提问在最上；每次提问内部按发生顺序：提问 → 模型决定调用工具 → 工具调用（Agent → MCP Portal → MCP Server）→ 数据访问 → 模型生成回答。一次提问一个请求 ID，每次工具调用一个调用 ID，两侧记录同一个 ID。提问与回答全文见 AI Gateway 日志。</div>
<div class="filters">
<label>用户邮箱<input id="f-user" type="text" placeholder="user@example.com"></label>
<label>开始日期（北京）<input id="f-from" type="date"></label>
<label>结束日期（北京）<input id="f-to" type="date"></label>
<label>会话 ID<input id="f-conv" type="text" placeholder="conversation_id"></label>
<button id="f-go" type="button">查询</button>
</div>
<div id="list"></div>
<div id="empty" hidden>没有匹配的审计事件。</div>
<div id="err" hidden></div>
<script nonce="__CSP_NONCE__">
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const bj = (ts) => new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
// Strip markdown noise from stored excerpts before display (content stays
// untouched in the DB; this only affects rendering).
const plain = (s) => String(s ?? "")
  .replace(/\x60\x60\x60[\\s\\S]*?\x60\x60\x60/g, " ")
  .replace(/^\\s*#{1,6}\\s+/gm, "")
  .replace(/^\\s*[-:|\\s]{3,}\\s*$/gm, " ")
  .replace(/\\|/g, " ")
  .replace(/[*\x60~]{1,3}/g, "")
  .replace(/\\[([^\\]]*)\\]\\([^)]*\\)/g, "$1")
  .replace(/\\s+/g, " ")
  .trim();
const params = () => {
  const p = new URLSearchParams();
  if ($("f-user").value.trim()) p.set("user", $("f-user").value.trim());
  if ($("f-from").value) p.set("from", $("f-from").value);
  if ($("f-to").value) p.set("to", $("f-to").value);
  if ($("f-conv").value.trim()) p.set("conversation", $("f-conv").value.trim());
  return p;
};

__GROUP_SRC__

// Chronological timeline rendering: +X.Xs offsets from the question (absolute
// Beijing time in the title tooltip), model rounds at depth 0, tool calls
// nested under the latest round that started before them, data accesses under
// their tool call (paired by call_id via _pair/_access from groupAuditEvents).
const off = (ts, base) =>
  '<span class="off" title="' + esc(bj(ts)) + '">+' +
  (Math.max(0, ts - base) / 1000).toFixed(1) + "s</span>";
const stBadge = (e) =>
  e.status ? '<span class="st ' + esc(e.status) + '">' + esc(e.status) + "</span>" : "";
const parseArgs = (e) => {
  try {
    return JSON.parse(e.args_json ?? "{}") ?? {};
  } catch {
    return {};
  }
};

function accessLine(a, base, depth) {
  let h = '<div class="tl d' + depth + '"><span class="conn">└</span>' + off(a.ts, base) +
    '<span>数据访问</span> <b>' + esc(a.tables ?? "—") + "</b> · " +
    (a.row_count != null ? esc(a.row_count) : "—") + " 行 · ";
  h += a.status && a.status !== "ok"
    ? '<span class="deny">' + esc(a.reason ?? a.status) + "</span>"
    : '<span class="st ok">ok</span>';
  if (a.sql_text) {
    h += ' <details class="sqld inl"><summary>查看 SQL</summary>' +
      '<code class="sql">' + esc(a.sql_text) + "</code></details>";
  }
  if (a.job_id) h += ' <span class="srv">job ' + esc(a.job_id) + "</span>";
  return h + "</div>";
}

function modelLine(e, idx, base) {
  const a = parseArgs(e);
  const tools = Array.isArray(a.tools) ? a.tools : [];
  let h = '<div class="tl d0">' + off(e.ts, base) +
    '<span class="tool">模型</span> <span>第' + esc(idx + 1) + "轮</span> · " +
    '<span class="srv">' + esc(e.tool ?? "—") + "</span> · " +
    (e.duration_ms != null ? (e.duration_ms / 1000).toFixed(1) + " s · " : "") +
    "输入 " + esc(a.input_tokens ?? "—") + " / 输出 " + esc(a.output_tokens ?? "—") + " tokens";
  if (tools.length) {
    h += " → 决定" + (tools.length > 1 ? "并行" : "") + "调用 " +
      '<b>' + esc(tools.join("、")) + "</b>";
  } else {
    h += " → 生成回答";
  }
  if (a.aig_log_id) {
    h += ' <button class="link" type="button" data-copy="' + esc(a.aig_log_id) +
      '" title="AI Gateway 日志 ID">复制日志 ID</button>';
  }
  if (e.reason === "dlp_blocked") h += ' <span class="dlp">DLP 拦截</span>';
  else if (e.reason && e.reason !== "stop" && e.reason !== "tool-calls") {
    h += ' <span class="deny">' + esc(e.reason) + "</span>";
  }
  h += stBadge(e);
  return h + "</div>";
}

function toolLine(e, mcp, base, conn, parallel) {
  let h = '<div class="tl d1"><span class="conn">' + conn + "</span>" + off(e.ts, base) +
    '<span>工具调用</span> <b>' + esc(auditNormTool(e)) + "</b>" +
    (e.server ? ' <span class="srv">' + esc(e.server) + "</span>" : "") +
    stBadge(e) +
    (parallel ? ' <span class="st">并行</span>' : "");
  if (e.args_json) h += ' <span class="args">' + esc(e.args_json) + "</span>";
  if (e.reason && e.reason !== "poll") h += ' <span class="deny">' + esc(e.reason) + "</span>";
  if (e.source === "agent") {
    if (mcp) {
      h += ' <span class="muted">· MCP Server 执行 ' + esc(mcp.duration_ms ?? "—") +
        " ms（端到端 " + esc(e.duration_ms ?? "—") + " ms）</span>";
    } else {
      h += ' <span class="warn">MCP Server 未返回审计记录</span>';
    }
  } else {
    h += ' <span class="srv">' + esc(e.source) + "</span>" +
      ' <span class="muted">· MCP Server 执行 ' + esc(e.duration_ms ?? "—") +
      " ms（Agent 侧无对应记录）</span>";
  }
  return h + "</div>";
}

// One agent tool_call + its nested data_access rows (and run_analysis job
// toggle). MCP rows never render at top level when paired.
function toolBlock(e, mcp, accesses, base, conn, parallel) {
  let h = toolLine(e, mcp, base, conn, parallel);
  h += accesses.map((a) => accessLine(a, base, 2)).join("");
  if (e.job_id) {
    h += '<div class="tl d2"><span class="conn"></span><span></span>' +
      '<button class="link" type="button" data-job="' + esc(e.job_id) +
      '">查看任务数据访问（' + esc(e.job_id) + "）</button></div>";
  }
  return h;
}

function mcpBlock(e, accesses, base) {
  let h = toolLine(e, e, base, "└", false);
  h += accesses.map((a) => accessLine(a, base, 2)).join("");
  return h;
}

function eventLine(e, base) {
  const st = stBadge(e);
  if (e.event === "question") {
    return '<div class="tl d0">' + off(e.ts, base) + '<span class="tool">提问</span>' +
      '<span class="q">' + esc(e.text_excerpt ?? "（未保存内容）") + "</span>" + st + "</div>";
  }
  if (e.event === "reply") {
    const text = plain(e.text_excerpt);
    const long = text.length > 120;
    return '<div class="tl d0">' + off(e.ts, base) + '<span class="tool">回答</span>' +
      '<span class="q reply-text">' + esc(text) + "</span>" + st +
      (long ? '<button class="link" type="button" data-expand>展开</button>' : "") + "</div>";
  }
  if (e.event === "dlp_block") {
    return '<div class="tl d0">' + off(e.ts, base) +
      '<span class="dlp">DLP 拦截（内容未保存）</span>' + st +
      (e.reason ? ' <span class="meta">' + esc(e.reason) + "</span>" : "") + "</div>";
  }
  if (e.event === "poll_group") {
    return '<div class="tl d0">' + off(e.ts, base) +
      '<span class="tool">进度查询（自动轮询）× ' + esc(e.count) + "</span>" +
      (e.job_id ? ' <span class="srv">job ' + esc(e.job_id) + "</span>" : "") + "</div>";
  }
  return "";
}

// One group body as a strict chronological timeline. Ordering / round
// assignment / parallel marking come from auditTimelineItems (audit-groups.ts).
function timelineRows(g, pairMap) {
  const rows = g.rows.slice().sort((a, b) => a.ts - b.ts);
  const base = (rows.find((r) => r.event === "question") ?? rows[0])?.ts ?? 0;
  let out = "";
  for (const it of auditTimelineItems(rows, pairMap)) {
    if (it.kind === "note") {
      out += '<div class="tl d1"><span class="conn">└</span><span></span>' +
        '<span class="muted">' + esc(it.text ?? "") + "</span></div>";
    } else if (it.kind === "model") {
      out += modelLine(it.row, it.idx, base);
    } else if (it.kind === "tool") {
      out += toolBlock(it.row, it.mcp, it.accesses ?? [], base, it.conn, it.parallel);
    } else if (it.kind === "mcp") {
      out += mcpBlock(it.row, it.accesses ?? [], base);
    } else if (it.kind === "access") {
      out += accessLine(it.row, base, it.depth ?? 1);
    } else {
      out += eventLine(it.row, base);
    }
  }
  return out;
}

// run_analysis job events as a mini timeline (model_call + data_access rows).
function jobMini(evs) {
  const rows = evs.slice().sort((a, b) => a.ts - b.ts);
  const base = rows[0]?.ts ?? 0;
  let out = "";
  for (const r of rows) {
    if (r.event === "model_call") {
      const a = parseArgs(r);
      out += '<div class="tl d0">' + off(r.ts, base) +
        '<span class="tool">模型</span> <span class="srv">' + esc(a.served_model ?? r.tool ?? "—") +
        "</span> · " + (r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + " s · " : "") +
        "输入 " + esc(a.input_tokens ?? "—") + " / 输出 " + esc(a.output_tokens ?? "—") +
        " tokens" + stBadge(r) +
        (r.reason ? ' <span class="deny">' + esc(r.reason) + "</span>" : "") + "</div>";
    } else if (r.event === "data_access") {
      out += accessLine(r, base, 0);
    }
  }
  return out || '<div class="sub">无任务数据访问记录</div>';
}

function renderGroup(g, pairMap) {
  const q = g.rows.find((r) => r.event === "question");
  const first = g.rows[0];
  const det = document.createElement("details");
  det.className = "group";
  if (g.id === "__unmatched__") {
    det.innerHTML = "<summary>未关联（缺少请求 ID 的事件）</summary>" +
      '<div class="rows">' + timelineRows(g, pairMap) + "</div>";
    return det;
  }
  const tss = g.rows.map((r) => r.ts);
  const base = (q ?? first)?.ts ?? 0;
  const total = (Math.max(...tss) - base) / 1000;
  const models = g.rows.filter((r) => r.event === "model_call").length;
  const tools = g.rows.filter((r) => r.event === "tool_call" && r.source === "agent").length;
  const tables = g.rows.filter((r) => r.event === "data_access").length;
  const title =
    esc(first?.user_email ?? "未知用户") +
    (first?.role ? ' <span class="meta">' + esc(first.role) + "</span>" : "") +
    ' <span class="meta">' + esc(bj(first?.ts ?? 0)) + "</span>" +
    ' <span class="meta">req ' + esc(g.id.slice(0, 8)) + "</span>" +
    (q ? ' <span class="q">' + esc(q.text_excerpt ?? "（未保存内容）") + "</span>" : "") +
    ' <span class="meta">总耗时 ' + total.toFixed(1) + " s · 模型 " + models +
    " 轮 · 工具 " + tools + " 次 · 访问 " + tables + " 张表</span>";
  det.innerHTML = "<summary>" + title + "</summary>" +
    '<div class="rows">' + timelineRows(g, pairMap) + "</div>";
  return det;
}

async function load() {
  $("err").hidden = true; $("empty").hidden = true;
  const resp = await fetch("/api/audit?" + params().toString());
  if (!resp.ok) {
    $("err").hidden = false;
    $("err").textContent = "查询失败：" + resp.status;
    return;
  }
  const data = await resp.json();
  const grouped = groupAuditEvents(data.events ?? []);
  // MCP tool_calls paired to agent rows render nested under their agent row
  const pairMap = new Map();
  for (const g of grouped.groups) {
    for (const m of g.rows) {
      if (m._pair) {
        if (!pairMap.has(m._pair)) pairMap.set(m._pair, []);
        pairMap.get(m._pair).push(m);
      }
    }
  }
  // paired mcp tool_calls must not also render as top-level rows
  for (const g of grouped.groups) {
    g.rows = g.rows.filter((r) => !(r._pair && r.event === "tool_call"));
  }
  const list = $("list");
  list.innerHTML = "";
  if (grouped.polls.length || grouped.unmatched.length) {
    grouped.groups.push({
      id: "__unmatched__",
      rows: [...grouped.polls, ...grouped.unmatched].sort((a, b) => a.ts - b.ts)
    });
  }
  if (!grouped.groups.length) { $("empty").hidden = false; return; }
  for (const g of grouped.groups) {
    try {
      list.appendChild(renderGroup(g, pairMap));
    } catch (err) {
      $("err").hidden = false;
      $("err").textContent = "部分记录渲染失败：" + String(err && err.message ? err.message : err);
    }
  }
}

$("list").addEventListener("click", async (ev) => {
  const exp = ev.target.closest("button[data-expand]");
  if (exp) {
    const t = exp.parentElement.querySelector(".reply-text");
    if (t) {
      const open = t.classList.toggle("open");
      exp.textContent = open ? "收起" : "展开";
    }
    return;
  }
  const copy = ev.target.closest("button[data-copy]");
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      copy.textContent = "已复制";
    } catch {
      copy.textContent = copy.dataset.copy;
    }
    return;
  }
  const btn = ev.target.closest("button[data-job]");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "加载中…";
  try {
    const resp = await fetch("/api/audit?job=" + encodeURIComponent(btn.dataset.job));
    const data = await resp.json();
    const box = document.createElement("div");
    box.innerHTML = jobMini(data.events ?? []);
    btn.replaceWith(box);
  } catch {
    btn.disabled = false;
    btn.textContent = "重试查看任务数据访问";
  }
});

$("f-go").addEventListener("click", load);
load();
</script>
</body>
</html>`;

export function renderAuditPage(nonce: string): string {
  return PAGE_HTML
    .replaceAll("__CSP_NONCE__", nonce)
    .replace("__GROUP_SRC__", auditGroupScriptSource());
}

const INLINE_SCRIPT =
  PAGE_HTML.match(/<script nonce="__CSP_NONCE__">([\s\S]*)<\/script>/)?.[1] ?? "";
let scriptHashPromise: Promise<string> | null = null;
export function auditPageScriptHash(): Promise<string> {
  scriptHashPromise ??= Promise.resolve(
    INLINE_SCRIPT.replace("__GROUP_SRC__", auditGroupScriptSource())
  )
    .then((src) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(src)))
    .then((digest) => btoa(String.fromCharCode(...new Uint8Array(digest))));
  return scriptHashPromise;
}
