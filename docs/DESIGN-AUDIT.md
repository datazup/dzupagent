## Findings

### DESIGN-001 - High - Playground UI components are documented as consumable, but they are not packaged as a usable design-system surface

Impact: Consumers are pointed at Vue SFC imports that the published package does not expose or build. That blocks reliable component adoption across apps and encourages downstream products to copy the trace UI or recreate local controls instead of sharing a single design-system primitive set.

Evidence:
- `packages/agent/src/playground/ui/index.ts:8` documents direct imports such as `@dzupagent/agent/playground/ui/TraceTimeline.vue`.
- `packages/agent/package.json:7` exposes only the package root `"."`; there is no `./playground/ui/*` subpath export for the documented component imports.
- `packages/agent/tsup.config.ts:4` builds only `src/index.ts`, so the `.vue` files under `packages/agent/src/playground/ui` are not part of the package entry graph.
- `packages/agent/package.json:21` through `packages/agent/package.json:42` lists runtime/dev dependencies, but there is no `vue`, Vue plugin, Tailwind, or shared UI/token package dependency even though the SFCs import Vue and use Tailwind classes.
- `packages/playground/docs/ARCHITECTURE.md:6` through `packages/playground/docs/ARCHITECTURE.md:8` states that `packages/playground` is absent as a real workspace package, leaving no dedicated UI package to own these components.

Remediation: Decide whether these components are maintenance-only examples or a real shared UI surface. If they are shared, create an explicit package or subpath export with Vue/Tailwind/theme peer requirements, build coverage for `.vue` files, and import examples that resolve from the published artifact. If they are maintenance-only, remove public import guidance and route product UI work to the consuming app boundary.

### DESIGN-002 - High - There is no repository-level token or theme contract for cross-app consistency

Impact: The repository currently has no canonical design-token package, Tailwind preset, CSS variable contract, or adopted shared UI dependency. Visual decisions in framework UI files therefore live as local utility classes, making Codev/app integration depend on manual class alignment instead of a versioned theme boundary.

Evidence:
- `package.json:7` through `package.json:9` limits workspaces to `packages/*`; the bounded snapshot and current file list show no active `packages/design-*`, `packages/ui`, or `packages/theme` source package in this repo.
- A package manifest search found no `vue`, `tailwindcss`, `@dzup-ui/core`, `@dzup-ui/tokens`, `@datazup/vue-ui`, or `@datazup/dzup-theme` dependency in `package.json` or `packages/*/package.json`.
- `packages/agent/src/playground/ui/TraceTimeline.vue:63` through `packages/agent/src/playground/ui/TraceTimeline.vue:90` hard-code status colors as Tailwind palette classes rather than semantic tokens.
- `packages/agent/src/playground/ui/TraceSummary.vue:93` through `packages/agent/src/playground/ui/TraceSummary.vue:132` hand-codes card surfaces with `border-gray-*`, `bg-white`, `dark:bg-gray-900`, and text palette utilities instead of a shared surface token.
- `AGENTS.md:8` through `AGENTS.md:15` explicitly says new product capabilities should be productized in consuming apps, which makes a reusable framework token contract important when framework examples still expose UI pieces.

Remediation: Add a narrow design-system boundary before expanding UI reuse: either adopt the workspace UI/token packages as dependencies for any real app-facing UI, or create a small DzupAgent theme contract that exports semantic CSS variables and Tailwind preset names for surfaces, text, borders, status, focus, and density. Keep product-specific screens outside `packages/server` and `packages/playground`, but make reusable primitives consume the shared contract.

### DESIGN-003 - Medium - Status and alert visuals use raw palette utilities instead of semantic status tokens

Impact: Trace status, error, recovery, and bottleneck visuals are encoded directly as red/emerald/yellow/orange/gray utility classes. If the consuming app changes brand, contrast targets, severity colors, or dark-mode palette, these components will not update coherently.

Evidence:
- `packages/agent/src/playground/ui/TraceTimeline.vue:63` through `packages/agent/src/playground/ui/TraceTimeline.vue:90` maps status to `bg-red-500`, `bg-emerald-500`, `bg-yellow-500`, and `bg-gray-400`.
- `packages/agent/src/playground/ui/TraceTimeline.vue:150` through `packages/agent/src/playground/ui/TraceTimeline.vue:151` hard-code selected and hover states with `border-blue-*`, `bg-blue-*`, and gray dark-mode utilities.
- `packages/agent/src/playground/ui/TraceSummary.vue:140` through `packages/agent/src/playground/ui/TraceSummary.vue:156` repeats red/yellow alert treatment directly in component markup.
- `packages/agent/src/playground/ui/TraceSummary.vue:179` through `packages/agent/src/playground/ui/TraceSummary.vue:183` uses `bg-orange-500` for bottleneck bars, introducing another status color outside a semantic mapping.
- `packages/agent/src/playground/ui/TraceNodeDetail.vue:33` through `packages/agent/src/playground/ui/TraceNodeDetail.vue:45` defines the same red/emerald/yellow/gray status palette again for badges.

Remediation: Introduce a small semantic status map, for example `statusToneClasses(status)` or design-token-backed variants for `success`, `danger`, `warning`, `neutral`, `selected`, and `performanceHotspot`. Use that helper across trace timeline, summary, state inspector, and node detail views. Tests should assert semantic status output or variant names rather than exact raw palette utilities.

### DESIGN-004 - Medium - Plain controls and display primitives are hand-built instead of shared components

Impact: The trace UI repeats ad hoc cards, badges, rows, tables, disclosure controls, and progress bars. Without shared primitives, sizing, focus, spacing, density, and dark-mode behavior can drift between DzupAgent examples and product apps that embed or reimplement these screens.

Evidence:
- `packages/agent/src/playground/ui/TraceSummary.vue:91` through `packages/agent/src/playground/ui/TraceSummary.vue:132` defines repeated stat cards inline rather than using a shared `StatCard` or surface primitive.
- `packages/agent/src/playground/ui/TraceSummary.vue:197` through `packages/agent/src/playground/ui/TraceSummary.vue:223` hand-builds a styled table with raw utility classes.
- `packages/agent/src/playground/ui/TraceStateInspector.vue:192` through `packages/agent/src/playground/ui/TraceStateInspector.vue:219` uses a clickable `div` with `role="button"` and bespoke badge styles for disclosure rows instead of a reusable disclosure/list-row primitive.
- `packages/agent/src/playground/ui/TraceNodeDetail.vue:85` through `packages/agent/src/playground/ui/TraceNodeDetail.vue:200` combines card, status badge, metric grid, alert, and code block styling in one component.
- `packages/agent/src/playground/ui/index.ts:31` through `packages/agent/src/playground/ui/index.ts:45` exports only utility functions; no shared visual primitives are available from the UI module.

Remediation: If this UI remains in framework code, add minimal primitives for `Surface`, `StatusBadge`, `MetricCard`, `ProgressBar`, `DisclosureRow`, and `CodeBlock`, then migrate the four trace SFCs through those primitives. If the design system lives in a consuming app, replace these SFCs with headless presenter data and let the app render with its own component library.

### DESIGN-005 - Medium - Theme integration is local class-level dark mode, not an explicit theme boundary

Impact: Components can follow Tailwind `dark:` classes, but there is no exported theme provider, root `data-theme` contract, token override hook, or deterministic theme API. Embedded consumers and screenshot tests cannot reliably force or inherit a workspace theme from the framework surface.

Evidence:
- `packages/agent/src/playground/ui/TraceTimeline.vue:150` through `packages/agent/src/playground/ui/TraceTimeline.vue:151` encode dark-mode behavior directly in selected/hover classes.
- `packages/agent/src/playground/ui/TraceSummary.vue:93` through `packages/agent/src/playground/ui/TraceSummary.vue:132` repeats light/dark surface classes on every stat card.
- `packages/agent/src/playground/ui/TraceStateInspector.vue:121` through `packages/agent/src/playground/ui/TraceStateInspector.vue:127` returns hard-coded dark variants from local badge logic.
- `packages/agent/src/playground/ui/TraceNodeDetail.vue:85` and `packages/agent/src/playground/ui/TraceNodeDetail.vue:197` define local dark surfaces instead of consuming a parent theme token.
- `packages/server/src/routes/playground.ts:60` through `packages/server/src/routes/playground.ts:117` serves static assets only; the server route has no theme negotiation or theme asset contract for hosted playground builds.

Remediation: Define an explicit theme integration contract for any shipped UI: semantic CSS variables scoped under a root class or `data-theme`, documented host responsibilities, and deterministic light/dark selection for tests. Components should consume variables or token-backed utility names rather than encoding every dark variant locally.

```json
{
  "domain": "design system",
  "counts": { "critical": 0, "high": 2, "medium": 3, "low": 0, "info": 0 },
  "findings": [
    { "id": "DESIGN-001", "severity": "high", "title": "Playground UI components are documented as consumable, but they are not packaged as a usable design-system surface", "file": "packages/agent/src/playground/ui/index.ts" },
    { "id": "DESIGN-002", "severity": "high", "title": "There is no repository-level token or theme contract for cross-app consistency", "file": "package.json" },
    { "id": "DESIGN-003", "severity": "medium", "title": "Status and alert visuals use raw palette utilities instead of semantic status tokens", "file": "packages/agent/src/playground/ui/TraceTimeline.vue" },
    { "id": "DESIGN-004", "severity": "medium", "title": "Plain controls and display primitives are hand-built instead of shared components", "file": "packages/agent/src/playground/ui/TraceSummary.vue" },
    { "id": "DESIGN-005", "severity": "medium", "title": "Theme integration is local class-level dark mode, not an explicit theme boundary", "file": "packages/agent/src/playground/ui/TraceNodeDetail.vue" }
  ]
}
```

## Scope Reviewed

Read first:
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-27/run-001/codex-prep/context/repo-snapshot.md`

Current-code files selectively reviewed:
- `package.json`
- `AGENTS.md`
- `packages/agent/package.json`
- `packages/agent/tsup.config.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/playground/ui/index.ts`
- `packages/agent/src/playground/ui/types.ts`
- `packages/agent/src/playground/ui/utils.ts`
- `packages/agent/src/playground/ui/TraceTimeline.vue`
- `packages/agent/src/playground/ui/TraceSummary.vue`
- `packages/agent/src/playground/ui/TraceStateInspector.vue`
- `packages/agent/src/playground/ui/TraceNodeDetail.vue`
- `packages/agent/src/__tests__/playground-ui-utils.test.ts`
- `packages/server/src/routes/playground.ts`
- `packages/server/src/composition/optional-routes.ts`
- `packages/server/README.md`
- `README.md`
- `packages/playground/docs/ARCHITECTURE.md`

Generated, dependency, coverage, and old-audit artifacts were not used as evidence. No runtime validation, browser rendering, screenshot review, build, lint, typecheck, or test command was run for this audit. Findings are based on static current-code inspection only.

## Strengths

- The repository has a clear product boundary: `AGENTS.md:8` through `AGENTS.md:15` keeps new product UX out of `packages/server` and `packages/playground`, which is the right constraint for framework reuse.
- Playground hosting is a thin compatibility layer rather than a product UI expansion. `packages/server/src/routes/playground.ts:60` through `packages/server/src/routes/playground.ts:117` only serves static assets and SPA fallback.
- The trace UI components already include basic accessibility hooks, including list semantics and keyboard activation in `packages/agent/src/playground/ui/TraceTimeline.vue:127` through `packages/agent/src/playground/ui/TraceTimeline.vue:156`, and disclosure keyboard handling in `packages/agent/src/playground/ui/TraceStateInspector.vue:52` through `packages/agent/src/playground/ui/TraceStateInspector.vue:58`.
- Display logic has started to separate from rendering through `packages/agent/src/playground/ui/utils.ts`, and that helper layer has focused Vitest coverage in `packages/agent/src/__tests__/playground-ui-utils.test.ts`.
- The decommission note in `packages/playground/docs/ARCHITECTURE.md:3` through `packages/playground/docs/ARCHITECTURE.md:15` truthfully documents that there is no active `packages/playground` package in this checkout.

## Open Questions Or Assumptions

- This audit assumes the design-system domain inside this repo is limited to the active framework UI surfaces and compatibility playground hosting. Sibling workspace UI packages may provide richer design-system infrastructure, but they are outside the audited repository.
- It is unclear whether the Vue trace components are intended as public consumable UI, internal examples, or abandoned compatibility code. Current docs imply consumption, while package exports/build config do not support it.
- The audit did not evaluate rendered contrast, responsive behavior, CSS generation, or actual app integration because no runtime/browser validation was run.
- The preferred cross-app design-system source is not defined in this repo. The remediation can be either adoption of a sibling shared UI package or a narrow DzupAgent-owned token contract.

## Recommended Next Actions

1. Classify `packages/agent/src/playground/ui/*` as either public shared UI or maintenance-only example code, then align exports/docs/build config with that decision.
2. Define the design-system boundary before adding more UI: shared token/theme package, adopted workspace UI dependency, or headless framework presenters rendered by consuming apps.
3. Centralize semantic status, surface, text, border, focus, and density tokens; migrate the four trace components away from raw palette utilities.
4. Add small reusable primitives only if UI remains in the framework package; otherwise move visual composition to the consuming app and keep DzupAgent exports headless.
5. After design cleanup, run focused validation such as `yarn typecheck --filter=@dzupagent/agent`, `yarn test --filter=@dzupagent/agent`, and a browser/screenshot pass in the consuming app before claiming runtime readiness.
