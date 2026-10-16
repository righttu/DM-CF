import { describe, expect, it } from "vitest";
import { renderPage, type BootstrapData } from "../src/agent/ui.js";
import { ANALYST_EMAIL, authedFetch, signJwt } from "./helpers.js";

function baseBootstrap(overrides: Partial<BootstrapData> = {}): BootstrapData {
  return {
    user: { email: "analyst@example.com", role: "analyst", localSimulation: false, actorId: "actor-1" },
    history: [],
    mcp: { connected: false, state: "disconnected" },
    servers: [],
    suggestions: [{ title: "示例", message: "示例问题" }],
    modelId: "@cf/zai-org/glm-5.3-flash",
    conversationId: "conv-1",
    portal: { listAvailable: false, manageAvailable: false, pending: null },
    setup: {
      mcpConfigured: true,
      modelConfigured: true,
      tracingWrapped: true,
      accessLogoutUrl: "https://agent-demo.example/cdn-cgi/access/logout"
    },
    ...overrides
  };
}

describe("UI page", () => {
  it("renders production-style bootstrap with Access logout URL and explicit warnings", () => {
    const html = renderPage(baseBootstrap(), "nonce-1");
    expect(html).toContain("https://agent-demo.example/cdn-cgi/access/logout");
    expect(html).toContain("所有 Access 应用会话");
    expect(html).toContain("不保证撤销 MCP OAuth 授权");
    expect(html).toContain("断开 MCP 连接");
    expect(html).toContain("不删除聊天历史，也不撤销 Portal/上游已有授权");
    expect(html).toContain("当前邮箱来自 Access");
    expect(html).toContain("授权时请核对各自账号");
    expect(html).toContain("审计身份 ID");
    expect(html).toContain("actor-1");
    expect(html).toContain("replaceChildren");
    expect(html).toContain("连接与诊断");
    expect(html).toContain("退出登录");
    expect(html).toContain("新建会话");
    expect(html).toContain("从 Portal 读取列表");
    expect(html).toContain("管理/重新授权 MCP");
    expect(html).toContain("重新读取工具目录");
    expect(html).toContain("打开 Portal 原生管理页");
    expect(html).toContain("noopener");
    expect(html).toContain("noreferrer");
    expect(html).toContain("先连接 Portal");
    expect(html).toContain("数据仅供研究参考，不构成投资建议。");
    expect(html).not.toContain("innerHTML");
  });

  it("serves null accessLogoutUrl in local env", async () => {
    const jwt = await signJwt({ sub: "sub-logout-local", email: ANALYST_EMAIL });
    const resp = await authedFetch("/", { jwt });
    expect(resp.status).toBe(200);
    const html = await resp.text();
    const bootJson = /id="bootstrap"[^>]*>([^<]+)<\/script>/.exec(html)?.[1];
    expect(bootJson).toBeTruthy();
    const boot = JSON.parse(bootJson!) as {
      setup: { accessLogoutUrl: string | null };
      user: { actorId: string };
      servers: { id: string; label: string; tools: string[] }[];
      suggestions: { title: string; message: string }[];
      modelId: string;
    };
    expect(boot.setup.accessLogoutUrl).toBeNull();
    expect(typeof boot.user.actorId).toBe("string");
    expect(boot.user.actorId.length).toBeGreaterThan(0);
    expect(Array.isArray(boot.servers)).toBe(true);
    expect(Array.isArray(boot.suggestions)).toBe(true);
    expect(typeof boot.modelId).toBe("string");
  });

  it("pins the global [hidden] display rule and the markdown DOM renderer", () => {
    const html = renderPage(baseBootstrap(), "nonce-2");
    expect(html).toContain("[hidden]{display:none!important}");
    for (const marker of [
      "renderMarkdown",
      "parseInline",
      "createTextNode",
      "noopener noreferrer",
      "target = '_blank'"
    ]) {
      expect(html).toContain(marker);
    }
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("eval(");
  });

  it("requires auth on every request including the page", async () => {
    const resp = await authedFetch("/");
    expect(resp.status).toBe(401);
  });

  it("serves the page with the product layout and no role selector", async () => {
    const jwt = await signJwt({ sub: "sub-ui", email: ANALYST_EMAIL });
    const resp = await authedFetch("/", { jwt });
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("<select");
    expect(html).toContain("analyst@example.com");
    expect(html).toContain("ABC 投研 Agent");
    expect(html).toContain("执行过程");
    expect(html).toContain("切换主题");
  });

  it("rejects cross-origin mutations", async () => {
    const jwt = await signJwt({ sub: "sub-origin", email: ANALYST_EMAIL });
    const resp = await authedFetch("/api/chat", {
      jwt,
      method: "POST",
      body: { message: "hi" },
      headers: { origin: "https://evil.example" }
    });
    expect(resp.status).toBe(403);
  });
});
