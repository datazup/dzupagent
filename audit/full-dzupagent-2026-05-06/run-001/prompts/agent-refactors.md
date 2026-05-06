# Agent Audit — Refactors (4-12h, contained module work)

These tasks change a contained module without altering the public API significantly. Each preserves backward compatibility unless explicitly noted.

---

## RF-AGT-01 — Sign approval webhooks with HMAC-SHA256 + timestamp
**ID:** RF-AGT-01
**Severity in audit:** AGT-002 (High)
**Target agent:** dzupagent-agent-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/approval-gate.ts:275-307` (notifyWebhook)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/approval-types.ts` (ApprovalConfig)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/index.ts` (export new helper)

**Current state:** Webhook fires with body only. No signature; receiver cannot authenticate.

**Target state:**
1. Extend `ApprovalConfig`:
   ```ts
   webhookSecret?: string
   webhookSignatureTolerance?: number  // ms, default 300_000 (5 min)
   ```
2. In `notifyWebhook`, compute headers:
   ```ts
   const ts = Date.now().toString()
   const sig = createHmac('sha256', this.config.webhookSecret).update(`${ts}.${body}`).digest('hex')
   headers['X-DzupAgent-Timestamp'] = ts
   headers['X-DzupAgent-Signature'] = `sha256=${sig}`
   ```
3. Export `verifyApprovalWebhookSignature(headers, body, secret, toleranceMs?)` from the approval module — pure function used by receivers.
4. Emit a startup warning via the agent's logger when `webhookUrl` is set without `webhookSecret`.
5. Document the receiver-side verification contract in JSDoc.

**Validation:**
- New vitest:
  - Signature is computed; received-side verifier returns true.
  - Tampered body → verifier false.
  - Stale timestamp (older than tolerance) → verifier false.
  - Missing secret → unsigned + warning logged.
- `yarn workspace @dzupagent/agent test --filter approval`
- Update `audit/full-dzupagent-2026-05-06/run-001/docs/AGENT-AUDIT.md` to mark AGT-002 closed.

---

## RF-AGT-02 — Persist approval timeout decision to checkpoint store
**ID:** RF-AGT-02
**Severity in audit:** AGT-007 (Medium)
**Target agent:** dzupagent-agent-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/approval-gate.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/approval-types.ts`

**Current state:** Approval timeout resolves to `'cancelled'` event but leaves the durable `checkpointStore` entry as pending. Resume re-fires the request.

**Target state:**
1. Add to `ApprovalPendingState` a discriminated `terminal?: { decision: 'timed_out' | 'rejected' | 'approved'; at: number }`.
2. On timeout in `requestApproval`, before resolving, write a terminal state `{ ...state, terminal: { decision: 'timed_out', at: Date.now() } }`.
3. `loadApprovalPendingState(runId)` returns the terminal state so callers can distinguish "still pending" vs "already decided".
4. Run engine resume path: if `terminal.decision === 'timed_out'`, treat the run as terminated, do NOT re-emit `approval:requested`.
5. Add a `cleanupTerminalApprovalState(runId, ttlMs)` helper that deletes terminal entries older than TTL.

**Validation:**
- Vitest covering: pending → timeout → load returns terminal record → resume detects terminal → run does not re-emit.
- `yarn verify --filter @dzupagent/agent`

---

## RF-AGT-03 — Snapshot/restore stuck detector across run suspend/resume
**ID:** RF-AGT-03
**Severity in audit:** AGT-006 (Medium)
**Target agent:** dzupagent-agent-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/guardrails/stuck-detector.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/run-engine.ts` (resume path)

**Current state:** StuckDetector state (`recentCalls`, `recentErrors`, `idleCount`, `currentBlock`, `lastCompletedBlock`, `hashHistory`, `semanticWindow`) is in-memory only. Cross-process resume restarts from zero.

**Target state:**
1. Add `snapshot(): StuckDetectorSnapshot` returning a serialized record of all internal state.
2. Add `restore(snapshot: StuckDetectorSnapshot): void`.
3. Define `StuckDetectorSnapshot` type with stable schema (versioned: `version: 1`).
4. Run engine: on suspend (e.g. approval pause), call `detector.snapshot()` and persist alongside approval pending state. On resume, call `detector.restore(snapshot)` before re-entering the tool loop.

**Validation:**
- Vitest: record 5 calls, snapshot, instantiate fresh detector, restore, record 1 more identical call → verify stuck triggers (would have needed all 6 in the unrestored detector).
- Cross-process simulation test: serialize to JSON, deserialize, behavior identical.

---

## RF-AGT-04 — Filter tools at registration based on agent permission tier
**ID:** RF-AGT-04
**Severity in audit:** AGT-012 (Medium)
**Target agent:** dzupagent-agent-dev (codegen-dev for tool tagging)
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-registry.ts` (to be confirmed)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/tools/*` (write_file, edit_file, generate, etc. — tag with required tier)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/sandbox/permission-tiers.ts`

**Current state:** Tool tier policy is enforced only at the sandbox layer. Model can issue write calls on read-only tier; the calls fail at sandbox boundary.

**Target state:**
1. Add `tierRequired?: PermissionTier` to the `StructuredTool` metadata or an adjacent registry entry.
2. At agent construction, if `config.permissionTier === 'read-only'`, filter the tool list to those with `tierRequired === 'read-only'` or undefined.
3. Document that the model NEVER sees tools above its tier.
4. Sandbox layer remains as defense-in-depth.

**Validation:**
- Vitest: agent with `read-only` tier and a write tool registered — assert the bound tool list does NOT contain the write tool.
- Existing sandbox enforcement tests still pass.

---

## RF-AGT-05 — Add tenantId + optional prompt/response capture to LLM audit log
**ID:** RF-AGT-05
**Severity in audit:** AGT-009 (Medium)
**Target agent:** dzupagent-agent-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/observability/llm-call-audit.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/run-engine.ts` (where audit entries are written)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/agent-types.ts` (DzupAgentConfig)

**Current state:** Audit entries are metadata-only. No tenantId, prompt, or response.

**Target state:**
1. Extend `LlmCallAuditEntry`:
   ```ts
   tenantId?: string
   promptHash?: string       // sha256 hex
   responseHash?: string     // sha256 hex
   prompt?: string           // only set when auditCapture === 'full'
   response?: string         // only set when auditCapture === 'full'
   toolCalls?: Array<{ name: string; argsHash: string }>
   ```
2. Add `DzupAgentConfig.auditCapture: 'metadata' | 'hashed' | 'full'` (default `'metadata'`, preserves backwards compat).
3. Run engine populates the new fields based on capture mode.
4. Document storage cost implications of `'full'`.

**Validation:**
- Vitest: each capture mode produces the expected entry shape.
- Existing audit tests pass.
- `yarn typecheck` clean.

---

## RF-AGT-06 — Move auto-compress consecutive-failure counter to run scope
**ID:** RF-AGT-06
**Severity in audit:** AGT-015 (Low)
**Target agent:** dzupagent-agent-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop.ts:504,640`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/run-engine.ts`

**Current state:** Counter is local to each `runToolLoop` call. Resets across loop boundaries within the same run.

**Target state:**
1. Hoist counter into a `RunCompressionState` object passed via `ToolLoopConfig`.
2. Run engine creates one `RunCompressionState` per run; passes the same instance into nested loops.
3. Cross-loop second failure now triggers `ContextCompressionFailedError`.

**Validation:**
- Vitest with two consecutive `runToolLoop` calls each having one compression failure — second call throws `ContextCompressionFailedError`.

---

## RF-AGT-07 — Wrap tool result safety scan with canonical PiiDetector
**ID:** RF-AGT-07
**Severity in audit:** AGT-010 (Medium)
**Target agent:** dzupagent-agent-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:303-339`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/security/src/pii/detector.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/security/src/content-scanner.ts`

**Current state:** Tool results scanned via `SafetyMonitor` (built-in-rules.ts: SSN/email/phone). Misses JWT, CC, IBAN, API keys.

**Target state:**
1. Add an optional `contentScanner?: ContentScanner` to `ToolLoopConfig`.
2. When provided, run BOTH `safetyMonitor` (for tool_abuse / escalation rules) AND `contentScanner` (for PII + injection on tool output).
3. Tool result with JWT → `verdict: 'block'` (or sanitize) → handled like the existing safetyMonitor block path.
4. Document precedence (block > sanitize > allow).

**Validation:**
- New vitest: tool returning JWT triggers block when `pii: 'block'`.
- Existing tool-result scan tests still pass.

---

## RF-AGT-08 — Enforce memory sanitization at MemoryService.write chokepoint
**ID:** RF-AGT-08
**Severity in audit:** AGT-014 (Medium)
**Target agent:** dzupagent-core-dev (memory)
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/memory/src/memory-service.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/memory/src/memory-sanitizer.ts`

**Current state:** Sanitizer is opt-in per writer. Direct `BaseStore.put` bypasses.

**Target state:**
1. Make `MemoryService.write(...)` the only sanctioned write path; route all framework writers through it.
2. Inside, call `sanitizeMemoryContent(content)`. If `!safe`:
   - Configurable: `'reject' | 'sanitize-and-log' | 'log-only'` (default `reject`).
3. Mark direct `BaseStore.put` as internal/test-only via JSDoc + a runtime `__internal: true` option (existing callers grandfathered).

**Validation:**
- Vitest writing `'ignore previous instructions...'` via `MemoryService.write` rejects.
- Same content via direct `BaseStore.put` is allowed (test-only).
- All existing tests pass.

---
