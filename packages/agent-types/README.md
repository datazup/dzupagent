# @dzupagent/agent-types

Shared type primitives consumed by @dzupagent/agent and @dzupagent/agent-adapters (Layer 0: no runtime deps)

Part of the [DzupAgent](../../README.md) framework.

## Usage

```ts
import {
  AGENT_RUN_EVENT_SCHEMA,
  AGENT_RUN_STATE_SCHEMA,
  AGENT_RUN_STATE_STABILITY,
  type AgentRunEventEnvelope,
  type AgentRunStateV2,
} from '@dzupagent/agent-types/run'
import type { MemoryClient, RetryPolicy, ToolPermissionPolicy } from '@dzupagent/agent-types'
```

`AgentRunStateV2` and the run-event/item/invocation contracts are draft,
data-only contracts. The experimental in-memory runner now adopts the decision
record and exact-resume subset for approval-gated read tools. Stability remains
`draft` until durable persistence, mutation-effect fencing, session composition,
and compatibility conformance adopt the shape. These contracts do not make the
legacy `DzupAgent.launch()` handle restartable.

## License

MIT
