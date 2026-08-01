# @dzupagent/runtime-contracts

Neutral runtime contracts for scheduling and execution ledger packages

Part of the [DzupAgent](../../README.md) framework.

## Usage

```ts
import type { ExecutionRun, ManagedRunEvent, WorkflowSchedule } from '@dzupagent/runtime-contracts'
```

New domain contracts use governed subpaths instead of growing the package
root:

```ts
import {
  validateAgentRunResult,
  validateReviewDecision,
  validateReviewLoopResult,
} from '@dzupagent/runtime-contracts/agent-review'

import {
  executeRagComposition,
  validateRagEvidenceBundle,
  validateRagGroundedAnswer,
} from '@dzupagent/runtime-contracts/rag'

import {
  validateAgentBlueprint,
  validateCompiledAgentDescriptor,
} from '@dzupagent/runtime-contracts/agent-blueprint'

import {
  validateAiExecutionReceipt,
  validateAiExecutionRequest,
  validateAiPublicTargetDescriptor,
} from '@dzupagent/runtime-contracts/ai-execution'
```

The agent-review contracts normalize bounded run results, reviewer
independence, validation/evidence-backed decisions, revision limits, progress,
and terminal states. They do not choose a provider or replace host-owned
validation, Git, budget, restart, or authorization gates.

The agent-blueprint contracts define provider-neutral, versioned references for
personas, tasks, prompt overlays, schemas, toolsets, policies, and allowlisted
handler functions. A compiled descriptor contains no executable code and an AI
`host-action-request` remains a request: authorization, signing keys, and
side-effect execution stay host-owned.

The AI execution subpath adds operation-specific inputs and outputs around the
existing canonical `ExecutionRequest`, browser-safe target projections,
private digest-bound target snapshots, ordered events, explicit usage/cost
truth, attempts, and terminal receipts. It does not create a second route,
policy, cancellation, effect, or provider request authority. Public targets
contain opaque target IDs only; resolved provider, model, profile, backend, and
Worker details remain private host evidence.

The base `ai-execution` entrypoint stays environment-neutral. Node execution
hosts use `@dzupagent/runtime-contracts/ai-execution/node` to materialize and
verify canonical SHA-256 target-snapshot custody before accepting a receipt.

The exported
`fixtures/agent-review-conformance-v1.json` package subpath is the immutable
provider-free cross-host corpus for accepted, revise, revision-limit,
no-progress, blocked-external, skipped-validation, and host-policy-failure
projections. Consumers must verify its `payloadSha256` over the canonical
payload before executing the cases; the fixture grants no runtime authority.

The RAG subpath also exposes a provider-neutral bounded composition. Hosts
inject retrieval and synthesis implementations; the composition admits at
most one primary retrieval and one explicitly declared fallback, validates
snapshot/scope/evidence bindings, abstains on no or insufficient evidence, and
rejects unsupported claims. It does not choose providers, mutate indexes, or
authorize snapshot promotion.

## License

MIT
