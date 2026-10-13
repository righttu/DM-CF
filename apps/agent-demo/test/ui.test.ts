import { describe, expect, it } from "vitest";
import { ANALYST_EMAIL, authedFetch, signJwt } from "./helpers.js";

describe("UI page", () => {
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
