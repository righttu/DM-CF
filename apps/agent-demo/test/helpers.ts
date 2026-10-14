import { SignJWT, importJWK, generateKeyPair } from "jose";
import { SELF } from "cloudflare:test";
import { TEST_PRIVATE_JWK, TEST_ISSUER } from "./keys.js";

const privateKeyPromise = importJWK({ ...TEST_PRIVATE_JWK }, "RS256");

export const AGENT_AUD = "test-agent-aud";
export const MCP_AUD = "test-mcp-aud";
export const ANALYST_EMAIL = "analyst@example.com";
export const VIEWER_EMAIL = "viewer@example.com";

export async function signJwt(options: {
  sub: string;
  email?: string;
  aud?: string;
  iss?: string;
  expiresInSeconds?: number;
  extraClaims?: Record<string, unknown>;
  privateKey?: CryptoKey;
}): Promise<string> {
  const key = options.privateKey ?? (await privateKeyPromise);
  let builder = new SignJWT({
    email: options.email,
    ...(options.extraClaims ?? {})
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setSubject(options.sub)
    .setIssuer(options.iss ?? TEST_ISSUER)
    .setAudience(options.aud ?? AGENT_AUD)
    .setIssuedAt();
  const seconds = options.expiresInSeconds ?? 300;
  builder = builder.setExpirationTime(Math.floor(Date.now() / 1000) + seconds);
  return builder.sign(key);
}

export async function forgedJwt(): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return signJwt({
    sub: "forged-sub",
    email: ANALYST_EMAIL,
    privateKey
  });
}

export function authedFetch(
  path: string,
  init: {
    jwt?: string | null;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    url?: string;
  } = {}
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("host")) headers.set("host", "localhost");
  if (init.jwt) headers.set("cf-access-jwt-assertion", init.jwt);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const request = new Request(init.url ?? `http://localhost${path}`, {
    method: init.method ?? "GET",
    headers,
    redirect: "manual",
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  return SELF.fetch(request);
}

export function mcpFetch(
  path: string,
  init: {
    method?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
    redirect?: "manual" | "follow" | "error";
  } = {}
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("host")) headers.set("host", "localhost");
  return SELF.fetch(
    new Request(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers,
      redirect: init.redirect ?? "manual",
      body: init.body
    })
  );
}

export function getSetCookies(resp: Response): string[] {
  const headers = resp.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

export function mergeCookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

export async function connectAgentMcp(input: {
  sub: string;
  email: string;
}): Promise<void> {
  const agentJwt = await signJwt({ sub: input.sub, email: input.email, aud: AGENT_AUD });
  const connectResp = await authedFetch("/api/connect", {
    jwt: agentJwt,
    method: "POST",
    body: {}
  });
  const connectData = (await connectResp.json()) as {
    status: string;
    authUrl?: string;
  };
  if (connectData.status === "ready") return;
  if (!connectData.authUrl) {
    throw new Error(`connect failed: ${JSON.stringify(connectData)}`);
  }
  const authUrl = new URL(connectData.authUrl);
  const mcpJwt = await signJwt({ sub: input.sub, email: input.email, aud: MCP_AUD });
  const consentGet = await mcpFetch(`${authUrl.pathname}${authUrl.search}`, {
    headers: { "cf-access-jwt-assertion": mcpJwt }
  });
  const html = await consentGet.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) throw new Error("no consent handle");
  const cookies = mergeCookieHeader(getSetCookies(consentGet));
  const consentPost = await mcpFetch("/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookies,
      "cf-access-jwt-assertion": mcpJwt,
      origin: authUrl.origin
    },
    body: `handle=${encodeURIComponent(handle)}&decision=approve`
  });
  if (consentPost.status !== 302) {
    throw new Error(`consent POST failed: ${consentPost.status}`);
  }
  const cbUrl = new URL(consentPost.headers.get("location")!);
  const cbResp = await authedFetch(`${cbUrl.pathname}${cbUrl.search}`, {
    jwt: agentJwt
  });
  if (![200, 302].includes(cbResp.status)) {
    throw new Error(`callback failed: ${cbResp.status}`);
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const session = await authedFetch("/api/session", { jwt: agentJwt });
    const data = (await session.json()) as { mcp?: { connected?: boolean } };
    if (data.mcp?.connected) return;
  }
  throw new Error("mcp did not reach ready state");
}
