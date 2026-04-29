# Architecture Audit

## Findings

### ARCHITECTURE-001 - High - Textual DSL coverage is behind the canonical AST and formatter

**Impact:** `dzupflow/v1` is presented as the editable textual form for canonical flow documents, but users cannot author every canonical node kind through the parser even though the formatter can emit several of those kinds. This breaks format -> parse round trips, blocks textual authoring for runtime leaf capabilities, and makes the DSL an incomplete projection rather than a canonical authoring surface.

**Evidence:** The canonical `FlowNode` union includes `SpawnNode`, `ClassifyNode`, `EmitNode`, and `MemoryNode` in `packages/flow-ast/src/types.ts:43` through `packages/flow-ast/src/types.ts:48`, with their shapes defined in `packages/flow-ast/src/types.ts:96` through `packages/flow-ast/src/types.ts:122`. The formatter emits `spawn`, `classify`, `emit`, and `memory` wrappers in `packages/flow-dsl/src/format-dsl.ts:153` through `packages/flow-dsl/src/format-dsl.ts:184`. The normalizer switch only accepts `action`, `if`, `parallel`, `for_each`, `approval`, `clarify`, `persona`, `route`, `complete`, `checkpoint`, and `restore`, then reports any other wrapper as `UNKNOWN_NODE_TYPE` in `packages/flow-dsl/src/normalize.ts:259` through `packages/flow-dsl/src/normalize.ts:290`. Tests also encode unknown wrappers as hard errors in `packages/flow-dsl/src/__tests__/normalize.test.ts:669` through `packages/flow-dsl/src/__tests__/normalize.test.ts:675`.

**Remediation:** Introduce a single node-authoring registry or table shared by normalization, formatting, document-to-graph projection, and tests. Either add parser/normalizer support for `spawn`, `classify`, `emit`, and `memory`, or mark formatter output for unsupported nodes as impossible with a typed failure result instead of emitting DSL that the parser rejects. Add round-trip tests for every `FlowNode` variant.

### ARCHITECTURE-002 - High - Formatter output is not value-preserving

**Impact:** A canonical document formatted back to textual DSL can lose or change data before it is parsed again. That undermines canonicalization and makes the formatter risky for editor save-on-format, generated examples, or review artifacts.

**Evidence:** `FlowInputSpec.default` is part of the canonical input contract in `packages/flow-ast/src/types.ts:16` through `packages/flow-ast/src/types.ts:21`, and normalization preserves valid defaults in `packages/flow-dsl/src/normalize.ts:756` through `packages/flow-dsl/src/normalize.ts:771`. The formatter emits input `type`, `required`, and `description`, but never emits `spec.default` in `packages/flow-dsl/src/format-dsl.ts:17` through `packages/flow-dsl/src/format-dsl.ts:25`. For arbitrary scalar values, the formatter emits arrays inline and objects via `JSON.stringify` in `packages/flow-dsl/src/format-dsl.ts:227` through `packages/flow-dsl/src/format-dsl.ts:232`, while the parser only understands inline arrays by splitting on commas and does not parse inline objects in `packages/flow-dsl/src/mini-yaml.ts:277` through `packages/flow-dsl/src/mini-yaml.ts:282`. That means object-valued action inputs or metadata can come back as strings rather than structured values.

**Remediation:** Make the formatter return a `Result` when a value cannot be represented losslessly, or teach it to emit nested YAML for every `FlowValue` shape and extend the parser accordingly. Add fixture-based format -> parse -> validate tests covering input defaults, nested objects, arrays of objects, quoted commas, and metadata.

### ARCHITECTURE-003 - Medium - Graph conversion can silently mask invalid node IDs

**Impact:** `documentToGraph()` is exported as a standalone public helper but does not enforce the canonical document invariants it relies on. If callers pass unchecked objects or ASTs with missing/duplicate IDs, graph projection can synthesize IDs, drop duplicate nodes, and suppress duplicate edges instead of returning diagnostics. This produces lossy graph views that look valid.

**Evidence:** `documentToGraph()` projects directly from `document.root.nodes` without validating the document in `packages/flow-dsl/src/document-to-graph.ts:15` through `packages/flow-dsl/src/document-to-graph.ts:18`. It synthesizes IDs for nodes without an `id` in `packages/flow-dsl/src/document-to-graph.ts:39` through `packages/flow-dsl/src/document-to-graph.ts:41`, and `pushNode` / `pushEdge` silently skip duplicate IDs in `packages/flow-dsl/src/document-to-graph.ts:116` through `packages/flow-dsl/src/document-to-graph.ts:129`. The canonical validator separately requires non-empty IDs and rejects duplicates in `packages/flow-ast/src/validate.ts:1397` through `packages/flow-ast/src/validate.ts:1419`. Current graph tests explicitly accept auto-generated IDs for nodes without IDs in `packages/flow-dsl/src/__tests__/graph.test.ts:173` through `packages/flow-dsl/src/__tests__/graph.test.ts:183`.

**Remediation:** Add a validating projection API, for example `validateAndDocumentToGraph(document): { ok, graph, diagnostics }`, and make direct projection either private or clearly documented as unsafe. Prefer failing on duplicate IDs in graph conversion because duplicate canonical IDs are structural defects, not deduplication opportunities.

### ARCHITECTURE-004 - Medium - Parallel branch names are encoded in freeform metadata

**Impact:** Branch identity is a graph and formatting concern, but the AST has no dedicated field for branch names. The DSL stores branch names in `meta.branchNames`, so semantic branch labels can collide with user metadata, drift from branch order, or be fabricated by callers that construct canonical documents directly.

**Evidence:** `ParallelNode` only stores `branches: FlowNode[][]` in `packages/flow-ast/src/types.ts:94`. The DSL normalizer captures named YAML branches and writes them into `meta.branchNames` in `packages/flow-dsl/src/normalize.ts:377` through `packages/flow-dsl/src/normalize.ts:425`. The formatter then reads `node.meta?.['branchNames']` to choose emitted branch keys in `packages/flow-dsl/src/format-dsl.ts:82` through `packages/flow-dsl/src/format-dsl.ts:93`, and graph projection uses the same metadata for edge labels in `packages/flow-dsl/src/document-to-graph.ts:95` through `packages/flow-dsl/src/document-to-graph.ts:106`. Tests also rely on `meta.branchNames` for branch labels in `packages/flow-dsl/src/__tests__/graph.test.ts:104` through `packages/flow-dsl/src/__tests__/graph.test.ts:140`.

**Remediation:** Promote branch names into a typed AST construct, such as `ParallelBranch { id?: string; name: string; nodes: FlowNode[] }`, or define a reserved metadata namespace with validation that length and order match `branches`. Update formatter and graph projection to consume that typed representation.

### ARCHITECTURE-005 - Medium - Structural validation rules diverge between textual DSL and canonical AST/compiler paths

**Impact:** A flow can be invalid in the textual DSL but valid as canonical JSON or direct compiler input. That weakens the promise that textual DSL normalization, document validation, and compiler shape validation describe the same language.

**Evidence:** The textual normalizer requires `parallel.branches` to define at least two named branches in `packages/flow-dsl/src/normalize.ts:388` through `packages/flow-dsl/src/normalize.ts:416`. The canonical AST validator rejects only zero branches in `packages/flow-ast/src/validate.ts:808` through `packages/flow-ast/src/validate.ts:845`, and the compiler shape validator also rejects only zero branches in `packages/flow-compiler/src/stages/shape-validate.ts:81` through `packages/flow-compiler/src/stages/shape-validate.ts:92`. The low-level AST parser accepts any array length and does not enforce the two-branch rule in `packages/flow-ast/src/parse.ts:605` through `packages/flow-ast/src/parse.ts:635`.

**Remediation:** Decide whether a one-branch parallel is semantically valid. If it is invalid, enforce the rule in `flow-ast` and compiler shape validation. If it is valid, relax the textual normalizer. Add cross-entry tests that feed the same structure through DSL, document JSON, and direct compiler input.

### ARCHITECTURE-006 - Medium - The custom mini-YAML parser is an under-specified language boundary

**Impact:** The textual DSL depends on a bespoke YAML subset parser rather than a documented grammar or a standard YAML parser. This makes authoring semantics hard to reason about, especially for quoted strings, inline arrays, comments, nested structured values, and future language additions.

**Evidence:** The parser tokenizes by raw indentation and skips only whole-line comments in `packages/flow-dsl/src/mini-yaml.ts:104` through `packages/flow-dsl/src/mini-yaml.ts:127`. Mapping keys are limited to identifier-like strings in `packages/flow-dsl/src/mini-yaml.ts:34` through `packages/flow-dsl/src/mini-yaml.ts:48`. Quoted strings are unwrapped without escape interpretation in `packages/flow-dsl/src/mini-yaml.ts:268` through `packages/flow-dsl/src/mini-yaml.ts:272`, and inline arrays are parsed with a simple comma split in `packages/flow-dsl/src/mini-yaml.ts:277` through `packages/flow-dsl/src/mini-yaml.ts:280`. The package description presents parser, formatter, validator, and graph projection as public package behavior in `packages/flow-dsl/package.json:2` through `packages/flow-dsl/package.json:5`.

**Remediation:** Either formalize the YAML subset in a grammar and compliance test suite, or adopt a mature YAML parser and validate the parsed object against the DSL schema. Keep the supported subset explicit in docs so formatter, parser, and examples cannot drift.

### ARCHITECTURE-007 - Low - Source-location diagnostics stop after syntax parsing

**Impact:** Authoring tools can point at YAML syntax failures, but normalization and validation failures only carry logical paths. This limits editor integrations and makes complex nested flow errors harder to connect back to the text the user wrote.

**Evidence:** `DslDiagnostic` supports an optional `span` in `packages/flow-dsl/src/types.ts:10` through `packages/flow-dsl/src/types.ts:17`. `parseDslToDocument()` fills spans only when `parseYamlSubset()` returns parser errors in `packages/flow-dsl/src/parse-dsl.ts:10` through `packages/flow-dsl/src/parse-dsl.ts:26`. Normalization diagnostics are created with paths but no spans throughout `packages/flow-dsl/src/normalize.ts`, for example unsupported top-level fields in `packages/flow-dsl/src/normalize.ts:146` through `packages/flow-dsl/src/normalize.ts:160` and required action fields in `packages/flow-dsl/src/normalize.ts:333` through `packages/flow-dsl/src/normalize.ts:340`. Validation diagnostics similarly map schema issues to path-only diagnostics in `packages/flow-dsl/src/document-validate.ts:11` through `packages/flow-dsl/src/document-validate.ts:20`.

**Remediation:** Preserve source ranges while parsing into the intermediate object, or maintain a path-to-span source map from the mini-YAML tokenizer. Use that map when emitting normalization and validation diagnostics.

### ARCHITECTURE-008 - Low - Public API exports internal stages without stability boundaries

**Impact:** Consumers can import normalizers, validators, graph conversion, and formatter internals from the root package, making it harder to change internals without breaking downstream code. This is public API sprawl in a package that is still shaping its canonical authoring contract.

**Evidence:** The package exports only the root subpath in `packages/flow-dsl/package.json:8` through `packages/flow-dsl/package.json:13`, and the root index re-exports `types`, `errors`, `canonicalize-dsl`, `parse-dsl`, `format-dsl`, `normalize`, `document-validate`, and `document-to-graph` in `packages/flow-dsl/src/index.ts:1` through `packages/flow-dsl/src/index.ts:8`. The compiler imports only the high-level canonicalization bridge through `canonicalizeDsl` in `packages/flow-compiler/src/authoring-input.ts:1` through `packages/flow-compiler/src/authoring-input.ts:3`, so most root exports are tooling conveniences rather than required compiler surface.

**Remediation:** Define a stable public root with `parseDslToDocument`, `canonicalizeDsl`, `formatDocumentToDsl`, and documented types. Move lower-level helpers behind explicit subpaths such as `@dzupagent/flow-dsl/internal` or `@dzupagent/flow-dsl/testing`, or document them as unstable before external consumers rely on them.

### ARCHITECTURE-009 - Low - Flow-node behavior is duplicated across oversized visitors

**Impact:** Adding or changing a node kind requires coordinated edits across multiple large switch-based modules. TypeScript exhaustiveness catches some omissions, but it does not catch semantic drift where every switch compiles but the parser, formatter, validator, graph projector, and compiler disagree on behavior.

**Evidence:** Node handling is duplicated in `normalizeNodeWrapper` in `packages/flow-dsl/src/normalize.ts:221` through `packages/flow-dsl/src/normalize.ts:291`, formatter dispatch in `packages/flow-dsl/src/format-dsl.ts:57` through `packages/flow-dsl/src/format-dsl.ts:201`, graph projection in `packages/flow-dsl/src/document-to-graph.ts:39` through `packages/flow-dsl/src/document-to-graph.ts:113`, canonical validation in `packages/flow-ast/src/validate.ts:347` through `packages/flow-ast/src/validate.ts:421`, and compiler shape validation in `packages/flow-compiler/src/stages/shape-validate.ts:34` through `packages/flow-compiler/src/stages/shape-validate.ts:205`. The largest focused modules are sizeable: `packages/flow-ast/src/validate.ts` is 1522 lines and `packages/flow-dsl/src/normalize.ts` is 905 lines.

**Remediation:** Introduce shared traversal helpers and node descriptor tables for child collections, DSL wrapper names, formatter names, and structural requirements. Keep per-stage validation messages local, but centralize the structural metadata that currently has to be retyped in every visitor.

### ARCHITECTURE-010 - Low - DSL bridge tests tolerate failure on valid-looking DSL examples

**Impact:** The compiler-level DSL bridge can regress while tests still pass, because some integration tests only assert that a result exists or allow either success or graceful failure. That reduces confidence in the architecture seam between `flow-dsl` and `flow-compiler`.

**Evidence:** The `compileDsl()` e2e test for a valid DSL string accepts a failure result as long as errors are present in `packages/flow-compiler/src/__tests__/e2e.test.ts:222` through `packages/flow-compiler/src/__tests__/e2e.test.ts:245`. The `prepareFlowInputFromDsl` test similarly accepts either `ok` or non-empty errors for a DSL snippet named valid in `packages/flow-compiler/src/__tests__/e2e.test.ts:328` through `packages/flow-compiler/src/__tests__/e2e.test.ts:359`. More focused compiler tests do assert a valid `compileDsl()` path in `packages/flow-compiler/test/compile.test.ts:167` through `packages/flow-compiler/test/compile.test.ts:188`, so this is not a total coverage gap, but the integration seam is weaker than it should be.

**Remediation:** Make e2e bridge tests deterministic: valid DSL must produce `ok`/success, invalid DSL must produce specific diagnostics, and source examples should include nested values plus every supported node kind. Keep graceful-failure tests for intentionally malformed inputs only.

### ARCHITECTURE-011 - Info - Package layering is clean, but dependency metadata is slightly noisy

**Impact:** The package dependency direction is healthy: `flow-ast` is foundational, `flow-dsl` depends on `flow-ast`, and `flow-compiler` consumes both without a reverse dependency. The minor issue is metadata noise that can confuse future dependency audits or publishing checks.

**Evidence:** `@dzupagent/flow-ast` has no runtime dependencies in `packages/flow-ast/package.json:23` through `packages/flow-ast/package.json:26`. `@dzupagent/flow-dsl` declares `@dzupagent/flow-ast` in both `dependencies` and `devDependencies` in `packages/flow-dsl/package.json:23` through `packages/flow-dsl/package.json:31`. `@dzupagent/flow-compiler` declares `@dzupagent/flow-dsl` as a dependency, `@dzupagent/flow-ast` as a peer dependency, and also includes `@dzupagent/flow-ast` in devDependencies in `packages/flow-compiler/package.json:26` through `packages/flow-compiler/package.json:40`. Source imports follow the same acyclic layering: compiler imports `flow-ast` / `flow-dsl`, DSL imports `flow-ast`, and AST imports only local modules.

**Remediation:** Keep the layering as-is. Consider removing duplicate workspace entries where Yarn publishing and local build behavior allow it, or document why a package appears in both runtime and dev dependency groups.

## Finding Manifest

```json
{
  "domain": "architecture",
  "counts": { "critical": 0, "high": 2, "medium": 4, "low": 4, "info": 1 },
  "findings": [
    { "id": "ARCHITECTURE-001", "severity": "high", "title": "Textual DSL coverage is behind the canonical AST and formatter", "file": "packages/flow-dsl/src/normalize.ts" },
    { "id": "ARCHITECTURE-002", "severity": "high", "title": "Formatter output is not value-preserving", "file": "packages/flow-dsl/src/format-dsl.ts" },
    { "id": "ARCHITECTURE-003", "severity": "medium", "title": "Graph conversion can silently mask invalid node IDs", "file": "packages/flow-dsl/src/document-to-graph.ts" },
    { "id": "ARCHITECTURE-004", "severity": "medium", "title": "Parallel branch names are encoded in freeform metadata", "file": "packages/flow-ast/src/types.ts" },
    { "id": "ARCHITECTURE-005", "severity": "medium", "title": "Structural validation rules diverge between textual DSL and canonical AST/compiler paths", "file": "packages/flow-dsl/src/normalize.ts" },
    { "id": "ARCHITECTURE-006", "severity": "medium", "title": "The custom mini-YAML parser is an under-specified language boundary", "file": "packages/flow-dsl/src/mini-yaml.ts" },
    { "id": "ARCHITECTURE-007", "severity": "low", "title": "Source-location diagnostics stop after syntax parsing", "file": "packages/flow-dsl/src/parse-dsl.ts" },
    { "id": "ARCHITECTURE-008", "severity": "low", "title": "Public API exports internal stages without stability boundaries", "file": "packages/flow-dsl/src/index.ts" },
    { "id": "ARCHITECTURE-009", "severity": "low", "title": "Flow-node behavior is duplicated across oversized visitors", "file": "packages/flow-dsl/src/normalize.ts" },
    { "id": "ARCHITECTURE-010", "severity": "low", "title": "DSL bridge tests tolerate failure on valid-looking DSL examples", "file": "packages/flow-compiler/src/__tests__/e2e.test.ts" },
    { "id": "ARCHITECTURE-011", "severity": "info", "title": "Package layering is clean, but dependency metadata is slightly noisy", "file": "packages/flow-dsl/package.json" }
  ]
}
```

## Scope Reviewed

This was a baseline source review for the architecture domain, focused on textual DSL parsing, normalization, canonicalization, formatting, document validation, and graph conversion. I read `context/repo-snapshot.md` first from the prepared audit pack, then selectively inspected:

- `packages/flow-dsl/src/**` and its focused tests.
- `packages/flow-ast/src/**` and AST validation/parse tests where needed for canonical contract comparison.
- `packages/flow-compiler/src/authoring-input.ts`, `packages/flow-compiler/src/cli-input.ts`, selected compiler tests, and package metadata to verify the bridge from DSL/document input into compilation.
- Workspace/package metadata relevant to boundaries, layering, public API surface, and circularity risk.

Generated files, dependency directories, `dist`, and old audit artifacts were not used as evidence. No runtime validation, test execution, or build execution was performed for this audit.

## Strengths

- The package layering is directionally sound: AST is foundational, DSL depends on AST, and compiler consumes both through a narrow authoring bridge.
- `canonicalizeDsl()` fails closed when parsing or validation produces diagnostics, and does not emit graph output for invalid DSL.
- `flowDocumentSchema` enforces canonical document invariants such as non-empty document metadata and unique node IDs.
- The textual DSL explicitly rejects graph-style top-level `nodes` / `edges`, which keeps the authoring format distinct from graph projection.
- Parser, normalizer, formatter, validator, graph projection, and compiler bridge code are separated into dedicated files rather than one monolithic DSL package file.
- There are focused tests for normalization, formatting, validation, graph projection, canonicalization, and compiler input bridging, even though several round-trip and parity gaps remain.

## Open Questions Or Assumptions

- I treated `dzupflow/v1` as intended to be a durable editable textual DSL because the package description and compiler bridge expose it as a parser/formatter/canonicalization path.
- I treated formatter output as expected to be parseable unless a function contract says otherwise. If formatting is only meant for display, the API and docs should say so and should not be used as a persistence path.
- I did not assume one-branch `parallel` is invalid or valid; the finding is that DSL and canonical/compiler paths currently disagree.
- I did not inspect product consumers outside this repo for workaround behavior. Findings are based on current framework package contracts only.
- I treated server/playground as outside the product feature path per repository guidance; this audit does not recommend adding new product DSL behavior there.

## Recommended Next Actions

1. Close the high-impact round-trip gaps first: align parser/normalizer support with formatter output and preserve `FlowInputSpec.default` plus nested structured values.
2. Decide the canonical branch representation for `parallel`; remove `meta.branchNames` as semantic storage or validate it as a reserved metadata namespace.
3. Unify validation invariants across textual DSL, canonical document validation, and compiler shape validation, starting with `parallel.branches`.
4. Add a fixture matrix that checks DSL parse, document validation, format round-trip, graph projection, and compiler bridge behavior for every canonical node kind.
5. Harden `documentToGraph()` as a validating API or move unchecked projection behind an internal/testing surface.
6. Reduce public API sprawl in `@dzupagent/flow-dsl` after the stable root contract is clarified.
