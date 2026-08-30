# @dzupagent/flow-ast

Flow AST contracts plus local parser and validator helpers for DzupAgent flow compiler stages

Part of the [DzupAgent](../../README.md) framework.

Expression work (conditions, templates, references) follows the policy in
[EXPRESSIONS.md](./EXPRESSIONS.md): new code uses structured `FlowExpression`
conditions with `@dzupagent/flow-ast/typed-condition-evaluator`; the string
condition engine is legacy and frozen.

## Usage

```ts
import {
  checkOutputKeyUniqueness,
  parseFlow,
  validateFlowDocumentShape,
} from "@dzupagent/flow-ast";
```

## Output-Key Uniqueness

`checkOutputKeyUniqueness(root)` returns hard `output_key_collision` errors when
two output-producing declarations can write the same state key on one execution
path. It covers `output.key`, `outputKey`, `output`, `outputVar`, default prompt /
HTTP / subflow destinations, try/catch error destinations, SPDD outputs, and
`for_each` aggregate destinations. Explicit `set.assign` entries are intentional
state mutation rather than result-output declarations and remain outside this gate.

Nested sequences, loops, personas, and routes do not create artificial fresh
scopes. Parallel branches share a collision domain. The cross-branch exceptions
are explicit mutually exclusive alternatives: branch then/else, approval
approve/reject, and successful try-body/recovery completion. Outputs from any
alternative still collide with a later same-path writer. A `for_each` body has
iteration-local state: collisions inside the body fail, while only declared
collection/accumulator destinations join the outer collision domain.

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
} from "@dzupagent/flow-ast/typed-condition-evaluator";

const result = evaluateFlowTypedCondition(condition, {
  hostCapabilities: [FLOW_TYPED_CONDITION_CAPABILITY],
  bindings: {
    inputs: { ready: true, score: 4 },
  },
});
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
