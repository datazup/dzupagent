# flow-ast expression policy

flow-ast ships four expression facilities. This is the one policy for which
engine new code uses, what each facility is for, and how each is exported
(ARCH27-T-17; supersedes nothing — it documents intent that previously lived
nowhere).

## The rule for new code

**Author conditions as structured `FlowExpression` values and evaluate them
with the typed condition evaluator.** Do not add capabilities to the legacy
string engine, and do not introduce a fifth expression facility — extend
`FlowExpression` and the typed evaluator instead.

## The four facilities

| Facility                    | Role                                                                                           | Status                                     | Export policy                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `expressions.ts`            | The structured `FlowExpression`/`FlowTypedCondition` AST and its static analysis               | **Current** authoring surface              | Subpath `@dzupagent/flow-ast/expressions`; the AST types alone are re-exported (type-only) from the root barrel          |
| `typed-condition-evaluator` | Evaluates `FlowTypedCondition` against flow state with typed diagnostics                       | **Current** evaluation engine — the future | Subpath `@dzupagent/flow-ast/typed-condition-evaluator` only; never on the root barrel                                   |
| `condition-expression.ts`   | The legacy string-source subset (`{{ … }}` templates, `&&`/`                                   |                                            | `/`!`, fixed comparators)                                                                                                | **Legacy** — frozen; kept for shipped string conditions (production consumer: flow-compiler `stages/semantic-condition.ts`) | Root barrel star-exports the curated facade (3 functions, 2 types); implementation lives in `condition-expression/` and is not exported |
| `reference-expression`      | The `{{ reference }}` grammar parser and template-reference analysis shared by the other three | **Internal support library**               | Not exported from the package at all — imported relatively by expressions, the typed evaluator, and the legacy validator |

## Migration path

1. New flow authoring surfaces produce `FlowExpression` (already the case for
   typed conditions in the v2 DSL).
2. String conditions reaching the runtime keep working through the legacy
   facade; each remaining producer of raw string conditions migrates to
   structured conditions on its own schedule, after which its edge stops
   touching the legacy engine.
3. When flow-compiler's `semantic-condition.ts` stage no longer receives raw
   string conditions, the legacy facade is deleted from the root barrel in the
   explicit-export consolidation review that `config/barrel-budgets.json`
   already pins for this package (`rootDebtPin`, review by 2026-09-09).

## Uniformity notes

- Root-barrel visibility is the exception, not the rule: only the legacy
  facade (compatibility) and the AST types (authoring ergonomics) are
  root-visible. Every engine lives behind its own subpath or stays internal.
- No expression _internals_ module may be star-exported from the root barrel;
  the legacy facade exists precisely so the root star-export re-exports a
  curated surface.
- `dialogue-core` has an unrelated private `evaluateConditionExpression` in
  its scheduler — it is not part of this policy's scope, but a future
  consolidation should route it through the typed evaluator too.
