const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>安全投研演示 Agent</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#0b1220;color:#e2e8f0;display:flex;height:100vh;overflow:hidden}
aside{width:280px;min-width:280px;background:#111a2e;border-right:1px solid #24304d;padding:20px;display:flex;flex-direction:column;gap:14px;overflow-y:auto}
main{flex:1;display:flex;flex-direction:column;padding:20px;gap:14px;min-width:0;min-height:0}
h1{font-size:16px;margin:0}
h2{font-size:13px;margin:0;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;background:#1e3a5f;color:#7dd3fc;border:1px solid #2d4a70;margin:2px 2px 2px 0}
[hidden]{display:none!important}
.badge.warn{background:#3a2f14;color:#fbbf24;border-color:#5c4a1f}
.badge.demo{background:#17301f;color:#6ee7b7;border-color:#23543a}
.badge.ro{background:#2a2140;color:#c4b5fd;border-color:#453a66}
.card{background:#141f38;border:1px solid #24304d;border-radius:10px;padding:14px}
.status-line{display:flex;justify-content:space-between;font-size:13px;padding:4px 0;color:#cbd5e1;gap:8px}
.status-line > span:first-child{min-width:0;overflow-wrap:anywhere}
.status-line > span:last-child{min-width:0;overflow-wrap:anywhere;text-align:right}
.status-line .ok{color:#6ee7b7}
.status-line .pending{color:#fbbf24}
.status-line .err{color:#fca5a5}
button{background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
button:disabled{background:#334155;color:#64748b;cursor:not-allowed}
button.ghost{background:#24304d}
button.scenario{display:block;width:100%;text-align:left;margin-bottom:8px;background:#1c2a47}
button.scenario:hover:not(:disabled){background:#24365c}
#chat{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:4px;min-height:0}
.msg{max-width:82%;padding:10px 14px;border-radius:10px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:#2563eb;color:#fff}
.msg.agent{align-self:flex-start;background:#1c2a47;border:1px solid #2d4166}
.msg.system{align-self:center;background:#22160b;color:#fbbf24;font-size:12px;border:1px solid #5c4a1f}
#composer{display:flex;gap:10px}
#input{flex:1;background:#0f172a;border:1px solid #2d4166;border-radius:8px;color:#e2e8f0;padding:10px;font-size:14px;resize:none;height:52px;font-family:inherit;min-width:0}
#timeline{display:flex;flex-direction:column;gap:6px;font-size:12px;max-height:240px;overflow-y:auto}
details.turn{background:#0b1426;border:1px solid #1f2b47;border-radius:6px;padding:4px 8px}
details.turn>summary{cursor:pointer;color:#cbd5e1;padding:2px 0;list-style-position:inside}
.turn-body{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.card-head{display:flex;justify-content:space-between;align-items:center}
.card-head button{padding:2px 10px;font-size:12px}
.event{background:#0f172a;border-left:3px solid #2d4a70;padding:6px 10px;border-radius:4px;color:#94a3b8;word-break:break-all}
.event.denied{border-left-color:#f87171;color:#fca5a5}
.event.ok{border-left-color:#34d399;color:#6ee7b7}
.small{font-size:12px;color:#64748b}
#dlp-result{font-size:12px;white-space:pre-wrap;word-break:break-all}
a{color:#7dd3fc}
#session-list{max-height:220px;overflow-y:auto}
.session-row{display:flex;gap:6px;margin-top:6px}
.session-open{flex:1;min-width:0;text-align:left;background:#1c2a47;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.session-row.current .session-open{outline:1px solid #2563eb}
.session-del{background:#3a1d24;color:#fca5a5;padding:6px 10px}
@media (max-width:900px){
  body{flex-direction:column;height:auto;min-height:100vh;overflow:auto}
  #chat{max-height:60vh;min-height:30vh}
  aside{width:100%;min-width:0;border-right:none;border-bottom:1px solid #24304d}
  main{padding:12px}
  #composer{flex-direction:column}
}
</style>
</head>
<body>
<aside>
  <h1>安全投研演示</h1>
  <div>
    <span class="badge demo">合成数据</span>
    <span class="badge ro">只读</span>
    <span class="badge" id="role-badge">身份未知</span>
    <span class="badge warn" id="local-badge" hidden>本地身份模拟</span>
  </div>
  <div class="card">
    <h2>身份</h2>
    <div class="status-line"><span>邮箱</span><span id="email">—</span></div>
    <div class="status-line"><span>角色</span><span id="role">—</span></div>
    <div class="status-line"><span>审计身份 ID</span><span id="actor">—</span></div>
    <div class="status-line"><span>会话 ID</span><span id="conversation-id">—</span></div>
    <div class="status-line"><span>请求 ID</span><span id="request-id">—</span></div>
    <p class="small" id="identity-note"></p>
    <button class="ghost" id="logout-btn" disabled>退出 Access 登录</button>
  </div>
  <div class="card">
    <h2>连接状态</h2>
    <div class="status-line"><span>MCP 工具服务</span><span id="mcp-state" class="pending">未连接</span></div>
    <div class="status-line"><span>模型网关</span><span id="model-state" class="pending">未确认</span></div>
    <div class="status-line"><span>DLP</span><span id="dlp-state" class="pending">未验证</span></div>
    <div class="status-line"><span>追踪</span><span id="trace-state" class="pending">—</span></div>
    <button id="connect-btn" disabled>连接 MCP（OAuth 授权）</button>
    <button class="ghost" id="disconnect-btn" disabled style="margin-top:8px">断开 MCP 连接</button>
    <p class="small" id="connect-hint"></p>
  </div>
  <div class="card">
    <h2>MCP 服务器</h2>
    <button class="ghost" id="portal-list-btn" disabled>从 Portal 读取列表</button>
    <button class="ghost" id="portal-manage-btn" disabled style="margin-top:8px">管理/重新授权 MCP</button>
    <button class="ghost" id="portal-refresh-btn" disabled style="margin-top:8px">重新读取工具目录</button>
    <p class="small" id="portal-hint"></p>
    <div id="portal-pending" hidden>
      <p class="small" id="portal-pending-msg"></p>
      <a id="portal-accept" class="small" target="_blank" rel="noopener noreferrer">同意并打开授权页</a>
      <button class="ghost" id="portal-decline" style="margin-left:6px">拒绝</button>
      <button class="ghost" id="portal-cancel" style="margin-left:6px">取消</button>
    </div>
    <a id="portal-url" class="small" target="_blank" rel="noopener noreferrer" hidden>打开 Portal 原生管理页</a>
    <div id="portal-roster"></div>
  </div>
  <div class="card">
    <div class="card-head"><h2>会话</h2><button class="ghost" id="new-session" type="button">新建会话</button></div>
    <div id="session-list"></div>
  </div>
  <div class="card">
    <h2>演示场景</h2>
    <div id="scenarios"></div>
  </div>
  <div class="card">
    <h2>权限测试</h2>
    <button class="ghost" id="test-list">测试 list_demo_companies</button>
    <button class="ghost" id="test-doc" style="margin-top:8px">测试 read_research_document</button>
    <div class="status-line" style="margin-top:8px"><span>当前可用工具</span><span id="tools-line">—</span></div>
  </div>
  <div class="card">
    <h2>DLP 测试</h2>
    <button class="ghost" id="dlp-btn" disabled>发送合成 DLP 标记</button>
    <p class="small">一次真实模型调用（已配置后可用）。仅证明云端网关行为。</p>
    <div id="dlp-result"></div>
  </div>
</aside>
<main>
  <div id="chat"></div>
  <div class="card"><div class="card-head"><h2>执行步骤</h2><button class="ghost" id="clear-timeline" type="button">清空</button></div><div id="timeline"></div></div>
  <div id="composer">
    <textarea id="input" placeholder="询问模拟报告……" maxlength="4000" disabled></textarea>
    <button id="send" disabled>发送</button>
  </div>
  <p class="small" id="composer-hint"></p>
  <p class="small">所有标的均为合成演示数据，不构成投资建议。权限由服务端判定，UI 文本不代表真实的 Access/DLP 状态（除非标记为云端确认）。时间线为本页执行事件记录，并非 Cloudflare 原生追踪。</p>
</main>
<script id="bootstrap" type="application/json" nonce="__CSP_NONCE__">__BOOTSTRAP__</script>
<script nonce="__CSP_NONCE__">
const boot = JSON.parse(document.getElementById('bootstrap').textContent);
const chat = document.getElementById('chat');
const timeline = document.getElementById('timeline');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function addMsg(cls, text) {
  chat.appendChild(el('div', 'msg ' + cls, text));
  chat.scrollTop = chat.scrollHeight;
}
let currentTurn = null;
function startTurn(label) {
  if (currentTurn) currentTurn.details.open = false;
  const details = document.createElement('details');
  details.className = 'turn';
  details.open = true;
  const body = el('div', 'turn-body');
  details.append(el('summary', '', new Date().toLocaleTimeString() + ' · ' + label), body);
  timeline.appendChild(details);
  currentTurn = { details, body, last: null };
  timeline.scrollTop = timeline.scrollHeight;
}
function addEvent(text, kind) {
  const k = kind || '';
  const turn = currentTurn;
  if (turn && turn.last && turn.last.text === text && turn.last.kind === k) {
    turn.last.count += 1;
    turn.last.node.textContent = text + ' ×' + turn.last.count;
  } else {
    const node = el('div', 'event ' + k, text);
    (turn ? turn.body : timeline).appendChild(node);
    if (turn) turn.last = { text, kind: k, count: 1, node };
  }
  timeline.scrollTop = timeline.scrollHeight;
}
function clearTimeline() {
  timeline.replaceChildren();
  currentTurn = null;
}
const sessionList = document.getElementById('session-list');
function renderSessions(list) {
  sessionList.replaceChildren();
  for (const x of (Array.isArray(list) ? list : [])) {
    const row = el('div', 'session-row' + (x.current ? ' current' : ''));
    const open = el('button', 'session-open', (x.title || '新会话') + ' · ' + x.messageCount);
    open.title = x.title || '新会话';
    open.disabled = x.current;
    open.addEventListener('click', () => sessionAction('/api/sessions/switch', { id: x.id }));
    const del = el('button', 'session-del', '删除');
    del.addEventListener('click', () => {
      if (!confirm('删除该会话及其对话记录？AI Gateway 中已产生的调用日志不会被删除。')) return;
      sessionAction('/api/sessions/delete', { id: x.id, confirm: true });
    });
    row.append(open, del);
    sessionList.appendChild(row);
  }
}
async function sessionAction(path, body) {
  if (sending) {
    addMsg('system', '当前回复尚未完成，请稍后再试。');
    return;
  }
  const r = await api(path, body);
  if (r.stale) return;
  const { status, data } = r;
  if (status === 409) {
    addMsg('system', '当前回复尚未完成，请稍后再试。');
    return;
  }
  if (status !== 200 || !data || !Array.isArray(data.history)) {
    addMsg('system', '会话操作失败（HTTP ' + status + '）');
    return;
  }
  chat.replaceChildren();
  for (const m of data.history) addMsg(m.role === 'user' ? 'user' : 'agent', m.content);
  clearTimeline();
  currentConversationId = data.conversationId;
  document.getElementById('conversation-id').textContent = data.conversationId;
  renderSessions(data.sessions);
}
function setStatus(id, text, cls) {
  const node = document.getElementById(id);
  node.textContent = text;
  node.className = cls || '';
}
let currentActorId = boot.user.actorId;
let currentRole = boot.user.role;
let currentConversationId = boot.conversationId;
let portalBusy = false;
let connectBusy = false;
let pendingPortalId = null;
let pollTimer = null;
let identityEpoch = 0;

function applyIdentity(u) {
  document.getElementById('email').textContent = u.email;
  document.getElementById('role').textContent = u.role;
  document.getElementById('actor').textContent = u.actorId;
  document.getElementById('role-badge').textContent = u.role === 'analyst' ? 'Analyst' : 'Viewer（只读）';
  document.getElementById('local-badge').hidden = !u.localSimulation;
  if (u.localSimulation) {
    document.getElementById('identity-note').textContent = '本地开发身份模拟已启用；不代表 Cloudflare Access 或 DLP 已生效。';
  } else {
    document.getElementById('identity-note').textContent = '当前邮箱来自 Access；Portal/上游可能复用浏览器登录，授权时请核对各自账号。';
  }
}

function logEvent(action, tool, status) {
  console.info(JSON.stringify({
    demo_event: true,
    role: currentRole,
    actorId: currentActorId,
    action: action,
    tool: tool || null,
    status: status || null,
    conversationId: currentConversationId || null
  }));
}

applyIdentity(boot.user);
document.getElementById('conversation-id').textContent = currentConversationId;
const logoutBtn = document.getElementById('logout-btn');
if (boot.setup.accessLogoutUrl) {
  logoutBtn.disabled = false;
  logoutBtn.addEventListener('click', () => {
    if (confirm('此操作会退出本 Zero Trust 组织的所有 Access 应用会话，不仅是 Agent；不会删除聊天历史，也不保证撤销 MCP OAuth 授权。确认退出？')) {
      window.location.assign(boot.setup.accessLogoutUrl);
    }
  });
} else {
  logoutBtn.textContent = '未接入真实 Access 退出';
  logoutBtn.disabled = true;
}
for (const m of boot.history) addMsg(m.role === 'user' ? 'user' : 'agent', m.content);

const scenarioButtons = [];
for (const s of boot.scenarios) {
  const b = el('button', 'scenario', s.label);
  b.disabled = true;
  b.addEventListener('click', () => { input.value = s.message; send(); });
  scenarioButtons.push(b);
  document.getElementById('scenarios').appendChild(b);
}

let readyForChat = false;
function refreshSession(s) {
  const user = s.user || boot.user;
  if (user.actorId !== currentActorId || user.role !== currentRole) {
    identityEpoch++;
    currentActorId = user.actorId;
    currentRole = user.role;
    chat.replaceChildren();
    clearTimeline();
    setStatus('dlp-state', '未验证', 'pending');
    document.getElementById('dlp-result').textContent = '';
    document.getElementById('request-id').textContent = '—';
    document.getElementById('portal-roster').replaceChildren();
    const urlLink = document.getElementById('portal-url');
    urlLink.hidden = true;
    urlLink.removeAttribute('href');
    document.getElementById('portal-accept').removeAttribute('href');
    document.getElementById('portal-pending-msg').textContent = '';
    document.getElementById('portal-pending').hidden = true;
    pendingPortalId = null;
    for (const m of (Array.isArray(s.history) ? s.history : [])) {
      addMsg(m.role === 'user' ? 'user' : 'agent', m.content);
    }
  }
  applyIdentity(user);
  if (Array.isArray(s.sessions)) renderSessions(s.sessions);
  if (s.conversationId) {
    currentConversationId = s.conversationId;
    document.getElementById('conversation-id').textContent = currentConversationId;
  }
  const mcpText = s.mcp.connected ? '已连接' : (s.mcp.state === 'authenticating' ? '待授权（将跳转至授权页）' : (s.mcp.state === 'failed' ? '连接失败' : (s.mcp.state === 'connecting' || s.mcp.state === 'discovering' ? '正在建立连接' : '未连接')));
  setStatus('mcp-state', mcpText, s.mcp.connected ? 'ok' : 'pending');
  setStatus('model-state', s.setup.modelConfigured ? '已配置（未经云端确认）' : '未配置', s.setup.modelConfigured ? 'pending' : 'err');
  document.getElementById('dlp-btn').disabled = !s.setup.modelConfigured || dlpBusy;
  setStatus('trace-state', s.setup.tracingWrapped ? 'AI 调用已包装（storeMessages/Tools 关闭）' : '未启用', 'pending');
  const connectBtn = document.getElementById('connect-btn');
  connectBtn.disabled = !s.setup.mcpConfigured || s.mcp.connected || connectBusy;
  connectBtn.textContent = s.mcp.connected ? 'MCP 已连接' : '连接 MCP（OAuth 授权）';
  document.getElementById('disconnect-btn').disabled = s.mcp.state === 'disconnected';
  document.getElementById('connect-hint').textContent =
    !s.setup.mcpConfigured ? 'MCP_SERVER_URL 未配置'
    : s.mcp.state === 'authenticating' ? '等待授权完成，本页将在同窗口跳转。'
    : (s.mcp.state === 'connecting' || s.mcp.state === 'discovering') ? '正在建立连接…'
    : s.mcp.state === 'failed' ? ('连接失败' + (s.mcp.detail ? '：' + s.mcp.detail : ''))
    : !s.mcp.connected ? ('当前状态：' + s.mcp.state + (s.mcp.detail ? '：' + s.mcp.detail : ''))
    : '';
  const tools = Array.isArray(s.tools) ? s.tools : [];
  const expected = Array.isArray(s.expectedTools) ? s.expectedTools : [];
  document.getElementById('tools-line').textContent =
    tools.length > 0 ? tools.join(', ') : (expected.length > 0 ? '无（未连接或远端未公布）' : '无');
  readyForChat = Boolean(s.setup.modelConfigured && s.mcp.connected);
  input.disabled = !readyForChat;
  sendBtn.disabled = !readyForChat || sending;
  for (const b of scenarioButtons) b.disabled = !readyForChat;
  document.getElementById('composer-hint').textContent = readyForChat ? '' :
    (!s.setup.modelConfigured && !s.mcp.connected ? '模型网关与 MCP 均未就绪，对话不可用。' :
     !s.setup.modelConfigured ? '模型网关未配置，对话不可用。' : 'MCP 未连接，对话不可用。');
  const portal = s.portal || {};
  document.getElementById('portal-list-btn').disabled = !s.mcp.connected || !portal.listAvailable || portalBusy;
  document.getElementById('portal-manage-btn').disabled = !s.mcp.connected || !portal.manageAvailable || portalBusy;
  document.getElementById('portal-refresh-btn').disabled = !s.mcp.connected || portalBusy;
  document.getElementById('portal-hint').textContent =
    s.mcp.connected ? '启用状态不代表认证或连接状态' : '先连接 Portal';
  renderPortalPending(portal);
  if (portalBusy || connectBusy || Boolean(portal.pending) ||
      ['authenticating', 'connecting', 'discovering'].includes(s.mcp.state)) {
    ensurePolling();
  }
}

function renderRoster(servers, truncated) {
  const box = document.getElementById('portal-roster');
  box.replaceChildren();
  for (const srv of (Array.isArray(servers) ? servers : [])) {
    const line = el('div', 'status-line');
    line.appendChild(el('span', '', srv.name + ' (' + srv.id + ')'));
    line.appendChild(el('span', '', srv.enabled === true ? '已启用' : (srv.enabled === false ? '未启用' : '状态未确认')));
    box.appendChild(line);
  }
  if (truncated) box.appendChild(el('p', 'small', '仅显示前 100 条（已截断）'));
}

function renderPortalPending(portal) {
  const box = document.getElementById('portal-pending');
  if (portal && portal.pending) {
    pendingPortalId = portal.pending.id;
    document.getElementById('portal-pending-msg').textContent = portal.pending.message;
    document.getElementById('portal-accept').href = portal.pending.url;
    box.hidden = false;
  } else {
    pendingPortalId = null;
    document.getElementById('portal-accept').removeAttribute('href');
    document.getElementById('portal-pending-msg').textContent = '';
    box.hidden = true;
  }
}

async function portalRespond(action) {
  if (!pendingPortalId) return;
  const r = await api('/api/portal/respond', { id: pendingPortalId, action: action });
  if (r.stale) return;
  loadSession();
}
document.getElementById('portal-accept').addEventListener('click', () => { portalRespond('accept'); });
document.getElementById('portal-decline').addEventListener('click', () => { portalRespond('decline'); });
document.getElementById('portal-cancel').addEventListener('click', () => { portalRespond('cancel'); });

async function portalAction(label, path, done) {
  if (portalBusy) return;
  portalBusy = true;
  ensurePolling();
  startTurn(label);
  try {
    const r = await api(path, {});
    if (r.stale) return;
    const { status, data } = r;
    const summary = data && data.status ? data.status : ('HTTP ' + status);
    addEvent(label + ' → ' + summary, data && data.status === 'ok' ? 'ok' : 'denied');
    logEvent(label, 'mcp', summary);
    if (done) done(status, data);
    if (data && data.status === 'error') {
      const d = await api('/api/diag/portal?mode=stored', {});
      if (!d.stale && d.data) addEvent('Portal 探测（使用已存令牌）：' + JSON.stringify(d.data), '');
    }
  } finally {
    portalBusy = false;
    loadSession();
  }
}
document.getElementById('portal-list-btn').addEventListener('click', () =>
  portalAction('读取 Portal 服务器列表', '/api/portal/list', (status, data) => {
    if (data && data.status === 'ok') renderRoster(data.servers, data.truncated);
  }));
document.getElementById('portal-manage-btn').addEventListener('click', () =>
  portalAction('管理/重新授权 MCP', '/api/portal/manage', (status, data) => {
    const link = document.getElementById('portal-url');
    if (data && data.status === 'ok' && data.authorizationUrl) {
      link.href = data.authorizationUrl;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  }));
document.getElementById('portal-refresh-btn').addEventListener('click', () =>
  portalAction('重新读取工具目录', '/api/portal/refresh', (status, data) => {
    if (data && data.status === 'ok') renderRoster(data.servers, data.truncated);
  }));

function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    await loadSession();
  }, 1500);
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
  if (epoch !== identityEpoch) {
    return { status: resp.status, data: null, stale: true };
  }
  if (data && data.requestId) {
    document.getElementById('request-id').textContent = data.requestId;
  }
  return { status: resp.status, data, stale: false };
}

async function loadSession() {
  const r = await api('/api/session');
  if (r.stale) return;
  const { status, data } = r;
  if (status === 200 && data) {
    refreshSession(data);
  } else {
    addMsg('system', '会话加载失败（HTTP ' + status + '）');
  }
}

document.getElementById('connect-btn').addEventListener('click', async () => {
  if (connectBusy) return;
  connectBusy = true;
  ensurePolling();
  try {
    startTurn('连接 MCP');
    addEvent('请求 MCP 连接…', '');
    logEvent('connect', 'mcp', 'requested');
    const r = await api('/api/connect', {});
    if (r.stale) return;
    const { status, data } = r;
    if (data && data.authUrl) {
      addEvent('需要 OAuth 授权，同窗口跳转授权页面', 'ok');
      logEvent('connect', 'mcp', 'redirecting');
      window.location.assign(data.authUrl);
      return;
    } else if (data && data.status === 'ready') {
      addEvent('MCP 已连接', 'ok');
      logEvent('connect', 'mcp', 'ready');
    } else {
      addEvent('连接失败（HTTP ' + status + '）' + (data && data.detail ? '：' + data.detail : '') + (data && data.requestId ? ' [请求 ID ' + data.requestId + ']' : ''), 'denied');
      logEvent('connect', 'mcp', 'failed');
      const d = await api('/api/diag/portal?mode=stored', {});
      if (!d.stale && d.data) addEvent('Portal 探测（使用已存令牌）：' + JSON.stringify(d.data), '');
    }
  } catch (e) {
    addEvent('连接失败（网络错误）', 'denied');
    logEvent('connect', 'mcp', 'failed');
  } finally {
    connectBusy = false;
    loadSession();
  }
});

document.getElementById('disconnect-btn').addEventListener('click', async () => {
  if (!confirm('删除此 Agent 的 MCP 连接及本地授权缓存；不删除聊天历史，也不撤销 Portal/上游已有授权。')) return;
  startTurn('断开 MCP');
  addEvent('断开 MCP 连接…', '');
  logEvent('disconnect', 'mcp', 'requested');
  const r = await api('/api/disconnect', { confirm: true });
  if (r.stale) return;
  const { status, data } = r;
  const ok = status === 200 && data && data.status === 'disconnected';
  addEvent(ok ? 'MCP 已断开' : '断开失败（HTTP ' + status + '）', ok ? 'ok' : 'denied');
  logEvent('disconnect', 'mcp', ok ? 'disconnected' : 'failed');
  loadSession();
});

async function toolTest(tool, args) {
  startTurn('权限测试 ' + tool);
  addEvent('权限测试 ' + tool + ' …', '');
  const r = await api('/api/tool-test', { tool, args });
  if (r.stale) return;
  const { status, data } = r;
  const summary = data && data.status ? data.status : ('HTTP ' + status);
  logEvent('tool-test', tool, summary);
  addEvent(tool + ' → ' + summary + (data && data.detail ? '：' + data.detail : ''), data && data.status === 'ok' ? 'ok' : 'denied');
}
document.getElementById('test-list').addEventListener('click', () => toolTest('list_demo_companies', {}));
document.getElementById('test-doc').addEventListener('click', () => toolTest('read_research_document', { document_id: 'research-note-a' }));

let dlpBusy = false;
document.getElementById('dlp-btn').addEventListener('click', async () => {
  if (dlpBusy) return;
  dlpBusy = true;
  startTurn('DLP 测试');
  document.getElementById('dlp-btn').disabled = true;
  setStatus('dlp-state', '测试中…', 'pending');
  document.getElementById('dlp-result').textContent = '';
  logEvent('dlp-test', null, 'requested');
  const r = await api('/api/dlp-test', {});
  if (r.stale) { dlpBusy = false; return; }
  const { status, data } = r;
  const box = document.getElementById('dlp-result');
  if (data && data.dlp) {
    const d = data.dlp;
    setStatus('dlp-state', d.action === 'BLOCK' ? '云端确认：已拦截' : (d.action === 'FLAG' ? '云端确认：标记（未拦截）' : '云端响应：未触发 DLP'), d.action === 'BLOCK' ? 'ok' : 'pending');
    box.textContent = 'action=' + (d.action || 'none') + '\\n' + (d.logId ? 'log_id=' + d.logId + '\\n' : '') + (d.detail ? 'detail=' + d.detail : '');
    logEvent('dlp-test', null, d.action || 'none');
  } else {
    setStatus('dlp-state', '无法确认（HTTP ' + status + '）', 'err');
    box.textContent = data && data.error ? String(data.error) : '无响应';
    logEvent('dlp-test', null, 'unconfirmed');
  }
  dlpBusy = false;
  loadSession();
});

document.getElementById('clear-timeline').addEventListener('click', clearTimeline);
let sending = false;
async function send() {
  const message = input.value.trim();
  if (!message || sending || !readyForChat) return;
  sending = true;
  sendBtn.disabled = true;
  input.value = '';
  addMsg('user', message);
  startTurn('对话：' + (message.length > 24 ? message.slice(0, 24) + '…' : message));
  const epoch = identityEpoch;
  let bubble = null;
  try {
    const resp = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message })
    });
    if (!resp.ok || !resp.body) {
      if (epoch === identityEpoch) {
        addMsg('system', '请求失败（HTTP ' + resp.status + '）');
        logEvent('chat', null, 'failed');
      }
    } else {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = null;
      const handle = (line) => {
        if (!line || epoch !== identityEpoch) return;
        let evt = null;
        try { evt = JSON.parse(line); } catch { return; }
        if (evt.type === 'step') {
          addEvent(evt.text, evt.kind);
        } else if (evt.type === 'delta') {
          if (!bubble) {
            bubble = el('div', 'msg agent', '');
            chat.appendChild(bubble);
          }
          bubble.textContent += evt.text;
          chat.scrollTop = chat.scrollHeight;
        } else if (evt.type === 'done' || evt.type === 'error') {
          done = evt;
        }
      };
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let idx = buffer.indexOf('\\n');
        while (idx >= 0) {
          handle(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\\n');
        }
      }
      buffer += decoder.decode();
      handle(buffer);
      if (epoch === identityEpoch) {
        if (done && done.requestId) document.getElementById('request-id').textContent = done.requestId;
        if (!done || done.type === 'error') {
          if (bubble) bubble.remove();
          addMsg('system', '请求中断，请重试。');
          logEvent('chat', null, 'failed');
        } else if (done.mcpRequired) {
          addMsg('system', '需要先完成 MCP 连接授权。');
          logEvent('chat', null, 'mcp_required');
          loadSession();
        } else {
          if (bubble) bubble.textContent = done.reply;
          else if (done.reply) addMsg('agent', done.reply);
          logEvent('chat', null, 'ok');
          if (done.dlp) setStatus('dlp-state', '云端确认：' + done.dlp.action, 'ok');
        }
      }
    }
  } catch (e) {
    if (epoch === identityEpoch) {
      addMsg('system', '网络错误');
      logEvent('chat', null, 'network_error');
    }
  }
  sending = false;
  sendBtn.disabled = !readyForChat;
}
document.getElementById('new-session').addEventListener('click', () => sessionAction('/api/sessions/new', {}));
sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

renderSessions(boot.sessions);
loadSession();
</script>
</body>
</html>`;

export interface BootstrapData {
  user: { email: string; role: string; localSimulation: boolean; actorId: string };
  history: { role: string; content: string }[];
  scenarios: readonly { id: string; label: string; message: string }[];
  mcp: { connected: boolean; state: string };
  tools: string[];
  expectedTools: string[];
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
