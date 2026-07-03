# @dzupagent/flow-ast

Flow AST contracts plus local parser and validator helpers for DzupAgent flow compiler stages

Part of the [DzupAgent](../../README.md) framework.

## Usage

```ts
import {
  checkOutputKeyUniqueness,
  parseFlow,
  validateFlowDocumentShape,
} from '@dzupagent/flow-ast'
```

## Output-Key Uniqueness

`checkOutputKeyUniqueness(root)` flags duplicate `agent.output.key` values
within the same sequence scope. Diagnostics use code `output_key_collision` and
severity `warning` in the current contract. They are surfaced so production
callers can count, record, and review possible overwrites without failing
existing authored flows.

The pass intentionally does not reject duplicate keys across fresh execution
scopes such as `parallel` branches, `try_catch` branches, nested `sequence`
nodes, or loop/persona bodies. It also does not inspect non-agent output fields
such as `prompt.outputKey`. Promoting these warnings to hard validation errors
requires a breaking migration after surveying real flows.

## License

MIT
