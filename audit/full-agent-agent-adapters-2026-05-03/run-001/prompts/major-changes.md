# Major Changes (P3 — 16h+ each)

Each prompt is a sprint-level task. Coordinate with consumers (`apps/codev-app`, `packages/server`) before merging. Gate on `yarn verify`.

---

## MC-01: OWASP-grade prompt-injection defense suite
**Findings:** AG-09, AG-08 (Agent/High)
**Agent:** `dzupagent-agent-dev`
**Estimated effort:** 2-3 days

Build `packages/security` (new package: `@dzupagent/security`):

### Package structure
```
packages/security/src/
  index.ts
  prompt-injection/
    detector.ts          — regex + classifier hybrid
    patterns.ts          — curated injection pattern library
    fixtures/            — 50+ known-bad prompt fixtures
  pii/
    detector.ts          — SSN, CC, IBAN, JWT, API key patterns
    presidio-adapter.ts  — optional wrapper for presidio-cli
  content-scanner.ts     — orchestrates both detectors
    → returns { findings: Finding[], sanitized: string, verdict: 'allow'|'sanitize'|'block' }
```

### Wire into the agent
1. `packages/agent/src/agent/run-engine.ts` — in `prepareRunState`, scan every `HumanMessage`:
   ```ts
   const scan = await this.security?.promptInjection?.scan(message.content)
   if (scan?.verdict === 'block') throw new PromptInjectionBlockedError(scan.findings)
   if (scan?.verdict === 'sanitize') message.content = scan.sanitized
   ```
2. `packages/agent/src/agent/agent-finalizers.ts` — in `maybeWriteBackMemory`:
   ```ts
   const sanitized = await this.security?.pii?.sanitize(content)
   const toWrite = sanitized ?? content
   ```
3. `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts` — for tools tagged `network: true` or `untrusted: true`: scan tool output for prompt injection before passing to LLM

### Configuration
Add to `DzupAgentConfig`:
```ts
security?: {
  promptInjection?: 'off' | 'warn' | 'block'  // default: 'block' in prod, 'warn' in dev
  pii?: 'off' | 'redact' | 'block'            // default: 'redact'
}
```

### Testing
- 50+ fixture tests in `packages/security/src/prompt-injection/fixtures/` covering:
  - `ignore previous instructions` variants
  - `<|im_start|>system` marker variants
  - Role confusion (`you are now DAN`)
  - Base64-encoded instructions
  - Markdown/JSON injection payloads
- Test: agent given SSN in prompt — memory record contains `[REDACTED-SSN]`
- Test: network tool returning injection payload with `block` config → tool result blocked

**Acceptance:** `yarn test --filter=@dzupagent/security` passes with 50+ fixture tests. `config.security.promptInjection: 'block'` is the production default in `presets/production.ts`.

---

## MC-02: First-class `MemoryClient` interface across agent + adapters
**Finding:** AG-06 (Agent/High)
**Agent:** `dzupagent-core-dev`
**Estimated effort:** 2-3 days

### Step 1 — Write ADR
Create `docs/dzupagent/adr/ADR-0005-memory-client-interface.md` documenting: why the current dynamic import + structural cast is insufficient, what `MemoryClient` provides, the three implementation tiers, and the migration path.

### Step 2 — Define the interface
In `packages/agent-types/src/memory-client.ts`:
```ts
export interface MemoryClient {
  get(namespace: string, scope: Scope, query?: MemoryQuery, ctx?: ReadContext): Promise<MemoryRecord[]>
  put(namespace: string, scope: Scope, record: MemoryRecord, ctx?: WriteContext): Promise<void>
  delete(namespace: string, scope: Scope, recordId: string): Promise<boolean>
  subscribe?(namespace: string, scope: Scope, listener: (e: MemoryChangeEvent) => void): () => void
  stats?(): Promise<MemoryStats>
}
```

### Step 3 — Implement three clients
1. `InMemoryMemoryClient` in `packages/memory/src/in-memory-client.ts` (default for dev/test)
2. `IpcMemoryClient` in `packages/memory-ipc/src/ipc-client.ts` (wraps existing Arrow runtime)
3. `HttpMemoryClient` stub in `packages/memory/src/http-client.ts` (placeholder, throws `NotImplementedError`)

### Step 4 — Backwards-compat adapter
```ts
// packages/memory/src/memory-service-adapter.ts
export function memoryServiceToClient(svc: MemoryServiceLike): MemoryClient { ... }
```

### Step 5 — Refactor agent
1. In `packages/agent/src/agent/memory-context-loader.ts:98-100`:
   - Remove `await import('@dzupagent/memory-ipc')` dynamic import
   - Accept `MemoryClient` via constructor injection (`config.memoryClient`)
2. In `DzupAgentConfig`, add `memoryClient?: MemoryClient` (default: `new InMemoryMemoryClient()`)
3. Remove `MemoryServiceLike` usage from `@dzupagent/agent` — all references go through `MemoryClient`

### Step 6 — Boundary test
Create `packages/agent/src/__tests__/boundary/memory-client-boundary.test.ts`:
```ts
it('agent package does not import @dzupagent/memory or @dzupagent/memory-ipc', () => {
  // parse packages/agent/package.json and verify no direct deps on memory or memory-ipc
})
```

**Acceptance:** `@dzupagent/agent` `package.json` has no direct deps on `@dzupagent/memory` or `@dzupagent/memory-ipc`. Boundary test passes. All memory tests pass.

---

## MC-03: Durable approval gates + workflow failure-recovery edges
**Findings:** AG-15, AG-20 (Agent/High + Medium)
**Agent:** `dzupagent-agent-dev`
**Estimated effort:** 2-3 days

### Part A — Durable approval gate

In `packages/agent/src/approval/approval-gate.ts`:

1. Create `ApprovalPendingState` type:
   ```ts
   interface ApprovalPendingState {
     runId: string; contactId: string; plan: string; channel: string
     requestedAt: number; timeoutAt: number; resumeToken: string
   }
   ```
2. When `config.durableResume === true`:
   - `requestApproval()` writes `ApprovalPendingState` to `config.checkpointStore.save(runId, 'approval:pending', state)`
   - Throws `ApprovalSuspendedError({ resumeToken })` instead of blocking on a Promise
   - The run-engine's outer driver catches `ApprovalSuspendedError`, persists the suspended run state, and returns `{ status: 'suspended', resumeToken }` to the caller
3. Resume path: `approvalGate.resume(runId, { decision: 'approved' | 'rejected' })`:
   - Loads checkpoint
   - Removes the `approval:pending` entry
   - Returns control to the suspended run

### Part B — Workflow failure-recovery edges

In `packages/agent/src/workflow/workflow-builder.ts`:

1. Add `.onError(predicate: (err: Error) => boolean, recoverySteps: WorkflowStep[]): WorkflowBuilder`
2. The `compile()` method wraps each node in a try/catch that, on error, evaluates predicates in registration order
3. Matching predicate routes to the corresponding recovery sub-graph
4. If no predicate matches: re-throw (existing behaviour)
5. Compose with existing checkpoint store so recovery nodes can access the failed node's state

### Integration test
```
test('approval gate survives process restart', async () => {
  // 1. Run agent until approval is needed → suspended with resumeToken
  // 2. Simulate restart: create new ApprovalGate with same checkpointStore
  // 3. Resume with approval decision
  // 4. Assert agent continues to completion
})
```

**Acceptance:** Approval gate state persists across restart. Workflow `.onError()` routes to recovery node. Integration test passes.

---

## MC-04: Decompose `OrchestratorFacade` into composable pipeline steps
**Finding:** A-06 (Architecture/High)
**Agent:** `dzupagent-connectors-dev`
**Estimated effort:** 4-5 days

### Step 1 — Extract policy pipeline
Create `packages/agent-adapters/src/pipeline/policy-enforcement-pipeline.ts`:
```ts
export class PolicyEnforcementPipeline {
  constructor(private readonly policyStore: AdapterPolicyStore) {}
  async enforce(input: RunInput, agentId: string): Promise<{ policy: CompiledPolicy; violations: PolicyViolation[] }>
}
```
Move `compilePolicyWithConformance`, `applyPolicyOverrides` from `OrchestratorFacade` here.

### Step 2 — Extract approval step
Create `packages/agent-adapters/src/pipeline/approval-pipeline-step.ts`:
```ts
export class ApprovalPipelineStep {
  constructor(private readonly approvalGate: AdapterApprovalGate) {}
  async check(input: RunInput, policy: CompiledPolicy): Promise<void | never>
}
```

### Step 3 — Extract guardrails step
Move `applyPostStreamWrappers` and guardrails setup from `OrchestratorFacade` to `GuardrailsPipelineStep`.

### Step 4 — Extract UCL enrichment step
Move `resolveDzupAgentPaths`, `applyDzupAgentEnrichment` to `UCLEnrichmentStep` in `packages/agent-adapters/src/dzupagent/ucl-enrichment-step.ts`.

### Step 5 — Rebuild the facade
```ts
export class OrchestratorFacade {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly pipeline: AdapterPipeline,  // composed from the 4 steps
    private readonly sessions: SessionRegistry,
    private readonly eventBus: DzupEventBus
  ) {}
  // 8 orchestration methods remain, each delegating to this.pipeline.run(input) then this.registry.execute(...)
}
```
`OrchestratorFacade` class body ≤ 300 LOC.

### createOrchestrator factory
Update `createOrchestrator()` to compose the pipeline from the 4 steps.

**Acceptance:** `OrchestratorFacade` class body is ≤300 LOC. Each step has its own test file. All existing orchestration tests pass.

---

## MC-05: Decompose `AdapterRecoveryCopilot` god object
**Findings:** C-04, A-09 (Code/P1, Architecture/High)
**Agent:** `dzupagent-connectors-dev`
**Estimated effort:** 3 days

### Extract `ExecutionTraceStore`
Create `packages/agent-adapters/src/recovery/execution-trace-store.ts`:
```ts
export class ExecutionTraceStore {
  constructor(private readonly config: { ttlMs: number; maxSize: number }) {}
  store(runId: string, trace: ExecutionTrace): void
  get(runId: string): ExecutionTrace | undefined
  remove(runId: string): void
  dispose(): void  // clears TTL timers
}
```
- Replace `setInterval` eviction with a `Map` + per-entry `setTimeout`
- `dispose()` clears all pending timeouts
- Independent of `AdapterRecoveryCopilot`

### Extract `RecoveryLoopRunner`
Create `packages/agent-adapters/src/recovery/recovery-loop-runner.ts`:
```ts
export class RecoveryLoopRunner {
  async run<T>(runFn: () => Promise<T>, config: RecoveryLoopConfig): Promise<T>
  async *runStream<T>(runFn: () => AsyncIterable<T>, config: RecoveryLoopConfig): AsyncIterable<T>
}
```
Based on the shared core from RF-02.

### Rebuild `AdapterRecoveryCopilot`
```ts
export class AdapterRecoveryCopilot {
  constructor(
    private readonly traceStore: ExecutionTraceStore,
    private readonly loopRunner: RecoveryLoopRunner,
    private readonly escalation: HumanEscalation,
    private readonly handoff: CrossProviderHandoff
  ) {}
  // executeWithRecovery and executeWithRecoveryStream — each ≤ 50 LOC
  dispose(): void { this.traceStore.dispose() }
}
```

### Lifecycle guarantee
Update `createOrchestrator()` and all consumers to call `copilot.dispose()` on shutdown.

**Acceptance:** `AdapterRecoveryCopilot` is ≤200 LOC. `ExecutionTraceStore` has its own tests. `dispose()` is called by the facade shutdown. All recovery tests pass.

---

## MC-06: Restructure `@dzupagent/agent` public API into subpath exports
**Finding:** A-15 (Architecture/Medium)
**Agent:** `dzupagent-agent-dev`
**Estimated effort:** 2 days

### Step 1 — Create subpath entry files
```
packages/agent/src/
  agent.ts          — DzupAgent, runToolLoop, IterationBudget, StuckDetector, ApprovalGate, AgentOrchestrator
  orchestration.ts  — WorkflowBuilder, AgentOrchestrator, orchestration types
  self-correction.ts — all 14 SelfCorrection* classes
  replay.ts         — ReplayEngine, ReplayController, ReplayInspector, TraceSerializer
  playground.ts     — AgentPlayground, TeamCoordinator
  pipeline-analytics.ts — PipelineAnalytics and related
```

### Step 2 — Update `package.json` exports
```json
{
  "exports": {
    ".": { "import": "./dist/agent.js", "types": "./dist/agent.d.ts" },
    "./orchestration": { "import": "./dist/orchestration.js", "types": "./dist/orchestration.d.ts" },
    "./self-correction": { "import": "./dist/self-correction.js", "types": "./dist/self-correction.d.ts" },
    "./replay": { "import": "./dist/replay.js", "types": "./dist/replay.d.ts" },
    "./playground": { "import": "./dist/playground.js", "types": "./dist/playground.d.ts" },
    "./pipeline": { "import": "./dist/pipeline.js", "types": "./dist/pipeline.d.ts" }
  }
}
```

### Step 3 — Deprecate root re-exports of advanced symbols
In the root `index.ts`, add `/** @deprecated Import from '@dzupagent/agent/self-correction' */` to all self-correction and replay re-exports.

### Step 4 — Update consumers
Run: `grep -r "from '@dzupagent/agent'" apps/ packages/ --include="*.ts" | grep -v "node_modules\|dist"` and update any imports of non-core symbols to use the new subpaths.

**Acceptance:** Root barrel exports ≤60 symbols. Subpath exports work. Consumer apps updated. Typecheck clean. Semver minor bump documented.

---

## MC-07: Unify orchestration config types in `@dzupagent/agent-types`
**Finding:** A-03 (Architecture/High)
**Agent:** `dzupagent-core-dev`
**Estimated effort:** 3-4 days

### Define generic base contracts in `@dzupagent/agent-types`
```ts
export interface BaseSupervisorContract<TAgent> {
  specialists: TAgent[]
  maxDelegations?: number
  selectionStrategy?: 'round-robin' | 'capability-match' | 'load-balanced'
}
export interface BaseMapReduceContract<TAgent, TChunk, TResult> {
  mappers: TAgent[]
  reducer: TAgent
  chunkSize?: number
  mergeFn: (results: TResult[]) => TResult
}
export interface BaseContractNetContract<TAgent> {
  bidders: TAgent[]
  evaluator: TAgent
  bidTimeoutMs?: number
}
```

### Specialize in each package
- `packages/agent/src/orchestration/orchestrator.ts`: `export type SupervisorConfig = BaseSupervisorContract<DzupAgent>` — replace the current full definition
- `packages/agent-adapters/src/orchestration/supervisor.ts`: `export type SupervisorConfig = BaseSupervisorContract<AgentCLIAdapter>` — same

Do the same for `MapReduceConfig` and `ContractNetConfig`.

### Verify no test breakage
Run: `yarn test --filter=@dzupagent/agent --filter=@dzupagent/agent-adapters -- orchestrat`

### Document the naming convention
Update `docs/dzupagent/architecture/ORCHESTRATION_TYPES.md` with a table mapping base contract → agent specialization → adapter specialization.

**Acceptance:** Only one definition of each base contract type. Both packages specialize it. No test breakage. Typecheck clean.
