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

Cloud state: both workers are live on their custom domains — MCP `https://mcp-demo.righttu.uk` (version `8135f2a9-c819-447a-8d29-e70230e00f16`), frontend `https://agent-demo.righttu.uk` (version `95660304-74e7-4ccd-9e5b-a7c68419c22e`), source `81e7b52`. Isolated D1 `demo-agent-db` is seeded from `migrations/0001_demo.sql` (3 reports / 3 docs); KV (CALLBACK/OAUTH/CONSENT) and dedicated AI Gateway `agent-demo` (auth + byok_only, caching disabled, 30 req/60 s) are frozen in the configs. `DASHSCOPE_API_KEY` + `CF_AIG_TOKEN` are set as worker secrets. Verified model connectivity from the VM using the app's SDK (`createOpenAICompatible` + `generateText`, `maxOutputTokens:16`, `maxRetries:0`): `model_sdk_success:true`. The ad hoc urllib probe returned CF 403 code 1010; the SDK probe succeeded. This does not verify full Worker-to-Portal agent chat. Access apps exist and both AUDs are set — allow `demo-users` policies are now configured on all three apps (frontend `40dae046-80f7-4428-bcdf-206504a155f9`, mcp_authorize `0155ff9c-615a-4fcb-bb13-6bd50dc949f5`, portal `e766068a-1a49-4ed3-9d34-c252ca27a235`), scoped to the two user-confirmed emails (never committed to the repo). Role allowlists are managed in the Cloudflare dashboard (both configs set top-level `keep_vars:true` and carry no production `ANALYST_EMAILS`/`VIEWER_EMAILS`, so deploys never overwrite console-managed vars or commit personal emails; absent role vars fail closed anyway) — frontend role vars are set in the cloud already; the MCP worker's role vars are set by the next deployment. Production `MCP_TOOL_NAMES_JSON` maps all three canonical tools to Portal namespaced names (`research-demo_<tool>`, `{server_id}_{tool}` convention, code-mode off) — prepared in config, pending role/map rollout publish.

Portal: server object `research-demo` created (OAuth pending), portal `code_mode` off / `on_behalf` true; Portal self-hosted managed OAuth app `14c2955d-d7bc-4b14-9d46-43b491220976` created with 0 policies and strict DCR callback `https://agent-demo.righttu.uk/mcp-oauth-callback`. `portal-demo.righttu.uk` DNS still pending (DNS API 403 — manual step). Existing dashscope provider stays enabled (`https://dashscope.aliyuncs.com`, unchanged globally), org `deny_unmatched=false`, OTP IdP `725e6447-…`.

Remaining manual/user steps: Access policies + real user emails, portal DNS for `portal-demo.righttu.uk`, portal OAuth wiring, Zero Trust DLP profile creation (marker `CF_DEMO_SECRET_9274`, Block Request — DLP API currently 403). Not verified: end-to-end user OAuth connect through Portal, Portal-namespaced tool calls, live DLP block, full agent chat against the real model, native trace display.

## VM runtime note

Test VM `/home/righttu/ai-finance/CloudFlare` (`master`, `origin git@github.com:righttu/DM-CF.git`): node/npm are not on the default PATH — source `~/.nvm/nvm.sh` (node v24.21.0, npm 12.2.0) before `npm ci`/`wrangler` in non-interactive SSH. User-authorized credential source is `/home/righttu/.bashrc`; use an interactive `bash -ic` shell to load its exported variables. Never print credential values or search other credential locations.

## Verified rollout follow-up (2026-10-14)

Both Workers have deployed `d9c116b`; both role allowlists and the frontend Portal tool map match the intended configuration. Dedicated Gateway `agent-demo` now has the `block-demo-marker` policy (Block Request) bound to custom profile `c381f346-8164-439d-b2f1-3cdb9781275f`, with enabled regex `CF_DEMO_SECRET_9274` and `allowed_match_count:0`. Frozen SDK probes and their Gateway logs confirm ordinary text succeeds and the synthetic marker triggers Request BLOCK. Evidence is in `test/evidence/probes/dlp-log-details-2026-10-14.json`.

This provider route returns HTTP 424 without `cf-aig-dlp` for the confirmed block: its JSON has `name:"AiGatewayError"`, an `error` array, and numeric `internalCode:2030`. That observed code corresponds to a request block despite the documented request/response code mapping; use the neutral `error_2030_gateway` detail for 424. Never classify status 424 alone as DLP. The application classifier regression covers this envelope and non-DLP 424 errors.

Portal Managed OAuth and strict frontend callback are enabled. MCP server visibility app `4f6e1112-2d74-4744-953d-801879c117aa` is type `mcp`, scoped only to destination `via_mcp_server_portal` / `research-demo`, with Allow policy `e7f2e3a9-9ae7-4bb0-a51e-ad60ceca0e24` matching the two user-confirmed emails. App-specific policy IDs cannot be reused across applications; create a separate scoped policy rather than broadening access. DNS API still returns 403 for `righttu.uk`, and `portal-demo.righttu.uk` did not resolve during the probe. Portal server remains waiting for browser OAuth with an empty tool list. User OAuth, full live Agent-to-Portal chat, and native trace display remain unverified.


## Consent browser compatibility (2026-10-15)

Current test VM SSH target is `righttu@192.168.64.3` (same ED25519 host key as the earlier `192.168.1.227`; older addresses no longer used). Successful MCP consent HTML must use `Referrer-Policy: same-origin`; Chrome sends literal `Origin: null` for native form POSTs served with `no-referrer`. Keep `no-referrer` on other responses and continue rejecting opaque or foreign Origin values. Browser reproduction captures are in `test/evidence/probes/origin-referrer-repro-2026-10-15.json`; do not relax CSRF or the origin allowlist to work around this header interaction.

## Account controls, Portal management, and audit correlation

Access reuses a global SSO identity across applications; separate application authorization does not require repeating OTP while that session is valid. `/cdn-cgi/access/logout` revokes the user's Access sessions across this Zero Trust organization, not just the Agent application. The UI requires confirmation and distinguishes this from disconnecting only the caller's `research` MCP connection/local OAuth cache; disconnect preserves history and does not promise upstream grant revocation. Consent HTML displays the verified upstream email and role. Viewer admin authorization advertises two business tools; Analyst advertises three, so the Portal's background discovery identity matters independently of the Agent login.

Portal management uses fixed native `portal_list_servers` and `portal_toggle_servers` calls from authenticated user-triggered endpoints; these management tools are not offered to the model. Returned URLs must match the configured Portal origin and `/authorize`. URL elicitation requires explicit user action and a 55-second expiry. Pending resolvers and persisted links belong only to their creating Durable Object; never share them in a module-level registry or let a different actor adopt them. Test these handlers inside `runInDurableObject`, not by invoking another actor's captured callback. Browser identity changes clear old DOM data/URLs and discard late responses. `[hidden]` needs an explicit display rule because author CSS can override the browser's default.

Audit `actorId` is SHA-256 of the verified subject, retaining existing per-user DO names. Agent and model operations carry server-generated `requestId` and `conversationId`; AI Gateway receives exactly five custom scalar metadata fields (`actor_id`, `conversation_id`, `request_id`, `role`, `action`). These are application-verified correlation tags, not Gateway-native `cf.user_id` verification. MCP audit identity comes from the authenticated OAuth principal; incoming UUID metadata is only correlation, never authorization. Missing MCP conversation metadata remains null instead of inventing a conversation. Do not log emails, credentials, prompts, callback queries, or tool bodies, and do not invent native trace IDs.

Failed MCP connections retry via SDK `connectToServer` without clearing credentials. Authenticating connections retain SDK nonce-expiry checks. OAuth callback errors redirect without raw error queries; protected status responses expose only sanitized diagnostics. Initial live Agent-to-Portal failure and the complete cloud identity/Tracing flow remain unverified until the user retries. Read-only tails are not reliable when VM egress times out; never save raw Worker tail events, and never treat an empty capture as proof of success.

Verification artifacts: `test/evidence/final-npm-test.log`, `final-check.log`, `final-check-build.log`, `ui-hidden-badge.log`, and `browser-verify.log`. Browser checks use actual rendered UI with local fixture responses, not real Cloudflare authorization.

## Consent transactions (Durable Object)

MCP consent no longer uses `CONSENT_KV`. Each authorization handle maps to one `ConsentTransaction` SQLite Durable Object (`CONSENT_TRANSACTIONS`, migration `v1-consent`), named by SHA-256 of the handle. Only the library's `transaction:<hash>` keys are redirected there (via a KV proxy); tokens/grants/clients stay in `OAUTH_KV`. The DO stores the library's encrypted record plus the verified identity (`sub`, issuer, audience), serializes decisions with `blockConcurrencyWhile`, and consumes the record before issuing a code (approve/deny races yield exactly one 302). Errors are distinct: `consent_expired_or_used` (missing/expired/used) vs `consent_subject_mismatch` (different identity, record not consumed) vs `consent_invalid_or_used` (library cookie/handle validation). The binding fails closed (503) if absent. `CONSENT_KV` remains bound but unused. Not yet verified live against Cloudflare Access/Portal.

## Portal rebuild without "stock" names (2026-10-15)

No resource name may contain "stock". Current cloud objects: Server `research-demo` ("Research Demo MCP"), Portal `research-portal` ("Research Demo Portal", host `portal-demo.righttu.uk`, `on_behalf:true`, code mode off), Portal Access app `ef19b698-af42-45ac-92be-6a97878a8414` of type **`mcp_portal`** (Managed OAuth, strict DCR callback `https://agent-demo.righttu.uk/mcp-oauth-callback`, `demo-users` allow policy), server visibility app `31d6ab48-f5a5-4a2e-a6df-2537004c9364` (type `mcp`, destination `via_mcp_server_portal`/`research-demo`). Tools: `list_demo_companies`, `get_latest_analysis(company_id)`, `read_research_document`; Portal-prefixed `research-demo_<tool>`. D1 columns renamed `stock_id` -> `company_id`.

Root cause of the dashboard's "Access application for this portal was not found / broken state": portals created through the API do NOT get an Access app automatically, and a manually created `self_hosted` app on the portal hostname is not recognized. The Portal app must be type `mcp_portal`. Old ids (portal app `14c2955d…`, visibility app `4f6e1112…`, server/portal `stock-research-demo`) were deleted.

Upstream (Portal -> Server) admin OAuth for `research-demo` needs a browser login and cannot be automated; until a user authorizes it the server is `waiting`/`required` with no tools. Agent tokens issued for the deleted Portal app are stale; disconnect and reconnect the Agent.

## Model switched to Workers AI (2026-10-15)

Chat/DLP-test calls now use Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` through the `AI` binding (`createWorkersAI` from `workers-ai-provider@3.3.1`) routed via AI Gateway `agent-demo` (`gateway.id`, `skipCache`, the same five custom metadata fields). The Qwen/DashScope code (`createOpenAICompatible`, `DASHSCOPE_API_KEY`, `CF_AIG_TOKEN`) is kept only as commented-out code in `src/agent/index.ts`; the secrets remain set but unused. Binding calls expose no response headers, so DLP is classified from the thrown binding error (`<code>:` prefix with 2029/2030) plus `AI.aiGatewayLogId`; this is unverified against a live DLP block with the binding. Tests mock the binding via `test/model-fake.ts` (`__setModelBindingForTests`). `package.json` has `overrides.agents.@ai-sdk/provider=3.0.18` to resolve an optional-peer conflict (agents wants ^4, ai 6 uses 3); plain `npm ci` works. VM TLS note: on the 192.168.64.3 network `gateway.ai.cloudflare.com` is intercepted by a corporate Zero Trust CA (Node/curl fail with self-signed chain); do not disable verification.

## Model choice and tool use (2026-10-15)

`@cf/meta/llama-3.3-70b-instruct-fp8-fast` was dropped: with tools offered it kept emitting tool calls even for a bare "hi" and with a tool result already visible (3/3 clean runs, our prompt or a neutral one), printed calls as plain text, and ignored `tool_choice:"none"`; this came from controlled replays through a temporary Worker (deleted afterwards), not from duplicate requests in our code. Modern candidates (Kimi K2.6, GLM 5.3 Flash, GLM 4.7 Flash, Gemma 4 26B) made the right decision on a greeting, a time question and a data question in the same harness (gpt-oss-120b and Qwen3 30B were not fully measured because the raw harness message format was rejected for them). Default is now `@cf/zai-org/glm-5.3-flash` with `reasoning_effort:"low"` ($0.15/$0.50 per M tokens, 1M context); `@cf/moonshotai/kimi-k2.6` (`chat_template_kwargs.thinking:false`, $0.95/$4.00) is a one-variable switch via `MODEL_ID`; per-model settings live in `MODEL_SETTINGS`. In 4 repetitions each, Kimi and GLM 5.3 Flash had zero wrong tool decisions and similar non-streamed latency (about 1.5-2s for a greeting, 3-4s to answer from one tool result, 5-11s to compare two analyses). The agent has no intent router, keyword list or leaked-JSON workaround; deciding whether to call tools is the model's job. Generic guards remain: `MAX_TOOL_STEPS=4` with tools withdrawn on the last step or after a repeats-only step (`activeTools: []`; the binding proxy strips empty `tools`/`tool_choice`), a per-turn cache for identical calls, and a notice (never stored in history) when the model returns no text.

## Streaming chat (2026-10-15)

`/api/chat/stream` returns NDJSON (`step`, `delta`, `done`/`error`) from `ResearchAgent.chatStream` (DO RPC `ReadableStream`); `/api/chat` keeps the same core (`runChat`, `streamText` consumed to completion) with buffered JSON and is what most tests use. Every text delta streams live, including narration before tool calls (steps are separated by a blank line); tool calls themselves surface as `step` events. The UI uses the stream and replaces the bubble with the authoritative `done.reply`. Real-Chrome fixture check: `test/evidence/browser-verify.mjs` (29/29 incl. streaming). The execution-steps panel groups events per turn in collapsible `details`.
