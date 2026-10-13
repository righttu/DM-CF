const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>安全投研演示 Agent</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh}
aside{width:280px;min-width:280px;background:#111a2e;border-right:1px solid #24304d;padding:20px;display:flex;flex-direction:column;gap:14px;overflow-y:auto}
main{flex:1;display:flex;flex-direction:column;padding:20px;gap:14px;min-width:0}
h1{font-size:16px;margin:0}
h2{font-size:13px;margin:0;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;background:#1e3a5f;color:#7dd3fc;border:1px solid #2d4a70;margin:2px 2px 2px 0}
.badge.warn{background:#3a2f14;color:#fbbf24;border-color:#5c4a1f}
.badge.demo{background:#17301f;color:#6ee7b7;border-color:#23543a}
.badge.ro{background:#2a2140;color:#c4b5fd;border-color:#453a66}
.card{background:#141f38;border:1px solid #24304d;border-radius:10px;padding:14px}
.status-line{display:flex;justify-content:space-between;font-size:13px;padding:4px 0;color:#cbd5e1;gap:8px}
.status-line .ok{color:#6ee7b7}
.status-line .pending{color:#fbbf24}
.status-line .err{color:#fca5a5}
button{background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
button:disabled{background:#334155;color:#64748b;cursor:not-allowed}
button.ghost{background:#24304d}
button.scenario{display:block;width:100%;text-align:left;margin-bottom:8px;background:#1c2a47}
button.scenario:hover:not(:disabled){background:#24365c}
#chat{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:4px;min-height:40vh}
.msg{max-width:82%;padding:10px 14px;border-radius:10px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:#2563eb;color:#fff}
.msg.agent{align-self:flex-start;background:#1c2a47;border:1px solid #2d4166}
.msg.system{align-self:center;background:#22160b;color:#fbbf24;font-size:12px;border:1px solid #5c4a1f}
#composer{display:flex;gap:10px}
#input{flex:1;background:#0f172a;border:1px solid #2d4166;border-radius:8px;color:#e2e8f0;padding:10px;font-size:14px;resize:none;height:52px;font-family:inherit;min-width:0}
#timeline{display:flex;flex-direction:column;gap:6px;font-size:12px}
.event{background:#0f172a;border-left:3px solid #2d4a70;padding:6px 10px;border-radius:4px;color:#94a3b8;word-break:break-all}
.event.denied{border-left-color:#f87171;color:#fca5a5}
.event.ok{border-left-color:#34d399;color:#6ee7b7}
.small{font-size:12px;color:#64748b}
#dlp-result{font-size:12px;white-space:pre-wrap;word-break:break-all}
a{color:#7dd3fc}
@media (max-width:900px){
  body{flex-direction:column}
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
    <p class="small" id="identity-note"></p>
  </div>
  <div class="card">
    <h2>连接状态</h2>
    <div class="status-line"><span>MCP 工具服务</span><span id="mcp-state" class="pending">未连接</span></div>
    <div class="status-line"><span>模型网关</span><span id="model-state" class="pending">未确认</span></div>
    <div class="status-line"><span>DLP</span><span id="dlp-state" class="pending">未验证</span></div>
    <div class="status-line"><span>追踪</span><span id="trace-state" class="pending">—</span></div>
    <button id="connect-btn" disabled>连接 MCP（OAuth 授权）</button>
    <p class="small" id="connect-hint"></p>
  </div>
  <div class="card">
    <h2>演示场景</h2>
    <div id="scenarios"></div>
  </div>
  <div class="card">
    <h2>权限测试</h2>
    <button class="ghost" id="test-list">测试 list_demo_stocks</button>
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
  <div class="card"><h2>执行事件</h2><div id="timeline"></div></div>
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
function addEvent(text, kind) {
  timeline.appendChild(el('div', 'event ' + (kind || ''), text));
}
function setStatus(id, text, cls) {
  const node = document.getElementById(id);
  node.textContent = text;
  node.className = cls || '';
}
function logEvent(action, tool, status) {
  console.info(JSON.stringify({
    demo_event: true,
    role: boot.user.role,
    action: action,
    tool: tool || null,
    status: status || null,
    conversationId: boot.conversationId || null
  }));
}

document.getElementById('email').textContent = boot.user.email;
document.getElementById('role').textContent = boot.user.role;
document.getElementById('role-badge').textContent = boot.user.role === 'analyst' ? 'Analyst' : 'Viewer（只读）';
if (boot.user.localSimulation) {
  document.getElementById('local-badge').hidden = false;
  document.getElementById('identity-note').textContent = '本地开发身份模拟已启用；不代表 Cloudflare Access 或 DLP 已生效。';
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
  const mcpText = s.mcp.connected ? '已连接' : (s.mcp.state === 'authenticating' ? '待授权（将跳转至授权页）' : (s.mcp.state === 'failed' ? '连接失败' : '未连接'));
  setStatus('mcp-state', mcpText, s.mcp.connected ? 'ok' : 'pending');
  setStatus('model-state', s.setup.modelConfigured ? '已配置（未经云端确认）' : '未配置', s.setup.modelConfigured ? 'pending' : 'err');
  document.getElementById('dlp-btn').disabled = !s.setup.modelConfigured || dlpBusy;
  setStatus('trace-state', s.setup.tracingWrapped ? 'AI 调用已包装（storeMessages/Tools 关闭）' : '未启用', 'pending');
  const connectBtn = document.getElementById('connect-btn');
  connectBtn.disabled = !s.setup.mcpConfigured || s.mcp.connected;
  connectBtn.textContent = s.mcp.connected ? 'MCP 已连接' : '连接 MCP（OAuth 授权）';
  document.getElementById('connect-hint').textContent =
    s.setup.mcpConfigured ? (s.mcp.state === 'authenticating' ? '等待授权完成，本页将在同窗口跳转。' : '') : 'MCP_SERVER_URL 未配置';
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
}

async function api(path, body) {
  const resp = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await resp.json(); } catch {}
  return { status: resp.status, data };
}

async function loadSession() {
  const { status, data } = await api('/api/session');
  if (status === 200 && data) {
    refreshSession(data);
  } else {
    addMsg('system', '会话加载失败（HTTP ' + status + '）');
  }
}

document.getElementById('connect-btn').addEventListener('click', async () => {
  addEvent('请求 MCP 连接…', '');
  logEvent('connect', 'mcp', 'requested');
  const { status, data } = await api('/api/connect', {});
  if (data && data.authUrl) {
    addEvent('需要 OAuth 授权，同窗口跳转授权页面', 'ok');
    logEvent('connect', 'mcp', 'redirecting');
    window.location.assign(data.authUrl);
    return;
  } else if (data && data.status === 'ready') {
    addEvent('MCP 已连接', 'ok');
    logEvent('connect', 'mcp', 'ready');
  } else {
    addEvent('连接失败（HTTP ' + status + '）', 'denied');
    logEvent('connect', 'mcp', 'failed');
  }
  loadSession();
});

async function toolTest(tool, args) {
  addEvent('权限测试 ' + tool + ' …', '');
  const { status, data } = await api('/api/tool-test', { tool, args });
  const summary = data && data.status ? data.status : ('HTTP ' + status);
  logEvent('tool-test', tool, summary);
  addEvent(tool + ' → ' + summary + (data && data.detail ? '：' + data.detail : ''), data && data.status === 'ok' ? 'ok' : 'denied');
}
document.getElementById('test-list').addEventListener('click', () => toolTest('list_demo_stocks', {}));
document.getElementById('test-doc').addEventListener('click', () => toolTest('read_research_document', { document_id: 'research-note-a' }));

let dlpBusy = false;
document.getElementById('dlp-btn').addEventListener('click', async () => {
  if (dlpBusy) return;
  dlpBusy = true;
  document.getElementById('dlp-btn').disabled = true;
  setStatus('dlp-state', '测试中…', 'pending');
  document.getElementById('dlp-result').textContent = '';
  logEvent('dlp-test', null, 'requested');
  const { status, data } = await api('/api/dlp-test', {});
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

let sending = false;
async function send() {
  const message = input.value.trim();
  if (!message || sending || !readyForChat) return;
  sending = true;
  sendBtn.disabled = true;
  input.value = '';
  addMsg('user', message);
  try {
    const { status, data } = await api('/api/chat', { message });
    if (data && data.events) {
      for (const e of data.events) addEvent(e.text, e.kind);
    }
    if (status === 409) {
      addMsg('system', '需要先完成 MCP 连接授权。');
      logEvent('chat', null, 'mcp_required');
      loadSession();
    } else if (status === 200 && data && data.reply !== undefined) {
      addMsg('agent', data.reply);
      logEvent('chat', null, 'ok');
      if (data.dlp) {
        setStatus('dlp-state', '云端确认：' + data.dlp.action, 'ok');
      }
    } else {
      addMsg('system', '请求失败（HTTP ' + status + '）');
      logEvent('chat', null, 'failed');
    }
  } catch (e) {
    addMsg('system', '网络错误');
    logEvent('chat', null, 'network_error');
  }
  sending = false;
  sendBtn.disabled = !readyForChat;
}
sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

loadSession();
</script>
</body>
</html>`;

export interface BootstrapData {
  user: { email: string; role: string; localSimulation: boolean };
  history: { role: string; content: string }[];
  scenarios: readonly { id: string; label: string; message: string }[];
  mcp: { connected: boolean; state: string };
  tools: string[];
  expectedTools: string[];
  conversationId: string;
  setup: { mcpConfigured: boolean; modelConfigured: boolean; tracingWrapped: boolean };
}

export function renderPage(bootstrap: BootstrapData, nonce: string): string {
  const json = JSON.stringify(bootstrap).replaceAll("<", "\\u003c");
  return PAGE_HTML.replace("__BOOTSTRAP__", json).replaceAll("__CSP_NONCE__", nonce);
}
