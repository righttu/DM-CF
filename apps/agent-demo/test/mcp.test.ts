import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { checkMcpScope } from "../src/mcp/index.js";
import { sha256Hex } from "../src/shared/access.js";
import {
  MCP_AUD,
  VIEWER_EMAIL,
  ANALYST_EMAIL,
  getSetCookies,
  mergeCookieHeader,
  mcpFetch,
  signJwt
} from "./helpers.js";

async function registerClient(): Promise<{ clientId: string; redirectUri: string }> {
  const resp = await mcpFetch("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test-client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: ["http://localhost/mcp-oauth-callback"]
    })
  });
  expect(resp.status).toBeLessThan(300);
  const data = (await resp.json()) as { client_id: string };
  return { clientId: data.client_id, redirectUri: "http://localhost/mcp-oauth-callback" };
}

function pkce() {
  const verifier = "test-verifier-" + crypto.randomUUID().replaceAll("-", "");
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(verifier))
    .then((d) => ({
      verifier,
      challenge: btoa(String.fromCharCode(...new Uint8Array(d)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")
    }));
}

async function runAuthorizeGet(jwt: string, clientId: string, redirectUri: string) {
  const { challenge } = await pkce();
  const url =
    `/authorize?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=mcp%3Aread&state=oauthstate1` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&resource=${encodeURIComponent("http://localhost/mcp")}`;
  return mcpFetch(url, { headers: { "cf-access-jwt-assertion": jwt } });
}

describe("MCP OAuth + tools", () => {
  it("rejects /mcp without a token with a Bearer challenge", async () => {
    const resp = await mcpFetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(resp.status).toBe(401);
    expect(resp.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("serves OAuth discovery metadata (library-implemented protocol)", async () => {
    const resp = await mcpFetch("/.well-known/oauth-authorization-server");
    expect(resp.status).toBe(200);
    const meta = (await resp.json()) as Record<string, string>;
    expect(meta.authorization_endpoint).toContain("/authorize");
    expect(meta.token_endpoint).toContain("/token");
    expect(meta.registration_endpoint).toContain("/register");
  });

  it("denies consent POST without Access JWT, with swapped subject, missing and reused handle", async () => {
    const { clientId, redirectUri } = await registerClient();
    const jwtA = await signJwt({ sub: "sub-consent-a", email: ANALYST_EMAIL, aud: MCP_AUD });
    const jwtB = await signJwt({ sub: "sub-consent-b", email: ANALYST_EMAIL, aud: MCP_AUD });

    const getResp = await runAuthorizeGet(jwtA, clientId, redirectUri);
    expect(getResp.status).toBe(200);
    const html = await getResp.text();
    expect(html).toContain("test-client");
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
    expect(handle).toBeTruthy();
    const cookies = mergeCookieHeader(getSetCookies(getResp));

    const noJwt = await mcpFetch("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
      body: `handle=${encodeURIComponent(handle!)}&decision=approve`
    });
    expect(noJwt.status).toBe(401);

    const swapped = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwtB
      },
      body: `handle=${encodeURIComponent(handle!)}&decision=approve`
    });
    expect(swapped.status).toBe(403);

    const missingHandle = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwtA
      },
      body: `decision=approve`
    });
    expect(missingHandle.status).toBe(400);

    const approved = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwtA
      },
      body: `handle=${encodeURIComponent(handle!)}&decision=approve`
    });
    expect(approved.status).toBe(302);
    const location = approved.headers.get("location") ?? "";
    expect(location).toContain("code=");
    expect(location).toContain("state=oauthstate1");

    const reused = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwtA
      },
      body: `handle=${encodeURIComponent(handle!)}&decision=approve`
    });
    expect([400, 403]).toContain(reused.status);
  });

  it("rejects missing or unknown consent decisions, wrong cookies, and cross-origin POSTs", async () => {
    const { clientId, redirectUri } = await registerClient();
    const jwt = await signJwt({ sub: "sub-decisions", email: ANALYST_EMAIL, aud: MCP_AUD });

    const getResp = await runAuthorizeGet(jwt, clientId, redirectUri);
    const html = await getResp.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
    const cookies = mergeCookieHeader(getSetCookies(getResp));

    const missingDecision = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwt
      },
      body: `handle=${encodeURIComponent(handle)}`
    });
    expect(missingDecision.status).toBe(400);

    const unknownDecision = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwt
      },
      body: `handle=${encodeURIComponent(handle)}&decision=maybe`
    });
    expect(unknownDecision.status).toBe(400);

    const wrongCookie = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "__Host-consent=forged",
        "cf-access-jwt-assertion": jwt
      },
      body: `handle=${encodeURIComponent(handle)}&decision=approve`
    });
    expect([400, 403]).toContain(wrongCookie.status);

    const foreignOrigin = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwt,
        origin: "https://evil.example"
      },
      body: `handle=${encodeURIComponent(handle)}&decision=approve`
    });
    expect(foreignOrigin.status).toBe(403);

    const portOrigin = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwt,
        origin: "http://localhost:9999"
      },
      body: `handle=${encodeURIComponent(handle)}&decision=approve`
    });
    expect(portOrigin.status).toBe(403);
  });

  it("consent GET sends same-origin referrer policy and POST accepts the exact configured origin", async () => {
    const { clientId, redirectUri } = await registerClient();
    const jwt = await signJwt({ sub: "sub-consent-hdr", email: ANALYST_EMAIL, aud: MCP_AUD });
    const getResp = await runAuthorizeGet(jwt, clientId, redirectUri);
    expect(getResp.status).toBe(200);
    expect(getResp.headers.get("referrer-policy")).toBe("same-origin");
    expect(getResp.headers.get("x-frame-options")).toBe("DENY");
    expect(getResp.headers.get("cache-control")).toContain("no-store");
    expect(getResp.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await getResp.text();
    expect(html).toContain("授权账号");
    expect(html).toContain(ANALYST_EMAIL);
    expect(html).toContain("analyst");
    expect(html).not.toContain("复用 Access 登录");
    expect(html).toContain("只读（mcp:read）");
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
    const cookies = mergeCookieHeader(getSetCookies(getResp));

    const post = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwt,
        origin: "http://localhost"
      },
      body: `handle=${encodeURIComponent(handle)}&decision=approve`
    });
    expect(post.status).toBe(302);
    const location = post.headers.get("location") ?? "";
    expect(location).toContain("code=");
    expect(location).toContain("state=oauthstate1");
  });

  it("rejects opaque and foreign Origin values without consuming the consent handle", async () => {
    const { clientId, redirectUri } = await registerClient();
    const jwt = await signJwt({ sub: "sub-origin-neg", email: ANALYST_EMAIL, aud: MCP_AUD });
    const getResp = await runAuthorizeGet(jwt, clientId, redirectUri);
    const html = await getResp.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
    const cookies = mergeCookieHeader(getSetCookies(getResp));

    for (const origin of [
      "null",
      "https://evil.example",
      "http://localhost:9999",
      "https://localhost",
      "not-an-origin"
    ]) {
      const resp = await mcpFetch("/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookies,
          "cf-access-jwt-assertion": jwt,
          origin
        },
        body: `handle=${encodeURIComponent(handle)}&decision=approve`
      });
      expect(resp.status).toBe(403);
      const data = (await resp.json()) as { error: string };
      expect(data.error).toBe("origin_not_allowed");
      expect(resp.headers.get("referrer-policy")).toBe("no-referrer");
    }

    const approved = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwt,
        origin: "http://localhost"
      },
      body: `handle=${encodeURIComponent(handle)}&decision=approve`
    });
    expect(approved.status).toBe(302);
    expect(approved.headers.get("location") ?? "").toContain("code=");
  });

  it("deny decision redirects with an error and never issues a code", async () => {
    const { clientId, redirectUri } = await registerClient();
    const jwt = await signJwt({ sub: "sub-deny", email: ANALYST_EMAIL, aud: MCP_AUD });
    const getResp = await runAuthorizeGet(jwt, clientId, redirectUri);
    const html = await getResp.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
    const cookies = mergeCookieHeader(getSetCookies(getResp));

    const denied = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwt,
        origin: "http://localhost"
      },
      body: `handle=${encodeURIComponent(handle)}&decision=deny`
    });
    expect(denied.status).toBe(302);
    const location = denied.headers.get("location") ?? "";
    expect(location).not.toContain("code=");
    expect(location.toLowerCase()).toContain("error");
  });

  it("completes full OAuth flow and serves viewer tools over real transport", async () => {
    const { clientId, redirectUri } = await registerClient();
    const jwt = await signJwt({ sub: "sub-flow-v", email: VIEWER_EMAIL, aud: MCP_AUD });
    const { verifier, challenge } = await pkce();

    const getResp = await mcpFetch(
      `/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=mcp%3Aread&state=st2&code_challenge=${challenge}&code_challenge_method=S256` +
        `&resource=${encodeURIComponent("http://localhost/mcp")}`,
      { headers: { "cf-access-jwt-assertion": jwt } }
    );
    const html = await getResp.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
    const cookies = mergeCookieHeader(getSetCookies(getResp));

    const postResp = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwt,
        origin: "http://localhost"
      },
      body: `handle=${encodeURIComponent(handle)}&decision=approve`
    });
    const location = new URL(postResp.headers.get("location")!);
    const code = location.searchParams.get("code")!;

    const tokenResp = await mcpFetch("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:
        `grant_type=authorization_code&code=${code}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${clientId}` +
        `&code_verifier=${verifier}`
    });
    expect(tokenResp.status).toBe(200);
    const token = (await tokenResp.json()) as { access_token: string };

    const rpc = async (method: string, params: unknown, id: number) => {
      const r = await mcpFetch("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token.access_token}`
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
      });
      const text = await r.text();
      const dataLine = text
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
      return { status: r.status, body: JSON.parse(dataLine ?? text) as Record<string, unknown> };
    };

    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" }
    }, 1);
    expect(init.status).toBe(200);

    const listResp = await rpc("tools/list", {}, 2);
    const toolNames = (((listResp.body.result as { tools?: { name: string }[] })?.tools) ?? []).map((t) => t.name);
    expect(toolNames).toContain("list_demo_companies");
    expect(toolNames).toContain("get_latest_analysis");
    expect(toolNames).not.toContain("read_research_document");

    const companiesReqId = crypto.randomUUID();
    const companiesConvId = crypto.randomUUID();
    const companiesResp = await rpc("tools/call", {
      name: "list_demo_companies",
      arguments: {},
      _meta: {
        "uk.righttu.demo/request_id": companiesReqId,
        "uk.righttu.demo/conversation_id": companiesConvId,
        actorId: "forged-actor",
        role: "analyst"
      }
    }, 3);
    const companiesPayload = JSON.parse(((companiesResp.body.result as { content?: { text?: string }[] })?.content?.[0].text) ?? "{}");
    expect(companiesPayload.companies).toHaveLength(2);
    expect(companiesPayload.is_demo).toBe(true);
    const companiesAudit = (
      companiesResp.body.result as {
        _meta?: Record<
          string,
          { actorId: string; role: string; requestId: string; conversationId: string | null }
        >;
      }
    )?._meta?.["uk.righttu.demo/audit"];
    expect(companiesAudit?.actorId).toBe(await sha256Hex("sub-flow-v"));
    expect(companiesAudit?.role).toBe("viewer");
    expect(companiesAudit?.requestId).toBe(companiesReqId);
    expect(companiesAudit?.conversationId).toBe(companiesConvId);

    const badMetaResp = await rpc("tools/call", {
      name: "list_demo_companies",
      arguments: {},
      _meta: {
        "uk.righttu.demo/request_id": "x".repeat(500),
        "uk.righttu.demo/conversation_id": "Bearer a.b.c",
        actorId: "forged",
        email: "forged@example.com"
      }
    }, 11);
    const badAudit = (
      badMetaResp.body.result as {
        _meta?: Record<
          string,
          { actorId: string; role: string; requestId: string; conversationId: string | null }
        >;
      }
    )?._meta?.["uk.righttu.demo/audit"];
    expect(badAudit?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(badAudit?.requestId).not.toBe("x".repeat(500));
    expect(badAudit?.conversationId).toBeNull();
    expect(badAudit?.actorId).toBe(await sha256Hex("sub-flow-v"));

    const latestResp = await rpc(
      "tools/call",
      { name: "get_latest_analysis", arguments: { company_id: "DEMO001" } },
      4
    );
    const latestPayload = JSON.parse(((latestResp.body.result as { content?: { text?: string }[] })?.content?.[0].text) ?? "{}");
    expect(latestPayload.report.report_date).toBe("2026-10-12");
    expect(latestPayload.report.source_id).toBe("demo-report-a-20261012");

    const invalidResp = await rpc(
      "tools/call",
      { name: "get_latest_analysis", arguments: { company_id: "EVIL001" } },
      5
    );
    const invalidText = ((invalidResp.body.result as { content?: { text?: string }[] })?.content?.[0].text) ?? "";
    expect(invalidText.length).toBeGreaterThan(0);
    expect(invalidText).not.toContain("demo-report");
    expect(invalidResp.body.error ?? (invalidResp.body.result as { isError?: boolean })?.isError ?? invalidText.toLowerCase().includes("invalid")).toBeTruthy();

    const guessedDoc = await rpc(
      "tools/call",
      { name: "read_research_document", arguments: { document_id: "research-note-a" }, _meta: { actorId: "spoof" } },
      6
    );
    expect(JSON.stringify(guessedDoc.body)).not.toContain("客户集中风险");

    const evilOrigin = await mcpFetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.access_token}`,
        origin: "https://evil.example"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} })
    });
    expect(evilOrigin.status).toBeGreaterThanOrEqual(400);

    const portMismatch = await mcpFetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.access_token}`,
        origin: "http://localhost:9999"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} })
    });
    expect(portMismatch.status).toBe(403);

    const schemeMismatch = await mcpFetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.access_token}`,
        origin: "https://localhost"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} })
    });
    expect(schemeMismatch.status).toBe(403);

    const hostAlias = await mcpFetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.access_token}`,
        origin: "http://frontend-host"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} })
    });
    expect(hostAlias.status).toBe(403);
  });

  it("stores consent transactions in the per-handle DO, not OAUTH_KV, and survives CONSENT_KV failure", async () => {
    const { clientId, redirectUri } = await registerClient();
    const jwt = await signJwt({ sub: "sub-do-store", email: ANALYST_EMAIL, aud: MCP_AUD });
    const txnPuts: string[] = [];
    const kvs = env as unknown as { OAUTH_KV: KVNamespace; CONSENT_KV: KVNamespace };
    const origPut = kvs.OAUTH_KV.put.bind(kvs.OAUTH_KV);
    const origKvGet = kvs.CONSENT_KV.get;
    kvs.OAUTH_KV.put = ((key: string, value: string, options?: unknown) => {
      if (/^transaction:/.test(key)) txnPuts.push(key);
      return origPut(key, value, options as never);
    }) as KVNamespace["put"];
    kvs.CONSENT_KV.get = (() => {
      throw new Error("CONSENT_KV must not be used");
    }) as KVNamespace["get"];
    try {
      const getResp = await runAuthorizeGet(jwt, clientId, redirectUri);
      expect(getResp.status).toBe(200);
      const html = await getResp.text();
      const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
      const cookies = mergeCookieHeader(getSetCookies(getResp));
      const hash = await sha256Hex(handle);
      const ns = (env as unknown as { CONSENT_TRANSACTIONS: DurableObjectNamespace })
        .CONSENT_TRANSACTIONS;
      const stub = ns.get(ns.idFromName(hash));
      const blob = await runInDurableObject(stub as never, (instance) =>
        (instance as unknown as { ctx: { storage: DurableObjectStorage } }).ctx.storage.get("blob")
      );
      expect(typeof blob).toBe("string");
      expect(txnPuts).toHaveLength(0);
      const approved = await mcpFetch("/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookies,
          "cf-access-jwt-assertion": jwt,
          origin: "http://localhost"
        },
        body: `handle=${encodeURIComponent(handle)}&decision=approve`
      });
      expect(approved.status).toBe(302);
      expect(approved.headers.get("location") ?? "").toContain("code=");
      expect(txnPuts).toHaveLength(0);
    } finally {
      kvs.OAUTH_KV.put = origPut;
      kvs.CONSENT_KV.get = origKvGet;
    }
  });

  it("returns distinct errors for wrong subject vs missing handle; wrong cookie does not consume", async () => {
    const { clientId, redirectUri } = await registerClient();
    const jwtA = await signJwt({ sub: "sub-do-a", email: ANALYST_EMAIL, aud: MCP_AUD });
    const jwtB = await signJwt({ sub: "sub-do-b", email: ANALYST_EMAIL, aud: MCP_AUD });
    const getResp = await runAuthorizeGet(jwtA, clientId, redirectUri);
    const html = await getResp.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
    const cookies = mergeCookieHeader(getSetCookies(getResp));
    const post = (extra: Record<string, string>, body: string) =>
      mcpFetch("/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookies,
          origin: "http://localhost",
          ...extra
        },
        body
      });
    const swapped = await post(
      { "cf-access-jwt-assertion": jwtB },
      `handle=${encodeURIComponent(handle)}&decision=approve`
    );
    expect(swapped.status).toBe(403);
    expect(((await swapped.json()) as { error: string }).error).toBe("consent_subject_mismatch");
    const random = await post(
      { "cf-access-jwt-assertion": jwtA },
      `handle=${encodeURIComponent("does-not-exist-handle")}&decision=approve`
    );
    expect(random.status).toBe(403);
    expect(((await random.json()) as { error: string }).error).toBe("consent_expired_or_used");
    const wrongCookie = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "__Host-consent=forged",
        "cf-access-jwt-assertion": jwtA,
        origin: "http://localhost"
      },
      body: `handle=${encodeURIComponent(handle)}&decision=approve`
    });
    expect(wrongCookie.status).toBe(403);
    const approved = await post(
      { "cf-access-jwt-assertion": jwtA },
      `handle=${encodeURIComponent(handle)}&decision=approve`
    );
    expect(approved.status).toBe(302);
    expect(approved.headers.get("location") ?? "").toContain("code=");
  });

  it("serializes concurrent decisions on one handle and keeps separate handles independent", async () => {
    const { clientId, redirectUri } = await registerClient();
    const jwt = await signJwt({ sub: "sub-do-race", email: ANALYST_EMAIL, aud: MCP_AUD });
    const begin = async () => {
      const getResp = await runAuthorizeGet(jwt, clientId, redirectUri);
      const html = await getResp.text();
      return {
        handle: /name="handle" value="([^"]+)"/.exec(html)?.[1]!,
        cookies: mergeCookieHeader(getSetCookies(getResp))
      };
    };
    const post = (h: string, c: string, decision: string) =>
      mcpFetch("/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: c,
          "cf-access-jwt-assertion": jwt,
          origin: "http://localhost"
        },
        body: `handle=${encodeURIComponent(h)}&decision=${decision}`
      });
    const first = await begin();
    const [r1, r2] = await Promise.all([
      post(first.handle, first.cookies, "approve"),
      post(first.handle, first.cookies, "approve")
    ]);
    expect([r1.status, r2.status].sort()).toEqual([302, 403]);
    const second = await begin();
    const [d1, d2] = await Promise.all([
      post(second.handle, second.cookies, "approve"),
      post(second.handle, second.cookies, "deny")
    ]);
    expect([d1.status, d2.status].sort()).toEqual([302, 403]);
    const third = await begin();
    const fourth = await begin();
    const [i1, i2] = await Promise.all([
      post(third.handle, third.cookies, "approve"),
      post(fourth.handle, fourth.cookies, "approve")
    ]);
    expect(i1.status).toBe(302);
    expect(i2.status).toBe(302);
    expect(third.handle).not.toBe(fourth.handle);
  });

  it("rejects expired transactions stored in the DO", async () => {
    const { clientId, redirectUri } = await registerClient();
    const jwt = await signJwt({ sub: "sub-do-ttl", email: ANALYST_EMAIL, aud: MCP_AUD });
    const getResp = await runAuthorizeGet(jwt, clientId, redirectUri);
    const html = await getResp.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
    const cookies = mergeCookieHeader(getSetCookies(getResp));
    const hash = await sha256Hex(handle);
    const ns = (env as unknown as { CONSENT_TRANSACTIONS: DurableObjectNamespace })
      .CONSENT_TRANSACTIONS;
    const stub = ns.get(ns.idFromName(hash));
    await runInDurableObject(stub as never, (instance) =>
      (instance as unknown as { ctx: { storage: DurableObjectStorage } }).ctx.storage.put(
        "expiresAt",
        Date.now() - 1000
      )
    );
    const resp = await mcpFetch("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies,
        "cf-access-jwt-assertion": jwt,
        origin: "http://localhost"
      },
      body: `handle=${encodeURIComponent(handle)}&decision=approve`
    });
    expect(resp.status).toBe(403);
    const body = await resp.text();
    expect((JSON.parse(body) as { error: string }).error).toBe("consent_expired_or_used");
    expect(body).not.toContain("sub-do-ttl");
  });

  it("scope check enforces mcp:read", () => {
    const denied = checkMcpScope({
      token: "t",
      clientId: "c",
      scope: ["other:scope"],
      expiresAt: 0,
      userId: "u",
      audience: "http://localhost/mcp"
    });
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
    expect(checkMcpScope(undefined)!.status).toBe(401);
    expect(
      checkMcpScope({
        token: "t",
        clientId: "c",
        scope: ["mcp:read"],
        expiresAt: 0,
        userId: "u",
        audience: "http://localhost/mcp"
      })
    ).toBeNull();
  });
});
