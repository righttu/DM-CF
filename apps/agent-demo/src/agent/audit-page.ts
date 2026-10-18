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
.note{padding:10px 22px;color:var(--muted);font-size:12.5px;border-bottom:1px solid var(--line)}
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
.dlp{color:var(--deny);font-weight:600}
.args{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);
max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button.link{background:none;border:none;color:var(--accent);cursor:pointer;font:inherit;
font-size:12px;padding:0}
#empty,#err{padding:40px;text-align:center;color:var(--muted)}
</style>
</head>
<body>
<div class="top"><div class="logo">ABC</div><h1>审计视图</h1>
<a class="back" href="/">← 返回对话</a></div>
<div class="note">同一请求 ID 串联 Agent、AI Gateway、MCP Server；提问与回答全文见 AI Gateway 日志。</div>
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
const params = () => {
  const p = new URLSearchParams();
  if ($("f-user").value.trim()) p.set("user", $("f-user").value.trim());
  if ($("f-from").value) p.set("from", $("f-from").value);
  if ($("f-to").value) p.set("to", $("f-to").value);
  if ($("f-conv").value.trim()) p.set("conversation", $("f-conv").value.trim());
  return p;
};

// Group by request_id; MCP tool_calls without request_id attach to an Agent
// tool_call of the same user+tool within ±15 s, else fall into "未关联".
function groupEvents(events) {
  const byReq = new Map();
  const orphans = [];
  for (const e of events) {
    if (e.request_id) {
      if (!byReq.has(e.request_id)) byReq.set(e.request_id, []);
      byReq.get(e.request_id).push(e);
    } else orphans.push(e);
  }
  const unmatched = [];
  for (const o of orphans) {
    let best = null, bestDt = 15001;
    for (const rows of byReq.values()) {
      const g = rows.find(
        (r) => r.event === "tool_call" && r.source === "agent" &&
          r.tool === o.tool && r.user_email === o.user_email &&
          Math.abs(r.ts - o.ts) < bestDt
      );
      if (g) { best = rows; bestDt = Math.abs(g.ts - o.ts); }
    }
    if (best) best.push(o); else unmatched.push(o);
  }
  const groups = [...byReq.entries()].map(([id, rows]) => ({
    id, rows: rows.sort((a, b) => a.ts - b.ts)
  }));
  if (unmatched.length) {
    groups.push({ id: "__unmatched__", rows: unmatched.sort((a, b) => a.ts - b.ts) });
  }
  groups.sort((a, b) => Math.max(...b.rows.map((r) => r.ts)) - Math.max(...a.rows.map((r) => r.ts)));
  return groups;
}

function rowHtml(e) {
  const time = '<span class="t">' + esc(bj(e.ts)) + "</span>";
  const st = e.status ? '<span class="st ' + esc(e.status) + '">' + esc(e.status) + "</span>" : "";
  const dur = e.duration_ms != null ? '<span class="meta">' + esc(e.duration_ms) + "ms</span>" : "";
  if (e.event === "question") {
    return '<div class="row">' + time + '<span class="tool">提问</span>' +
      '<span class="q">' + esc(e.text_excerpt ?? "（未保存内容）") + "</span>" + st + "</div>";
  }
  if (e.event === "reply") {
    return '<div class="row">' + time + '<span class="tool">回答</span>' +
      '<span class="q">' + esc(e.text_excerpt ?? "") + "</span>" + st + "</div>";
  }
  if (e.event === "dlp_block") {
    return '<div class="row">' + time +
      '<span class="dlp">DLP 拦截（内容未保存）</span>' + st +
      (e.reason ? '<span class="meta">' + esc(e.reason) + "</span>" : "") + "</div>";
  }
  if (e.event === "tool_call") {
    let h = '<div class="row">' + time +
      '<span class="srv">' + esc(e.source) + "</span>" +
      '<span class="tool">' + esc(e.server ?? "") + " · " + esc(e.tool ?? "") + "</span>" + st + dur;
    if (e.args_json) h += '<span class="args">' + esc(e.args_json) + "</span>";
    if (e.reason) h += '<span class="meta" style="color:var(--deny)">' + esc(e.reason) + "</span>";
    if (e.job_id) {
      h += '<button class="link" type="button" data-job="' + esc(e.job_id) +
        '">查看任务数据访问（' + esc(e.job_id) + "）</button>";
    }
    return h + "</div>";
  }
  if (e.event === "data_access") {
    let h = '<div class="sub">' + time +
      '<span class="srv">' + esc(e.source) + "</span> " +
      '<b>' + esc(e.tables ?? "") + "</b> " + st;
    if (e.row_count != null) h += '<span class="meta">' + esc(e.row_count) + " 行</span>";
    if (e.sql_text) h += '<code class="sql">' + esc(e.sql_text) + "</code>";
    if (e.reason) h += '<div class="deny">拒绝原因：' + esc(e.reason) + "</div>";
    if (e.job_id) h += '<div class="meta">job: ' + esc(e.job_id) + "</div>";
    return h + "</div>";
  }
  return "";
}

function renderGroup(g) {
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
  det.innerHTML = "<summary>" + title + "</summary>" +
    '<div class="rows">' + g.rows.map(rowHtml).join("") + "</div>";
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
  const list = $("list");
  list.innerHTML = "";
  const groups = groupEvents(data.events ?? []);
  if (!groups.length) { $("empty").hidden = false; return; }
  for (const g of groups) list.appendChild(renderGroup(g));
}

$("list").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-job]");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "加载中…";
  try {
    const resp = await fetch("/api/audit?job=" + encodeURIComponent(btn.dataset.job));
    const data = await resp.json();
    const box = document.createElement("div");
    box.innerHTML = (data.events ?? [])
      .sort((a, b) => a.ts - b.ts)
      .map(rowHtml)
      .join("") || '<div class="sub">无任务数据访问记录</div>';
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
  return PAGE_HTML.replaceAll("__CSP_NONCE__", nonce);
}

const INLINE_SCRIPT =
  PAGE_HTML.match(/<script nonce="__CSP_NONCE__">([\s\S]*)<\/script>/)?.[1] ?? "";
let scriptHashPromise: Promise<string> | null = null;
export function auditPageScriptHash(): Promise<string> {
  scriptHashPromise ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(INLINE_SCRIPT))
    .then((digest) => btoa(String.fromCharCode(...new Uint8Array(digest))));
  return scriptHashPromise;
}
