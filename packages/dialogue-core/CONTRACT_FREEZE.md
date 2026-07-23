# @dzupagent/dialogue-core — Contract Freeze (Run A)

**Frozen scheduler package version:** 0.2.0
**Current source package version:** 0.2.0
**Next release:** 0.3.0 through the continuation-v1 minor changeset
**Git commit:** 1f41b140 (dzupagent)  
**Frozen:** 2026-06-05  
**Status:** FROZEN — Run B/C/D may now consume these interfaces.

Any breaking change to the interfaces below requires a new Run A patch and a new CONTRACT_FREEZE.md entry before downstream runs may proceed.

The staged 0.3.0 release adds
`@dzupagent/dialogue-core/continuation/v1` as a separate, additive,
fail-closed continuation contract. It does not change the v0.2 scheduler
interfaces or the legacy internal `parseDecisionBlock()` fallback behavior.

---

## 1. Port Interfaces

### `AgentPort`

```typescript
import type { AgentRunRequest } from "@dzupagent/dialogue-core";

interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface AgentResult {
  raw: string;
  usage?: AgentUsage;
}

interface AgentPort {
  run(request: AgentRunRequest): Promise<AgentResult>;
}
```

### `WorkspacePort`

```typescript
type DirtyPolicy = "reject" | "isolate" | "allow";

interface WorkspaceSnapshot {
  baseRevision: string;
  treeHash: string;
}

interface WorkspaceEffect {
  diff: string;
  changedFiles: string[];
  postRevision: string;
  treeHash: string;
  applyStatus: "clean" | "partial" | "failed" | "no-op";
}

interface WorkspacePort {
  snapshot(): Promise<WorkspaceSnapshot>;
  captureEffect(beforeSnapshot: WorkspaceSnapshot): Promise<WorkspaceEffect>;
}
```

### `ValidatorPort`

```typescript
import type { ValidationSpec } from "@dzupagent/dialogue-core";

interface ValidationResult {
  ok: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
}

interface ValidatorPort {
  validate(spec: ValidationSpec): Promise<ValidationResult>;
}
```

`ValidationSpec` fields: `commandId`, `args?`, `cwdRoot`, `timeoutMs?`, `env?`, `maxOutputBytes?`, `tenantScope?`, `sandboxPolicy?` (`"none" | "read-only" | "workspace-write"`).

### `TracePort`

```typescript
import type {
  PersistedTurnEvent,
  StreamTurnEvent,
} from "@dzupagent/dialogue-core";

interface TracePort {
  emit(event: PersistedTurnEvent | StreamTurnEvent): Promise<void>;
}
```

### `RedactionPolicy`

```typescript
import type { RawTurnEvent, RedactedEvents } from "@dzupagent/dialogue-core";

interface RedactionPolicy {
  redact(event: RawTurnEvent): RedactedEvents;
}
// RedactedEvents = { persisted: PersistedTurnEvent; stream: StreamTurnEvent }
```

---

## 2. Key Types for Adapter Authors

### `AgentRunRequest`

```typescript
interface AgentRunRequest {
  runId: string;
  runSpecHash: RunSpecHash; // `sha256:${string}`
  turnIndex: number;
  turnType: TurnVerb;
  participantId: string;
  provider?: string;
  model?: string;
  mode: DialogueMode; // "deliberate" | "build"
  input: AgentRunInput;
  escape?: boolean;
}

interface AgentRunInput {
  prompt: string;
  role?: string;
  systemPrompt?: string;
  scopeFiles?: AgentRunScopeFile[];
}
```

### `PersistedTurnEvent`

Extends `TurnEventBase` with `visibility: "persisted"`. Fields `input.prompt`, `input.systemPrompt`, `output.raw`, `workspace.diff`, and `validation.output` are OMITTED — replaced by `*Redacted` optional counterparts. Stream events use the corresponding `*Preview` fields. This is what `TracePort.emit` should write to NDJSON.

### `RawTurnEvent`

Extends `TurnEventBase` with `visibility: "raw"`. Contains full prompt, raw output, full diff, and validation output. This is what `RedactionPolicy.redact` receives as input.

---

## 3. `DialogueScheduler` Entry Point

```typescript
import { DialogueScheduler } from "@dzupagent/dialogue-core";

const scheduler = new DialogueScheduler(ports, options);
// DialogueSchedulerPorts = { agent: AgentPort; workspace: WorkspacePort; validator: ValidatorPort; trace: TracePort }
// DialogueSchedulerOptions = { redactionPolicy: RedactionPolicy; clock?: DialogueSchedulerClock }

const result: DialogueSchedulerResult = await scheduler.run(runInput);
// DialogueSchedulerRunInput = { runId: string; spec: RunSpec }
// DialogueSchedulerResult = { status: "done" | "escaped" | "budget_exceeded" | "max_iterations"; handoff?: HandoffDescriptor; events: PersistedTurnEvent[] }
```

---

## 4. Identity `RedactionPolicy` Contract (Run B)

The `scripts` environment has no tenant secrets. Run B MUST export a named constant `IDENTITY_REDACTION_POLICY` that preserves values while mapping raw-only fields to the sink-safe `*Redacted` and `*Preview` names, satisfying this checklist:

- [ ] Named export `IDENTITY_REDACTION_POLICY: RedactionPolicy`
- [ ] `redact(event)` returns `{ persisted, stream }` both derived from `event`
- [ ] `persisted.visibility === "persisted"`
- [ ] `stream.visibility === "stream"`
- [ ] Raw-only field names are omitted from both sink events
- [ ] Prompt, system-prompt, output, diff, and validation-output values may be preserved under their sink-safe counterparts

---

## 5. `HandoffDescriptor` Shape

```typescript
interface HandoffDescriptor {
  targetParticipantId?: string;
  reason?: string;
  context?: string;
}
```

`claude_orchestrates_gpt55.yaml` downstream steps must handle `handoff` being `undefined` when `status === "done"` without a targeted handoff.

---

## 6. Tests (Run A gate — must stay green)

- `yarn test` in `packages/dialogue-core` → 15 tests pass
- `yarn typecheck` in `packages/dialogue-core` → exit 0
- `yarn build` in `packages/dialogue-core` → exit 0

---

## 7. Additive Agent Run Middleware (2026-07-16)

`DialogueSchedulerOptions.agentRunMiddleware` is an optional provider-neutral
interception seam around every `AgentPort.run` call:

```typescript
type DialogueSchedulerAgentRunMiddleware = (
  context: { request: AgentRunRequest },
  next: (requestOverride?: AgentRunRequest) => Promise<AgentResult>,
) => Promise<AgentResult>;
```

The middleware may call `next()` zero times to reuse a checkpoint, once for
ordinary policy wrapping, or more than once for a bounded repair/retry policy.
When performing a repair it may pass an explicit replacement request to
`next(requestOverride)`; the original request remains the default.
When omitted, scheduler behavior is unchanged. Flow-specific checkpoint,
isolation, ledger, repair, and cost policy remains in the consuming adapter;
it is not embedded in `dialogue-core`.

`DialogueSchedulerOptions.implementationTurnMiddleware` is a second optional,
provider-neutral seam around the complete implementation turn. Its `next`
callback accepts an alternate `WorkspacePort`, allowing a consuming adapter to
bind snapshot and effect capture to an isolated workspace before agent
execution. The middleware observes the completed/failed result and may perform
adapter-owned cleanup. When omitted, the scheduler uses its configured
workspace port exactly as before.

---

## 8. Additive continuation v1 subpath (2026-07-23)

`@dzupagent/dialogue-core/continuation/v1` owns a provider-neutral,
deterministic continuation boundary:

- strict proposal normalization for `continue`, `complete`, and `blocked`;
- portable evidence, policy, and host-control inputs;
- host stop/suspend precedence;
- verified-blocker and validation-aware completion admission;
- a versioned repeated-task key;
- JSON-safe canonicalization and SHA-256 hashing; and
- stable transition diagnostics.

Malformed JSON, unknown verdicts, blank continuation tasks, unverified blocked
claims, and insufficient completion evidence never default to `continue` or
`complete`. The subpath performs no provider, database, filesystem, Git,
network, environment, or clock access.

This addition does not make the continuation kernel authoritative in any host.
Scripts and Codev adoption remain comparison-gated.

Focused 0.3.0 staging gate:

- `yarn build --filter=@dzupagent/dialogue-core` → exit 0
- `yarn typecheck --filter=@dzupagent/dialogue-core` → exit 0
- `yarn lint --filter=@dzupagent/dialogue-core` → exit 0
- `yarn test --filter=@dzupagent/dialogue-core` → 30 tests pass
