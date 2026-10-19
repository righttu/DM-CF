# agent-demo (Cloudflare investment-agent security demo)

Isolated synthetic-data demo. Two Workers: `src/agent` (frontend + ResearchAgent Durable Object) and `src/mcp` (stateless MCP + OAuth). App code in `apps/agent-demo`, configs in `.devin/agent-demo`.

## 用户偏好（必须遵守）

- 与用户的所有交流、任务完成后的执行小结，一律使用中文。

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

## Sessions, readable identity, layout (2026-10-15)

Chat context lives in the per-user `ResearchAgent` Durable Object state (SQLite, named by SHA-256 of the verified Access `sub`): `history` and `conversationId` are the current session; other sessions are archived in `sessions` (max 20, 60 stored messages each, last `MAX_HISTORY_MESSAGES`=12 are sent to the model). `POST /api/sessions/{new,switch,delete}` (delete needs `confirm:true`; ids must be UUIDs owned by the caller's DO; 409 while a reply is running) and `sessions` in `/api/session`. Deleting a session removes it from the DO only; AI Gateway keeps its own request/response logs (collect_logs on). Role change clears history and sessions. `conversationId` doubles as the audit/Gateway conversation id, so each session is traceable separately.

AI Gateway custom metadata is now exactly `user` (verified Access email), `conversation_id`, `request_id`, `role`, `action` (Gateway allows 5 entries; the `actor_id` hash was dropped from this sink). The AI SDK telemetry metadata (Agent tracing) adds `userEmail` next to `actorId`. This is an explicit decision to store emails in Gateway logs/traces; Worker console audit lines still carry only the hash. Not verified that the Agent tracing UI displays the metadata attribute.

Login: Cloudflare Access (one-time PIN IdP) in front of the Agent/Portal/MCP apps; the Worker validates the Access JWT (signature, issuer, audience) and maps the email to a role from the `ANALYST_EMAILS` / `VIEWER_EMAILS` Worker variables (dashboard-managed, not in code). Adding a user means adding the email to the Access policies (`demo-users` on the Agent, MCP authorize, Portal and server-visibility apps) and to one role variable. Only `env.local` carries fixed fake emails.

UI layout: `body` is a fixed-height flex row, `#chat` scrolls internally and the composer stays visible (stacked layout below 900px keeps page scrolling). Real-Chrome fixture: `test/evidence/browser-verify.mjs` 39/39 (long conversation, sessions, streaming).

## Naming and the four Access applications (2026-10-15)

Naming rule: company is "ABC", no "demo" in display names, logo is a blue circle with white "ABC" (Agent page and MCP authorization page). Access applications (names only changed; ids, AUDs, policies, OAuth settings verified identical afterwards): `ABC Agent` (self_hosted, `agent-demo.righttu.uk`, id `4ddbea30…`), `ABC MCP Portal` (type `mcp_portal`, `portal-demo.righttu.uk`, id `ef19b698…`), `ABC MCP Server Authorization` (self_hosted, `mcp-demo.righttu.uk/authorize`, id `8753694f…`), `ABC MCP Server Visibility` (type `mcp`, destination = server id `research-demo`, id `31d6ab48…`). Portal object name `ABC MCP Portal`; server object name `ABC Research MCP Server` (stayed `connected`/`ready` with 3 tools after the rename). Hostnames and the ids `research-demo` / `research-portal` still contain "demo"/"research"; changing a server or portal id means recreating it and repeating the browser admin authorization, so they were left alone. Backups of the pre-rename configs were written to `/tmp/rename-backup` on the VM.

## Agent tracing identity (2026-10-16)

Agent tracing documents three identity fields: agent name (`functionId`, shared: `abc-research-agent`), agent id (one per user DO: the verified email, falling back to the hash) and conversation id (our session id). The SDK also reserves the metadata key `user.id`, set to the email; `userEmail`, `actorId`, `role`, `action`, `requestId` pass through as `cloudflare.agents.metadata.*`. Do not put user data in the agent name (docs warn it creates too many agent names). The earlier `functionId` value `research-demo` was an accident of a global rename and collided with the MCP server id; it only labels the tracing view and is not a Cloudflare object. Which of these the dashboard shows is not confirmed; the Workers observability events API does not return span attributes.

## Quant MCP-S, MCP kit, generic Portal tools, product UI (2026-10-16)

- `src/shared/mcp-kit.ts` holds the reusable MCP-S pieces (OAuthProvider, ConsentTransaction DO, consent GET/POST with `allowedRoles`, origin/scope checks, audit wrapper). `src/mcp/index.ts` (Research MCP-S, analyst+viewer) and `src/quant/index.ts` (`abc-quant-mcp-s`, analyst only) are thin configs.
- Quant MCP-S: Worker `abc-quant-mcp-s`, domain `abc-quant-mcp-s.righttu.uk`, Portal server id `abc-quant` (tools appear as `abc-quant_<tool>`), container `abc-quant-embedding-container` (bge-small-zh-v1.5 via sentence-transformers, `container/embedding/`; model files are staged by `scripts/prepare-embedding-model.sh` from the VM and never committed). Config `.devin/agent-demo/wrangler.quant.jsonc` (`REPLACE_ME_*` for OAuth KV id and Access AUD until cloud setup). Binds D1 `quant-data` (`85914a38-…`) and Vectorize `stock-knowledge` directly; never goes through `stock-api` (whose `/api/db/execute` runs arbitrary SQL).
- All quant SQL, the data dictionary (units checked against live rows: fundamentals `total_mv` 万元 and amounts 元 cumulative; Hunter `total_mv` 亿元, `net_*` 万元; alpha ratios are `%` text; surveys dates `YYYY-MM-DD`), tool and parameter descriptions and the prompt addendum live in `src/quant/catalog.ts`; change SQL only there. `query_data` is read-only by construction: guard + execution as `SELECT * FROM (<sql>) LIMIT ?`.
- `stock_basic` (5,916 rows incl. delisted, `cnspell` pinyin initials) is synced by `stock_basic_sync_final.py` (Tushare → D1 REST, idempotent `INSERT OR REPLACE`); on the VM run it with `/home/righttu/ai-finance/stock-sync-venv/bin/python` inside `bash -ic`.
- Agent: model tools are whatever the Portal lists (minus `portal_*`), wrapped with `ai.jsonSchema`; `callPortalTool` replaces the canonical mapping (`MCP_TOOL_NAMES_JSON`, `/api/tool-test`, `/api/diag/portal`, scenario buttons removed). `SERVER_LABELS` maps `research-demo`/`abc-quant` to display labels. Stop generation aborts `streamText` via the stream's `cancel()`; partial text is stored with `（已停止生成）`. Prompts: `SYSTEM_PROMPT` + `SUGGESTED_PROMPTS` in `src/research-policy.ts`, `MAX_TOOL_STEPS=6`.
- UI: sidebar (sessions), welcome screen with role-aware suggestions, Markdown rendered by a DOM-building renderer (never innerHTML of model text), per-answer "执行过程" chip, diagnostics drawer, light/dark theme, mobile off-canvas. CSP is `script-src 'nonce-…' 'sha256-…'` (hash of the static inline script from `pageScriptHash()`). `test/evidence/browser-verify.mjs` (real Chrome, 56 checks) — kill stale Chrome on port 9223 first; headless Chrome can freeze CSS transitions in screenshots.
- Code Mode / `optimize_context` are off on purpose (model needs the tool descriptions and data dictionary up front).
- VM network (192.168.64.3) currently intercepts TLS for Docker Hub, PyTorch, HuggingFace, ModelScope and `stock-api.righttu.uk`; PyPI, Tushare and api.cloudflare.com work. Container image builds on the VM fail until that is resolved; never disable verification or install CAs without the user.

## Quant MCP-S rollout (2026-10-17)

- VM SSH target is now `righttu@172.20.10.6` (same ED25519 host key as 192.168.64.3). Its network no longer intercepts TLS. The VM is arm64: amd64 images build there but cannot run locally (QEMU crashes in torch); for local smoke tests build with `--build-arg BASE_PLATFORM=linux/arm64`.
- `abc-quant-mcp-s` deployed (version `a9d19df3-7010-41eb-9ef7-74025e58b939`, commit `db2fa31`) with container `abc-quant-embedding-container` (image ~1.5 GB amd64, RSS ~360 MiB, cold start ~2.4 s in the arm64 smoke test). OAuth KV `abc-quant-mcp-s-oauth` (`3e6db718…`), Access app `ABC Quant MCP-S Authorization` (`7ab4eb7e…`, path `/authorize`, analyst-only policy), `ABC Quant MCP-S Visibility` (type `mcp`, destination `via_mcp_server_portal` / `abc-quant`, analyst-only). Role lists are Worker secrets copied from the frontend's role vars.
- Portal `research-portal` now lists `research-demo` and `abc-quant` (on_behalf true). After creation `abc-quant` waits for browser admin authorization in the dashboard.
- Embedding compatibility verified: `stock-knowledge` is 512-dim (975 vectors on 2026-10-17); re-embedding three stored `chunk_text`s with the container image gave cosine 1.000000 (max abs diff ≤1.2e-7) against the stored vectors. Done through a temporary Vectorize-bound Worker that was deleted afterwards (the VM API token has no Vectorize permission).
- `container/embedding/requirements.txt` is a real resolver output (41 pins, all ≥7 days old); never hand-edit individual transitive pins.

## Deferred backlog (user decision 2026-10-17: revisit at the end if time allows)

1. DLP block through the Workers AI binding: never verified live (classification relies on thrown binding errors 2029/2030).
2. Agent Tracing does not show the user; `user.id`/agent id per user are sent but the dashboard display is unconfirmed.
3. Dedicated service account for the Portal dashboard admin authorization (today the Analyst's own account is used; its role decides the synced tool catalog).
4. Enterprise IdP (Okta / Entra ID / Google) with group-based roles instead of hand-maintained `ANALYST_EMAILS`/`VIEWER_EMAILS`.
5. Rename legacy hostnames `portal-demo` / `mcp-demo` (requires Portal/server/Access/Agent config changes and re-authorization).
6. Scheduled sync for `stock_basic` (script `stock_basic_sync_final.py` exists, no schedule); research knowledge base is small (975 chunks).

## Phase 2 design notes (on-demand analysis container, not started)

- First step: connectivity test from Cloudflare Containers to Tushare (`api.tushare.pro`), Eastmoney and Sina before packaging the Manual engine.
- Secrets (Tushare token, DashScope key, AIG token) live in Worker secrets or Secrets Store; start by passing them as container env at start, later harden with outbound-handler credential injection (container never sees the token; check whether Tushare carries the token in the JSON body).
- Data access: prefer a container outbound handler (`outboundByHost`) that serves stock-api-compatible paths backed by the QUANT_DB / Vectorize / R2 bindings with an allowlist of the exact operations the Manual engine uses, instead of the public `stock-api` whose `/api/db/execute` runs arbitrary SQL. Requires an inventory of every SQL/R2/Vectorize call made by `Manual_Analyst_Engine` and the modules it imports; Python then only needs `D1_API_URL` from an env var.

## Phase 2 rollout (2026-10-17)

- Deployed `abc-quant-mcp-s` version `f3e0c806-1a6d-441a-abe3-1f742df10b4e` (commit `7dc4997`) with `abc-quant-analysis-container` (standard-2, max 3, image ~1.8 GB amd64). Worker secrets: `MY_TUSHARE_TOKEN`, `DASHSCOPE_API_KEY`, `CF_AIG_TOKEN` (uploaded from the VM env, never printed), plus the role lists; `CF_ACCOUNT_ID` is a var. Always confirm with `wrangler secret list` — a chained command that aborts early silently skips the uploads.
- Jobs: id `<ts_code>:<YYYYMMDD Asia/Shanghai>`, one container instance per job, 20-minute timeout alarm, failed/timeout jobs may be retried the same day. Tools `run_analysis` / `get_analysis_status`; Portal needed a manual capability sync to list them: `POST /accounts/{id}/access/ai-controls/mcp/servers/abc-quant/sync` (otherwise ~2 h).
- Container data access goes through `QuantAnalysisContainer.outboundByHost["quant-data.internal"]` (`src/quant/analysis.ts`): stock-api-compatible paths, allowlist scoped to the job's ts_code/date, vector queries use the namespace only (no metadata filter, mirroring stock-api). Engine modules read `D1_API_URL` / `EMBEDDING_MODEL_PATH` from env (defaults unchanged for the VM batch jobs).
- Build prep on the VM: `scripts/prepare-analysis-container.sh` and `scripts/prepare-embedding-model.sh` (staged `app/` and `model/` are gitignored). Deploys rebuild both images; keep ≥6 GB free on the VM root (`docker builder prune -af` clears our build cache).
- Connectivity from Cloudflare Containers (egress KIX) to Tushare, Eastmoney (forecast, report list, notices, surveys), pdf.dfcfw.com and AI Gateway verified on 2026-10-17. The Sina roll-news API answers "sorry to you for this page" from everywhere (VM too), so the engine's news fetch returns nothing.
- First deploy failed live with `ctx.exports.ContainerProxy is undefined`: the Worker entry must `export { ContainerProxy } from "@cloudflare/containers"` for outbound handlers. Never override `alarm()` or call `setAlarm` in a Container subclass (the library owns alarms; use `this.schedule()`). Local tests use a plain-DO stand-in, so they cannot catch Container-runtime wiring.
- Verified end-to-end on 2026-10-17 (version `127f7ab4`): 600031.SH diagnosis ran ~9 min (≈6 min in the Qwen call via the user's `ai-gateway`/`custom-dashscope` route), 58 outbound operations allowed / 0 denied, result row written (target 20.93, final_score 30). The analysis container embeds in-process with its own copy of bge-small-zh; the embedding container only serves `search_research`. Crawling is Python `requests` + `pdfplumber` (no headless browser; Playwright exists only in `hotspot_registry_final.py`).

## Phase timeline + VM hygiene (2026-10-17)

- `abc-quant-mcp-s` version `0550b423` (commit `4048b97`): `get_analysis_status` returns `timeline` (phase, label, `started_at_bj`, `duration_s`) and `total_s`; Portal re-synced (11 tools).
- Never point local/VM smoke tests of the engine at the production `stock-api` (it reaches prod D1); use an invalid `D1_API_URL` or a local stub.
- Smoke builds must not leave modified tracked files in the VM checkout (they block `git pull`, and a chained deploy then runs from the wrong directory). Compare with `git show origin/master:<file> | cmp` before discarding.
- After each deploy, remove pushed `registry.cloudflare.com/.../abc-quant-*` images and `docker builder prune -af`; the VM root otherwise drops to ~1.5 GB free.
- No cron/systemd jobs exist on the VM: all batch scripts are run manually (inventory for Phase 3).

## Phase 3 rollout (2026-10-17)

- `abc-quant-pipeline` deployed (version `43684363`, commit `370e06c`): cron `0 10 * * 1-5` (18:00 Asia/Shanghai) creates Workflow `abc-quant-daily` instance `daily-YYYYMMDD`; steps trade_day → stock_basic (Worker-native TS port) → fundamentals → chip_hunter → alpha_hunter → hotspot_registry → registry_auditor → hotspot_hunter → knowledge_miner → ai_brain, continue-on-failure, one retry per script, 4 h cap, 2-minute polling. Secrets `MY_TUSHARE_TOKEN`, `DASHSCOPE_API_KEY`, `CF_AIG_TOKEN` set (verified with `wrangler secret list`). Container `abc-quant-batch-container` (standard-2, max 2) runs each script as a subprocess; outbound allowlist per script in `src/pipeline/outbound.ts` (`/api/db/save` mirrors stock-api: INSERT OR IGNORE, first-row columns).
- Workflows replay `run()` after every sleep: every timestamp must come from a `step.do`, and step names must be unique per attempt (memoized by name).
- Batch image must build under QEMU on the arm64 VM: base `mcr.microsoft.com/playwright/python` pinned by amd64 digest (no apt, no `playwright install`). Image ~4.25 GB; a pipeline deploy needs ~4.5 GB free on the VM root.
- Manual trigger: `npx wrangler workflows trigger abc-quant-daily '{"only":["stock_basic"],"force":true}' -c ../../.devin/agent-demo/wrangler.pipeline.jsonc`; inspect with `wrangler workflows instances describe abc-quant-daily <id>`.
- Verified 2026-10-17 (Saturday): trade-day gate skipped correctly; forced stock_basic wrote 5,916 rows in 16 s; forced knowledge_miner ran in the container (first start hit "no container instance" while the app was provisioning, the step auto-retried) and exited 0. First full run: Monday 18:00.

## Phase 3 adjustments (2026-10-18)

- Deployed `abc-quant-pipeline` `387c0245` and `abc-quant-mcp-s` `29ac335d` (commit `810b171`): cron 18:30 Asia/Shanghai (`30 10 * * 1-5`); fundamentals only on Fridays in Jan–Apr, Jul–Aug, Oct (`FUNDAMENTALS_SCHEDULE` in `src/pipeline/workflow.ts`); 8 h cap for knowledge_miner/ai_brain; `CHIP_TOP_N = 30` in `ai_analyst_infra_final.py` (None = all chip stocks); Brain and Auditor use `AI_ENGINE = "WORKERS_AI"` (Kimi K2.6) through the `ai.internal` outbound handler → `env.AI.run(..., {gateway:{id:"ai-gateway"}})`; Qwen code kept commented. The Agent's deep diagnosis shares the Brain module and therefore uses Kimi too. VM fallback runs of Brain/Auditor need a CF token with Workers AI permission (unverified).
- VM disk: a pipeline deploy needs ~4.5 GB free. On 2026-10-18 a deploy with 3.6 GB free filled the root to 100 %; recovered with `docker builder prune -af` + `docker image prune -f` (dangling layers from smoke builds). Run deploys with a disk guard and prune before each one; remove locally cached smoke base images (e.g. the arm64 playwright base).
- Open: Kimi output format for Brain not yet verified live; repeated diagnosis within the 3-day lookback window awaits a user decision.

## Qwen switch, model pass-through, DO cleanup (2026-10-18)

- Deployed: Agent `b19e99b0` (analysis progress card), Quant MCP-S `45b629dd`, pipeline `d2d3590e` (commit `1670306`). Brain and Auditor use `AI_ENGINE = "BAILIAN"` (Qwen via `ai-gateway`/`custom-dashscope`, client `timeout=1800, max_retries=0`); the WORKERS_AI branch reads `BRAIN_AI_MODEL` / `AUDITOR_AI_MODEL` (e.g. `dynamic/abc-brain`). `ai.internal` passes any well-formed model (`@cf/…`, `dynamic/…`, `provider/model`) to `env.AI.run(..., {gateway:{id:"ai-gateway"}})`.
- `ai-gateway` now has the same DLP policy as `agent-demo` (`block-demo-marker`, profile `c381f346…`, REQUEST/BLOCK); backup of the previous gateway config at `/tmp/ai-gateway-backup.json` on the VM.
- Dynamic routes: API `GET/POST /ai-gateway/gateways/{id}/routes` exists; routes need BYOK provider keys, which the VM token cannot manage (Secrets Store 10000) — the user must add the DashScope key in the dashboard. The existing custom provider `dashscope` has base_url `https://dashscope.aliyuncs.com` (no `/compatible-mode/v1`), so a route-compatible provider needs a base_url with that prefix.
- Analysis and batch job DOs wipe their storage 30 days after reaching a terminal state (token-guarded `schedule()` callback; the library's `container_schedules` table remains).
- VM ops: run long deploys with `nohup bash -ic "bash script.sh"` (plain `nohup bash` does not load `CLOUDFLARE_API_TOKEN` from `.bashrc`). Never `pkill -f` with a pattern that appears in your own ssh command line — it kills the session; put kill logic in a script file.
- Deck: `docs/build-deck.py` (gitignored) builds the customer deck with speaker notes; Keynote cannot open pptx files that contain notes — previews are rendered from a `DECK_NOTES=0` build. `IMAGE_TAG` constant holds the current analysis image tag.
- Backlog (user, 2026-10-18): Agent “跑批状态” panel for Analysts — deferred.
- 2026-10-18: DashScope `qwen3.5-flash` (Auditor) returns `AllocationQuota.FreeTierOnly` (free quota exhausted) for both the container key and the BYOK key; `qwen3.8-2.4t-a95b` (Brain) works (requires thinking). The user's BYOK key in `ai-gateway` is stored under alias `bailian-key`; dynamic routes / AI binding only use alias `default`. Custom provider `dashscope-compat` (base_url `https://dashscope.aliyuncs.com/compatible-mode/v1`) created for unified/dynamic-route calls; the old `dashscope` provider stays for Brain's native path.
- Deployed 2026-10-18 (commit `7b639bc`): Agent `74e4c688`, Quant MCP-S `6463a24a`, pipeline `450ee9c4`. Deck `IMAGE_TAG` = `6463a24a`.
- 2026-10-18: Quant MCP-S `11408aae` (commit `c9913ac`): analysis job DOs are destroyed 5 minutes after a terminal state (stop container, then wipe storage); batch job DOs keep 24 h. Dynamic routes `abc-brain` (dashscope-compat qwen3.8-2.4t-a95b → Workers AI Kimi K2.6) and `abc-auditor` (qwen3.5-flash → Kimi) created on `ai-gateway` via `POST /ai-gateway/gateways/ai-gateway/routes` (model elements require a `fallback` output). Live test: both routes answered via the Kimi fallback because `custom-dashscope-compat` calls reached DashScope without an API key (BYOK for that provider not applied) and provider `dashscope` still only has alias `bailian-key`. Production Brain stays on the direct `custom-dashscope` path until BYOK is fixed.

## Architecture audit and BYOK recheck (2026-10-18, 13:58 Beijing)

- The user corrected the gateway receiving the BYOK keys. Fresh probes now return `dynamic/abc-brain` -> HTTP 200, provider `custom-dashscope-compat`, model `qwen3.8-2.4t-a95b`. `dynamic/abc-auditor` -> HTTP 200 via Kimi; a direct Flash call still returns `AllocationQuota.FreeTierOnly`. The earlier missing-key diagnosis is historical, not current.
- Read-only live Worker settings confirm no `AI_ENGINE` / `BRAIN_AI_MODEL` / `AUDITOR_AI_MODEL` overrides: production scripts have NOT been switched to the dynamic routes. Brain's BAILIAN client goes through `ai-gateway`; Auditor's BAILIAN client calls DashScope directly, bypassing Gateway/DLP. Do not claim every current model call passes through a gateway.
- Both `agent-demo` and `ai-gateway` have the request-block DLP marker policy configured. Full live Workers AI binding DLP regression remains pending; configuration alone does not prove all paths block correctly.
- Agent's gateway `agent-demo` can have its own dynamic route (for example `dynamic/abc-agent`), but none has been created or selected for Agent. Check streaming, tool calling and DLP before changing production.
- Frozen public configuration/probe evidence: `docs/architecture-facts.json` (local, gitignored). PPT must distinguish current paths from optional dynamic-route/`ai.internal` paths; outbound handlers run inside the owning Worker, not a separate deployed Worker.

## All model calls via dynamic routes (2026-10-18, commit `15592b1`)

- Deployed Agent `e40744f3`, Quant MCP-S `c99d794f`, pipeline `e3b020ae`. Agent `MODEL_ID` = `dynamic/abc-agent` on gateway `agent-demo` (route → Workers AI `@cf/zai-org/glm-5.3-flash`, no fallback). Brain/Auditor default `AI_ENGINE=WORKERS_AI` with `dynamic/abc-brain` / `dynamic/abc-auditor` on `ai-gateway` (qwen3.8-2.4t-a95b / qwen3.8-27b via `custom-dashscope-compat`, fallback Kimi K2.6; abc-brain timeouts 1,200,000 ms). VM manual runs use `https://gateway.ai.cloudflare.com/v1/<acct>/ai-gateway/compat` with `cf-aig-authorization`.
- AI binding + dynamic route with a custom provider skips the custom-provider node and serves the fallback (no log entry for the primary). Therefore `ai.internal` calls the gateway over HTTPS (`/compat/chat/completions`) with the Worker's `CF_AIG_TOKEN`; containers no longer receive `DASHSCOPE_API_KEY`/`CF_AIG_TOKEN` (only `MY_TUSHARE_TOKEN`). Workers AI provider routes (abc-agent) work through the binding: probe verified streaming, tool calls and DLP (`AI_APICallError` "2030: …" → `error_2030_gateway`). Evidence: `test/evidence/probes/aig-route-probe-2026-10-18.json`.
- Route API: `POST /ai-gateway/gateways/{gw}/routes` (model elements need a `fallback` output), new version `POST …/routes/{id}/versions`, publish `POST …/routes/{id}/deployments {version_id}`. The list endpoint returns null; read routes by id.
- `container/*/app` are untracked staging copies created by `scripts/prepare-*.sh` from the repo root; edit the root Python files only.
- MCP Portal `research-portal` has Code Mode policy `off` and the Agent URL has no `optimize_context`, so the model sees all tool definitions (normal mode).
- Not yet exercised end to end after this deploy: a container Brain run through `ai.internal` → HTTPS → `abc-brain` (needs a deep diagnosis or Monday's batch), and an Auditor run (no pending registry rows on 2026-10-18).

## Cron weekday numbering (2026-10-18)

- Cloudflare cron weekdays are 1 = Sunday … 7 = Saturday, so the old `30 10 * * 1-5` meant Sunday–Thursday and would have skipped Friday. On Sunday 2026-10-18 it fired at 18:30 Beijing time; `trade_day` returned `open:false` and every step was skipped (instance `daily-20261018`, 6 s). The schedule is now `30 10 * * MON-FRI`, in `wrangler.pipeline.jsonc` and live through `PUT /workers/scripts/abc-quant-pipeline/schedules`. Always use three-letter weekday names.

## Audit trail (2026-10-18, commit `2fcb9e0`)

- Deployed Agent `6501c80b`, Research MCP `7fe4d829`, Quant MCP-S `a666a426`. These services write to a separate D1 database `abc-audit` (`9eac7020-e816-4095-947d-4829df2b6e88`, binding `AUDIT_DB`, table `audit_events`, migration `migrations/audit/0001_audit.sql` applied remotely):
  - the Agent DO writes question, tool_call, reply and dlp_block events;
  - both MCP servers write tool_call and data_access events (SQL, tables, row count, deny reason) through `mcp-kit`;
  - the Quant diagnosis Outbound Handler writes data_access events keyed by `job_id`.
- Writes go through `waitUntil` and never fail the user path. DLP-blocked content is never stored.
- The admin view `/audit` and `/api/audit` are gated only by the secret `AUDIT_ADMIN_EMAILS` (set to the admin's email; never commit it). Non-admins get 404.
- The ABC Agent Access app (`4ddbea30-…`) got a separate allow policy `audit-admin` for the admin email.
- Not yet verified live: whether the Portal forwards MCP `_meta` request IDs to MCP-S. The page falls back to matching on user + tool within ±15 s.
- No retention purge yet. The batch pipeline is not audited (system activity).
- 2026-10-19 live check: the Portal does **not** forward MCP `_meta` request IDs. MCP-S rows arrive with NULL `request_id`, and their tool names lack the Portal prefix (`find_stock` vs `abc-quant_find_stock`).
- Agent `e04e8fe4` (commit `6ad887c`) stamps real event times. The page joins MCP rows to the Agent request by matching the same user and the normalized tool name inside the question→reply window; this is unambiguous because each user's DO allows only one in-flight chat.
- Rows written before `6ad887c` share one flush timestamp and may stay in 未关联.

## Exact audit correlation by call ID (2026-10-19, commit `ca8226b`)

- Deployed Agent `10a42c93`, Research MCP `98142875`, Quant MCP-S `de86aff8`.
- The Agent injects a reserved tool argument `_audit` `{call_id, request_id, conversation_id}`. The Portal forwards arguments verbatim but drops `_meta`.
- MCP tool input schemas use `z.looseObject`, so `_audit` survives validation. The published schema gains only `additionalProperties: {}` and no `_audit` property. `mcp-kit` strips `_audit` before the handler runs and before args are recorded, and writes `call_id` on tool_call and data_access rows.
- The page joins rows by `call_id` first. The time-window match is only for legacy rows without `call_id`.
- Migration 0002 (`call_id` column + index) was applied through the D1 query API.
- Network caveat: on the `192.168.64.3` network the VM's HTTPS is intercepted by a corporate Zero Trust CA. Because of that, `wrangler d1 execute --file` fails with "fetch failed" and Docker cannot pull `python:3.12-slim` (x509 unknown authority). Plain `wrangler deploy` of non-container Workers still works there.
- Deploy container Workers from the hotspot network (`172.20.10.6`). Do not disable TLS verification.
