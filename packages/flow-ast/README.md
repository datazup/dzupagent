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

## License

MIT
