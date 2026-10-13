# agent-demo (Cloudflare investment-agent security demo)

Isolated synthetic-data demo. Two Workers: `src/agent` (frontend + ResearchAgent Durable Object) and `src/mcp` (stateless MCP + OAuth). App code in `apps/agent-demo`, configs in `.devin/agent-demo`.

## Verified commands (run from `apps/agent-demo`)

```sh
npm ci                                                          # pinned deps; node_modules is gitignored.
                                                                # postinstall bridges .devin/agent-demo/node_modules
                                                                # -> ../../apps/agent-demo/node_modules (setup:config)
npx tsc --noEmit -p ../../.devin/agent-demo/tsconfig.json       # typecheck
npx vitest run -c ../../.devin/agent-demo/vitest.config.ts      # full suite
npx wrangler deploy --dry-run -c ../../.devin/agent-demo/wrangler.agent.jsonc
npx wrangler deploy --dry-run -c ../../.devin/agent-demo/wrangler.mcp.jsonc
```

Test evidence logs live under `apps/agent-demo/test/evidence/` (gitignored).

## Test topology

- `test/entry.ts` mounts both workers in the runner (MCP paths routed to `src/mcp`); `wrangler.test.jsonc` supplies local D1/KV/vars plus `ACCESS_TEST_JWKS_JSON` (local JWKS only; `TEAM_DOMAIN` issuer is never fetched).
- A second Miniflare worker named `mcp` serves `test/aux-mcp-entry.ts` (esbuild-bundled at config load into `.wrangler/vitest-aux/mcp.mjs`). `miniflare.outboundService: "mcp"` routes the Durable Object's outbound fetches (e.g. `http://localhost/mcp`) to it, giving the agent→MCP path a real transport inside the pool. The aux entry only re-adds the `Host` header that workerd's socket layer supplies in production.
- `test/helpers.ts#connectAgentMcp` performs the real OAuth connect: `/api/connect` → `addMcpServer` → discovery → DCR `/register` → Access-JWT consent (`/authorize`) → `/token` → `initialize`/`tools/list` → `ready`.

## Local development (named `local` environment)

Both configs carry an `env.local` block (local origins, loopback hosts, local KV/D1 ids, simulated-identity allowlist — never a production bypass).

```sh
npm ci
# MCP worker on :8788 (first terminal)
npx wrangler dev -c ../../.devin/agent-demo/wrangler.mcp.jsonc --env local --port 8788
# local D1 fixtures (second terminal, explicit --local only)
npx wrangler d1 execute demo-agent-db-local -c ../../.devin/agent-demo/wrangler.mcp.jsonc --env local --local --file=./migrations/0001_demo.sql
# Agent worker on :8787
npx wrangler dev -c ../../.devin/agent-demo/wrangler.agent.jsonc --env local --port 8787
```

Simulated identity is header-gated and loopback-only:

```sh
curl -H 'x-demo-local-role: analyst' http://localhost:8787/api/session
curl -H 'x-demo-local-role: analyst' http://localhost:8787/
# browser preview (injects the header for you):
node ../../.devin/agent-demo/preview-proxy.mjs   # http://127.0.0.1:8790
```

`x-demo-local-role` only works when `ENVIRONMENT=local`, `LOCAL_DEV_IDENTITY_ENABLED=true`, and the request arrives on a loopback host; the UI labels it as simulation, never as real Access/DLP. There is no role switching in production config.

Limits of the local loop: a browser cannot set `x-demo-local-role`, and the OAuth consent page on the MCP worker requires an Access JWT (or a locally minted token matching `ACCESS_TEST_JWKS_JSON` supplied via `.dev.vars`). Full local connect therefore needs either real Access secrets or test-JWKS material placed in `.devin/agent-demo/.dev.vars` (gitignored, read by Wrangler from the config directory — an Access JWT cannot be conjured by a secret alone; the header-preview path does not exercise the browser OAuth flow). Model calls additionally need real `ACCOUNT_ID`/`GATEWAY_ID`/`DASHSCOPE_API_KEY`/`CF_AIG_TOKEN`; `REPLACE_ME*` placeholders are treated as unconfigured by the code.

## Cloud prerequisites (not yet configured)

Approved production hostnames (custom domains, `workers_dev:false`): `agent-demo.righttu.uk` (frontend worker), `mcp-demo.righttu.uk` (MCP worker), `portal-demo.righttu.uk` (required MCP Portal endpoint for `MCP_SERVER_URL` — no direct-server fallback). Access team domain + AUDs, KV/D1 real IDs, `DASHSCOPE_API_KEY` + `CF_AIG_TOKEN` secrets, dedicated isolated AI Gateway `custom-dashscope` provider + DLP profile (marker `CF_DEMO_SECRET_9274`, Block Request), MCP Portal instance. Cloud Qwen, Access, Portal, DLP and native trace display remain unverified until those are supplied.

## VM runtime note

Test VM `/home/righttu/ai-finance/CloudFlare` (`master`, `origin git@github.com:righttu/DM-CF.git`): node/npm are not on the default PATH — source `~/.nvm/nvm.sh` (node v24.21.0, npm 12.2.0) before `npm ci`/`wrangler` in non-interactive SSH. The checked non-interactive SSH session did not expose Cloudflare credential environment variables; deployment needs an explicitly provisioned private environment file.
