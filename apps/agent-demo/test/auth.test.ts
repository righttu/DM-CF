import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  ANALYST_EMAIL,
  VIEWER_EMAIL,
  authedFetch,
  forgedJwt,
  signJwt,
  AGENT_AUD
} from "./helpers.js";

describe("Access JWT authentication", () => {
  it("denies missing token", async () => {
    const resp = await authedFetch("/api/session");
    expect(resp.status).toBe(401);
  });

  it("accepts a valid analyst JWT and returns normalized role", async () => {
    const jwt = await signJwt({ sub: "sub-analyst-1", email: " Analyst@Example.com " });
    const resp = await authedFetch("/api/session", { jwt });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { user: { role: string; email: string } };
    expect(data.user.role).toBe("analyst");
    expect(data.user.email).toBe("analyst@example.com");
  });

  it("denies a forged signature", async () => {
    const jwt = await forgedJwt();
    const resp = await authedFetch("/api/session", { jwt });
    expect(resp.status).toBe(401);
  });

  it("denies an expired token", async () => {
    const jwt = await signJwt({
      sub: "sub-exp",
      email: ANALYST_EMAIL,
      expiresInSeconds: -10
    });
    const resp = await authedFetch("/api/session", { jwt });
    expect(resp.status).toBe(401);
  });

  it("denies wrong issuer", async () => {
    const jwt = await signJwt({
      sub: "sub-iss",
      email: ANALYST_EMAIL,
      iss: "https://evil.cloudflareaccess.com"
    });
    const resp = await authedFetch("/api/session", { jwt });
    expect(resp.status).toBe(401);
  });

  it("denies wrong audience", async () => {
    const jwt = await signJwt({
      sub: "sub-aud",
      email: ANALYST_EMAIL,
      aud: "other-aud"
    });
    const resp = await authedFetch("/api/session", { jwt });
    expect(resp.status).toBe(401);
  });

  it("denies unknown email", async () => {
    const jwt = await signJwt({ sub: "sub-unknown", email: "mallory@evil.example" });
    const resp = await authedFetch("/api/session", { jwt });
    expect(resp.status).toBe(401);
  });

  it("denies missing email claim", async () => {
    const jwt = await signJwt({ sub: "sub-noemail", email: undefined });
    const resp = await authedFetch("/api/session", { jwt });
    expect(resp.status).toBe(401);
  });

  it("ignores frontend-supplied role headers and body", async () => {
    const jwt = await signJwt({ sub: "sub-viewer-1", email: VIEWER_EMAIL });
    const resp = await authedFetch("/api/session", {
      jwt,
      method: "POST",
      headers: { "x-demo-local-role": "analyst", "x-user-role": "analyst" }
    });
    expect(resp.status).not.toBe(200);
    const getResp = await authedFetch("/api/session", {
      jwt,
      headers: { "x-demo-local-role": "analyst", "x-user-role": "analyst" }
    });
    expect(getResp.status).toBe(200);
    const data = (await getResp.json()) as { user: { role: string } };
    expect(data.user.role).toBe("viewer");
  });

  it("keeps per-subject DO isolation for history and OAuth callbacks", async () => {
    const jwtA = await signJwt({ sub: "sub-iso-a", email: ANALYST_EMAIL });
    const jwtB = await signJwt({ sub: "sub-iso-b", email: ANALYST_EMAIL });
    const respB = await authedFetch("/api/session", { jwt: jwtB });
    const dataB = (await respB.json()) as { history: unknown[] };
    expect(dataB.history).toHaveLength(0);

    const { sha256Hex } = await import("../src/shared/access.js");
    const nameA = await sha256Hex("sub-iso-a");
    await (env as { CALLBACK_KV: KVNamespace }).CALLBACK_KV.put(
      "oauth-state:state-aaa",
      nameA
    );
    const cbB = await authedFetch("/mcp-oauth-callback?state=state-aaa&code=x", {
      jwt: jwtB
    });
    expect(cbB.status).toBe(403);
    const cbUnknown = await authedFetch("/mcp-oauth-callback?state=nope&code=x", {
      jwt: jwtA
    });
    expect(cbUnknown.status).toBe(404);
  });
});

import { sanitizeDiagnostic } from "../src/shared/access.js";

describe("sanitizeDiagnostic", () => {
  it("redacts secrets, JWTs, emails, auth URL params, and falls back generic", () => {
    expect(
      sanitizeDiagnostic("connect failed token=abcd123 for user@corp.example")
    ).toBe("connect failed token=[REDACTED] for [EMAIL]");
    expect(
      sanitizeDiagnostic("bad header Bearer AAA.BBB.CCC", ["AAA.BBB.CCC"])
    ).toBe("bad header [REDACTED]");
    expect(sanitizeDiagnostic(new Error("jwt eyJhbGciOi.xxx.yyy rejected"))).not.toContain(
      "eyJhbGciOi"
    );
    const url = sanitizeDiagnostic(
      "GET https://portal-demo.righttu.uk/authorize?state=secretstate&code=verysecret"
    );
    expect(url).not.toContain("secretstate");
    expect(url).not.toContain("verysecret");
    expect(url).toContain("/authorize");
    expect(sanitizeDiagnostic({ weird: true })).toBe("MCP 连接失败");
    expect(sanitizeDiagnostic(42)).toBe("MCP 连接失败");
  });
});
