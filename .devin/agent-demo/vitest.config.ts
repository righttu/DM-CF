import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const appRoot = new URL("../../apps/agent-demo", import.meta.url).pathname;

export default defineConfig({
  root: "../../apps/agent-demo",
  plugins: [
    cloudflareTest(async () => {
      const auxDir = join(appRoot, ".wrangler", "vitest-aux");
      mkdirSync(auxDir, { recursive: true });
      const mcpBundle = join(auxDir, "mcp.mjs");
      await esbuild.build({
        entryPoints: [join(appRoot, "test/aux-mcp-entry.ts")],
        bundle: true,
        format: "esm",
        target: "esnext",
        platform: "neutral",
        mainFields: ["module", "main", "browser"],
        conditions: ["workerd", "worker", "import", "default"],
        external: ["cloudflare:*", "node:*"],
        outfile: mcpBundle,
        logLevel: "silent"
      });
      return {
      wrangler: {
        configPath: "../../.devin/agent-demo/wrangler.test.jsonc"
      },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
        outboundService: "mcp",
        workers: [
          {
            name: "mcp",
            scriptPath: mcpBundle,
            modules: true,
            compatibilityDate: "2026-08-22",
            compatibilityFlags: ["nodejs_compat"],
            d1Databases: { DEMO_DB: "demo-agent-db-test" },
            kvNamespaces: {
              OAUTH_KV: "test-oauth-kv",
              CONSENT_KV: "test-consent-kv"
            },
            bindings: {
              ENVIRONMENT: "local",
              TEAM_DOMAIN: "https://team.example.test",
              MCP_AUTHORIZE_ACCESS_AUD: "test-mcp-aud",
              PUBLIC_MCP_ORIGIN: "http://localhost",
              ALLOWED_ORIGINS: "http://localhost",
              ANALYST_EMAILS: "analyst@example.com",
              VIEWER_EMAILS: "viewer@example.com",
              ACCESS_TEST_JWKS_JSON:
                '{"keys":[{"kty":"RSA","n":"sId9Bo01-FfSxOU4i1oOZr630Qa-7K4yWKkdl5eiEZjWR8aFfb2mGzt5k9Hllw5UUSrkUrq-BN1f08SVLjt-ufFrQ6XK4Asc4IFo58Ed4WteED0ovJ44Rhdjvb_SHkZDUaoeJmhhlQ67ZBWkRlWSA5c2jZpTurcaUc0LLkMsHZZH3LhOaiZ8BIOZZe2u1IBn4IKp3oi-DcEjdnKdPUr8ZQ51bHuDdYI_EWyd595YVFSWk1Os3203-q6_577Uec-suqlw-FoYvDsWUkZnB5pW03zFGe8V25KW8GyUa8rH16tS_bRgxOhwPncD_YKUgXGXQs31ZrL8StvmEBnDKl3n7Q","e":"AQAB","kid":"test-key-1","alg":"RS256","use":"sig"}]}'
            }
          }
        ],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            new URL("../../apps/agent-demo/migrations", import.meta.url).pathname
          )
        }
      }
      };
    })
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 30000
  }
});
