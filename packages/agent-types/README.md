# @dzupagent/agent-types

Shared type primitives consumed by @dzupagent/agent and @dzupagent/agent-adapters (Layer 0: no runtime deps)

Part of the [DzupAgent](../../README.md) framework.

## Usage

```ts
import {
  AGENT_RUN_EVENT_SCHEMA,
  AGENT_RUN_STATE_SCHEMA,
  AGENT_RUN_STATE_STABILITY,
  AGENT_SESSION_SCHEMA,
  type AgentRunEventEnvelope,
  type AgentRunStateV2,
  type AgentSessionSnapshot,
} from '@dzupagent/agent-types/run'
import type { MemoryClient, RetryPolicy, ToolPermissionPolicy } from '@dzupagent/agent-types'
```

`AgentRunStateV2` and the run-event/item/invocation contracts are draft,
data-only contracts. `AgentSessionSnapshot` is distinct reusable conversation
history. The experimental in-memory runner adopts exact resume for
approval-gated read tools plus revisioned session bindings and transactions.
Stability remains `draft` until durable persistence, mutation-effect fencing,
host composition, and compatibility conformance adopt the shapes. These
contracts do not make the legacy `DzupAgent.launch()` handle restartable.

## License

MIT
