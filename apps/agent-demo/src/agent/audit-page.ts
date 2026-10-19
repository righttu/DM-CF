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
<div class="note legend">一次提问 = 一个请求 ID；每次工具调用 = 一个调用 ID，Agent 与 MCP Server 两侧记录同一个调用 ID。端到端耗时含模型与 Portal 转发，MCP Server 耗时只含工具执行与查库。提问与回答全文见 AI Gateway 日志。</div>
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

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

function accTable(accesses) {
  if (!accesses.length) return '<div class="noacc">无数据访问</div>';
  let rows = "";
  for (const a of accesses) {
    const result =
      a.status && a.status !== "ok"
        ? '<span class="deny">' + esc(a.reason ?? a.status) + "</span>"
        : '<span class="st ok">ok</span>';
    rows += "<tr><td>" + esc(a.tables ?? "—") + "</td><td>" +
      (a.row_count != null ? esc(a.row_count) : "—") + "</td><td>" + result + "</td></tr>";
    if (a.sql_text) {
      rows += '<tr class="sqltr"><td colspan="3"><details class="sqld"><summary>查看 SQL</summary>' +
        '<code class="sql">' + esc(a.sql_text) + "</code></details></td></tr>";
    }
  }
  return '<div class="acct">数据访问</div>' +
    '<table class="acc"><thead><tr><th>表</th><th>行数</th><th>结果</th></tr></thead>' +
    "<tbody>" + rows + "</tbody></table>";
}

function accessSub(e) {
  let h = '<div class="sub">' +
    '<span class="t">' + esc(bj(e.ts)) + "</span>" +
    '<span class="srv">' + esc(e.source) + "</span> " +
    '<b>' + esc(e.tables ?? "") + "</b> " +
    (e.status ? '<span class="st ' + esc(e.status) + '">' + esc(e.status) + "</span>" : "");
  if (e.row_count != null) h += '<span class="meta">' + esc(e.row_count) + " 行</span>";
  if (e.sql_text) h += '<code class="sql">' + esc(e.sql_text) + "</code>";
  if (e.reason) h += '<div class="deny">拒绝原因：' + esc(e.reason) + "</div>";
  if (e.job_id) h += '<div class="meta">job: ' + esc(e.job_id) + "</div>";
  return h + "</div>";
}

// One card per Agent tool_call: the MCP row with the same call_id supplies
// the server-side duration and its data_access rows; they never render as
// top-level lines.
function agentCard(e, mcpRows, idx) {
  const tool = auditNormTool(e);
  const mcp = mcpRows?.[0];
  const st = e.status ? '<span class="st ' + esc(e.status) + '">' + esc(e.status) + "</span>" : "";
  let h = '<div class="card"><div class="l1">' +
    '<span class="step">' + (CIRCLED[idx] ?? String(idx + 1) + ".") + "</span>" +
    '<span>调用工具</span>' +
    '<span class="tool">' + esc(tool) + "</span>" +
    '<span class="srv">' + esc(e.server ?? "") + "</span>" + st;
  if (e.args_json) h += '<span class="args">' + esc(e.args_json) + "</span>";
  if (e.reason && e.reason !== "poll") h += '<span class="deny">' + esc(e.reason) + "</span>";
  h += "</div>";
  if (mcp) {
    h += '<div class="l2">Agent 发起 → MCP Portal → MCP Server 执行 ' +
      esc(mcp.duration_ms ?? "—") + " ms（端到端 " + esc(e.duration_ms ?? "—") + " ms）</div>";
  } else {
    h += '<div class="l2"><span class="warn">MCP Server 未返回审计记录</span>' +
      (e.duration_ms != null ? "（端到端 " + esc(e.duration_ms) + " ms）" : "") + "</div>";
  }
  const accesses = [
    ...(mcpRows ?? []).flatMap((m) => m._access ?? []),
    ...(e._access ?? [])
  ];
  h += accTable(accesses);
  if (e.job_id) {
    h += '<button class="link" type="button" data-job="' + esc(e.job_id) +
      '">查看任务数据访问（' + esc(e.job_id) + "）</button>";
  }
  return h + "</div>";
}

// Unmatched MCP-side rows render in the same card layout, minus the Agent
// part (no matching Agent call exists for them).
function mcpCard(e) {
  const tool = auditNormTool(e);
  const st = e.status ? '<span class="st ' + esc(e.status) + '">' + esc(e.status) + "</span>" : "";
  let h = '<div class="card"><div class="l1">' +
    '<span>调用工具</span>' +
    '<span class="tool">' + esc(tool) + "</span>" +
    '<span class="srv">' + esc(e.server ?? "") + "</span>" + st +
    '<span class="srv">' + esc(e.source) + "</span>";
  if (e.args_json) h += '<span class="args">' + esc(e.args_json) + "</span>";
  if (e.reason) h += '<span class="deny">' + esc(e.reason) + "</span>";
  h += "</div>";
  h += '<div class="l2">MCP Server 执行 ' + esc(e.duration_ms ?? "—") +
    " ms（Agent 侧无对应记录）</div>";
  h += accTable(e._access ?? []);
  return h + "</div>";
}

function rowHtml(e, pairMap, ctx) {
  const time = '<span class="t">' + esc(bj(e.ts)) + "</span>";
  const st = e.status ? '<span class="st ' + esc(e.status) + '">' + esc(e.status) + "</span>" : "";
  if (e.event === "question") {
    return '<div class="row">' + time + '<span class="tool">提问</span>' +
      '<span class="q">' + esc(e.text_excerpt ?? "（未保存内容）") + "</span>" + st + "</div>";
  }
  if (e.event === "reply") {
    const text = plain(e.text_excerpt);
    const long = text.length > 120;
    return '<div class="row">' + time + '<span class="tool">回答</span>' +
      '<span class="q reply-text">' + esc(text) + "</span>" + st +
      (long ? '<button class="link" type="button" data-expand>展开</button>' : "") + "</div>";
  }
  if (e.event === "dlp_block") {
    return '<div class="row">' + time +
      '<span class="dlp">DLP 拦截（内容未保存）</span>' + st +
      (e.reason ? '<span class="meta">' + esc(e.reason) + "</span>" : "") + "</div>";
  }
  if (e.event === "poll_group") {
    return '<div class="row">' + time +
      '<span class="tool">进度查询（自动轮询）× ' + esc(e.count) + "</span>" +
      (e.job_id ? '<span class="srv">job ' + esc(e.job_id) + "</span>" : "") + "</div>";
  }
  if (e.event === "tool_call") {
    if (e.source === "agent") {
      return agentCard(e, pairMap?.get(e.id), ctx.step++);
    }
    // mcp tool_call without a matching agent call (未关联 or foreign rows)
    return mcpCard(e);
  }
  if (e.event === "data_access") {
    if (e._nested || e._pair) return "";
    return accessSub(e);
  }
  return "";
}

function renderGroup(g, pairMap) {
  const q = g.rows.find((r) => r.event === "question");
  const first = g.rows[0];
  const title = g.id === "__unmatched__"
    ? "未关联（缺少请求 ID 的事件）"
    : esc(first?.user_email ?? "未知用户") +
      (first?.role ? ' <span class="meta">' + esc(first.role) + "</span>" : "") +
      ' <span class="meta">' + esc(bj(first?.ts ?? 0)) + "</span>" +
      ' <span class="meta">req ' + esc(g.id.slice(0, 8)) + "</span>" +
      (q ? ' <span class="q">' + esc(q.text_excerpt ?? "（未保存内容）") + "</span>" : "");
  const det = document.createElement("details");
  det.className = "group";
  const ctx = { step: 0 };
  det.innerHTML = "<summary>" + title + "</summary>" +
    '<div class="rows">' + g.rows.map((r) => rowHtml(r, pairMap, ctx)).join("") + "</div>";
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
  for (const g of grouped.groups) list.appendChild(renderGroup(g, pairMap));
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
  const btn = ev.target.closest("button[data-job]");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "加载中…";
  try {
    const resp = await fetch("/api/audit?job=" + encodeURIComponent(btn.dataset.job));
    const data = await resp.json();
    const box = document.createElement("div");
    const evs = (data.events ?? []).sort((a, b) => a.ts - b.ts);
    box.innerHTML = evs.length
      ? accTable(evs)
      : '<div class="sub">无任务数据访问记录</div>';
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
