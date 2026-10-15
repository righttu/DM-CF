import { describe, expect, it } from "vitest";
import { renderPage, type BootstrapData } from "../src/agent/ui.js";
import { ANALYST_EMAIL, authedFetch, signJwt } from "./helpers.js";

describe("UI page", () => {
  it("renders production-style bootstrap with Access logout URL and explicit warnings", () => {
    const bootstrap: BootstrapData = {
      user: { email: "analyst@example.com", role: "analyst", localSimulation: false, actorId: "actor-1" },
      history: [],
      scenarios: [],
      mcp: { connected: false, state: "disconnected" },
      tools: [],
      expectedTools: [],
      conversationId: "conv-1",
      setup: {
        mcpConfigured: true,
        modelConfigured: true,
        tracingWrapped: true,
        accessLogoutUrl: "https://agent-demo.example/cdn-cgi/access/logout"
      }
    };
    const html = renderPage(bootstrap, "nonce-1");
    expect(html).toContain("https://agent-demo.example/cdn-cgi/access/logout");
    expect(html).toContain("退出 Access 登录");
    expect(html).toContain("所有 Access 应用会话");
    expect(html).toContain("不保证撤销 MCP OAuth 授权");
    expect(html).toContain("断开 MCP 连接");
    expect(html).toContain("不删除聊天历史，也不撤销 Portal/上游已有授权");
    expect(html).toContain("当前邮箱来自 Access");
    expect(html).toContain("授权时请核对各自账号");
    expect(html).toContain("审计身份 ID");
    expect(html).toContain("actor-1");
    expect(html).toContain("replaceChildren");
    expect(html).toContain("MCP 服务器");
    expect(html).toContain("从 Portal 读取列表");
    expect(html).toContain("管理/重新授权 MCP");
    expect(html).toContain("重新读取工具目录");
    expect(html).toContain("打开 Portal 原生管理页");
    expect(html).toContain("noopener");
    expect(html).toContain("noreferrer");
    expect(html).toContain("先连接 Portal");
    expect(html).not.toContain("innerHTML");
  });

  it("serves null accessLogoutUrl and a disabled logout label in local env", async () => {
    const jwt = await signJwt({ sub: "sub-logout-local", email: ANALYST_EMAIL });
    const resp = await authedFetch("/", { jwt });
    expect(resp.status).toBe(200);
    const html = await resp.text();
    const bootJson = /id="bootstrap"[^>]*>([^<]+)<\/script>/.exec(html)?.[1];
    expect(bootJson).toBeTruthy();
    const boot = JSON.parse(bootJson!) as {
      setup: { accessLogoutUrl: string | null };
      user: { actorId: string };
    };
    expect(boot.setup.accessLogoutUrl).toBeNull();
    expect(typeof boot.user.actorId).toBe("string");
    expect(boot.user.actorId.length).toBeGreaterThan(0);
    expect(html).toContain("未接入真实 Access 退出");
  });

  it("pins the global [hidden] display rule so badges cannot leak visible", () => {
    const html = renderPage(
      {
        user: { email: "a@example.com", role: "viewer", localSimulation: false, actorId: "actor-x" },
        history: [],
        scenarios: [],
        mcp: { connected: false, state: "disconnected" },
        tools: [],
        expectedTools: [],
        conversationId: "c",
        portal: { listAvailable: false, manageAvailable: false, pending: null },
        setup: {
          mcpConfigured: true,
          modelConfigured: true,
          tracingWrapped: true,
          accessLogoutUrl: "https://agent-demo.example/cdn-cgi/access/logout"
        }
      },
      "nonce-2"
    );
    expect(html).toContain("[hidden]{display:none!important}");
    const badgeRule = html.indexOf(".badge{display:inline-block");
    const hiddenRule = html.indexOf("[hidden]{display:none!important}");
    expect(badgeRule).toBeGreaterThanOrEqual(0);
    expect(hiddenRule).toBeGreaterThan(badgeRule);
  });

  it("requires auth on every request including the page", async () => {
    const resp = await authedFetch("/");
    expect(resp.status).toBe(401);
  });

  it("serves the page with safe badges and no role selector", async () => {
    const jwt = await signJwt({ sub: "sub-ui", email: ANALYST_EMAIL });
    const resp = await authedFetch("/", { jwt });
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("合成数据");
    expect(html).toContain("只读");
    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("<select");
    expect(html).toContain("analyst@example.com");
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
