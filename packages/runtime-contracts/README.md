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
  validateRagEvidenceBundle,
  validateRagGroundedAnswer,
} from '@dzupagent/runtime-contracts/rag'
```

The agent-review contracts normalize bounded run results, reviewer
independence, validation/evidence-backed decisions, revision limits, progress,
and terminal states. They do not choose a provider or replace host-owned
validation, Git, budget, restart, or authorization gates.

## License

MIT
