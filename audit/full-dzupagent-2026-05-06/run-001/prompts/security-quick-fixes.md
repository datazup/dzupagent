# Security Quick Fixes — dzupagent (audit 2026-05-06)

**Target agent:** `fix:implement` with parallelism=4. Each fix is independent.
**Total effort:** ~10h. Pre-req: read `docs/SECURITY-AUDIT.md`.

---

## QF-SEC-01 — SEC-002: Wrap ApprovalGate webhook in outbound URL policy
**Files:** `packages/agent/src/approval/approval-gate.ts:275-322`
**Exploit:** Operator-supplied `webhookUrl` triggers raw `fetch(...)` from inside the trust boundary; reaches IMDS / Redis / internal services. SSRF.
**Fix:** Replace `fetch(webhookUrl, ...)` with `fetchWithOutboundUrlPolicy(webhookUrl, init, { policy: this.config.outboundUrlPolicy })`. Plumb `outboundUrlPolicy?: OutboundUrlSecurityPolicy` through `ApprovalConfig`. Default to "no internal addresses".
**Validation:** `yarn workspace @dzupagent/agent test --filter approval-gate`. New test: `webhookUrl: 'http://127.0.0.1:80/'` emits `approval:webhook_failed` with `error.message` containing "blocked".
**Effort:** 2h

---

## QF-SEC-02 — SEC-003: GitHub connector through SSRF policy
**Files:** `packages/connectors/src/github/github-client.ts:213`
**Exploit:** `baseUrl` overridable; LLM that suggests `http://internal-secrets:8080` exfiltrates GitHub bearer token to attacker.
**Fix:** Replace `await fetch(...)` with `await fetchWithOutboundUrlPolicy(...)`. Validate `config.baseUrl` at construction with `validateOutboundUrlSyntax`. Default `allowHttp: false`.
**Validation:** `yarn workspace @dzupagent/connectors test`. New test: constructor with `baseUrl: 'http://localhost'` throws.
**Effort:** 2h

---

## QF-SEC-03 — SEC-004: Default `promptInjection: 'warn'` in run-engine
**Files:** `packages/agent/src/agent/run-engine.ts:347-387` and `agent-types.ts:430`
**Exploit:** Out-of-the-box DzupAgent skips prompt-injection scanning; LLM01 fully open.
**Fix:** In `prepareToolLoopExecution`, when `config.security?.promptInjection` is undefined and `NODE_ENV !== 'test'`, default to `'warn'`. Add documented opt-out flag. Stderr warn when explicit `'off'` in production.
**Validation:** New test asserts an injection-laden user message produces an `agent:context_fallback` with `reason: 'security:sanitized'` without explicit security config.
**Effort:** 1.5h

---

## QF-SEC-04 — SEC-005: Bump axios + ip-address via root resolutions
**Files:** root `package.json` (add `resolutions`)
**Exploit:** axios prototype pollution + NO_PROXY bypass reachable through Snowflake connector. ip-address XSS via express-rate-limit transitive.
**Fix:** Add to root `package.json`:
```json
"resolutions": {
  "axios": "^1.15.0",
  "ip-address": "^10.1.1"
}
```
Then `yarn install && yarn dedupe`.
**Validation:** `yarn audit --severity high` returns 0 findings (or only node-tar — see RF-SEC-05).
**Effort:** 1h (assuming no breaking changes from axios 1.14→1.15)

---

## QF-SEC-05 — SEC-010: LocalWorkspace allowedCommands hardening
**Files:** `packages/codegen/src/workspace/local-workspace.ts:149-165,268-272`
**Status:** Already fixed in the live checkout. Undefined `allowedCommands` resolves to the default allowlist, and only literal `'*'` bypasses the check.
**Fix:** No code task. Keep this as a closed finding unless a future codegen workspace change regresses it.
**Validation:** Optional regression-only: `new LocalWorkspace({ rootDir, command: { allowedCommands: undefined } }).runCommand('curl', [])` throws `WorkspaceCommandDeniedError`.
**Effort:** 0h

---

## QF-SEC-06 — SEC-014: AgentDefinitionService.update key allowlist
**Files:** `packages/server/src/services/agent-definition-service.ts:72-83`, `routes/agents.ts:56-74`
**Exploit:** PATCH body `{ ownerId: 'evil', tenantId: 'admin' }` is spread directly into the row.
**Fix:** Add Zod schema `AgentUpdateSchema` (under `routes/schemas.ts`) that allows ONLY documented keys. Use `validateBodyCompat`. Service rejects `tenantId`/`ownerId`/`id` keys with 400.
**Validation:** Test: PATCH with body `{ ownerId: 'evil' }` → 400; row unchanged.
**Effort:** 1.5h

---

## QF-SEC-07 — SEC-016: Gemini CLI `--` separator
**Files:** `packages/agent-adapters/src/gemini/gemini-adapter.ts:163-201`
**Exploit:** prompt prefixed with `--exec=…` may be re-parsed by gemini CLI as a flag.
**Fix:** Use `args.push('-p=' + input.prompt)` (or insert `'--'` before the prompt). Allowlist regex `^[A-Za-z0-9_-]+$` for `resumeSessionId`.
**Validation:** Test: input.prompt starting with `--exec` is consumed as a literal prompt, not a CLI flag.
**Effort:** 1h

---

## QF-SEC-08 — SEC-019: Pipe console.error through redactSecrets in route handlers
**Files:** `packages/server/src/routes/{mcp,skills,clusters,marketplace}.ts` (every `console.error('[…] ${internal}')`)
**Exploit:** API keys / bearer tokens in error messages get logged in plaintext.
**Fix:** Centralise via a `logRouteError(prefix, err)` helper that calls `redactSecrets(err.message)` before `console.error`.
**Validation:** Inject an `Error` containing a fake `OPENAI_API_KEY` value into a route; capture stderr; assert `[REDACTED]` substring.
**Effort:** 2h

---

## QF-SEC-09 — SEC-022: Add RBAC requireRole to learning routes
**Files:** `packages/server/src/routes/learning.ts:367, 560`
**Exploit:** Any authenticated key (including `viewer` role) can ingest learning patterns into shared memory.
**Fix:** `app.post('/feedback', requireRole(['user', 'operator', 'admin']), …)`. `app.post('/ingest', requireRole(['operator', 'admin']), …)`. `app.post('/skill-packs/load', requireRole(['admin']), …)`.
**Validation:** Test: POST /ingest with viewer-role API key returns 403.
**Effort:** 1h

---

## QF-SEC-10 — SEC-024: Remove `as never` casts on apiKey context reads
**Files:** `packages/server/src/routes/run-guard.ts:30,40,68`, `runs.ts:63,74`, `api-keys.ts:112,115,118`
**Fix:** Extend `AppEnv['Variables']` to `apiKey: ApiKeyContext | undefined`. Replace `c.get('apiKey' as never)` with `c.get('apiKey')`. Compile error surfaces if anyone changes the key.
**Validation:** `grep -rn "apiKey' as never" packages/server/src` returns 0; `yarn typecheck --filter=@dzupagent/server` green.
**Effort:** 1h
