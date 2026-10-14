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

Approved production hostnames (custom domains, `workers_dev:false`): `agent-demo.righttu.uk` (frontend worker), `mcp-demo.righttu.uk` (MCP worker), `portal-demo.righttu.uk` (required MCP Portal endpoint for `MCP_SERVER_URL` — no direct-server fallback).

Cloud state: both workers are live on their custom domains — MCP `https://mcp-demo.righttu.uk` (version `8135f2a9-c819-447a-8d29-e70230e00f16`), frontend `https://agent-demo.righttu.uk` (version `95660304-74e7-4ccd-9e5b-a7c68419c22e`), source `81e7b52`. Isolated D1 `demo-agent-db` is seeded from `migrations/0001_demo.sql` (3 reports / 3 docs); KV (CALLBACK/OAUTH/CONSENT) and dedicated AI Gateway `agent-demo` (auth + byok_only, caching disabled, 30 req/60 s) are frozen in the configs. `DASHSCOPE_API_KEY` + `CF_AIG_TOKEN` are set as worker secrets. Verified model connectivity from the VM using the app's SDK (`createOpenAICompatible` + `generateText`, `maxOutputTokens:16`, `maxRetries:0`): `model_sdk_success:true`. The ad hoc urllib probe returned CF 403 code 1010; the SDK probe succeeded. This does not verify full Worker-to-Portal agent chat. Access apps exist and both AUDs are set — `policy_count=0` and production `ANALYST_EMAILS`/`VIEWER_EMAILS` are empty strings, so Access denies everyone until the user supplies real emails and policies.

Portal: server object `stock-research-demo` created (OAuth pending), portal `code_mode` off / `on_behalf` true; Portal self-hosted managed OAuth app `14c2955d-d7bc-4b14-9d46-43b491220976` created with 0 policies and strict DCR callback `https://agent-demo.righttu.uk/mcp-oauth-callback`. `portal-demo.righttu.uk` DNS still pending (DNS API 403 — manual step). Existing dashscope provider stays enabled (`https://dashscope.aliyuncs.com`, unchanged globally), org `deny_unmatched=false`, OTP IdP `725e6447-…`.

Remaining manual/user steps: Access policies + real user emails, portal DNS for `portal-demo.righttu.uk`, portal OAuth wiring, Zero Trust DLP profile creation (marker `CF_DEMO_SECRET_9274`, Block Request — DLP API currently 403). Not verified: end-to-end user OAuth connect through Portal, Portal-namespaced tool calls, live DLP block, full agent chat against the real model, native trace display.

## VM runtime note

Test VM `/home/righttu/ai-finance/CloudFlare` (`master`, `origin git@github.com:righttu/DM-CF.git`): node/npm are not on the default PATH — source `~/.nvm/nvm.sh` (node v24.21.0, npm 12.2.0) before `npm ci`/`wrangler` in non-interactive SSH. The checked non-interactive SSH session did not expose Cloudflare credential environment variables; deployment needs an explicitly provisioned private environment file.
