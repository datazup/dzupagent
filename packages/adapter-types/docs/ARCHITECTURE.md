# @dzupagent/adapter-types Architecture

## Purpose
`@dzupagent/adapter-types` is the contract package for adapter interoperability in DzupAgent.
It defines the shared TypeScript interfaces and event schemas that all agent adapters and adapter consumers use.

This package is intentionally lightweight:
- No runtime dependencies.
- One public entrypoint (`src/index.ts`).
- Distributed as ESM + `.d.ts` declarations.

## Why This Package Exists
Without this package, adapter implementations and consumers would need to depend on a heavier runtime package just to share types.  
`@dzupagent/adapter-types` solves that by isolating contracts for:
- Adapter execution and lifecycle.
- Event normalization.
- Capability declaration.
- Health/session metadata.
- Task routing decisions.

## Package Layout
- `src/index.ts`: Complete public contract surface.
- `src/__tests__/adapter-types.test.ts`: Public shape sanity checks for core types.
- `src/__tests__/adapter-types.integration.test.ts`: Event union lifecycle and exhaustiveness checks.
- `tsup.config.ts`: ESM build + declaration output.
- `tsconfig.json`: Strict TS settings (NodeNext, strict, noUncheckedIndexedAccess).

## Architecture at a Glance
The package models three contract layers:

1. Adapter Runtime Contract
- `AgentCLIAdapter` defines what every adapter must implement.
- `AgentInput` and `AdapterConfig` define execution/configuration inputs.

2. Event Contract
- `AgentEvent` is a discriminated union of normalized lifecycle events.
- Consumers can rely on exhaustive `switch` handling by `event.type`.

3. Orchestration Contract
- `TaskDescriptor`, `RoutingDecision`, `TaskRoutingStrategy` define adapter selection logic.

## Core Type Model

### Provider Identity
`AdapterProviderId` is currently a closed provider union:
- `claude`
- `codex`
- `gemini`
- `qwen`
- `crush`
- `goose`
- `openrouter`

This ID is reused across configuration, health, sessions, and all adapter events.

### Adapter Execution Input
`AgentInput` models a single execution request:
- Required:
  - `prompt`
- Optional execution controls:
  - `workingDirectory`
  - `systemPrompt`
  - `maxTurns`
  - `maxBudgetUsd`
  - `signal` (cancellation)
  - `resumeSessionId`
  - `options` (provider-specific extensibility)
  - `correlationId` (cross-event trace linkage)

### Adapter Configuration
`AdapterConfig` models adapter instance configuration:
- Provider and runtime settings:
  - `apiKey`
  - `model`
  - `timeoutMs`
  - `workingDirectory`
  - `sandboxMode` (`read-only` | `workspace-write` | `full-access`)
- Environment handling:
  - `env`
  - `envFilter` (`EnvFilterConfig` with allow/block/disable options)
- Provider extension point:
  - `providerOptions`

### Capabilities
`AdapterCapabilityProfile` explicitly describes supported runtime behaviors:
- `supportsResume`
- `supportsFork`
- `supportsToolCalls`
- `supportsStreaming`
- `supportsCostUsage`
- `maxContextTokens` (optional)

Capabilities are queried through `AgentCLIAdapter.getCapabilities()`.

### Adapter Interface
`AgentCLIAdapter` is the contract all adapters implement:
- Required:
  - `providerId`
  - `execute(input)`
  - `resumeSession(sessionId, input)`
  - `interrupt()`
  - `healthCheck()`
  - `configure(opts)`
  - `getCapabilities()`
- Optional:
  - `listSessions()`
  - `forkSession(sessionId)`
  - `warmup()`

### Health and Sessions
- `HealthStatus` captures operational readiness:
  - `healthy`, `sdkInstalled`, `cliAvailable`, and error/success metadata.
- `SessionInfo` captures tracked session metadata:
  - IDs, provider, timestamps, working directory, and custom metadata.

## Event System
`AgentEvent` is a discriminated union over these event types:
- `adapter:started`
- `adapter:message`
- `adapter:tool_call`
- `adapter:tool_result`
- `adapter:completed`
- `adapter:failed`
- `recovery:cancelled`
- `adapter:stream_delta`
- `adapter:progress`

All event types include:
- `type`
- `providerId`
- `timestamp`
- Optional `correlationId` for end-to-end traceability.

### Event Roles
- `adapter:started`: session/model/context start metadata.
- `adapter:message`: normalized textual message with role.
- `adapter:tool_call`: tool invocation record.
- `adapter:tool_result`: tool completion output + duration.
- `adapter:stream_delta`: incremental output chunk for streaming UIs.
- `adapter:progress`: coarse/fine progress status updates.
- `adapter:completed`: terminal success with result and optional token usage.
- `adapter:failed`: terminal failure payload.
- `recovery:cancelled`: terminal failure for aborted recovery path.

### Typical Lifecycle
A common happy-path stream:
1. `adapter:started`
2. `adapter:message` (optional, repeated)
3. `adapter:progress` (optional, repeated)
4. `adapter:tool_call` / `adapter:tool_result` (optional, repeated)
5. `adapter:stream_delta` (optional, repeated)
6. `adapter:completed`

Failure path:
1. `adapter:started` (if startup passed)
2. Any intermediate events
3. `adapter:failed` or `recovery:cancelled`

## Routing Contracts
For adapter selection logic:
- `TaskDescriptor`: task properties and constraints (tags, budget, preferred provider, execution/reasoning hints).
- `RoutingDecision`: selected provider (`AdapterProviderId` or `auto`), reason, confidence, optional fallback list.
- `TaskRoutingStrategy`: pluggable strategy interface with `route(task, availableProviders)`.

## Feature Inventory

### 1) Unified Adapter Interface
Single adapter interface for providers with different SDK/CLI behavior.

### 2) Normalized Event Envelope
One discriminated event union that allows transport-agnostic consumers to process any provider stream consistently.

### 3) Capability Negotiation
Capability profile allows runtime logic to gate optional behavior (resume, fork, streaming, cost tracking).

### 4) Correlation Support
`correlationId` appears on input and all events to support log and telemetry correlation.

### 5) Operational Metadata
Health/session contracts support orchestration features like status checks, session listing, and lifecycle introspection.

### 6) Security-Aware Env Configuration
`EnvFilterConfig` supports environment variable filtering to reduce accidental secret exposure to child processes.

### 7) Routing Strategy Contracts
Task routing contracts decouple selection logic from adapter runtime details.

## Current Implementation Analysis
This analysis is based on:
- `src/index.ts` (single source of truth for contracts)
- `src/__tests__/adapter-types.test.ts`
- `src/__tests__/adapter-types.integration.test.ts`

### Architectural Characteristics
- Single-file contract model: all exported contracts are centralized in one module, which keeps discoverability high and import complexity low.
- Zero-runtime package intent: runtime behavior is intentionally minimal; value is in TypeScript declarations and discriminated unions.
- Event-first interoperability: adapter output is normalized into `AgentEvent`, allowing downstream tooling to be provider-agnostic.
- Capability negotiation model: optional/variable provider behavior is represented via `AdapterCapabilityProfile` instead of fragmented conditional contracts.
- Extensible edge points: `options` and `providerOptions` provide escape hatches for provider-specific needs without breaking shared contracts.

### Strengths
- Strong event discriminants (`type`) support exhaustive handling patterns.
- Correlation model (`correlationId`) is consistently available across input and event payloads.
- Safety-oriented config includes `envFilter` and constrained `sandboxMode`.
- Session and health contracts are explicit enough for orchestration and observability layers.

### Remaining Coverage Risks
- Tests are runtime contract-shape tests, not compile-time negative tests.
- There is still no `tsd`-style assertion suite to lock down type-level regressions (for example accidental widening/narrowing of unions).

## Feature Update Coverage and Related Tests
The table below maps feature areas to current tests and identifies where additional tests would improve contract safety.

| Feature / Contract | Description | Current Test Coverage | Status |
| --- | --- | --- | --- |
| Provider IDs (`AdapterProviderId`) | Supported provider union (`claude`, `codex`, `gemini`, `qwen`, `crush`, `goose`, `openrouter`) | `adapter-types.test.ts` verifies example provider list and includes `openrouter` | Covered |
| Capability profile (`AdapterCapabilityProfile`) | Declares resume/fork/tool/stream/cost capabilities and context size | `adapter-types.test.ts` validates representative profile including `maxContextTokens` | Covered |
| Input contract (`AgentInput`) | Prompt + execution controls, cancellation, resume, options, correlation | `adapter-types.test.ts` validates full sample object including `signal`, `resumeSessionId`, `correlationId` | Covered |
| Config contract (`AdapterConfig`, `EnvFilterConfig`) | Runtime config, env pass-through, env filtering, sandbox mode | `adapter-types.test.ts` + `adapter-config-variants.test.ts` validate representative config, all sandbox modes, and env-filter variants | Covered |
| Event union (`AgentEvent`) | Full discriminated union of adapter lifecycle events | `adapter-types.integration.test.ts` uses exhaustive switch with `assertNever` to enforce union completeness | Covered |
| Stream/progress updates (`adapter:stream_delta`, `adapter:progress`) | Incremental output and progress reporting events | `adapter-types.integration.test.ts` creates and validates both event shapes in lifecycle flow | Covered |
| Terminal failure contracts (`adapter:failed`, `recovery:cancelled`) | Failure and cancelled-recovery terminal payloads | `adapter-types.integration.test.ts` verifies both in dedicated failure scenario | Covered |
| Usage/health/session metadata (`TokenUsage`, `HealthStatus`, `SessionInfo`) | Cost and operational metadata contracts | `adapter-types.test.ts` validates representative typed objects | Covered |
| Routing contracts (`TaskDescriptor`, `RoutingDecision`, `TaskRoutingStrategy`) | Task-to-provider decision interfaces | `adapter-routing-contracts.test.ts` validates strategy behavior and typed decisions | Covered |
| Adapter interface (`AgentCLIAdapter`) | Required/optional adapter methods contract | `agent-cli-adapter-contract.test.ts` validates execute/resume/health/configure/capabilities and optional session methods | Covered |

### Related Tests Added for This Feature Update
The following tests were added to close feature-level coverage gaps:
- `src/__tests__/adapter-routing-contracts.test.ts`
- `src/__tests__/agent-cli-adapter-contract.test.ts`
- `src/__tests__/adapter-config-variants.test.ts`

Validation status:
- `yarn workspace @dzupagent/adapter-types test` passed (`5` files, `10` tests).
- `yarn workspace @dzupagent/adapter-types typecheck` passed.

## How to Use

### 1) Install and Import
```bash
yarn add @dzupagent/adapter-types
```

```ts
import type {
  AdapterConfig,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '@dzupagent/adapter-types'
```

### 2) Implement an Adapter
```ts
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
} from '@dzupagent/adapter-types'

export class ExampleAdapter implements AgentCLIAdapter {
  readonly providerId = 'codex'
  private config: AdapterConfig = {}

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      maxContextTokens: 128_000,
    }
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const startedAt = Date.now()
    const sessionId = `sess_${startedAt}`

    yield {
      type: 'adapter:started',
      providerId: this.providerId,
      sessionId,
      timestamp: startedAt,
      prompt: input.prompt,
      model: this.config.model,
      workingDirectory: input.workingDirectory ?? this.config.workingDirectory,
      correlationId: input.correlationId,
    }

    yield {
      type: 'adapter:stream_delta',
      providerId: this.providerId,
      content: 'Working on it...',
      timestamp: Date.now(),
      correlationId: input.correlationId,
    }

    yield {
      type: 'adapter:completed',
      providerId: this.providerId,
      sessionId,
      result: 'Final answer',
      durationMs: Date.now() - startedAt,
      timestamp: Date.now(),
      usage: { inputTokens: 100, outputTokens: 50, costCents: 12 },
      correlationId: input.correlationId,
    }
  }

  resumeSession(sessionId: string, input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    return this.execute({ ...input, resumeSessionId: sessionId })
  }

  interrupt(): void {
    // Adapter-specific cancellation behavior.
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: true,
      providerId: this.providerId,
      sdkInstalled: true,
      cliAvailable: true,
      lastSuccessTimestamp: Date.now(),
    }
  }
}
```

### 3) Consume Events Safely (Exhaustive Switch)
```ts
function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'adapter:started':
      console.log('started', event.sessionId)
      return
    case 'adapter:message':
      console.log('message', event.role, event.content)
      return
    case 'adapter:tool_call':
      console.log('tool call', event.toolName, event.input)
      return
    case 'adapter:tool_result':
      console.log('tool result', event.toolName, event.output)
      return
    case 'adapter:stream_delta':
      process.stdout.write(event.content)
      return
    case 'adapter:progress':
      console.log('progress', event.phase, event.percentage ?? 'n/a')
      return
    case 'adapter:completed':
      console.log('done', event.result, event.usage)
      return
    case 'adapter:failed':
      console.error('failed', event.code, event.error)
      return
    case 'recovery:cancelled':
      console.error('recovery cancelled', event.error)
      return
    default: {
      const _exhaustive: never = event
      throw new Error(`Unhandled event: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
```

### 4) Apply Capability-Based Guards
```ts
function maybeResume(adapter: AgentCLIAdapter, sessionId: string, input: AgentInput) {
  if (!adapter.getCapabilities().supportsResume) {
    throw new Error(`${adapter.providerId} does not support resume`)
  }
  return adapter.resumeSession(sessionId, input)
}
```

### 5) Use Routing Types for Provider Selection
```ts
import type {
  AdapterProviderId,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '@dzupagent/adapter-types'

class CostAwareRouter implements TaskRoutingStrategy {
  readonly name = 'cost-aware'

  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision {
    if (task.preferredProvider && availableProviders.includes(task.preferredProvider)) {
      return {
        provider: task.preferredProvider,
        reason: 'Honored preferred provider',
        confidence: 0.95,
      }
    }

    return {
      provider: 'auto',
      reason: 'No explicit match; defer to default orchestration policy',
      confidence: 0.6,
      fallbackProviders: availableProviders,
    }
  }
}
```

## Build and Distribution
- Build command: `yarn workspace @dzupagent/adapter-types build`
- Output:
  - `dist/index.js` (ESM entry)
  - `dist/index.d.ts` (public type contract)
- Export map exposes only package root (`"."`).

## Test Coverage in This Package
- `adapter-types.test.ts` validates contract shape examples for core config/runtime payloads.
- `adapter-types.integration.test.ts` validates event lifecycle modeling and union exhaustiveness.

Run checks:
```bash
yarn workspace @dzupagent/adapter-types test
yarn workspace @dzupagent/adapter-types typecheck
```

## Practical Guidance for Consumers
- Always branch by `event.type` to leverage discriminated-union safety.
- Pass a `correlationId` in `AgentInput` when observability matters.
- Gate optional behaviors (`resume`, `fork`, `streaming`, cost reporting) through `getCapabilities()`.
- Use `envFilter` when adapters launch child processes that inherit environment variables.
- Treat this package as the contract boundary; keep provider-specific details in adapter implementations.
