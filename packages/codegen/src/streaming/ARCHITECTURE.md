# Streaming Architecture (`@dzupagent/codegen`)

## 1. Scope

`packages/codegen/src/streaming` is currently a documentation anchor, not a runtime module directory.

The streaming behavior in `@dzupagent/codegen` is implemented across these files:

- `../generation/codegen-run-engine.ts`
- `../sandbox/sandbox-protocol-v2.ts`
- `../sandbox/docker-sandbox.ts`
- `../tools/preview-app.tool.ts`
- `../vfs/workspace-runner.ts` (adjacent non-streaming execution path)

This document describes the current design, runtime flow, feature set, usage, cross-package integration, and test coverage.

## 2. Design Intent

The package has two distinct streaming concerns:

1. LLM output streaming:
- Consume `adapter:*` incremental events and forward normalized bus events (`agent:stream_delta`, etc.) while generating code.

2. Command/process streaming:
- Stream `stdout`/`stderr`/`exit` from long-lived sandbox sessions for app preview and similar workflows.

## 3. Core Components

### 3.1 `CodegenRunEngine` (generation-side streaming)

File: `../generation/codegen-run-engine.ts`

Responsibilities:

- Executes generation through an `AgentCLIAdapter` when provided.
- Iterates adapter event streams (`for await ... of adapter.execute(...)`).
- Forwards selected adapter events onto `DzupEventBus`.
- Extracts final generated code from `adapter:completed`.
- Falls back to `CodeGenService` when no adapter is configured.

Notable mappings in `forwardEvent(...)`:

- `adapter:started` -> `agent:started`
- `adapter:stream_delta` -> `agent:stream_delta`
- `adapter:completed` -> `agent:completed`
- `adapter:failed` -> `agent:failed`
- `adapter:tool_call` -> `tool:called`
- `adapter:tool_result` -> `tool:result`

### 3.2 `SandboxProtocolV2` (execution-side streaming contract)

File: `../sandbox/sandbox-protocol-v2.ts`

Adds session and stream APIs on top of `SandboxProtocol`:

- `startSession(...)`
- `executeStream(sessionId, command, ...) -> AsyncIterable<ExecEvent>`
- `exposePort(sessionId, port)`
- `stopSession(sessionId)`

`ExecEvent` union:

- `{ type: 'stdout'; data: string }`
- `{ type: 'stderr'; data: string }`
- `{ type: 'exit'; exitCode: number; timedOut: boolean }`

### 3.3 `DockerSandbox` (current V2 implementation)

File: `../sandbox/docker-sandbox.ts`

Implements `SandboxProtocolV2` with Docker-backed sessions.

Key streaming behavior:

- `executeStream(...)` runs `docker exec` via `spawn`.
- Emits line-based `stdout`/`stderr` events.
- Emits a terminal `exit` event on close/error/timeout.
- Kills process on timeout and marks `timedOut`.

### 3.4 `preview_app` tool (consumer of streaming execution)

File: `../tools/preview-app.tool.ts`

`createPreviewAppTool(sandbox: SandboxProtocolV2)`:

- Starts or reuses a session.
- Exposes requested port.
- Calls `executeStream(...)` to detect early startup signal.
- Returns serialized `PreviewAppResult`:
  - `sessionId`
  - `url`
  - `health: 'starting' | 'ready' | 'error'`
  - `message?`

### 3.5 `WorkspaceRunner` (non-streaming sibling path)

File: `../vfs/workspace-runner.ts`

- Uses one-shot `sandbox.execute(...)` (not stream).
- Included for architecture contrast: same execution domain, different interaction model.

## 4. End-to-End Flows

### 4.1 LLM Streaming Flow

```text
Caller
  -> CodegenRunEngine.generateFile(...)
     -> adapter.execute(AgentInput) [AsyncGenerator<AgentEvent>]
        -> forwardEvent(event) to DzupEventBus
           -> mapped events (agent:started, agent:stream_delta, ...)
     -> capture adapter:completed
     -> extractLargestCodeBlock(completed.result)
     -> return GenerateFileResult
```

### 4.2 Sandbox Session Streaming Flow (Preview)

```text
preview_app tool invocation
  -> sandbox.startSession() or reuse sessionId
  -> sandbox.exposePort(sessionId, port)
  -> for await (event of sandbox.executeStream(sessionId, command))
     -> stdout/stderr => health=ready
     -> exit(0)      => health=ready
     -> exit(!0)     => health=error
  -> return { sessionId, url, health, message }
```

## 5. Feature Inventory

1. Adapter event normalization:
- Unified translation from `adapter:*` to `DzupEventBus` events in `CodegenRunEngine`.

2. Incremental generation observability:
- Stream deltas can be surfaced in real-time UIs through bus consumers.

3. Session-based command streaming:
- Long-running command output streamed as typed events (`stdout`, `stderr`, `exit`).

4. Preview orchestration:
- Single tool (`preview_app`) encapsulates session lifecycle + port exposure + startup detection.

5. Secure-by-default Docker mode with preview override:
- Default mode: network/read-only restrictions.
- Preview mode: relaxed network/workdir constraints for dev server workflows.

## 6. Usage Examples

### 6.1 Generate with adapter streaming + event bus

```ts
import { CodegenRunEngine } from '@dzupagent/codegen'

const engine = new CodegenRunEngine({
  adapter,
  eventBus,
  workingDirectory: '/workspace/app',
  maxTurns: 1,
})

const result = await engine.generateFile(
  {
    filePath: 'src/routes/users.ts',
    purpose: 'Express routes for user CRUD',
    context: { framework: 'express' },
  },
  'You are a precise TypeScript backend generator.'
)

console.log(result.content)
```

### 6.2 Start preview app in a sandbox session

```ts
import { DockerSandbox, createPreviewAppTool } from '@dzupagent/codegen'

const sandbox = new DockerSandbox({ previewMode: true, timeoutMs: 60_000 })
const previewTool = createPreviewAppTool(sandbox)

const raw = await previewTool.invoke({
  command: 'npm run dev',
  port: 3000,
  timeoutMs: 30_000,
})

const preview = JSON.parse(String(raw))
console.log(preview.url, preview.health)
```

### 6.3 Consume command stream directly

```ts
const { sessionId } = await sandbox.startSession({ timeoutMs: 60_000 })

for await (const event of sandbox.executeStream(sessionId, 'npm run dev', { timeoutMs: 30_000 })) {
  if (event.type === 'stdout' || event.type === 'stderr') {
    console.log(`[${event.type}]`, event.data)
  }
  if (event.type === 'exit') {
    console.log('done', event.exitCode, event.timedOut)
  }
}
```

## 7. Typical Use Cases

1. Real-time code generation UX:
- Show partial LLM output while generation is still running.

2. Preview generated web apps:
- Start dev server inside isolated runtime and return a URL to users/agents.

3. Live command diagnostics:
- Stream build/test/lint output instead of waiting for a full buffered result.

4. Telemetry and traceability:
- Emit standardized stream events into shared event infrastructure.

## 8. Cross-Package References

These packages consume or shape this streaming contract:

1. `@dzupagent/adapter-types`
- `src/index.ts` defines `adapter:stream_delta` in `AgentEvent`.

2. `@dzupagent/agent-adapters`
- `src/registry/event-bus-bridge.ts` maps `adapter:stream_delta` to `agent:stream_delta`.
- `src/streaming/streaming-handler.ts` serializes adapter streams to SSE/JSONL/NDJSON.
- `src/http/adapter-http-handler.ts` exposes SSE streaming responses.

3. `@dzupagent/core`
- `src/events/event-types.ts` defines `agent:stream_delta` and `agent:stream_done` bus events.

4. `@dzupagent/server`
- `src/runtime/dzip-agent-run-executor.ts` emits `agent:stream_delta`/`agent:stream_done` during run execution.

5. `@dzupagent/playground`
- `src/stores/chat-store.ts` incrementally assembles assistant messages from `agent:stream_delta` and finalizes on `agent:stream_done`.

6. `@dzupagent/evals`
- `src/contracts/suites/sandbox-contract.ts` references the base sandbox contract from codegen for conformance testing.

## 9. Test Coverage (Current State)

Validation run date: `2026-04-04`

Executed tests:

- `src/__tests__/preview-app-tool.test.ts`
- `src/__tests__/sandbox-cloud-adapters.test.ts`
- `src/__tests__/workspace-runner.test.ts`
- `src/__tests__/tools-suite.test.ts`

Command:

- `yarn workspace @dzupagent/codegen test -- ...`
- Result: `87 passed / 87 total`

Focused coverage command:

- `yarn workspace @dzupagent/codegen test:coverage -- ...`
- Tests passed, but command exited non-zero due global threshold enforcement (expected for partial suite runs).

Coverage highlights (from `coverage/coverage-summary.json`):

- `src/tools/preview-app.tool.ts`: lines `94.32%`, branches `82.6%`, functions `100%`
- `src/sandbox/docker-sandbox.ts`: lines `55.01%`, branches `78.57%`, functions `69.23%`
- `src/vfs/workspace-runner.ts`: lines `100%`, branches `87.5%`, functions `100%`
- `src/generation/codegen-run-engine.ts`: lines `0%` (no direct tests in this run, and no dedicated unit tests currently)
- `src/sandbox/sandbox-protocol-v2.ts`: interface/type-only file, not represented as executable coverage target

## 10. Known Gaps And Risks

1. No dedicated streaming module boundary:
- Streaming concerns are distributed across generation, sandbox, and tools.

2. `CodegenRunEngine` test gap:
- No direct tests for adapter-stream handling and event forwarding behavior.

3. `agent:stream_delta` run ID inconsistency in `CodegenRunEngine`:
- Current mapping uses a constant run ID (`'codegen'`) for stream deltas, while other mapped events use adapter session IDs.

4. Preview startup timeout logic is optimistic:
- `preview_app` declares an early `streamTimeout`, but timeout checks occur inside the event loop and depend on receiving events.

5. Port exposure is currently a URL convention, not full mapping orchestration:
- `DockerSandbox.exposePort(...)` returns `http://localhost:<port>`; robust port publishing would require explicit container port mapping strategy.

6. Factory typing mismatch for V2-only consumers:
- `createSandbox(...)` returns `SandboxProtocol`, so V2 methods are not visible without narrowing/casting even when Docker provider is selected.

## 11. Recommendations

1. Add `codegen-run-engine` unit tests:
- Assert event forwarding payloads, failure handling, and final content extraction.

2. Introduce a `MockSandboxV2` test double:
- Enable deeper integration tests for session + stream lifecycle.

3. Normalize run ID strategy:
- Use adapter session ID consistently for all forwarded streaming events.

4. Formalize a `streaming/` runtime module:
- Centralize stream event types/helpers to reduce behavior drift across files.

5. Add explicit preview readiness probes:
- Optional HTTP probe or regex-based readiness detection instead of first-output heuristics.
