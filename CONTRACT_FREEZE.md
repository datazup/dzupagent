# @dzupagent/dialogue-core — Contract Freeze (Run A)

**Package version:** 0.2.0  
**Git commit:** 1f41b140 (dzupagent)  
**Frozen:** 2026-06-05  
**Status:** FROZEN — Run B/C/D may now consume these interfaces.

Any breaking change to the interfaces below requires a new Run A patch and a new CONTRACT_FREEZE.md entry before downstream runs may proceed.

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
  scopeFiles?: AgentRunScopeFile[];
}
```

### `PersistedTurnEvent`

Extends `TurnEventBase` with `visibility: "persisted"`. Fields `input.prompt`, `output.raw`, `workspace.diff`, `validation.output` are OMITTED — replaced by `*Redacted` optional counterparts. This is what `TracePort.emit` should write to NDJSON.

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

The `scripts` environment has no tenant secrets. Run B MUST export a named constant `IDENTITY_REDACTION_POLICY` that passes `RawTurnEvent` through as `PersistedTurnEvent` + `StreamTurnEvent` with no field removal, satisfying this checklist:

- [ ] Named export `IDENTITY_REDACTION_POLICY: RedactionPolicy`
- [ ] `redact(event)` returns `{ persisted, stream }` both derived from `event`
- [ ] `persisted.visibility === "persisted"`
- [ ] `stream.visibility === "stream"`
- [ ] No fields removed (prompt/output/diff copied, redacted fields may be populated with the raw values)

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

- `node --test packages/dialogue-core/src/__tests__/dialogue-scheduler.test.mjs` → 11 tests pass
- `node --test packages/dialogue-core/src/__tests__/run-spec-hash.test.mjs` → passes
- `node node_modules/.bin/tsc --noEmit --project packages/dialogue-core/tsconfig.json` → exit 0
