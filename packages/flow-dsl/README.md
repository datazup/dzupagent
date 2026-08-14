# @dzupagent/flow-dsl

Textual dzupflow/v1 parser plus a bounded dzupflow/v2 compatibility frontend,
formatter, validator, and graph projection for the DzupAgent framework. Author
multi-step agent flows in YAML (or plain JSON); this package lowers supported
v2 envelopes and existing v1 wrappers into the same typed `FlowDocumentV1`
canonical AST consumed by current compilers and hosts.

Part of the [DzupAgent](../../README.md) framework.

## Usage

```ts
import {
  parseDslToDocument,
  validateDocument,
  canonicalizeDsl,
} from "@dzupagent/flow-dsl";

const { ok, document, diagnostics } = parseDslToDocument(source);
if (!ok) {
  console.error(diagnostics);
  process.exit(1);
}
```

`parseDslToDocument(source)` runs three phases in order — YAML subset parse,
normalize (canonical AST), validate (semantic checks) — and returns a single
`ParseDslResult`. Any diagnostic in any phase fails the call and sets
`ok: false`.

`@dzupagent/flow-dsl/source-map` exports `createDslSourceMap(source, document)`
to build a deterministic authored-to-canonical index after subset parsing.
`resolveDslSourceSpan` composes canonical
node paths and field-relative UTF-16 offsets into absolute source offsets plus
one-based line/column positions. Nested branches, named parallel branches,
quoted scalars, inline JSON values, and literal blocks are supported. Generated
v2 primitive/fragment fields map to their parent `use` as explicitly derived
breadcrumbs; derived mappings resolve diagnostics but reject field-relative
quick fixes. For v2, consume the `sourceMap` returned by
`parseDslToDocument`/`canonicalizeDsl` so parser-only expansion lineage can be
composed before the canonical document is returned.

The YAML frontend is intentionally a block-style subset. It supports mappings,
sequences, scalar values, inline scalar arrays/JSON objects, and literal block
scalars (`|`). Literal blocks preserve indentation deeper than their content
indentation. Folded scalars (`>`), anchors, tags, and general YAML features are
not part of the contract; canonical examples use only this documented subset.

## Document shape

```yaml
dsl: dzupflow/v1 # or dzupflow/v1alpha-agent
id: my-flow # flow identifier
version: 1
title: Optional human title
description: Optional one-liner
inputs:
  goal: string # shorthand
  count: # or full spec
    type: number
    required: false
    default: 5
    classification: internal # public | internal | sensitive | secret
defaults:
  persona: planner # alias for personaRef
  timeout_ms: 300000 # alias for timeoutMs
  retry: { attempts: 3, delayMs: 100 }
steps:
  - action:
      id: plan
      ref: tool.plan_task
      input: { goal: "{{ input.goal }}" }
  - complete:
      id: done
      result: ok
```

`steps` is a flat array of single-key node wrappers — `- action: { ... }`,
`- if: { ... }`, etc. Graph-style top-level `nodes`/`edges` fields are
explicitly rejected.

Input classification is optional for compatibility. When declared, the flow
compiler propagates the most restrictive classification through dependent
state outputs. `secrets.*` references are always treated as `secret`.
Compatibility compilation warns when `sensitive` or `secret` values reach an
unreviewed provider, tool, command, event, evidence, persistence, artifact, or
human-prompt sink; strict compilation rejects the same flow. The existing
`evidence.write` field `redact: true` is the only v1 declassification contract.
Generic declassification syntax is intentionally deferred until a reviewed
primitive contract can define its transform and evidence semantics.

Credential inputs use the opaque `credential` type:

```yaml
inputs:
  providerCredential:
    type: credential
    required: true
```

Credential inputs are always classified `secret`, cannot declare defaults, and
cannot be downgraded. They represent host-supplied handles, never raw secret
text. The compiler only admits them as unfiltered whole values at input paths
explicitly declared by a V2 primitive contract.

## PrimitiveDefinitionV2

All built-in primitives originate from the serializable
`PrimitiveDefinitionV2` contracts exported as
`BUILT_IN_PRIMITIVE_DEFINITIONS_V2`. Each contract declares identity,
owner/stability, required profiles and capabilities, input classification and
credential policy, typed and classified output ports, normalized errors,
effects/replay, delivery/durability/cancellation, policy, evidence/redaction,
and a deterministic SHA-256 semantic hash.

Credential-capable primitives additionally declare exact
`credentialInputPaths`; `*` may identify an array item before a reviewed
descendant path such as `records.*.credential`. A primitive that forbids
credentials cannot declare credential paths.
Handle-only primitives also declare a `credentialResolverCapabilityRef` that
must appear in `requiresCapabilities`; `adapter.run@1` requires
`flow.runtime.credential.resolve@1`.
Definitions requiring redaction evidence must bind
`dzupagent.flowRedactionReceipt/v1` and a versioned policy reference.
`evidence.write@1` now carries that canonical receipt requirement in its
semantic hash.

`BUILT_IN_PRIMITIVES` remains the compatible v1 registry view and is generated
from those V2 definitions. Composite expansion functions are attached through
stable `expansionRef` identities so the V2 catalog itself remains serializable.
Use `exportPrimitiveCatalogV2` for the complete contract; existing consumers
can continue to use `exportPrimitiveCatalog`.

## Bounded dzupflow/v2 frontend

`parseDslToDocument` recognizes the explicit `dsl: dzupflow/v2` document kind
with `version: 2.0.0`. The current bounded frontend supports the uniform
multi-key step envelope:

```yaml
dsl: dzupflow/v2
id: bounded-example
version: 2.0.0
steps:
  - id: seed
    use: core.set@1
    with:
      assign:
        ready: true
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft the result.
    save:
      result: state.draft
  - id: done
    use: core.complete@1
    with:
      result: accepted
```

The current kernel subset is:

- implicit top-level sequence;
- `core.set@1`;
- `core.branch@1`, using either a legacy string `when` or the typed form below,
  plus `with.then` and optional `with.else`;
- exact registered primitive invocation such as `adapter.run@1`;
- `core.complete@1`.

Every `use` must include an exact version. Primitive invocations bind the
exact V2 ref and semantic hash, and generated v1 namespace imports remain
version-pinned. `save` currently supports one declared output port mapped to a
flat `state.<key>` when the compatible v1 node has a reviewed output adapter.

Authored V2 may additionally declare an exact primitive import closure:

```yaml
imports:
  primitives:
    - ref: primitive://adapter.run@1
      semanticHash: sha256:<exact-registry-sha256>
```

The ref must exist in the selected registry and the hash must match its exact
semantic contract. Duplicate, missing, unused, unregistered, malformed, or
hash-drifted imports fail closed. Omitting `imports` preserves compatibility
and records a derived effective import set in frontend metadata; an explicit
catalog is required when source-level lock custody is needed.

### Typed conditions and general `when`

The bounded typed-condition syntax is keyed data, not JavaScript or a template
string:

```yaml
inputs:
  ready: boolean
  score: number
steps:
  - id: draft
    use: adapter.run@1
    when:
      all:
        - ref: inputs.ready
        - gte:
            - ref: inputs.score
            - 3
    with:
      provider: codex
      instructions: Draft the result.
    save:
      result: state.draft
```

Supported forms are scalar literals, `ref`, `all`, `any`, `not`, `exists`,
`is_empty`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, and `in`.
Operator objects contain exactly one key. The parser limits conditions to 256
nodes and depth 32 and rejects I/O or nondeterministic operators.

General typed `when` is supported on `core.set@1`, exact registered primitive
invocations, and `core.complete@1`. Lowering creates a canonical branch guard
whose `then` contains the original lowered step. The child keeps its authored
id, save/evidence/annotation data, exact primitive ref/hash lineage, and
authored source mappings. The guard uses the fixed legacy string shadow
`condition: "false"` and carries semantic authority in
`typedCondition: dzupagent.flowTypedCondition/v1`.

The compiler is the single semantic authority for typed conditions. It
requires strict references, declared value types, compatible operands, a
boolean result, and control-flow availability. A valid typed condition also
adds the required capability `flow.control.typed-condition@1`.

`@dzupagent/flow-ast/typed-condition-evaluator` now publishes one reviewed,
provider-free evaluator for that capability. No generic compiler target has
adopted and qualified it. Compilation therefore still stops at Stage 4 with
`TYPED_CONDITION_TARGET_UNSUPPORTED` before artifact emission. The fixed
legacy shadow keeps unchanged hosts fail closed; it is never treated as the
typed condition's executable meaning. Existing v1 strings and v2
`core.branch@1` string `when` remain compatible.

Successful parsing returns the same canonical `FlowDocumentV1` as equivalent
v1 source and adds immutable `frontend` evidence to parse and canonicalize
results with authored/lowered step paths and exact primitive bindings.
Composite expansion also retains exact primitive ref/hash lineage in document
metadata.

Primitive steps may declare a bounded `policy`. Every authored key must occur
in the exact selected primitive's `allowedOverrides`. `timeoutMs` and
`budgetCents` are positive finite ceilings that compose with inherited host
limits by `min`; `requireApproval` may only be `true` and composes by logical
`or`. `@dzupagent/flow-dsl/v2-policy-narrowing` exposes the deterministic,
provider-free `evaluatePrimitivePolicyNarrowing` intersection contract, and
`v2InheritedPolicy` lets a parser
reject an authored ceiling that exceeds known host limits. Empty objects,
unknown fields, unreviewed future semantics, invalid values, attempted
widening, and policy on kernel steps fail closed at the exact authored field.
Successful policy evidence binds the authored path, primitive ref, primitive
semantic hash, and normalized narrowing.

Primitive steps may also declare a bounded `retry` envelope. `match` must be
a non-empty list of exact, case-sensitive error codes declared by the selected
primitive, and every selected error must be marked `retryable: true`.
Wildcards, duplicates, undeclared errors, and declared terminal errors fail
closed. `maxAttempts` is the total same-invocation attempt count, including
the initial attempt, and is bounded from 2 through 20. Optional backoff
requires an exact `fixed` or `exponential` strategy, non-negative integer
`initialMs`/`maxMs` with `maxMs >= initialMs`, and `none` or `full` jitter.
`@dzupagent/flow-dsl/v2-retry-policy` exposes the immutable provider-free
`evaluatePrimitiveRetryPolicy` validation contract. Successful evidence binds
the authored path, primitive ref/hash, normalized retry policy, and the invariant
`attemptIdentity: "same-invocation"`; it never converts retry into a new task
or invocation.

Primitive steps may declare a bounded `catch` array for exact declared
terminal errors. Catch rejects wildcard, duplicate, undeclared, and
`retryable: true` errors; retryable errors belong to `retry`. Every clause
must explicitly choose `continue`, `complete`, or `fail`, and `fail` requires
a stable code. The content-free terminal-attempt descriptor binds the exact
primitive ref/hash, terminal error code, same-invocation identity,
`internal` classification, and `rawProviderContent: "excluded"`.
`@dzupagent/flow-dsl/v2-terminal-catch` exposes the provider-free
`evaluatePrimitiveTerminalCatch` contract. Successful evidence is retained as
frontend metadata and is not projected into an invented V1 `catch` or
`on_error` field.

Primitive steps may save two through 32 exact output ports to distinct
`state.<key>` destinations. `@dzupagent/flow-dsl/v2-multi-port-save` exposes
the provider-free `evaluatePrimitiveMultiPortSave` contract. Every immutable
binding retains the exact port, output schema, cardinality, classification,
persistence, destination key and required schema, plus whether the value is
guarded or unavailable after a terminal-catch `continue`. Unknown ports,
non-state persistence, invalid or duplicate destinations, and out-of-bound
binding counts fail closed. The compatibility lowering retains one
deterministic V1 anchor only for existing analysis; the complete binding set
stays in frontend metadata and generic artifact emission remains blocked until
a target adopts `flow.save.primitive-multi-port@1`.

The parse and canonicalize results additionally return a v2 `sourceMap`.
Direct canonical fields compose back to exact authored `id`, `use`, `with`,
`when`, `save`, evidence, and annotation spans. Composite and fragment
expansion propagates parser-only lineage through nested generated steps, then
removes it immutably before returning the canonical document. Generated
compiler diagnostics point to the parent `use`; relative edits on those
derived paths and on adapted save targets are suppressed.

No generic compiler target has adopted
`flow.policy.primitive-narrowing@1`. Valid policy therefore stops at Stage 4
with `V2_POLICY_TARGET_UNSUPPORTED`; when typed control is also present, both
target-adoption diagnostics are returned together. No generic compiler target
has adopted `flow.retry.primitive-errors@1` either, so valid retry evidence
stops at Stage 4 with `V2_RETRY_TARGET_UNSUPPORTED` rather than being dropped
through V1 compatibility lowering. Retry, policy, and typed-control target
diagnostics accumulate. Terminal catch likewise stops with
`V2_CATCH_TARGET_UNSUPPORTED` until a target adopts
`flow.catch.primitive-terminal@1`; all four target gaps accumulate. The
multi-port save contract likewise stops with
`V2_MULTI_SAVE_TARGET_UNSUPPORTED`, so all five target gaps accumulate.
The bounded frontend still fails closed on nested or non-state save targets;
unknown kernel versions;
unregistered primitives; conflicting versions from one namespace; and
unregistered top-level profile/schema/fragment/connector/role/flow locks,
outputs, state, and return surfaces.
This is a compatibility frontend, not a new runtime. Richer kernel constructs,
typed-condition target adoption, exact generated-field edits, and source
pre/post hash attestation remain separate work. The existing canonical v1
formatter preserves the typed-condition sidecar and its quoted fail-closed
shadow across parse-format-parse round trips.

Beyond `imports.primitives`, V2 authoring accepts exact content-addressed
`profiles`, `schemas`, `fragments`, `connectors`, `roles`, and `flows`
catalogs when the caller supplies matching `v2ImportCatalogs` (or
`importCatalogs` on the authoring subpath). References remain
catalog-specific opaque strings rather than inventing one universal URI
scheme. Every entry requires an exact lowercase SHA-256 identity, rejects
duplicates, unknown refs, hash drift, extra fields, and implicit latest
selection, and is projected with the effective primitive imports into one
sorted `dzupagent.dslV2ResolvedImportLock/v1`. The frontend and authoring
result expose its digest; this is content custody only and does not resolve or
execute the imported resources.

## Authored V2 formatting and report-only V1 migration

`@dzupagent/flow-dsl/v2-authoring` publishes:

- `importDslV2Source` for YAML import, bounded validation, deterministic key
  ordering, canonical source and semantic hashes, and parse-format-parse
  verification;
- `formatDslV2Document` for the same contract from plain JSON input; and
- `previewDslV1ToV2Migration` for a report-only, hash-bound migration preview.

Formatting covers the complete currently qualified V2 envelope, including
typed conditions, policy narrowing, retry, terminal catch, multi-port save,
evidence, annotations, explicit primitive imports, and caller-qualified
broader content-addressed locks. Comments are intentionally not preserved.
Non-JSON values, cycles, unknown fields, and unsupported envelope shapes
produce diagnostics instead of being dropped.

The V1 preview classifies each node as `equivalent`, `lossy`, or `unsupported`.
It emits a candidate only when the supported set/branch/primitive/complete
projection lowers to the exact same canonical V1 document. Primitive
migration requires the source V1 `uses.<namespace>` pin and materializes the
corresponding exact ref and semantic hash in `imports.primitives`; it never
selects an implicit latest version. The immutable report carries source,
candidate, semantic, and report hashes.

These APIs authorize source formatting and report construction only. They do
not mutate the input document, apply a migration, execute a runtime, dispatch
a provider, deploy, or activate a target.

## Custom V2 registries and authoring metadata

Hosts can create an immutable, deterministically hashed `PrimitiveRegistryV2`
with `createPrimitiveRegistryV2`, or extend the complete built-in registry with
`extendPrimitiveRegistryV2`. Registration validates schema contracts, exact
refs, aliases, supersession links, compensation targets, credential paths, and
semantic hashes. `toPrimitiveRegistryV1` derives the parser expansion registry
without weakening the V2 catalog.

`createPrimitiveAuthoringMetadata` projects inline input and output schemas
into stable nested fields, classifications, credential flags, and completion
items. Array item paths use `*`. Hosts that require every leaf input to have an
explicit classification can set `requireClassifiedLeafInputs`.

External schemas use exact `schema://namespace/name@version` refs. Define them
with `defineFlowSchema`, then create a deterministic `FlowSchemaRegistry` with
`createFlowSchemaRegistry`. Reviewed trust is the default admission policy;
local or untrusted contracts require an explicit host opt-in. Registry
construction rejects duplicate refs, hash drift, missing supersession targets,
cross-identity supersession, missing nested refs, `$ref` siblings, and cycles.
`resolveFlowSchema` returns an immutable resolved schema plus the exact
registry hash and transitive ref/hash bindings. Passing the registry to
`createPrimitiveAuthoringMetadata` or `createPrimitiveRegistryV2` enables deep
field and classification checks for external primitive input schemas.

`expandRegisteredCompositesDetailed` also returns `primitiveExpansions`.
Each entry binds the authored invocation path to the exact V2 primitive ref,
semantic hash, generated paths, child composite refs, and optional parent
primitive ref. Set `requirePrimitiveLineage: true` to fail closed when an
invoked v1 composite has no matching exact V2 contract.

## Report-only version migrations

`defineVersionMigration` declares an exact primitive or schema route such as
`migration://primitive/custom.lookup@1-to-2` or
`migration://schema/custom/customer@1-to-2`. The immutable definition locks
the source and target semantic hashes, change classification, stable transform
and semantic-projection refs, and exact/manual/unavailable rollback truth.

`createVersionMigrationRegistry` binds every route to the current primitive or
schema registries. It rejects hash drift, duplicate routes, cross-identity
routes, targets that do not explicitly supersede their source, and
inconsistent incompatible/equivalent declarations. There is no path search
and no implicit latest version.

`previewVersionMigration` runs a registered transform twice against frozen
JSON clones, rejects nondeterminism or non-finite JSON, compares optional
semantic projections, and verifies exact rollback without changing the source
value or a DSL document. `qualifyVersionMigration` evaluates hash-pinned,
order-independent fixtures and returns an immutable readiness report.
Incompatible routes always remain blocked. These APIs produce previews and
evidence only; applying edited DSL remains a separate, explicitly authorized
consumer action.

## Template expressions

The DSL supports `{{ ... }}` expressions inside any string field. Two evaluation
modes:

- **Whole-string mode** — a string that is exactly one `{{ expr }}` (with
  optional surrounding whitespace) returns the resolved value with its original
  type. `'{{ state.n }}'` with `state.n = 42` resolves to the number `42`.
- **Interpolation mode** — any other string with embedded `{{ ... }}`
  substitutes each occurrence via `String(value)`. `'Bearer {{ state.token }}'`
  with `state.token = 't'` resolves to `'Bearer t'`. `undefined`/`null`
  substitute to the empty string.

### Grammar

```
expression  := "{{" ws path ws ("|" ws filter ws)* "}}"
path        := ident ("." ident | "[" int "]" | ".length")*
ident       := [A-Za-z_][A-Za-z0-9_]*
int         := [0-9]+
filter      := name (":" arg)?
arg         := quoted-string | signed-int | bare-string
```

### Path operators

- `state.foo.bar` — dotted property access on object scopes.
- `state.arr[0]` — non-negative integer index into an array.
- `state.arr.length` / `state.s.length` — `Array.length` or `String.length`;
  returns `undefined` on non-iterable values.

Standard scopes available at evaluation time include `state`, `input`,
`output`, `node`, and `last_agent` (the most recent `agent` node result). The
exact scope set is provided by the host runtime.

### Pipe filters (closed set)

| Filter        | Behavior                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `length`      | `Array.length` / `String.length`; `undefined` otherwise.                                                                                      |
| `json`        | `JSON.stringify(value)`.                                                                                                                      |
| `upper`       | `String(value).toUpperCase()`; `undefined` for null/undefined.                                                                                |
| `lower`       | `String(value).toLowerCase()`; `undefined` for null/undefined.                                                                                |
| `default:"x"` | Returns the literal arg when value is null/undefined; passthrough otherwise. Arg accepts a quoted string, a signed integer, or a bare string. |

Filters chain left-to-right: `{{ state.items | length | json }}` returns the
length as a JSON string.

Unknown filter, malformed expression, or out-of-bounds index all yield
`undefined`. In interpolation mode `undefined` substitutes to the empty
string; in whole-string mode the entire expression resolves to `undefined`.

`resolveDeep(value, scope)` walks objects and arrays recursively, applying the
above to every string leaf. The executor uses it for `set.assign`, `http.url`,
`http.headers`, `http.body`, `emit.payload`, classify/approval/clarification
prompts, and `memory.search.query`.

## Nodes

Every step is a single-key wrapper object. The key is the node kind; the value
is its body. All bodies share an optional `id`. Snake_case aliases (`error_var`,
`flow_ref`, `value_expr`, `max_iterations`, etc.) are accepted alongside the
camelCase form.

### `action`

Invoke a registered tool/skill with input.

```yaml
- action:
    id: plan
    ref: tool.plan_task # or toolRef
    input: { goal: "{{ input.goal }}" }
    persona: planner # optional; binds personaRef
```

### `complete`

Mark the flow finished.

```yaml
- complete:
    id: done
    result: ok # optional string
```

### `set`

Declarative state mutation. Values are resolved through `resolveDeep` before
being merged into state. Journal payload records only the assigned keys (not
their values) to avoid leaking secrets.

```yaml
- set:
    id: seed_state
    assign:
      count: "{{ state.items | length }}"
      done: true
      summary: "{{ state.last_agent.output.summary }}"
```

`assign` is required and must be a plain object. Arrays or scalars are rejected
with `INVALID_NODE_SHAPE`.

### `memory`

Read, write, list, or search in tenant-scoped memory. `tier` must be one of
`session`, `project`, or `workspace`.

```yaml
- memory:
    id: load_plan
    operation: read
    tier: session
    key: plan
    outputVar: planResult
```

```yaml
- memory:
    id: save_snapshot
    operation: write
    tier: project
    key: snapshot
    valueExpr: "{{ plan }}" # value_expr alias accepted
```

```yaml
- memory:
    id: list_items
    operation: list
    tier: workspace
    outputVar: items
```

#### `memory.search`

Templated semantic search against the configured memory backend.

```yaml
- memory:
    id: find_prior
    operation: search
    tier: workspace
    query: "{{ state.who }}" # required, may use templates
    limit: 5 # positive integer; defaults to 10
    outputVar: priorSessions # default: memorySearchResults
```

`query` is required for `search` and is resolved through the template engine
at execution time. Results land in `outputVar` as `MemoryItem[]`.

### `http`

Execute an HTTP request. `url`, `headers`, and `body` are all template-resolved
via `resolveDeep` at execution.

```yaml
- http:
    id: post_echo
    method: POST # GET|POST|PUT|PATCH|DELETE
    url: "{{ state.endpoint }}/echo/{{ state.who }}"
    headers:
      Authorization: "Bearer {{ state.token }}"
    body:
      firstTag: "{{ state.items[0] }}"
      count: "{{ state.items | length }}"
    outputVar: response
```

### `prompt`

Single LLM call with explicit user/system prompts. When nested inside a
`persona` body, runtime persona inheritance applies to the prompt node unless
an explicit `systemPrompt` is set on the node (see
[persona inheritance](#persona--inheritance-semantics)).

```yaml
- prompt:
    id: greet
    userPrompt: "Greet {{ state.who | upper }}"
    systemPrompt: "You are concise." # optional; wins over inherited persona
    outputKey: greeting # where to store the assistant reply
    model: claude-sonnet-4-6 # optional override
    provider: anthropic # optional override
    tools: true # optional; expose host tools
```

### `agent`

Multi-iteration agent loop with structured output, retry, validation, and
policy. Available under `dsl: dzupflow/v1alpha-agent` (and forward).

```yaml
- agent:
    id: plan
    agentId: planner
    profile: planner-profile # optional profile reference
    toolset: planning # named toolset to expand
    tools: [fs.read] # or explicit tool ids
    instructions: "Plan the work"
    input: { topic: flow }
    stop: { maxIterations: 4, requireFinalSchema: true }
    output: { key: plan, schemaRef: plan.v1 }
    retry:
      onInvalidOutput: { attempts: 2, repairPrompt: true }
      onValidationFailure: { attempts: 1, fullLoop: false }
      onModelUnavailable: { attempts: 2, fallbackProfile: backup }
    validation:
      required: [{ command: "yarn typecheck" }]
      repair: { maxAttempts: 2 }
    policy:
      timeoutMs: 60000
      budgetCents: 100
      workingDirectory: apps/codev-app
      approval: { requiredFor: [destructive_shell] }
      audit: { captureToolCalls: true }
```

### `validate`

Standalone validation gate (referenced suite or inline commands).

```yaml
- validate:
    id: final
    commands:
      - { command: "yarn typecheck" }
    repair: { maxAttempts: 2, onFailure: retry-prior-agent }
```

### `persona` — inheritance semantics

Wraps a body of steps with a persona binding. If the bound persona has a
`systemPromptTemplate`, runtime inheritance currently applies to nested
`prompt` nodes only. A nested `prompt.systemPrompt` wins over the inherited
template. Nested `agent` and `adapter.*` nodes do not inherit that binding at
runtime; set `instructions` / `persona` explicitly on those nodes. Nested
personas override the outer binding inside their own body for prompt nodes.

When inheritance fires for a prompt node, the journal records
`persona_systemprompt_applied { personaId }`.

```yaml
- persona:
    id: with_persona
    ref: friendly-assistant # or personaId
    body:
      - prompt:
          id: greet
          userPrompt: "Greet the user."
          outputKey: greeting
```

### `route`

Capability- or provider-routed sub-sequence.

```yaml
- route:
    id: pick_path
    strategy: capability # or fixed-provider
    tags: [fast, cheap]
    body:
      - action: { ref: skill:run, input: {} }
```

### `if` / branch

```yaml
- if:
    condition: "{{ state.count | length }}"
    then:
      - action: { ref: skill:a, input: {} }
    else:
      - action: { ref: skill:b, input: {} }
```

Normalizes to `type: 'branch'` in the AST.

### `parallel`

Run named branches concurrently. Requires at least two non-empty branches.

```yaml
- parallel:
    id: split
    branches:
      backend:
        - action: { ref: skill:api, input: {} }
      frontend:
        - action: { ref: skill:ui, input: {} }
```

### `group`

Group steps into a named nested block. Requires at least one step.

```yaml
- group:
    id: preflight
    steps:
      - action: { ref: skill:lint, input: {} }
      - action: { ref: skill:typecheck, input: {} }
```

Normalizes to a nested `type: 'sequence'` in the AST. The document's top-level
`steps:` list is already the root sequence, so `group` is what makes a _nested_
sequence expressible — without it a nested sequence has no authored form, and
the formatter can only splice its children into the parent list (which silently
dropped the wrapper's `id` on every round trip before this keyword existed).

### `for_each`

Iterate a state source. Supports `attachAs`, `collectInto`, `accumulator`, and
`concurrency` for parallel iteration (see flow-ast types for details).

```yaml
- for_each:
    id: process_items
    source: items # state key (or template)
    as: item
    body:
      - action: { ref: skill:process, input: { item: "{{ item }}" } }
```

### `try_catch`

```yaml
- try_catch:
    id: safe_op
    error_var: err
    body:
      - action: { ref: skill:risky, input: {} }
    catch:
      - complete: { result: recovered }
```

### `loop`

```yaml
- loop:
    id: poll
    condition: "{{ state.running }}"
    maxIterations: 50 # max_iterations alias accepted
    body:
      - action: { ref: skill:check, input: {} }
```

### `approval`

Pause for human approval; branch on the response.

```yaml
- approval:
    id: gate
    question: "Proceed with deploy?"
    approval_class: destructive_shell # optional; omitted means always-human
    options: [yes, no]
    onApprove:
      - action: { ref: skill:deploy, input: {} }
    onReject:
      - complete: { result: aborted }
```

`approval_class` is a typed policy selector. Accepted values are
`read_only`, `local_side_effect`, `destructive_shell`, `network_egress`,
`mcp_external_side_effect`, and `unknown`. Runtimes may apply tenant policy
modes such as auto-approve, require-human, or auto-deny. Omitting the field
preserves the explicit always-human approval gate. Untyped aliases such as
`policyRef` are not part of the approval-node DSL contract.

### `clarify`

Pause for a clarification answer (`text` or `choice`).

```yaml
- clarify:
    id: ask_name
    question: "What is your name?"
    expected: text # or choice
    choices: [a, b] # required when expected = choice
```

### `classify`

LLM-driven enum selection from a fixed choice list.

```yaml
- classify:
    id: pick_tier
    prompt: "Which implementation tier?"
    choices: [frontend, backend, infra]
    output: tier # alias for outputKey
    default: infra # must be one of choices
```

### `emit`

Emit a structured event to the host event bus. `payload` is deep-resolved
through the template engine.

```yaml
- emit:
    id: announce
    event: demo.completed
    payload:
      who: "{{ state.who }}"
      itemCount: "{{ state.items | length }}"
      descriptor: "{{ state.who }} processed {{ state.items | length }} tags"
```

### `spawn`

Spawn a child flow run from a template; optionally block until completion.

```yaml
- spawn:
    id: run_child
    templateRef: tmpl-abc # template_ref alias accepted
    waitForCompletion: true
    input: { goal: "{{ input.goal }}" }
```

### `subflow`

Inline another flow document by reference. Invocation inputs bind to the
child's declared top-level `inputs` as hygienic private state. If the caller
sets `outputVar`, the child must declare exactly which internal state key is
exported with `meta.subflowOutput`.

```yaml
# auth-flow-id.dzupflow.yaml
meta:
  subflowOutput: authenticatedUser
inputs:
  user: string

# parent flow
- subflow:
    id: inline_auth
    flowRef: auth-flow-id # flow_ref alias accepted
    input: { user: "{{ state.user }}" }
    outputVar: authResult
```

Unknown invocation inputs, missing required child inputs, and an `outputVar`
without `meta.subflowOutput` fail compilation. The formatter preserves
canonical `input` and `outputVar` fields on round-trip. Inlining also namespaces
child node IDs, state keys, template references, and raw condition references;
only the declared output is copied back to the caller's public state.

### `return_to`

Jump back to an earlier step id (bounded loop construct).

```yaml
- return_to:
    id: try_again
    targetId: plan
    condition: "{{ state.retry }}"
    maxIterations: 3
```

### `wait`

```yaml
- wait:
    id: pause
    durationMs: 2000 # duration_ms alias accepted
```

### `checkpoint` / `restore`

Snapshot and resume points for long-running flows.

```yaml
- checkpoint:
    id: cp1
    captureOutputOf: plan
    label: after-plan
- restore:
    id: r1
    checkpointLabel: after-plan
    onNotFound: skip # or fail
```

## Output-key uniqueness

The flow-ast pass `checkOutputKeyUniqueness` checks every explicit/default output
destination and returns structured diagnostics with code
`output_key_collision` and severity `error`. `validateDocument`,
`parseDslToDocument`, `compileDocument`, `compileDsl`, and direct root
compilation all enforce the same hard gate.

Collisions are path-aware. Nested sequences and wrappers remain in their
parent's collision domain, and parallel branches share one domain. Reuse is
allowed only between explicit mutually exclusive branch then/else, approval
approve/reject, or successful try-body/recovery outcomes. The try/catch error
destination belongs to the recovery path. A later writer still collides with
every possible output from those alternatives. Explicit `set.assign` entries
remain the intentional state-mutation surface and are not result outputs. A
`for_each` body is an iteration-local state scope; its internal collisions fail,
and only declared collection/accumulator destinations join outer state.

## Validation

```ts
import { validateDocument } from "@dzupagent/flow-dsl";
const { valid, diagnostics } = validateDocument(document);
```

`parseDslToDocument` runs `validateDocument` for you and rolls its diagnostics
into the same result. Use the standalone form when you already hold a
`FlowDocumentV1` (e.g. after `canonicalizeDsl`).

## License

MIT
