# @dzupagent/adapter-types

The package also exposes separate `InlineAiExecutionPort` and
`DurableAiExecutionPort` lifecycle contracts. These ports compose the canonical
AI execution request, event, and receipt types from
`@dzupagent/runtime-contracts/ai-execution`; they do not define product scope,
provider policy, or target resolution.

Type definitions for DzupAgent agent adapters — enables third-party adapter implementations

Part of the [DzupAgent](../../README.md) framework.

## Usage

```ts
import type { ProviderExecutionPort, TaskRoutingStrategy } from '@dzupagent/adapter-types'

import type {
  AdapterInstallationRef,
  CapabilityManifest,
} from '@dzupagent/adapter-types/monitoring/installation'
```

The package root remains available for compatibility. New monitoring consumers
should use the plane-scoped entrypoints:

- `@dzupagent/adapter-types/monitoring/installation`
- `@dzupagent/adapter-types/monitoring/health`
- `@dzupagent/adapter-types/monitoring/lifecycle`
- `@dzupagent/adapter-types/monitoring/posture`
- `@dzupagent/adapter-types/monitoring/dashboard`

## License

MIT
