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
```

## License

MIT
