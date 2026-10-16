import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyResult } from "jose";

export type DemoRole = "analyst" | "viewer";

export interface AccessIdentity {
  sub: string;
  email: string;
  role: DemoRole;
  localSimulation: boolean;
}

export interface AuditContext {
  actorId: string;
  userEmail?: string;
  role: DemoRole;
  requestId: string;
  identitySource: "access" | "local_jwt" | "local_simulation";
}

export interface AccessEnv {
  TEAM_DOMAIN?: string;
  ANALYST_EMAILS?: string;
  VIEWER_EMAILS?: string;
  ENVIRONMENT?: string;
  ACCESS_TEST_JWKS_JSON?: string;
  LOCAL_DEV_IDENTITY_ENABLED?: string;
  LOCAL_ANALYST_EMAIL?: string;
  LOCAL_VIEWER_EMAIL?: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function remoteJwks(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${teamDomain.replace(/\/+$/, "")}/cdn-cgi/access/certs`)
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

export function isLocalEnvironment(env: AccessEnv): boolean {
  return env.ENVIRONMENT === "local";
}

export function isLoopbackRequest(request: Request): boolean {
  const host = request.headers.get("host") ?? "";
  const hostname = host.split(":")[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function resolveRole(env: AccessEnv, email: string): DemoRole | null {
  const normalized = normalizeEmail(email);
  const parse = (value?: string) =>
    (value ?? "")
      .split(",")
      .map((entry) => normalizeEmail(entry))
      .filter((entry) => entry.length > 0);
  if (parse(env.ANALYST_EMAILS).includes(normalized)) return "analyst";
  if (parse(env.VIEWER_EMAILS).includes(normalized)) return "viewer";
  return null;
}

export function looksLikePlaceholder(value: string | undefined): boolean {
  return !value || /replace[-_]?(me|team)/i.test(value);
}

export function extractAccessToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header && header.trim().length > 0) return header.trim();
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "CF_Authorization") return rest.join("=");
  }
  return null;
}

export async function verifyAccessJwt(
  request: Request,
  env: AccessEnv,
  audience: string | undefined
): Promise<AccessIdentity | null> {
  if (!audience || !env.TEAM_DOMAIN) return null;
  if (looksLikePlaceholder(env.TEAM_DOMAIN)) return null;
  if (!isLocalEnvironment(env)) {
    try {
      if (new URL(env.TEAM_DOMAIN).protocol !== "https:") return null;
    } catch {
      return null;
    }
  }
  const token = extractAccessToken(request);
  if (!token) return null;
  try {
    const jwks =
      isLocalEnvironment(env) && env.ACCESS_TEST_JWKS_JSON
        ? createLocalJWKSet(JSON.parse(env.ACCESS_TEST_JWKS_JSON))
        : remoteJwks(env.TEAM_DOMAIN);
    const result: JWTVerifyResult = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      issuer: env.TEAM_DOMAIN.replace(/\/+$/, ""),
      audience
    });
    const payload = result.payload;
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.email !== "string" || payload.email.length === 0) return null;
    const role = resolveRole(env, payload.email);
    if (!role) return null;
    return {
      sub: payload.sub,
      email: normalizeEmail(payload.email),
      role,
      localSimulation: false
    };
  } catch {
    return null;
  }
}

export function localSimulatedIdentity(
  request: Request,
  env: AccessEnv
): AccessIdentity | null {
  if (!isLocalEnvironment(env)) return null;
  if (env.LOCAL_DEV_IDENTITY_ENABLED !== "true") return null;
  if (!isLoopbackRequest(request)) return null;
  const requested = (request.headers.get("x-demo-local-role") ?? "").trim().toLowerCase();
  const email =
    requested === "analyst"
      ? env.LOCAL_ANALYST_EMAIL
      : requested === "viewer"
        ? env.LOCAL_VIEWER_EMAIL
        : undefined;
  if (!email) return null;
  const role = resolveRole(env, email);
  if (!role || role !== requested) return null;
  return {
    sub: `local-${role}`,
    email: normalizeEmail(email),
    role,
    localSimulation: true
  };
}

export async function authenticate(
  request: Request,
  env: AccessEnv,
  audience: string | undefined
): Promise<AccessIdentity | null> {
  const identity = await verifyAccessJwt(request, env, audience);
  if (identity) return identity;
  return localSimulatedIdentity(request, env);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function checkBrowserOrigin(
  request: Request,
  allowedOrigin: string | undefined
): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (!allowedOrigin) return false;
  try {
    return new URL(origin).origin === new URL(allowedOrigin).origin;
  } catch {
    return false;
  }
}

export function sanitizeDiagnostic(
  error: unknown,
  secrets: readonly (string | undefined)[] = []
): string {
  let text: string;
  if (typeof error === "string") {
    text = error;
  } else if (error instanceof Error && typeof error.message === "string") {
    text = error.message;
  } else {
    return "MCP 连接失败";
  }
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  text = text.replace(/https?:\/\/[^\s"'<>`)\]]+/giu, (match) => {
    try {
      const u = new URL(match);
      return u.origin + u.pathname;
    } catch {
      return "[REDACTED]";
    }
  });
  text = text.replace(
    /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    "[REDACTED]"
  );
  text = text.replace(/Bearer\s+\S+/gi, "[REDACTED]");
  text = text.replace(
    /\b(token|secret|api_key|password|authorization|state|code_verifier|client_secret|authorization_code|code)\b(["']?\s*[:=]\s*["']?)[^\s&"',}\]]+/gi,
    "$1$2[REDACTED]"
  );
  text = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[EMAIL]");
  text = text.replace(/[A-Za-z0-9_-]{32,}/g, "[REDACTED]");
  return text.slice(0, 400);
}
