const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ABC 投研 Agent</title>
<style>
:root{
  color-scheme:light;
  --brand:#1d4ed8;--brand-strong:#1e40af;--brand-soft:#eff4ff;
  --bg:#f4f6fb;--panel:#ffffff;--panel-2:#f8fafc;
  --line:#e2e8f0;--line-strong:#cbd5e1;
  --text:#0f172a;--muted:#64748b;--faint:#94a3b8;
  --ok:#15803d;--ok-soft:#dcfce7;--warn:#b45309;--warn-soft:#fef3c7;--err:#b91c1c;
  --user-bg:#1d4ed8;--user-text:#ffffff;
  --shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px -12px rgba(15,23,42,.15);
  --radius:12px;
}
[data-theme="dark"]{
  color-scheme:dark;
  --brand:#3b82f6;--brand-strong:#60a5fa;--brand-soft:#16233f;
  --bg:#0b1220;--panel:#121a2c;--panel-2:#0f1729;
  --line:#24304d;--line-strong:#33415f;
  --text:#e2e8f0;--muted:#94a3b8;--faint:#64748b;
  --ok:#4ade80;--ok-soft:#14301f;--warn:#fbbf24;--warn-soft:#3a2f14;--err:#f87171;
  --user-bg:#1d4ed8;--user-text:#ffffff;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px -12px rgba(0,0,0,.5);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  background:var(--bg);color:var(--text);display:flex;overflow:hidden;font-size:14px}
button{font-family:inherit;font-size:13px;cursor:pointer;border:none;border-radius:10px;
  padding:8px 14px;background:var(--brand);color:#fff;transition:background .15s,box-shadow .15s}
button:hover:not(:disabled){background:var(--brand-strong)}
button:disabled{opacity:.5;cursor:not-allowed}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--line-strong)}
button.ghost:hover:not(:disabled){background:var(--panel-2);color:var(--text)}
button.icon{background:transparent;border:none;color:var(--muted);padding:6px;border-radius:8px;
  display:inline-flex;align-items:center;justify-content:center}
button.icon:hover:not(:disabled){background:var(--panel-2);color:var(--text)}
a{color:var(--brand)}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
[hidden]{display:none!important}

/* sidebar */
aside{width:264px;min-width:264px;background:var(--panel);border-right:1px solid var(--line);
  display:flex;flex-direction:column;z-index:30}
.brand{display:flex;align-items:center;gap:10px;padding:18px 18px 14px}
.brand .logo{width:36px;height:36px;min-width:36px;border-radius:50%;background:#1d4ed8;color:#fff;
  font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
.brand h1{font-size:15px;margin:0;font-weight:600}
#new-session{margin:0 18px 12px;padding:10px;font-weight:600}
#session-scroll{flex:1;overflow-y:auto;padding:0 10px;min-height:0}
.session-item{display:flex;align-items:center;gap:4px;border-radius:10px;padding:8px 10px;
  cursor:pointer;color:var(--muted)}
.session-item:hover{background:var(--panel-2)}
.session-item.current{background:var(--brand-soft);color:var(--text)}
.session-item .s-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.session-item .s-time{font-size:11px;color:var(--faint);flex-shrink:0}
.session-item .s-del{opacity:0;padding:4px;flex-shrink:0}
.session-item:hover .s-del,.session-item .s-del:focus-visible{opacity:1}
.user-card{border-top:1px solid var(--line);padding:12px 16px;display:flex;align-items:center;gap:10px}
.user-card .avatar{width:32px;height:32px;min-width:32px;border-radius:50%;background:var(--brand-soft);
  color:var(--brand);font-weight:600;font-size:12px;display:flex;align-items:center;justify-content:center}
.user-card .u-meta{flex:1;min-width:0}
.user-card .u-email{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.role-badge{display:inline-block;font-size:10.5px;padding:1px 7px;border-radius:999px;margin-top:2px;
  background:var(--brand-soft);color:var(--brand)}
.role-badge.viewer{background:var(--warn-soft);color:var(--warn)}
.user-menu{position:relative}
.user-menu button.icon{opacity:1}
#user-menu-pop{position:absolute;bottom:44px;left:0;background:var(--panel);border:1px solid var(--line);
  border-radius:10px;box-shadow:var(--shadow);min-width:160px;padding:6px;z-index:60}
#user-menu-pop button{display:block;width:100%;text-align:left;background:transparent;color:var(--text);
  padding:8px 10px;border-radius:8px}
#user-menu-pop button:hover{background:var(--panel-2)}
#user-menu-pop .menu-danger{color:var(--err)}

/* main */
main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
#topbar{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--line);
  background:var(--panel)}
#menu-btn{display:none}
#session-title{flex:1;min-width:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mcp-pill{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;padding:5px 12px;border-radius:999px;
  border:1px solid var(--line);background:var(--panel-2);color:var(--muted);white-space:nowrap;cursor:default}
#mcp-pill .dot{width:8px;height:8px;border-radius:50%;background:var(--warn)}
#mcp-pill.ok{color:var(--ok)}
#mcp-pill.ok .dot{background:var(--ok)}
#mcp-pill button{border:none;background:none;color:var(--brand);font-size:12.5px;padding:0 0 0 4px}
#chat-wrap{flex:1;overflow-y:auto;min-height:0}
#chat{max-width:820px;margin:0 auto;padding:24px 24px 8px;display:flex;flex-direction:column;gap:18px}

/* welcome */
#welcome{text-align:center;padding:60px 20px 20px}
#welcome h2{font-size:24px;margin:0 0 8px;font-weight:600}
#welcome .sub{color:var(--muted);margin:0 0 32px}
.sugg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;max-width:640px;margin:0 auto;text-align:left}
.sugg{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;
  font-size:13.5px;color:var(--text);box-shadow:var(--shadow);text-align:left}
.sugg:hover:not(:disabled){border-color:var(--brand);background:var(--panel)}
.sugg-title{font-weight:600;margin-bottom:4px;color:var(--brand)}
.sugg-msg{font-size:12.5px;color:var(--muted);line-height:1.5}

/* messages */
.msg{display:flex;gap:12px;max-width:100%}
.msg .m-avatar{width:30px;height:30px;min-width:30px;border-radius:50%;background:#1d4ed8;color:#fff;
  font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:2px}
.msg.user{justify-content:flex-end}
.msg.user .bubble{background:var(--user-bg);color:var(--user-text);border-radius:var(--radius);
  padding:10px 14px;max-width:78%;white-space:pre-wrap;word-break:break-word;line-height:1.6}
.msg.agent .m-body{flex:1;min-width:0}
.md{line-height:1.7;font-size:14px;word-break:break-word;overflow-wrap:anywhere}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md h1,.md h2,.md h3,.md h4{margin:16px 0 8px;font-weight:600;line-height:1.35}
.md h1{font-size:19px}.md h2{font-size:17px}.md h3{font-size:15.5px}.md h4{font-size:14px}
.md p{margin:8px 0}
.md code{background:var(--panel-2);border:1px solid var(--line);border-radius:5px;
  padding:1px 5px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.md pre{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius);
  padding:12px 14px;overflow-x:auto;margin:10px 0}
.md pre code{background:none;border:none;padding:0;font-size:12.5px}
.md ul,.md ol{margin:8px 0;padding-left:22px}
.md li{margin:3px 0}
.md blockquote{margin:10px 0;padding:6px 14px;border-left:3px solid var(--line-strong);
  color:var(--muted);background:var(--panel-2);border-radius:0 8px 8px 0}
.md hr{border:none;border-top:1px solid var(--line);margin:14px 0}
.md table{border-collapse:collapse;margin:10px 0;font-size:13px;display:block;overflow-x:auto;max-width:100%}
.md th,.md td{border:1px solid var(--line);padding:6px 12px;text-align:left}
.md th{background:var(--panel-2);font-weight:600}
.msg-note{font-size:12px;color:var(--err);margin-top:8px}
.msg-sys{align-self:center;font-size:12px;color:var(--warn);background:var(--warn-soft);
  border-radius:8px;padding:5px 12px}

/* process chip */
details.proc{border:1px solid var(--line);border-radius:10px;background:var(--panel-2);
  margin-bottom:8px;font-size:12.5px;overflow:hidden}
details.proc>summary{cursor:pointer;list-style:none;padding:7px 12px;color:var(--muted);
  display:flex;align-items:center;gap:8px;user-select:none}
details.proc>summary::-webkit-details-marker{display:none}
details.proc>summary::before{content:"▸";color:var(--faint);transition:transform .15s}
details.proc[open]>summary::before{transform:rotate(90deg)}
details.proc .proc-body{border-top:1px solid var(--line);padding:6px 12px 10px}
.proc-row{display:flex;align-items:center;gap:8px;padding:4px 0;color:var(--muted)}
.proc-row .p-status{width:14px;text-align:center;flex-shrink:0}
.proc-row .p-status.ok{color:var(--ok)}
.proc-row .p-status.err{color:var(--err)}
.proc-row .p-status.run{color:var(--warn)}
.proc-row .p-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.proc-row .p-time{color:var(--faint);font-size:11.5px}
.msg-actions{display:flex;align-items:center;gap:6px;margin-top:6px;color:var(--faint);font-size:11.5px}
.msg-actions button.icon{font-size:14px}

/* composer */
#composer-area{border-top:1px solid var(--line);background:var(--panel);padding:12px 20px 6px}
#composer{max-width:820px;margin:0 auto;display:flex;gap:10px;align-items:flex-end}
#input{flex:1;min-width:0;resize:none;border:1px solid var(--line-strong);border-radius:var(--radius);
  padding:11px 14px;font-family:inherit;font-size:14px;line-height:1.5;background:var(--panel-2);
  color:var(--text);max-height:200px;height:46px;overflow-y:auto}
#input:focus{border-color:var(--brand);outline:none;box-shadow:0 0 0 3px rgba(29,78,216,.15)}
#input::placeholder{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#send{height:46px;min-width:72px;font-weight:600}
#send.stop{background:var(--err)}
#composer-hint{max-width:820px;margin:6px auto 0;font-size:12px;color:var(--faint);min-height:16px}
#foot{max-width:820px;margin:0 auto;padding:4px 0 10px;font-size:11.5px;color:var(--faint)}

/* drawer */
#backdrop{position:fixed;inset:0;background:rgba(15,23,42,.4);z-index:40;opacity:0;pointer-events:none;transition:opacity .2s}
#backdrop.show{opacity:1;pointer-events:auto}
#drawer{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:100vw;background:var(--panel);
  border-left:1px solid var(--line);box-shadow:var(--shadow);z-index:50;display:flex;flex-direction:column;
  transform:translateX(105%);transition:transform .25s}
#drawer.open{transform:none}
.drawer-head{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid var(--line)}
.drawer-head h2{font-size:15px;margin:0;flex:1}
.drawer-body{flex:1;overflow-y:auto;padding:14px 18px;display:flex;flex-direction:column;gap:14px}
.d-card{border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;background:var(--panel-2)}
.d-card h3{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin:0 0 8px;font-weight:600}
.status-line{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:3px 0;color:var(--muted)}
.status-line>span:first-child{min-width:0;flex-shrink:0}
.status-line>span:last-child{min-width:0;overflow-wrap:anywhere;text-align:right;color:var(--text)}
.status-line .ok{color:var(--ok)}
.status-line .pending{color:var(--warn)}
.status-line .err{color:var(--err)}
.d-card button{width:100%;margin-top:8px}
.d-card button.ghost{margin-top:6px}
.small{font-size:12px;color:var(--faint);line-height:1.5}
.tool-tag{display:inline-block;font-size:11px;background:var(--panel);border:1px solid var(--line);
  border-radius:6px;padding:2px 8px;margin:2px 3px 2px 0;color:var(--muted);font-family:ui-monospace,Menlo,monospace}
.server-block{margin-bottom:10px}
.server-block .sv-head{font-size:12.5px;font-weight:600;margin-bottom:4px}
#portal-pending{border:1px solid var(--warn);border-radius:10px;padding:10px 12px;margin-top:8px;background:var(--warn-soft)}
#portal-pending .row{display:flex;gap:8px;margin-top:8px}
#portal-pending .row button,#portal-pending .row a{flex:1}
#dlp-result{font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--muted);margin-top:8px}

@media (max-width:1023px){
  .session-item .s-del{opacity:1}
}
@media (max-width:767px){
  #menu-btn{display:inline-flex}
  aside{position:fixed;top:0;left:0;bottom:0;transform:translateX(-105%);transition:transform .25s;box-shadow:var(--shadow)}
  aside.open{transform:none}
  #drawer{width:100vw}
  #topbar{padding:10px 14px}
  #chat{padding:16px 14px 4px}
  #composer-area{padding:10px 12px 4px}
  .msg.user .bubble{max-width:88%}
}
</style>
</head>
<body>
<aside id="sidebar">
  <div class="brand"><div class="logo">ABC</div><h1>ABC 投研 Agent</h1></div>
  <button id="new-session" type="button">＋ 新建会话</button>
  <div id="session-scroll"><div id="session-list"></div></div>
  <div class="user-card">
    <div class="avatar" id="u-avatar">·</div>
    <div class="u-meta"><div class="u-email" id="u-email">—</div><span class="role-badge" id="u-role">—</span></div>
    <div class="user-menu">
      <button class="icon" id="user-menu-btn" aria-label="用户菜单" aria-haspopup="true">⋮</button>
      <div id="user-menu-pop" hidden>
        <button id="menu-diag" type="button">连接与诊断</button>
        <button id="menu-logout" class="menu-danger" type="button">退出登录</button>
      </div>
    </div>
  </div>
</aside>
<div id="backdrop"></div>
<main>
  <div id="topbar">
    <button class="icon" id="menu-btn" aria-label="打开会话列表">☰</button>
    <div id="session-title">新会话</div>
    <span id="mcp-pill"><span class="dot"></span><span id="mcp-pill-text">未连接</span></span>
    <button class="icon" id="theme-btn" aria-label="切换主题">◐</button>
  </div>
  <div id="chat-wrap"><div id="chat"></div></div>
  <div id="composer-area">
    <div id="composer">
      <textarea id="input" placeholder="向 ABC 投研 Agent 提问，例如某只股票的基本面、研报观点或策略信号……" maxlength="4000" rows="1" disabled></textarea>
      <button id="send" disabled>发送</button>
    </div>
    <div id="composer-hint"></div>
    <div id="foot">数据仅供研究参考，不构成投资建议。</div>
  </div>
</main>
<div id="drawer" role="dialog" aria-label="连接与诊断">
  <div class="drawer-head"><h2>连接与诊断</h2><button class="icon" id="drawer-close" aria-label="关闭">✕</button></div>
  <div class="drawer-body">
    <div class="d-card">
      <h3>身份</h3>
      <div class="status-line"><span>邮箱</span><span id="email">—</span></div>
      <div class="status-line"><span>角色</span><span id="role">—</span></div>
      <div class="status-line"><span>审计身份 ID</span><span id="actor">—</span></div>
      <div class="status-line"><span>会话 ID</span><span id="conversation-id">—</span></div>
      <div class="status-line"><span>请求 ID</span><span id="request-id">—</span></div>
      <p class="small" id="identity-note"></p>
    </div>
    <div class="d-card">
      <h3>MCP 连接</h3>
      <div class="status-line"><span>状态</span><span id="mcp-state" class="pending">未连接</span></div>
      <div class="status-line"><span>模型网关</span><span id="model-state" class="pending">未确认</span></div>
      <div class="status-line"><span>模型</span><span id="model-id">—</span></div>
      <button id="connect-btn" disabled>连接 MCP（OAuth 授权）</button>
      <button class="ghost" id="disconnect-btn" disabled>断开 MCP 连接</button>
      <p class="small" id="connect-hint"></p>
    </div>
    <div class="d-card">
      <h3>服务器与工具</h3>
      <div id="servers-box"><p class="small">未连接</p></div>
    </div>
    <div class="d-card">
      <h3>Portal 服务器</h3>
      <button class="ghost" id="portal-list-btn" disabled>从 Portal 读取列表</button>
      <button class="ghost" id="portal-manage-btn" disabled>管理/重新授权 MCP</button>
      <button class="ghost" id="portal-refresh-btn" disabled>重新读取工具目录</button>
      <div id="portal-pending" hidden>
        <p class="small" id="portal-pending-msg" style="margin:0"></p>
        <div class="row">
          <a id="portal-accept" class="small" target="_blank" rel="noopener noreferrer">同意并打开授权页</a>
          <button class="ghost" id="portal-decline">拒绝</button>
          <button class="ghost" id="portal-cancel">取消</button>
        </div>
      </div>
      <a id="portal-url" class="small" target="_blank" rel="noopener noreferrer" hidden>打开 Portal 原生管理页</a>
      <div id="portal-roster" style="margin-top:6px"></div>
      <p class="small" id="portal-hint"></p>
    </div>
    <div class="d-card">
      <h3>DLP 测试</h3>
      <div class="status-line"><span>状态</span><span id="dlp-state" class="pending">未验证</span></div>
      <button class="ghost" id="dlp-btn" disabled>发送合成 DLP 标记</button>
      <p class="small">一次真实模型调用（已配置后可用）。仅证明云端网关行为。</p>
      <div id="dlp-result"></div>
    </div>
    <p class="small" id="drawer-note"></p>
  </div>
</div>
<script id="bootstrap" type="application/json" nonce="__CSP_NONCE__">__BOOTSTRAP__</script>
<script nonce="__CSP_NONCE__">
'use strict';
const boot = JSON.parse(document.getElementById('bootstrap').textContent);
const $ = (id) => document.getElementById(id);
const chat = $('chat'), chatWrap = $('chat-wrap'), input = $('input'), sendBtn = $('send');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 7 * 86400000) return Math.floor(d / 86400000) + ' 天前';
  return new Date(ts).toLocaleDateString();
}

/* ---------- safe markdown renderer (DOM nodes only, no HTML parsing) ---------- */
const INLINE_TOKEN = /(\\*\\*|__|\\*|_|\\x60|\\[)/;
function parseInline(text, parent) {
  let rest = text;
  while (rest.length > 0) {
    const m = INLINE_TOKEN.exec(rest);
    if (!m) { parent.appendChild(document.createTextNode(rest)); return; }
    const idx = m.index, tok = m[1];
    if (idx > 0) parent.appendChild(document.createTextNode(rest.slice(0, idx)));
    if (tok === '\`') {
      const end = rest.indexOf('\`', idx + 1);
      if (end > idx) {
        parent.appendChild(el('code', '', rest.slice(idx + 1, end)));
        rest = rest.slice(end + 1);
      } else { parent.appendChild(document.createTextNode('\`')); rest = rest.slice(idx + 1); }
    } else if (tok === '**' || tok === '__') {
      const end = rest.indexOf(tok, idx + 2);
      if (end > idx + 2) {
        const b = el('strong');
        parseInline(rest.slice(idx + 2, end), b);
        parent.appendChild(b); rest = rest.slice(end + 2);
      } else { parent.appendChild(document.createTextNode(tok)); rest = rest.slice(idx + 2); }
    } else if (tok === '*' || tok === '_') {
      const end = rest.indexOf(tok, idx + 1);
      if (end > idx + 1) {
        const e = el('em'); parseInline(rest.slice(idx + 1, end), e);
        parent.appendChild(e); rest = rest.slice(end + 1);
      } else { parent.appendChild(document.createTextNode(tok)); rest = rest.slice(idx + 1); }
    } else if (tok === '[') {
      const close = rest.indexOf('](', idx);
      const closeParen = close > 0 ? rest.indexOf(')', close + 2) : -1;
      if (close > idx && closeParen > close + 2) {
        const label = rest.slice(idx + 1, close);
        const href = rest.slice(close + 2, closeParen).trim();
        if (/^https?:\\/\\//i.test(href)) {
          const a = el('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
          parseInline(label, a); parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(label));
        }
        rest = rest.slice(closeParen + 1);
      } else { parent.appendChild(document.createTextNode('[')); rest = rest.slice(idx + 1); }
    }
  }
}

function tableAligns(sep) {
  const cells = sep.split('|').map((c) => c.trim()).filter((c) => c !== '');
  const aligns = [];
  for (const c of cells) {
    if (!/^:?-{3,}:?$/.test(c)) return null;
    aligns.push(c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left');
  }
  return aligns.length ? aligns : null;
}
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}
function renderMarkdown(src, container) {
  container.replaceChildren();
  const lines = String(src).replace(/\\r\\n?/g, '\\n').split('\\n');
  const root = el('div', 'md');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    const fence = /^\`\`\`/.test(trimmed);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\`\`\`/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      root.appendChild(el('pre')).appendChild(el('code', '', buf.join('\\n')));
      continue;
    }
    const h = /^(#{1,4})\\s+(.+)$/.exec(trimmed);
    if (h) {
      const node = el('h' + h[1].length);
      parseInline(h[2], node);
      root.appendChild(node); i++; continue;
    }
    if (/^(-{3,}|\\*{3,}|_{3,})$/.test(trimmed)) { root.appendChild(el('hr')); i++; continue; }
    if (trimmed.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().slice(1).replace(/^\\s?/, '')); i++;
      }
      const bq = el('blockquote'); parseInline(buf.join('\\n'), bq);
      root.appendChild(bq); continue;
    }
    if (trimmed.includes('|') && i + 1 < lines.length) {
      const aligns = tableAligns(lines[i + 1]);
      if (aligns && splitRow(line).length === aligns.length) {
        const table = el('table');
        const thead = el('thead'); const hr2 = el('tr');
        splitRow(line).forEach((c, k) => {
          const th = el('th'); th.style.textAlign = aligns[k]; parseInline(c, th); hr2.appendChild(th);
        });
        thead.appendChild(hr2); table.appendChild(thead);
        const tbody = el('tbody');
        i += 2;
        while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim()) {
          const cells = splitRow(lines[i]);
          const tr = el('tr');
          cells.forEach((c, k) => {
            const td = el('td'); if (aligns[k]) td.style.textAlign = aligns[k];
            parseInline(c, td); tr.appendChild(td);
          });
          tbody.appendChild(tr); i++;
        }
        table.appendChild(tbody); root.appendChild(table); continue;
      }
    }
    const ulM = /^[-*+]\\s+(.+)$/.exec(trimmed);
    const olM = /^\\d+[.)]\\s+(.+)$/.exec(trimmed);
    if (ulM || olM) {
      const list = el(ulM ? 'ul' : 'ol');
      const re = ulM ? /^[-*+]\\s+(.+)$/ : /^\\d+[.)]\\s+(.+)$/;
      while (i < lines.length) {
        const t = lines[i].trim();
        const mm = re.exec(t);
        if (mm) {
          const li = el('li'); parseInline(mm[1], li); list.appendChild(li); i++;
        } else if ((ulM ? /^\\s{2,}[-*+]\\s+(.+)$/ : /^\\s{2,}\\d+[.)]\\s+(.+)$/).test(lines[i])) {
          const li = el('li');
          parseInline((/^\\s{2,}(?:[-*+]|\\d+[.)])\\s+(.+)$/).exec(lines[i])[1], li);
          list.appendChild(li); i++;
        } else break;
      }
      root.appendChild(list); continue;
    }
    const buf = [trimmed];
    i++;
    while (i < lines.length && lines[i].trim() &&
      !/^(#{1,4}\\s|\`|>|[-*+]\\s|\\d+[.)]\\s|(-{3,}|\\*{3,}|_{3,})$)/.test(lines[i].trim()) &&
      !(lines[i].trim().includes('|') && i + 1 < lines.length && tableAligns(lines[i + 1]))) {
      buf.push(lines[i].trim()); i++;
    }
    const p = el('p'); parseInline(buf.join(' '), p); root.appendChild(p);
  }
  container.appendChild(root);
}

/* ---------- state ---------- */
let currentActorId = boot.user.actorId;
let currentRole = boot.user.role;
let currentEmail = boot.user.email;
let currentConversationId = boot.conversationId;
let sending = false, portalBusy = false, connectBusy = false, dlpBusy = false;
let pendingPortalId = null, pollTimer = null, identityEpoch = 0, abortCtrl = null;
let readyForChat = false;
let toolCount = 0;

/* ---------- theme ---------- */
const themeBtn = $('theme-btn');
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('abc-theme', t); } catch {}
}
let savedTheme = 'light';
try { savedTheme = localStorage.getItem('abc-theme') || 'light'; } catch {}
applyTheme(savedTheme);
themeBtn.addEventListener('click', () => {
  savedTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(savedTheme);
});

/* ---------- sidebar / drawer ---------- */
const sidebar = $('sidebar'), backdrop = $('backdrop'), drawer = $('drawer');
function openSidebar(o) {
  sidebar.classList.toggle('open', o);
  backdrop.classList.toggle('show', o || drawer.classList.contains('open'));
}
function openDrawer(o) {
  drawer.classList.toggle('open', o);
  backdrop.classList.toggle('show', o || sidebar.classList.contains('open'));
}
$('menu-btn').addEventListener('click', () => openSidebar(!sidebar.classList.contains('open')));
$('drawer-close').addEventListener('click', () => openDrawer(false));
$('menu-diag').addEventListener('click', () => { $('user-menu-pop').hidden = true; openDrawer(true); });
backdrop.addEventListener('click', () => { openSidebar(false); openDrawer(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { openSidebar(false); openDrawer(false); $('user-menu-pop').hidden = true; }
});
$('user-menu-btn').addEventListener('click', () => { $('user-menu-pop').hidden = !$('user-menu-pop').hidden; });
document.addEventListener('click', (e) => {
  if (!$('user-menu-pop').hidden && !e.target.closest('.user-menu')) $('user-menu-pop').hidden = true;
});
$('menu-logout').addEventListener('click', () => {
  $('user-menu-pop').hidden = true;
  if (!boot.setup.accessLogoutUrl) return;
  if (confirm('此操作会退出本 Zero Trust 组织的所有 Access 应用会话，不仅是 Agent；不会删除聊天历史，也不保证撤销 MCP OAuth 授权。确认退出？')) {
    window.location.assign(boot.setup.accessLogoutUrl);
  }
});
if (!boot.setup.accessLogoutUrl) {
  $('menu-logout').textContent = '退出登录（未接入 Access）';
}

/* ---------- messages ---------- */
function scrollChat() { chatWrap.scrollTop = chatWrap.scrollHeight; }
function addSystem(text) { chat.appendChild(el('div', 'msg-sys', text)); scrollChat(); }
function addUser(text) {
  const m = el('div', 'msg user'); m.appendChild(el('div', 'bubble', text));
  chat.appendChild(m); scrollChat();
}
function makeProcChip() {
  const det = el('details', 'proc');
  const sum = document.createElement('summary');
  sum.textContent = '执行过程';
  const body = el('div', 'proc-body');
  det.append(sum, body);
  return { det, sum, body, tools: new Map(), started: Date.now() };
}
function procUpdate(chip, evt) {
  const key = evt.tool || evt.text;
  let row = chip.tools.get(key);
  if (!row) {
    row = { node: el('div', 'proc-row'), status: el('span', 'p-status run', '◌'), name: el('span', 'p-name'), time: el('span', 'p-time') };
    row.node.append(row.status, row.name, row.time);
    chip.body.appendChild(row.node);
    chip.tools.set(key, row);
  }
  const label = evt.server ? (serverLabels[evt.server] || evt.server) : 'MCP';
  const disp = evt.tool && evt.server && evt.tool.startsWith(evt.server + '_') ? evt.tool.slice(evt.server.length + 1) : evt.tool;
  row.name.textContent = evt.tool ? label + ' · ' + disp : evt.text;
  if (evt.status === 'running' || (!evt.status && evt.kind === '')) {
    row.status.className = 'p-status run'; row.status.textContent = '◌';
  } else if (evt.kind === 'ok' || evt.status === 'ok') {
    row.status.className = 'p-status ok'; row.status.textContent = '✓';
  } else {
    row.status.className = 'p-status err'; row.status.textContent = '✕';
  }
  if (typeof evt.durationMs === 'number') row.time.textContent = (evt.durationMs / 1000).toFixed(1) + ' s';
  const rows = [...chip.tools.values()];
  const toolRows = rows.filter((r) => r.name.textContent.includes(' · '));
  const secs = ((Date.now() - chip.started) / 1000).toFixed(1);
  const doneTools = toolRows.filter((r) => !r.status.className.includes('run')).length;
  chip.sum.textContent = toolRows.length > 0
    ? (doneTools >= toolRows.length ? '调用了 ' + toolRows.length + ' 个工具 · ' + secs + ' s' : '正在调用工具（' + doneTools + '/' + toolRows.length + '）…')
    : '执行过程';
}
let serverLabels = {};
function procFinish(chip) {
  const toolRows = [...chip.tools.values()].filter((r) => r.name.textContent.includes(' · '));
  chip.sum.textContent = toolRows.length
    ? '调用了 ' + toolRows.length + ' 个工具 · ' + ((Date.now() - chip.started) / 1000).toFixed(1) + ' s'
    : '执行过程';
}

function addAgentShell() {
  const m = el('div', 'msg agent');
  m.appendChild(el('div', 'm-avatar', 'ABC'));
  const body = el('div', 'm-body');
  const chip = makeProcChip();
  chip.det.style.display = 'none';
  const md = el('div', 'md-target');
  const actions = el('div', 'msg-actions');
  const copyBtn = el('button', 'icon', '⧉');
  copyBtn.setAttribute('aria-label', '复制回答');
  copyBtn.title = '复制';
  const time = el('span', '', '');
  actions.append(copyBtn, time);
  body.append(chip.det, md, actions);
  actions.style.display = 'none';
  m.appendChild(body);
  chat.appendChild(m); scrollChat();
  return { m, chip, md, actions, copyBtn, time, raw: '' };
}
function finishAgent(sh) {
  sh.chip.det.style.display = sh.chip.tools.size ? '' : 'none';
  sh.actions.style.display = '';
  sh.time.textContent = new Date().toLocaleTimeString();
  sh.copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(sh.raw); sh.copyBtn.textContent = '✓'; setTimeout(() => { sh.copyBtn.textContent = '⧉'; }, 1200); } catch {}
  });
}

function renderWelcome() {
  if (chat.children.length) return;
  const w = el('div', '', '');
  w.id = 'welcome';
  const local = (currentEmail || boot.user.email || '').split('@')[0] || '用户';
  w.appendChild(el('h2', '', '你好，' + local));
  w.appendChild(el('p', 'sub', currentRole === 'viewer'
    ? '当前身份可以查询演示数据库中的模拟公司报告。'
    : '我可以查询行情数据、基本面、量化策略信号、AI 诊断报告和研报观点，结论会注明数据来源和日期。'));
  const grid = el('div', 'sugg-grid');
  const sugg = currentSuggestions();
  if (sugg.length === 0) {
    grid.appendChild(el('div', 'sugg small', '暂无建议提示词'));
  }
  for (const s of sugg) {
    const b = el('button', 'sugg');
    b.appendChild(el('div', 'sugg-title', s.title));
    b.appendChild(el('div', 'sugg-msg', s.message));
    b.addEventListener('click', () => { input.value = s.message; send(); });
    grid.appendChild(b);
  }
  w.appendChild(grid);
  chat.appendChild(w);
}
let sessionSuggestions = Array.isArray(boot.suggestions) ? boot.suggestions.slice() : [];
function currentSuggestions() { return sessionSuggestions; }
function clearWelcome() { const w = $('welcome'); if (w) w.remove(); }

/* ---------- sessions ---------- */
const sessionList = $('session-list');
function renderSessions(list) {
  sessionList.replaceChildren();
  const items = (Array.isArray(list) ? list : []).slice().sort((a, b) => (a.current ? -1 : b.current ? 1 : b.updatedAt - a.updatedAt));
  for (const x of items) {
    const row = el('div', 'session-item' + (x.current ? ' current' : ''));
    row.appendChild(el('span', 's-title', x.title || '新会话'));
    row.appendChild(el('span', 's-time', relTime(x.updatedAt)));
    const del = el('button', 'icon s-del', '✕');
    del.setAttribute('aria-label', '删除会话');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('删除该会话及其对话记录？AI Gateway 中已产生的调用日志不会被删除。')) return;
      sessionAction('/api/sessions/delete', { id: x.id, confirm: true });
    });
    row.appendChild(del);
    row.addEventListener('click', () => {
      if (!x.current) sessionAction('/api/sessions/switch', { id: x.id });
      openSidebar(false);
    });
    sessionList.appendChild(row);
  }
  const cur = items.find((x) => x.current);
  $('session-title').textContent = cur ? (cur.title || '新会话') : '新会话';
}
async function sessionAction(path, body) {
  if (sending) { addSystem('当前回复尚未完成，请稍后再试。'); return; }
  const r = await api(path, body);
  if (r.stale) return;
  const { status, data } = r;
  if (status === 409) { addSystem('当前回复尚未完成，请稍后再试。'); return; }
  if (status !== 200 || !data || !Array.isArray(data.history)) { addSystem('会话操作失败（HTTP ' + status + '）'); return; }
  chat.replaceChildren();
  renderHistory(data.history);
  currentConversationId = data.conversationId;
  $('conversation-id').textContent = data.conversationId;
  renderSessions(data.sessions);
  if (!data.history.length) renderWelcome();
}
function renderHistory(history) {
  for (const m of history) {
    if (m.role === 'user') addUser(m.content);
    else {
      const sh = addAgentShell();
      sh.raw = m.content;
      renderMarkdown(m.content, sh.md);
      finishAgent(sh);
    }
  }
}

/* ---------- status / session refresh ---------- */
function setStatus(id, text, cls) { const n = $(id); n.textContent = text; n.className = cls || ''; }
function applyIdentity(u) {
  currentEmail = u.email;
  $('u-email').textContent = u.email;
  $('email').textContent = u.email;
  $('role').textContent = u.role;
  $('actor').textContent = u.actorId;
  $('u-avatar').textContent = (u.email || '·').slice(0, 1).toUpperCase();
  const badge = $('u-role');
  badge.textContent = u.role === 'analyst' ? 'Analyst' : 'Viewer';
  badge.className = 'role-badge' + (u.role === 'analyst' ? '' : ' viewer');
  $('identity-note').textContent = u.localSimulation
    ? '本地开发身份模拟已启用；不代表 Cloudflare Access 或 DLP 已生效。'
    : '当前邮箱来自 Access；Portal/上游可能复用浏览器登录，授权时请核对各自账号。';
}
function logEvent(action, tool, status) {
  console.info(JSON.stringify({ demo_event: true, role: currentRole, actorId: currentActorId,
    action, tool: tool || null, status: status || null, conversationId: currentConversationId || null }));
}
function refreshSession(s) {
  const user = s.user || boot.user;
  if (Array.isArray(s.suggestions)) sessionSuggestions = s.suggestions.slice();
  applyIdentity(user);
  const identityChanged = user.actorId !== currentActorId || user.role !== currentRole;
  if (identityChanged) {
    identityEpoch++;
    currentActorId = user.actorId; currentRole = user.role;
    setStatus('dlp-state', '未验证', 'pending');
    $('dlp-result').textContent = ''; $('request-id').textContent = '—';
    $('portal-roster').replaceChildren();
    const link = $('portal-url'); link.hidden = true; link.removeAttribute('href');
    $('portal-accept').removeAttribute('href'); $('portal-pending-msg').textContent = '';
    $('portal-pending').hidden = true; pendingPortalId = null;
  }
  if (identityChanged || !sending) {
    chat.replaceChildren();
    renderHistory(Array.isArray(s.history) ? s.history : []);
    if (!(s.history || []).length) renderWelcome();
  }
  if (Array.isArray(s.sessions)) renderSessions(s.sessions);
  if (s.conversationId) {
    currentConversationId = s.conversationId;
    $('conversation-id').textContent = currentConversationId;
  }
  const mcp = s.mcp;
  const serverGroups = Array.isArray(s.servers) ? s.servers : [];
  serverLabels = {};
  for (const g of serverGroups) if (g && g.id && g.label) serverLabels[g.id] = g.label;
  toolCount = serverGroups.reduce((n, g) => n + g.tools.length, 0);
  const pill = $('mcp-pill');
  pill.classList.toggle('ok', !!mcp.connected);
  const pillText = el('span', '', mcp.connected
    ? '已连接 · ' + toolCount + ' 个工具'
    : (mcp.state === 'authenticating' ? '待授权' : '未连接'));
  pillText.id = 'mcp-pill-text';
  pill.replaceChildren(el('span', 'dot'), pillText);
  if (!mcp.connected && mcp.state !== 'authenticating') {
    const btn = el('button', '', '连接');
    btn.type = 'button';
    btn.addEventListener('click', () => openDrawer(true));
    pill.appendChild(btn);
  }
  setStatus('mcp-state', mcp.connected ? '已连接' : (mcp.state === 'authenticating' ? '待授权（将跳转至授权页）' : (mcp.state === 'failed' ? '连接失败' : (['connecting', 'discovering'].includes(mcp.state) ? '正在建立连接' : '未连接'))), mcp.connected ? 'ok' : 'pending');
  setStatus('model-state', s.setup.modelConfigured ? '已配置（未经云端确认）' : '未配置', s.setup.modelConfigured ? 'pending' : 'err');
  $('model-id').textContent = s.modelId || '—';
  $('dlp-btn').disabled = !s.setup.modelConfigured || dlpBusy;
  const connectBtn = $('connect-btn');
  connectBtn.disabled = !s.setup.mcpConfigured || mcp.connected || connectBusy;
  connectBtn.textContent = mcp.connected ? 'MCP 已连接' : '连接 MCP（OAuth 授权）';
  $('disconnect-btn').disabled = mcp.state === 'disconnected';
  $('connect-hint').textContent =
    !s.setup.mcpConfigured ? 'MCP_SERVER_URL 未配置'
    : mcp.state === 'authenticating' ? '等待授权完成，本页将在同窗口跳转。'
    : ['connecting', 'discovering'].includes(mcp.state) ? '正在建立连接…'
    : mcp.state === 'failed' ? ('连接失败' + (mcp.detail ? '：' + mcp.detail : ''))
    : !mcp.connected ? ('当前状态：' + mcp.state + (mcp.detail ? '：' + mcp.detail : '')) : '';
  const box = $('servers-box');
  box.replaceChildren();
  const groups = Array.isArray(s.servers) ? s.servers : [];
  if (!groups.length) {
    box.appendChild(el('p', 'small', mcp.connected ? '远端未公布工具' : '未连接'));
  }
  for (const g of groups) {
    const blk = el('div', 'server-block');
    blk.appendChild(el('div', 'sv-head', (g.label || g.id || 'MCP') + (g.id ? '（' + g.id + '）' : '')));
    const tags = el('div');
    for (const t of g.tools) tags.appendChild(el('span', 'tool-tag', t));
    blk.appendChild(tags); box.appendChild(blk);
  }
  readyForChat = Boolean(s.setup.modelConfigured && mcp.connected);
  input.disabled = !readyForChat;
  sendBtn.disabled = !readyForChat || sending;
  $('composer-hint').textContent = readyForChat ? '' :
    (!s.setup.modelConfigured && !mcp.connected ? '模型网关与 MCP 均未就绪，对话不可用。' :
     !s.setup.modelConfigured ? '模型网关未配置，对话不可用。' : 'MCP 未连接，对话不可用。');
  const portal = s.portal || {};
  $('portal-list-btn').disabled = !mcp.connected || !portal.listAvailable || portalBusy;
  $('portal-manage-btn').disabled = !mcp.connected || !portal.manageAvailable || portalBusy;
  $('portal-refresh-btn').disabled = !mcp.connected || portalBusy;
  $('portal-hint').textContent = mcp.connected ? '启用状态不代表认证或连接状态' : '先连接 Portal';
  renderPortalPending(portal);
  $('drawer-note').textContent = '合成演示数据；权限由服务端判定，UI 文本不代表真实的 Access/DLP 状态（除非标记为云端确认）。';
  if (portalBusy || connectBusy || Boolean(portal.pending) || ['authenticating', 'connecting', 'discovering'].includes(mcp.state)) ensurePolling();
}
function renderPortalPending(portal) {
  const box = $('portal-pending');
  if (portal && portal.pending) {
    pendingPortalId = portal.pending.id;
    $('portal-pending-msg').textContent = portal.pending.message;
    $('portal-accept').href = portal.pending.url;
    box.hidden = false;
    openDrawer(true);
  } else {
    pendingPortalId = null;
    $('portal-accept').removeAttribute('href');
    $('portal-pending-msg').textContent = '';
    box.hidden = true;
  }
}
async function portalRespond(action) {
  if (!pendingPortalId) return;
  const r = await api('/api/portal/respond', { id: pendingPortalId, action });
  if (r.stale) return;
  loadSession();
}
$('portal-accept').addEventListener('click', () => portalRespond('accept'));
$('portal-decline').addEventListener('click', () => portalRespond('decline'));
$('portal-cancel').addEventListener('click', () => portalRespond('cancel'));

async function portalAction(label, path, done) {
  if (portalBusy) return;
  portalBusy = true; ensurePolling();
  $('portal-hint').textContent = label + '…';
  try {
    const r = await api(path, {});
    if (r.stale) return;
    const { status, data } = r;
    const summary = data && data.status ? data.status : ('HTTP ' + status);
    $('portal-hint').textContent = label + ' → ' + summary;
    logEvent(label, 'mcp', summary);
    if (done) done(status, data);
  } finally { portalBusy = false; loadSession(); }
}
$('portal-list-btn').addEventListener('click', () =>
  portalAction('读取 Portal 服务器列表', '/api/portal/list', (status, data) => {
    if (data && data.status === 'ok') renderRoster(data.servers, data.truncated);
  }));
$('portal-manage-btn').addEventListener('click', () =>
  portalAction('管理/重新授权 MCP', '/api/portal/manage', (status, data) => {
    const link = $('portal-url');
    if (data && data.status === 'ok' && data.authorizationUrl) { link.href = data.authorizationUrl; link.hidden = false; }
    else link.hidden = true;
  }));
$('portal-refresh-btn').addEventListener('click', () =>
  portalAction('重新读取工具目录', '/api/portal/refresh', (status, data) => {
    if (data && data.status === 'ok') renderRoster(data.servers, data.truncated);
  }));
function renderRoster(servers, truncated) {
  const box = $('portal-roster'); box.replaceChildren();
  for (const srv of (Array.isArray(servers) ? servers : [])) {
    const line = el('div', 'status-line');
    line.append(el('span', '', srv.name + ' (' + srv.id + ')'),
      el('span', '', srv.enabled === true ? '已启用' : srv.enabled === false ? '未启用' : '状态未确认'));
    box.appendChild(line);
  }
  if (truncated) box.appendChild(el('p', 'small', '仅显示前 100 条（已截断）'));
}

function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setTimeout(async () => { pollTimer = null; await loadSession(); }, 1500);
}
async function api(path, body) {
  const epoch = identityEpoch;
  const resp = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await resp.json(); } catch {}
  if (epoch !== identityEpoch) return { status: resp.status, data: null, stale: true };
  if (data && data.requestId) $('request-id').textContent = data.requestId;
  return { status: resp.status, data, stale: false };
}
async function loadSession() {
  const r = await api('/api/session');
  if (r.stale) return;
  if (r.status === 200 && r.data) refreshSession(r.data);
  else addSystem('会话加载失败（HTTP ' + r.status + '）');
}

$('connect-btn').addEventListener('click', async () => {
  if (connectBusy) return;
  connectBusy = true; ensurePolling();
  $('connect-hint').textContent = '请求 MCP 连接…';
  logEvent('connect', 'mcp', 'requested');
  try {
    const r = await api('/api/connect', {});
    if (r.stale) return;
    const { status, data } = r;
    if (data && data.authUrl) {
      $('connect-hint').textContent = '需要 OAuth 授权，同窗口跳转授权页面';
      logEvent('connect', 'mcp', 'redirecting');
      window.location.assign(data.authUrl); return;
    } else if (data && data.status === 'ready') {
      $('connect-hint').textContent = 'MCP 已连接';
      logEvent('connect', 'mcp', 'ready');
    } else {
      $('connect-hint').textContent = '连接失败（HTTP ' + status + '）' + (data && data.detail ? '：' + data.detail : '');
      logEvent('connect', 'mcp', 'failed');
    }
  } catch {
    $('connect-hint').textContent = '连接失败（网络错误）';
    logEvent('connect', 'mcp', 'failed');
  } finally { connectBusy = false; loadSession(); }
});
$('disconnect-btn').addEventListener('click', async () => {
  if (!confirm('删除此 Agent 的 MCP 连接及本地授权缓存；不删除聊天历史，也不撤销 Portal/上游已有授权。')) return;
  logEvent('disconnect', 'mcp', 'requested');
  const r = await api('/api/disconnect', { confirm: true });
  if (r.stale) return;
  const ok = r.status === 200 && r.data && r.data.status === 'disconnected';
  $('connect-hint').textContent = ok ? 'MCP 已断开' : '断开失败（HTTP ' + r.status + '）';
  logEvent('disconnect', 'mcp', ok ? 'disconnected' : 'failed');
  loadSession();
});
$('dlp-btn').addEventListener('click', async () => {
  if (dlpBusy) return;
  dlpBusy = true; $('dlp-btn').disabled = true;
  setStatus('dlp-state', '测试中…', 'pending');
  $('dlp-result').textContent = '';
  logEvent('dlp-test', null, 'requested');
  const r = await api('/api/dlp-test', {});
  if (r.stale) { dlpBusy = false; return; }
  const { status, data } = r;
  if (data && data.dlp) {
    const d = data.dlp;
    setStatus('dlp-state', d.action === 'BLOCK' ? '云端确认：已拦截' : (d.action === 'FLAG' ? '云端确认：标记（未拦截）' : '云端响应：未触发 DLP'), d.action === 'BLOCK' ? 'ok' : 'pending');
    $('dlp-result').textContent = 'action=' + (d.action || 'none') + '\\n' + (d.logId ? 'log_id=' + d.logId + '\\n' : '') + (d.detail ? 'detail=' + d.detail : '');
    logEvent('dlp-test', null, d.action || 'none');
  } else {
    setStatus('dlp-state', '无法确认（HTTP ' + status + '）', 'err');
    $('dlp-result').textContent = data && data.error ? String(data.error) : '无响应';
    logEvent('dlp-test', null, 'unconfirmed');
  }
  dlpBusy = false; loadSession();
});

/* ---------- chat send / stream / stop ---------- */
let shell = null, rafQueued = false;
function scheduleRender() {
  if (rafQueued || !shell) return;
  rafQueued = true;
  requestAnimationFrame(() => { rafQueued = false; if (shell) renderMarkdown(shell.raw, shell.md); });
}
function setSendingUI(on) {
  sendBtn.disabled = on ? false : !readyForChat;
  sendBtn.textContent = on ? '停止' : '发送';
  sendBtn.classList.toggle('stop', on);
}
async function send() {
  if (sending) { if (abortCtrl) abortCtrl.abort(); return; }
  const message = input.value.trim();
  if (!message || !readyForChat) return;
  sending = true; setSendingUI(true);
  abortCtrl = new AbortController();
  input.value = ''; input.style.height = '46px';
  clearWelcome();
  addUser(message);
  shell = addAgentShell();
  const epoch = identityEpoch;
  let done = null, gotDelta = false;
  try {
    const resp = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: abortCtrl.signal
    });
    if (!resp.ok || !resp.body) {
      if (epoch === identityEpoch) { addSystem('请求失败（HTTP ' + resp.status + '）'); logEvent('chat', null, 'failed'); }
    } else {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const handle = (line) => {
        if (!line || epoch !== identityEpoch) return;
        let evt = null;
        try { evt = JSON.parse(line); } catch { return; }
        if (evt.type === 'step') {
          shell.chip.det.style.display = '';
          procUpdate(shell.chip, evt);
          scrollChat();
        } else if (evt.type === 'delta') {
          shell.raw += evt.text; gotDelta = true;
          scheduleRender(); scrollChat();
        } else if (evt.type === 'done' || evt.type === 'error') {
          done = evt;
        }
      };
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let idx = buffer.indexOf('\\n');
        while (idx >= 0) { handle(buffer.slice(0, idx)); buffer = buffer.slice(idx + 1); idx = buffer.indexOf('\\n'); }
      }
      buffer += decoder.decode();
      handle(buffer);
      if (epoch === identityEpoch) {
        if (done && done.requestId) $('request-id').textContent = done.requestId;
        if (!done || done.type === 'error') {
          shell.m.remove(); shell = null;
          addSystem(abortCtrl.signal.aborted ? '已停止生成。' : '请求中断，请重试。');
          logEvent('chat', null, 'failed');
        } else if (done.mcpRequired) {
          shell.m.remove(); shell = null;
          addSystem('需要先完成 MCP 连接授权。');
          logEvent('chat', null, 'mcp_required');
          loadSession();
        } else {
          shell.raw = done.reply;
          renderMarkdown(done.reply, shell.md);
          if (done.stopped) {
            shell.chip.det.style.display = shell.chip.tools.size ? '' : 'none';
            addSystem('生成已停止，已保留已生成的内容。');
          }
          procFinish(shell.chip);
          finishAgent(shell);
          logEvent('chat', null, 'ok');
          if (done.dlp) setStatus('dlp-state', '云端确认：' + done.dlp.action, 'ok');
        }
      }
    }
  } catch (e) {
    if (epoch === identityEpoch) {
      if (abortCtrl.signal.aborted && shell) {
        if (shell.raw.trim()) {
          renderMarkdown(shell.raw + '\\n\\n（已停止生成）', shell.md);
          procFinish(shell.chip);
          finishAgent(shell);
        } else { shell.m.remove(); shell = null; }
        addSystem('生成已停止。');
      } else {
        if (shell) { shell.m.remove(); shell = null; }
        addSystem('网络错误'); logEvent('chat', null, 'network_error');
      }
    }
  }
  shell = null;
  sending = false; abortCtrl = null;
  setSendingUI(false);
}
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', send);
$('new-session').addEventListener('click', () => { openSidebar(false); sessionAction('/api/sessions/new', {}); });

/* ---------- init ---------- */
applyIdentity(boot.user);
$('conversation-id').textContent = currentConversationId;
renderHistory(boot.history);
renderSessions(boot.sessions);
if (!boot.history.length) renderWelcome();
loadSession();
</script>
</body>
</html>`;

export interface BootstrapData {
  user: { email: string; role: string; localSimulation: boolean; actorId: string };
  history: { role: string; content: string }[];
  mcp: { connected: boolean; state: string; error?: string | null; detail?: string | null };
  servers: { id: string; label: string; tools: string[] }[];
  suggestions: readonly { title: string; message: string }[];
  modelId: string;
  conversationId: string;
  sessions?: { id: string; title: string; updatedAt: number; messageCount: number; current: boolean }[];
  portal?: {
    listAvailable: boolean;
    manageAvailable: boolean;
    pending: { id: string; url: string; message: string; expiresAt: number } | null;
  };
  setup: { mcpConfigured: boolean; modelConfigured: boolean; tracingWrapped: boolean; accessLogoutUrl: string | null };
}

export function renderPage(bootstrap: BootstrapData, nonce: string): string {
  const json = JSON.stringify(bootstrap).replaceAll("<", "\\u003c");
  return PAGE_HTML.replace("__BOOTSTRAP__", json).replaceAll("__CSP_NONCE__", nonce);
}

const INLINE_SCRIPT = PAGE_HTML.match(/<script nonce="__CSP_NONCE__">([\s\S]*)<\/script>/)?.[1] ?? "";
let scriptHashPromise: Promise<string> | null = null;
export function pageScriptHash(): Promise<string> {
  scriptHashPromise ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(INLINE_SCRIPT))
    .then((digest) => btoa(String.fromCharCode(...new Uint8Array(digest))));
  return scriptHashPromise;
}
