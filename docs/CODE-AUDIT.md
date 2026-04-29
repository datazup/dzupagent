# Code Quality Audit - Flow DSL Textual Parsing, Normalization, Canonicalization, Formatting, Validation, and Graph Conversion

## Findings

### DOMAIN-001 - High - Invalid `dsl` versions are normalized into valid documents

**Impact:** A document that declares an unsupported DSL version can pass through `parseDslToDocument()` and `canonicalizeDsl()` as if it were `dzupflow/v1`. This breaks the version boundary that should protect future grammar changes, and it makes `DSL_ERROR.INVALID_DSL_VERSION` effectively dead code on the main parse path.

**Evidence:**
- `packages/flow-dsl/src/normalize.ts:171` through `packages/flow-dsl/src/normalize.ts:174` constructs the canonical document with `dsl: raw.dsl === 'dzupflow/v1' ? 'dzupflow/v1' : 'dzupflow/v1'`, so every input becomes `dzupflow/v1`.
- `packages/flow-dsl/src/parse-dsl.ts:34` through `packages/flow-dsl/src/parse-dsl.ts:40` attempts to report `INVALID_DSL_VERSION`, but it checks the already-normalized `document.dsl`, so the condition is unreachable for non-null documents.
- `packages/flow-dsl/src/errors.ts:1` through `packages/flow-dsl/src/errors.ts:13` defines `INVALID_DSL_VERSION`, but the current normalization flow prevents it from being emitted for a wrong textual `dsl` value.
- `packages/flow-dsl/src/__tests__/validator.test.ts:131` through `packages/flow-dsl/src/__tests__/validator.test.ts:140` explicitly documents the current behavior: `dzupflow/v2` still produces a document.

**Remediation:** Validate `raw.dsl` before constructing the canonical document. Preserve the raw value long enough to emit `INVALID_DSL_VERSION`, and make `canonicalizeDsl()` fail closed when this diagnostic appears. Add a regression test where `dsl: dzupflow/v2` returns `ok: false` and no derived graph.

### DOMAIN-002 - High - Formatter output is not a parser-compatible canonical form

**Impact:** `formatDocumentToDsl()` is exported as the textual formatter, but its output is not a reliable input to `parseDslToDocument()`. This makes canonical formatting unsafe for review, storage, or round-trip editing flows because users can format a valid document into text that the same package cannot parse back.

**Evidence:**
- `packages/flow-dsl/src/format-dsl.ts:57` through `packages/flow-dsl/src/format-dsl.ts:69` emits child fields for `- action:` at `indentLevel + 1`.
- `packages/flow-dsl/src/mini-yaml.ts:175` through `packages/flow-dsl/src/mini-yaml.ts:181` parses an inline sequence mapping with an empty value by requiring nested fields at `indent + 4`. For a `steps:` list indented two spaces, handwritten parseable DSL uses six spaces under `- action:`, while the formatter emits four.
- `packages/flow-dsl/src/__tests__/formatter.test.ts:281` through `packages/flow-dsl/src/__tests__/formatter.test.ts:285` avoids parsing formatter output and states that the formatter uses different indentation conventions than the parser expects.
- `packages/flow-dsl/src/format-dsl.ts:8` through `packages/flow-dsl/src/format-dsl.ts:13` formats multiline descriptions by passing `|` through `pushField()`, and `packages/flow-dsl/src/format-dsl.ts:217` through `packages/flow-dsl/src/format-dsl.ts:224` quotes that value as `"|"`, so it does not emit a YAML literal block marker the parser recognizes.
- `packages/flow-dsl/src/__tests__/formatter.test.ts:63` through `packages/flow-dsl/src/__tests__/formatter.test.ts:69` encodes the quoted-pipe behavior in comments instead of asserting a round-trip contract.

**Remediation:** Make the formatter and parser share one indentation contract. Add `formatDocumentToDsl(document) -> parseDslToDocument(output)` tests for every supported node kind and for multiline scalar fields. Emit literal blocks as `description: |` without quoting the pipe, and preserve blank lines/indentation according to the documented subset.

### DOMAIN-003 - Medium - Formatting is lossy for input defaults and structured scalar values

**Impact:** A canonical `FlowDocumentV1` can contain JSON-like input defaults and nested object values, but formatting either drops them or emits them in a form the mini parser treats as strings. This corrupts the authored contract across format/review/save cycles.

**Evidence:**
- `packages/flow-ast/src/types.ts:16` through `packages/flow-ast/src/types.ts:21` allows `FlowInputSpec.default?: FlowValue`.
- `packages/flow-dsl/src/format-dsl.ts:17` through `packages/flow-dsl/src/format-dsl.ts:25` formats input specs with `type`, `required`, and `description`, but never emits `spec.default`.
- `packages/flow-dsl/src/normalize.ts:756` through `packages/flow-dsl/src/normalize.ts:771` correctly preserves and validates JSON-like defaults when parsing, so the formatter is the asymmetric side of the contract.
- `packages/flow-dsl/src/format-dsl.ts:227` through `packages/flow-dsl/src/format-dsl.ts:233` emits arbitrary objects with `JSON.stringify(value)`.
- `packages/flow-dsl/src/mini-yaml.ts:268` through `packages/flow-dsl/src/mini-yaml.ts:282` parses booleans, numbers, strings, nulls, and inline arrays, but it does not parse inline JSON objects. A formatted nested object such as `{ "a": 1 }` is read back as a string.

**Remediation:** Add a `FlowValue` formatter/parser pair instead of using ad hoc scalar formatting. Emit object defaults and object input values as nested mappings, or explicitly support a JSON scalar form and parse it back. Add round-trip tests for `inputs.*.default`, nested action input, `meta`, and emit payload values.

### DOMAIN-004 - Medium - Node-kind support drifts across formatter, textual normalizer, AST parser, and validators

**Impact:** Different entry points disagree about which node kinds are valid. This is a maintainability risk because adding a node requires updates in several hand-maintained lists, and a valid AST can be formatted into textual DSL that the textual parser rejects.

**Evidence:**
- `packages/flow-ast/src/types.ts:32` through `packages/flow-ast/src/types.ts:48` includes `spawn`, `classify`, `emit`, `memory`, `checkpoint`, and `restore` in `FlowNode`.
- `packages/flow-dsl/src/format-dsl.ts:153` through `packages/flow-dsl/src/format-dsl.ts:184` emits textual forms for `spawn`, `classify`, `emit`, and `memory`.
- `packages/flow-dsl/src/normalize.ts:259` through `packages/flow-dsl/src/normalize.ts:282` accepts only textual wrappers for `action`, `if`, `parallel`, `for_each`, `approval`, `clarify`, `persona`, `route`, `complete`, `checkpoint`, and `restore`. The formatter-only node kinds above fall into `UNKNOWN_NODE_TYPE`.
- `packages/flow-ast/src/parse.ts:41` through `packages/flow-ast/src/parse.ts:52` keeps a separate `KNOWN_NODE_TYPES` set that only includes the original ten node kinds and excludes `checkpoint` and `restore`, even though `packages/flow-ast/src/validate.ts:328` through `packages/flow-ast/src/validate.ts:345` validates the newer node kinds.

**Remediation:** Introduce a single node-kind registry or table-driven node definition map shared by parsing, normalization, formatting, and validation. Until then, remove formatter cases for unsupported textual node kinds or add normalizer support for them in the same change. Add a test that enumerates `FlowNode['type']` support across parser, formatter, graph projection, and validation.

### DOMAIN-005 - Medium - Duplicate YAML mapping keys silently overwrite earlier values

**Impact:** Duplicate keys in the textual DSL can hide authoring mistakes, especially at top-level fields such as `steps`, `inputs`, or `defaults`, and inside node bodies such as `ref`, `input`, or `branches`. Silent last-write-wins behavior makes review output look valid while discarding part of the source.

**Evidence:**
- `packages/flow-dsl/src/mini-yaml.ts:197` through `packages/flow-dsl/src/mini-yaml.ts:242` builds mappings into a plain `Record<string, unknown>`.
- `packages/flow-dsl/src/mini-yaml.ts:222` through `packages/flow-dsl/src/mini-yaml.ts:238` assigns `obj[key] = ...` without tracking whether the key was already present.
- There is no duplicate-key diagnostic in `packages/flow-dsl/src/errors.ts:1` through `packages/flow-dsl/src/errors.ts:13`.
- The observed parser tests in `packages/flow-dsl/src/__tests__/mini-yaml.test.ts:23` through `packages/flow-dsl/src/__tests__/mini-yaml.test.ts:176` cover scalar, nested, sequence, literal, inline-array, and indentation errors, but not duplicate keys.

**Remediation:** Track keys within `parseMapping()` and emit a parse diagnostic on duplicates, including the duplicate line and the first occurrence if available. Decide whether duplicate keys should fail hard in `parseYamlSubset()` or remain recoverable diagnostics, then add tests for top-level and nested duplicates.

### DOMAIN-006 - Medium - Graph conversion trusts non-canonical IDs and silently collapses duplicates

**Impact:** `documentToGraph()` is exported directly and accepts a `FlowDocumentV1`, but `FlowNodeBase.id` is optional at the type level. If callers bypass `canonicalizeDsl()` or `validateDocument()`, graph conversion can synthesize IDs, collide with authored IDs, or silently collapse duplicate nodes and edges. The derived graph then becomes a lossy projection rather than a validation-backed canonical graph.

**Evidence:**
- `packages/flow-ast/src/types.ts:4` through `packages/flow-ast/src/types.ts:14` makes `FlowNodeBase.id` optional.
- `packages/flow-dsl/src/document-to-graph.ts:39` through `packages/flow-dsl/src/document-to-graph.ts:42` generates fallback IDs from `node.type` and `state.nodes.length + 1`.
- `packages/flow-dsl/src/document-to-graph.ts:116` through `packages/flow-dsl/src/document-to-graph.ts:119` silently returns when a node ID already exists.
- `packages/flow-dsl/src/document-to-graph.ts:121` through `packages/flow-dsl/src/document-to-graph.ts:130` silently returns when an edge ID already exists.
- `packages/flow-ast/src/validate.ts:1397` through `packages/flow-ast/src/validate.ts:1420` enforces non-empty unique IDs only during document validation, not inside the graph converter itself.

**Remediation:** Either make `documentToGraph()` validate canonical ID invariants before projection, or narrow its accepted type to a validated/canonical branded document. At minimum, return graph diagnostics for duplicate and synthesized IDs instead of silently dropping nodes and edges. Add tests for duplicate IDs and authored IDs that collide with fallback IDs.

### DOMAIN-007 - Medium - Validation and normalization rules are duplicated across several walkers

**Impact:** The DSL stack has separate hand-maintained walkers for mini-YAML parsing, textual normalization, document validation, legacy AST parsing, compiler shape validation, and graph projection. The current bugs around DSL versioning, node-kind drift, formatter round-trip, and route/clarification constraints are symptoms of duplicated rule ownership rather than isolated style issues.

**Evidence:**
- `packages/flow-dsl/src/normalize.ts:317` through `packages/flow-dsl/src/normalize.ts:705` implements per-node normalization and required-field diagnostics.
- `packages/flow-ast/src/validate.ts:347` through `packages/flow-ast/src/validate.ts:1081` implements a separate per-node validation walker.
- `packages/flow-compiler/src/stages/shape-validate.ts:34` through `packages/flow-compiler/src/stages/shape-validate.ts:205` implements another structural validation walker.
- `packages/flow-ast/src/parse.ts:41` through `packages/flow-ast/src/parse.ts:52` and `packages/flow-dsl/src/normalize.ts:259` through `packages/flow-dsl/src/normalize.ts:282` keep separate node-kind lists.
- `packages/flow-dsl/src/normalize.ts:581` through `packages/flow-dsl/src/normalize.ts:613`, `packages/flow-ast/src/validate.ts:732` through `packages/flow-ast/src/validate.ts:806`, and `packages/flow-compiler/src/stages/shape-validate.ts:136` through `packages/flow-compiler/src/stages/shape-validate.ts:155` all encode route-specific requirements.

**Remediation:** Consolidate node definitions into declarative descriptors that own aliases, required fields, child collections, formatting names, and validation constraints. Generate or table-drive the repetitive switch cases from those descriptors. Add a consistency test that compares supported node kinds and child paths across the DSL, AST, compiler, and graph modules.

### DOMAIN-008 - Low - Inline scalar parsing is fragile for quoted commas, nested arrays, and JSON-like values

**Impact:** The parser is intentionally a YAML subset, but the subset accepts inline arrays in a way that looks more capable than it is. Values containing commas or nested bracket/object syntax are split incorrectly or retained as strings, which can surprise authors when tags, choices, defaults, or payloads contain richer values.

**Evidence:**
- `packages/flow-dsl/src/mini-yaml.ts:277` through `packages/flow-dsl/src/mini-yaml.ts:280` parses inline arrays with `inner.split(',')`.
- `packages/flow-dsl/src/mini-yaml.ts:268` through `packages/flow-dsl/src/mini-yaml.ts:282` has no state machine for quotes, escapes, nesting, or inline objects.
- `packages/flow-dsl/src/__tests__/mini-yaml.test.ts:129` through `packages/flow-dsl/src/__tests__/mini-yaml.test.ts:140` covers only simple inline arrays and empty arrays.

**Remediation:** Either document and enforce a narrower scalar grammar, or replace `split(',')` with a small token parser that respects quotes and bracket nesting. Add tests for `["a,b"]`, nested arrays, escaped quotes, and inline JSON objects if those remain accepted.

### DOMAIN-009 - Low - `parseDslToDocument()` returns partial documents alongside diagnostics

**Impact:** `canonicalizeDsl()` correctly fails closed when diagnostics exist, but lower-level callers of `parseDslToDocument()` can receive a non-null document that has known unsupported fields, missing required fields, or validation failures. This is a fragile API invariant because callers must remember that `document !== null` does not mean "valid".

**Evidence:**
- `packages/flow-dsl/src/parse-dsl.ts:43` through `packages/flow-dsl/src/parse-dsl.ts:47` returns `document: validation.valid ? (document as FlowDocumentV1) : document`, so a structurally invalid normalized document can still be returned.
- `packages/flow-dsl/src/canonicalize-dsl.ts:6` through `packages/flow-dsl/src/canonicalize-dsl.ts:15` adds a stricter wrapper that rejects any diagnostics, implying the lower-level parse result needs extra interpretation.
- `packages/flow-dsl/src/__tests__/validator.test.ts:123` through `packages/flow-dsl/src/__tests__/validator.test.ts:128` asserts that unsupported top-level fields still produce a document.

**Remediation:** Make the parse result state explicit. Options include returning `{ valid: boolean }`, returning `document: null` when diagnostics include error-level issues, or splitting recoverable warnings from hard errors. Document which diagnostics are safe to ignore and update tests accordingly.

### DOMAIN-010 - Low - Textual formatting accepts values wider than the textual grammar

**Impact:** Several AST fields are typed as `Record<string, unknown>`, and the formatter accepts them without checking that each value is representable in the textual DSL. Non-JSON values can be stringified incorrectly, while valid nested objects are emitted in a form the parser does not reconstruct.

**Evidence:**
- `packages/flow-ast/src/types.ts:13`, `packages/flow-ast/src/types.ts:54`, `packages/flow-ast/src/types.ts:99`, and `packages/flow-ast/src/types.ts:113` use `Record<string, unknown>` for `meta`, action input, spawn input, and emit payload.
- `packages/flow-dsl/src/format-dsl.ts:43` through `packages/flow-dsl/src/format-dsl.ts:48`, `packages/flow-dsl/src/format-dsl.ts:66` through `packages/flow-dsl/src/format-dsl.ts:69`, and `packages/flow-dsl/src/format-dsl.ts:170` through `packages/flow-dsl/src/format-dsl.ts:174` format those unknown values as textual scalars.
- `packages/flow-dsl/src/format-dsl.ts:227` through `packages/flow-dsl/src/format-dsl.ts:233` falls back to `JSON.stringify(value)` without validating that the result is parseable by `parseScalar()`.

**Remediation:** Define a textual-format value type, likely `FlowValue`, and either reject non-representable values with diagnostics or emit them as nested mappings. If `unknown` must remain in the AST, keep the formatter result as `{ ok, text, diagnostics }` rather than a bare string.

### DOMAIN-011 - Low - Test coverage is broad but misses the highest-risk round-trip and drift contracts

**Impact:** The package has many tests, but the tests currently allow several important invariants to drift: formatter output round-tripping, wrong DSL version rejection, duplicate YAML keys, formatter support for newer node kinds, and structured default formatting. This is not a zero-test package, but the missing tests align with the actual correctness risks found above.

**Evidence:**
- `packages/flow-dsl/src/__tests__/formatter.test.ts:281` through `packages/flow-dsl/src/__tests__/formatter.test.ts:285` explicitly avoids parsing formatter output.
- `packages/flow-dsl/src/__tests__/validator.test.ts:131` through `packages/flow-dsl/src/__tests__/validator.test.ts:140` documents wrong-version acceptance rather than rejecting it.
- `packages/flow-dsl/test/format-dsl.test.ts:5` through `packages/flow-dsl/test/format-dsl.test.ts:25` checks only containment for a minimal document.
- `packages/flow-dsl/test/document-to-graph.test.ts:5` through `packages/flow-dsl/test/document-to-graph.test.ts:24` covers only a simple sequence in the top-level test folder, while the more detailed graph tests still do not cover duplicate IDs.
- Declarative files such as `packages/flow-dsl/src/index.ts`, `packages/flow-dsl/src/errors.ts`, and `packages/flow-dsl/src/types.ts` have no direct behavioral tests, which is acceptable; the meaningful gap is around cross-module contracts, not those low-risk export/type files.

**Remediation:** Add contract tests instead of more containment tests: `parse(format(doc))`, `format(parse(source).document)`, node-kind matrix consistency, wrong-version failure, duplicate-key failure, and graph projection on duplicate/missing IDs. Keep simple export/type files covered indirectly unless they gain behavior.

### DOMAIN-012 - Info - Graph-style input is deliberately rejected in textual DSL

**Impact:** This is a boundary note, not a defect. The textual DSL rejects top-level `nodes` and `edges` and requires authoring through `steps`. That is a maintainable boundary as long as consuming apps do not expect graph-style documents to be accepted by `@dzupagent/flow-dsl`.

**Evidence:**
- `packages/flow-dsl/src/normalize.ts:146` through `packages/flow-dsl/src/normalize.ts:159` emits a targeted unsupported-field diagnostic and suggestion for top-level `nodes` and `edges`.
- `packages/flow-dsl/test/parse-dsl.test.ts:71` through `packages/flow-dsl/test/parse-dsl.test.ts:95` asserts rejection of graph-style top-level input.
- `packages/flow-dsl/src/canonicalize-dsl.ts:6` through `packages/flow-dsl/src/canonicalize-dsl.ts:15` fails closed and does not derive graph output when diagnostics are present.

**Remediation:** Keep this boundary documented in package docs and compiler-facing errors. If graph-style imports become a product requirement, implement them as a separate converter instead of weakening the `dzupflow/v1` textual authoring form.

## Finding Manifest

```json
{
  "domain": "code quality",
  "counts": { "critical": 0, "high": 2, "medium": 5, "low": 4, "info": 1 },
  "findings": [
    { "id": "DOMAIN-001", "severity": "high", "title": "Invalid dsl versions are normalized into valid documents", "file": "packages/flow-dsl/src/normalize.ts" },
    { "id": "DOMAIN-002", "severity": "high", "title": "Formatter output is not a parser-compatible canonical form", "file": "packages/flow-dsl/src/format-dsl.ts" },
    { "id": "DOMAIN-003", "severity": "medium", "title": "Formatting is lossy for input defaults and structured scalar values", "file": "packages/flow-dsl/src/format-dsl.ts" },
    { "id": "DOMAIN-004", "severity": "medium", "title": "Node-kind support drifts across formatter, textual normalizer, AST parser, and validators", "file": "packages/flow-dsl/src/normalize.ts" },
    { "id": "DOMAIN-005", "severity": "medium", "title": "Duplicate YAML mapping keys silently overwrite earlier values", "file": "packages/flow-dsl/src/mini-yaml.ts" },
    { "id": "DOMAIN-006", "severity": "medium", "title": "Graph conversion trusts non-canonical IDs and silently collapses duplicates", "file": "packages/flow-dsl/src/document-to-graph.ts" },
    { "id": "DOMAIN-007", "severity": "medium", "title": "Validation and normalization rules are duplicated across several walkers", "file": "packages/flow-dsl/src/normalize.ts" },
    { "id": "DOMAIN-008", "severity": "low", "title": "Inline scalar parsing is fragile for quoted commas, nested arrays, and JSON-like values", "file": "packages/flow-dsl/src/mini-yaml.ts" },
    { "id": "DOMAIN-009", "severity": "low", "title": "parseDslToDocument returns partial documents alongside diagnostics", "file": "packages/flow-dsl/src/parse-dsl.ts" },
    { "id": "DOMAIN-010", "severity": "low", "title": "Textual formatting accepts values wider than the textual grammar", "file": "packages/flow-dsl/src/format-dsl.ts" },
    { "id": "DOMAIN-011", "severity": "low", "title": "Test coverage is broad but misses the highest-risk round-trip and drift contracts", "file": "packages/flow-dsl/src/__tests__/formatter.test.ts" },
    { "id": "DOMAIN-012", "severity": "info", "title": "Graph-style input is deliberately rejected in textual DSL", "file": "packages/flow-dsl/src/normalize.ts" }
  ]
}
```

## Scope Reviewed

Reviewed current repository code for the code quality domain, weighted toward textual DSL parsing, normalization, canonicalization, formatting, document validation, and graph conversion.

Primary files inspected:
- `context/repo-snapshot.md` from the prepared audit prompt pack.
- `packages/flow-dsl/src/parse-dsl.ts`
- `packages/flow-dsl/src/mini-yaml.ts`
- `packages/flow-dsl/src/normalize.ts`
- `packages/flow-dsl/src/format-dsl.ts`
- `packages/flow-dsl/src/canonicalize-dsl.ts`
- `packages/flow-dsl/src/document-validate.ts`
- `packages/flow-dsl/src/document-to-graph.ts`
- `packages/flow-dsl/src/types.ts`
- `packages/flow-dsl/src/errors.ts`
- `packages/flow-ast/src/types.ts`
- `packages/flow-ast/src/parse.ts`
- `packages/flow-ast/src/validate.ts`
- `packages/flow-compiler/src/authoring-input.ts`
- `packages/flow-compiler/src/cli-input.ts`
- `packages/flow-compiler/src/index.ts`
- `packages/flow-compiler/src/stages/shape-validate.ts`

Tests inspected selectively:
- `packages/flow-dsl/test/*.test.ts`
- `packages/flow-dsl/src/__tests__/*.test.ts`
- `packages/flow-ast/test/*.test.ts`
- `packages/flow-compiler/test/cli-input.test.ts`

Generated files, dependency folders, and old audit artifacts were not used as source evidence. No runtime validation command was run for this audit; findings are based on current source and test inspection.

## Strengths

- `canonicalizeDsl()` fails closed when parse, normalize, or validate diagnostics exist, and it avoids deriving a graph for invalid input.
- Diagnostics carry a phase (`parse`, `normalize`, `validate`), code, message, path, and optional suggestion, which is useful for editor and product UX integration.
- `flow-ast` now has a recursive `FlowValue` guard for input defaults, and `flow-dsl` normalization aligns with it for parsed defaults.
- The textual DSL explicitly rejects graph-style `nodes` and `edges`, preserving a clear authoring boundary around `steps`.
- There is meaningful test coverage across parser basics, normalization, validation, graph projection, compiler CLI input, and checkpoint/restore behavior. The gaps are concentrated around cross-module contract tests rather than lack of tests overall.
- The compiler has a dedicated `prepareFlowInputFromDsl()` path, so textual authoring can be hardened behind one canonicalization seam.

## Open Questions Or Assumptions

- Assumption: `formatDocumentToDsl()` is intended to produce reusable source text, not just a display-only preview. Its package description says parser, formatter, validator, and graph projection, so this audit treats round-trip safety as an expected quality property.
- Assumption: `dzupflow/v1` should reject unknown `dsl` values even when the rest of the document is structurally valid.
- Open question: Should the textual DSL eventually support every `FlowNode` kind, or should it intentionally remain a smaller authoring subset? The formatter currently implies broader support than the normalizer provides.
- Open question: Should `parseDslToDocument()` expose warnings separately from hard errors, or should callers use `canonicalizeDsl()` for any valid-document need?
- Open question: Should `meta`, action input, spawn input, and emit payload be constrained to `FlowValue` for text formatting, while the lower-level AST remains `unknown` for runtime compatibility?

## Recommended Next Actions

1. Fix the DSL version invariant first. Preserve `raw.dsl`, emit `INVALID_DSL_VERSION`, and add a failing canonicalization test for `dzupflow/v2`.
2. Establish the formatter contract. Either mark it display-only and rename/document it accordingly, or make `parse(format(document))` a required test across supported node kinds.
3. Close the lossy formatting gaps for `FlowValue`: input defaults, nested objects, arrays with quoted commas, and multiline strings.
4. Create a node-kind consistency test that compares AST types, textual normalizer wrappers, formatter cases, graph projection cases, and compiler shape validation.
5. Add duplicate-key detection in `mini-yaml` before widening the grammar further.
6. Harden `documentToGraph()` with canonical validation or diagnostics for duplicate/missing IDs before projection.
7. Consolidate repeated node rules into a declarative table once the immediate correctness fixes are in place. This is the maintainability step that prevents the same drift from reappearing.
