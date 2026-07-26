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

## Credential and redaction contracts

The public AST surface includes dependency-neutral runtime contracts for:

- nominal, host-created `FlowCredentialHandle` objects containing routing
  metadata but never raw credential material;
- lease-only `FlowCredentialHandleResolver` results, so portable consumers do
  not receive resolved secret values;
- deterministic `FlowRedactionOperation`, result, and receipt shapes;
- monotonic classification checks, SHA-256 content identities, versioned
  transform/policy authority, and Ed25519 receipt attestations;
- runtime validators that reject result/receipt drift and unexpected receipt
  fields such as raw content.

These are contracts only. Hosts still own credential lease dereferencing,
transform execution, receipt signing and verification, secure persistence, and
terminal-result conflict handling.

## Typed-condition evaluation

The provider-free evaluator is published on a reviewed subpath so the
growth-frozen root barrel remains unchanged:

```ts
import {
  evaluateFlowTypedCondition,
  FLOW_TYPED_CONDITION_CAPABILITY,
} from '@dzupagent/flow-ast/typed-condition-evaluator'

const result = evaluateFlowTypedCondition(condition, {
  hostCapabilities: [FLOW_TYPED_CONDITION_CAPABILITY],
  bindings: {
    inputs: { ready: true, score: 4 },
  },
})
```

Every call requires the exact `flow.control.typed-condition@1` capability.
Evaluation is synchronous, deterministic, provider-free, and I/O-free. It
uses strict references, boolean-only control composition, short-circuit
`and`/`or`, finite numeric comparisons, code-unit string ordering,
structural array/plain-object equality, deterministic reference filters, and
structured fail-closed results for missing or incompatible runtime values.

The evaluator grants no target, provider, mutation, deployment, or production
authority. Compiler targets remain blocked until a host separately adopts and
qualifies the capability.

## License

MIT
