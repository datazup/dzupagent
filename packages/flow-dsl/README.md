# @dzupagent/flow-dsl

Textual dzupflow/v1 DSL parser, formatter, validator, and graph projection for
the DzupAgent framework. Author multi-step agent flows in YAML (or plain JSON);
this package compiles them into the typed `FlowDocumentV1` AST consumed by the
codev-app flow-runtime executor.

Part of the [DzupAgent](../../README.md) framework.

## Usage

```ts
import {
  parseDslToDocument,
  validateDocument,
  canonicalizeDsl,
} from '@dzupagent/flow-dsl'

const { ok, document, diagnostics } = parseDslToDocument(source)
if (!ok) {
  console.error(diagnostics)
  process.exit(1)
}
```

`parseDslToDocument(source)` runs three phases in order — YAML subset parse,
normalize (canonical AST), validate (semantic checks) — and returns a single
`ParseDslResult`. Any diagnostic in any phase fails the call and sets
`ok: false`.

## Document shape

```yaml
dsl: dzupflow/v1                # or dzupflow/v1alpha-agent
id: my-flow                     # flow identifier
version: 1
title: Optional human title
description: Optional one-liner
inputs:
  goal: string                  # shorthand
  count:                        # or full spec
    type: number
    required: false
    default: 5
defaults:
  persona: planner              # alias for personaRef
  timeout_ms: 300000            # alias for timeoutMs
  retry: { attempts: 3, delayMs: 100 }
steps:
  - action:
      id: plan
      ref: tool.plan_task
      input: { goal: '{{ input.goal }}' }
  - complete:
      id: done
      result: ok
```

`steps` is a flat array of single-key node wrappers — `- action: { ... }`,
`- if: { ... }`, etc. Graph-style top-level `nodes`/`edges` fields are
explicitly rejected.

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

| Filter         | Behavior                                                                                  |
|----------------|-------------------------------------------------------------------------------------------|
| `length`       | `Array.length` / `String.length`; `undefined` otherwise.                                  |
| `json`         | `JSON.stringify(value)`.                                                                  |
| `upper`        | `String(value).toUpperCase()`; `undefined` for null/undefined.                            |
| `lower`        | `String(value).toLowerCase()`; `undefined` for null/undefined.                            |
| `default:"x"`  | Returns the literal arg when value is null/undefined; passthrough otherwise. Arg accepts a quoted string, a signed integer, or a bare string. |

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
    ref: tool.plan_task           # or toolRef
    input: { goal: '{{ input.goal }}' }
    persona: planner              # optional; binds personaRef
```

### `complete`

Mark the flow finished.

```yaml
- complete:
    id: done
    result: ok                    # optional string
```

### `set`

Declarative state mutation. Values are resolved through `resolveDeep` before
being merged into state. Journal payload records only the assigned keys (not
their values) to avoid leaking secrets.

```yaml
- set:
    id: seed_state
    assign:
      count: '{{ state.items | length }}'
      done: true
      summary: '{{ state.last_agent.output.summary }}'
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
    valueExpr: '{{ plan }}'        # value_expr alias accepted
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
    query: '{{ state.who }}'       # required, may use templates
    limit: 5                       # positive integer; defaults to 10
    outputVar: priorSessions       # default: memorySearchResults
```

`query` is required for `search` and is resolved through the template engine
at execution time. Results land in `outputVar` as `MemoryItem[]`.

### `http`

Execute an HTTP request. `url`, `headers`, and `body` are all template-resolved
via `resolveDeep` at execution.

```yaml
- http:
    id: post_echo
    method: POST                  # GET|POST|PUT|PATCH|DELETE
    url: '{{ state.endpoint }}/echo/{{ state.who }}'
    headers:
      Authorization: 'Bearer {{ state.token }}'
    body:
      firstTag: '{{ state.items[0] }}'
      count: '{{ state.items | length }}'
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
    userPrompt: 'Greet {{ state.who | upper }}'
    systemPrompt: 'You are concise.'    # optional; wins over inherited persona
    outputKey: greeting                 # where to store the assistant reply
    model: claude-sonnet-4-6            # optional override
    provider: anthropic                 # optional override
    tools: true                         # optional; expose host tools
```

### `agent`

Multi-iteration agent loop with structured output, retry, validation, and
policy. Available under `dsl: dzupflow/v1alpha-agent` (and forward).

```yaml
- agent:
    id: plan
    agentId: planner
    profile: planner-profile          # optional profile reference
    toolset: planning                  # named toolset to expand
    tools: [fs.read]                   # or explicit tool ids
    instructions: 'Plan the work'
    input: { topic: flow }
    stop: { maxIterations: 4, requireFinalSchema: true }
    output: { key: plan, schemaRef: plan.v1 }
    retry:
      onInvalidOutput: { attempts: 2, repairPrompt: true }
      onValidationFailure: { attempts: 1, fullLoop: false }
      onModelUnavailable: { attempts: 2, fallbackProfile: backup }
    validation:
      required: [{ command: 'yarn typecheck' }]
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
      - { command: 'yarn typecheck' }
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
    ref: friendly-assistant            # or personaId
    body:
      - prompt:
          id: greet
          userPrompt: 'Greet the user.'
          outputKey: greeting
```

### `route`

Capability- or provider-routed sub-sequence.

```yaml
- route:
    id: pick_path
    strategy: capability               # or fixed-provider
    tags: [fast, cheap]
    body:
      - action: { ref: skill:run, input: {} }
```

### `if` / branch

```yaml
- if:
    condition: '{{ state.count | length }}'
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

### `for_each`

Iterate a state source. Supports `attachAs`, `collectInto`, `accumulator`, and
`concurrency` for parallel iteration (see flow-ast types for details).

```yaml
- for_each:
    id: process_items
    source: items                      # state key (or template)
    as: item
    body:
      - action: { ref: skill:process, input: { item: '{{ item }}' } }
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
    condition: '{{ state.running }}'
    maxIterations: 50                  # max_iterations alias accepted
    body:
      - action: { ref: skill:check, input: {} }
```

### `approval`

Pause for human approval; branch on the response.

```yaml
- approval:
    id: gate
    question: 'Proceed with deploy?'
    options: [yes, no]
    onApprove:
      - action: { ref: skill:deploy, input: {} }
    onReject:
      - complete: { result: aborted }
```

### `clarify`

Pause for a clarification answer (`text` or `choice`).

```yaml
- clarify:
    id: ask_name
    question: 'What is your name?'
    expected: text                     # or choice
    choices: [a, b]                    # required when expected = choice
```

### `classify`

LLM-driven enum selection from a fixed choice list.

```yaml
- classify:
    id: pick_tier
    prompt: 'Which implementation tier?'
    choices: [frontend, backend, infra]
    output: tier                       # alias for outputKey
    default: infra                     # must be one of choices
```

### `emit`

Emit a structured event to the host event bus. `payload` is deep-resolved
through the template engine.

```yaml
- emit:
    id: announce
    event: demo.completed
    payload:
      who: '{{ state.who }}'
      itemCount: '{{ state.items | length }}'
      descriptor: '{{ state.who }} processed {{ state.items | length }} tags'
```

### `spawn`

Spawn a child flow run from a template; optionally block until completion.

```yaml
- spawn:
    id: run_child
    templateRef: tmpl-abc              # template_ref alias accepted
    waitForCompletion: true
    input: { goal: '{{ input.goal }}' }
```

### `subflow`

Inline another flow document by reference.

```yaml
- subflow:
    id: inline_auth
    flowRef: auth-flow-id              # flow_ref alias accepted
    input: { user: '{{ state.user }}' }
    outputVar: authResult
```

### `return_to`

Jump back to an earlier step id (bounded loop construct).

```yaml
- return_to:
    id: try_again
    targetId: plan
    condition: '{{ state.retry }}'
    maxIterations: 3
```

### `wait`

```yaml
- wait:
    id: pause
    durationMs: 2000                   # duration_ms alias accepted
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
    onNotFound: skip                   # or fail
```

## Output-key uniqueness

The flow-ast pass `checkOutputKeyUniqueness` flags two `agent` nodes that share
the same `output.key` within the same sequence-scope. Scopes are:

- the root sequence
- each persona / for_each / route body
- each branch `then` / `else`
- each approval `onApprove` / `onReject`
- each `try_catch` body and `catch`
- each parallel branch

Cross-scope duplicates are allowed because they cannot both execute on the same
path.

Today these are surfaced by `checkOutputKeyUniqueness(root)` as structured
diagnostics with code `output_key_collision` and severity `warning`. They do
not block DSL parsing or document validation. Promotion to errors is planned for
a follow-up milestone.

## Validation

```ts
import { validateDocument } from '@dzupagent/flow-dsl'
const { valid, diagnostics } = validateDocument(document)
```

`parseDslToDocument` runs `validateDocument` for you and rolls its diagnostics
into the same result. Use the standalone form when you already hold a
`FlowDocumentV1` (e.g. after `canonicalizeDsl`).

## License

MIT
