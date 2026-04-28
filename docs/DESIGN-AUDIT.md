# Design System Audit

## Findings

### DESIGN-001 - High - Playground Vue components are not packaged as a consumable design-system surface

Impact: Consumers are told to import Vue SFCs from `@dzupagent/agent/playground/ui/...`, but the package does not expose those subpaths, does not build `.vue` files, and does not declare Vue as a dependency or peer. This makes the only live component surface effectively source-only and likely unusable from a published package, which blocks cross-app component adoption and makes design-system consistency unenforceable.

Evidence:
- `packages/agent/src/playground/ui/index.ts:8` documents imports such as `@dzupagent/agent/playground/ui/TraceTimeline.vue`.
- `packages/agent/package.json:7` exposes only the package root `"."`; there is no `./playground/ui/*` export.
- `packages/agent/package.json:21` through `packages/agent/package.json:42` does not declare `vue`, `@vitejs/plugin-vue`, Tailwind, or any shared UI/theme package.
- `packages/agent/package.json:43` limits published files to `dist`.
- `packages/agent/tsup.config.ts:4` builds only `src/index.ts`.
- `packages/agent/tsconfig.json:24` includes only `src/**/*.ts`, excluding the `.vue` components from TypeScript checks.
- `packages/agent/src/playground/ui/TraceTimeline.vue:13`, `TraceNodeDetail.vue:9`, `TraceSummary.vue:10`, and `TraceStateInspector.vue:10` import from `vue`.

Remediation: Either move these components into a real UI package owned by the consuming app/design-system layer, or make them a supported framework subpath. If supported here, add explicit `vue` peer dependency, a Vue-aware build path, generated declarations, subpath exports for `./playground/ui/*`, package files that include the built SFC assets, and a package-level verification gate that proves consumers can import the built components.

### DESIGN-002 - Medium - Active Vue components hardcode Tailwind visual primitives instead of consuming design tokens

Impact: Colors, radii, spacing, typography, and semantic status treatments are encoded directly in component templates. Downstream apps cannot theme these components through `--dz-*` tokens or a shared component contract, so each app must either accept the embedded gray/red/yellow/emerald/orange palette or fork/override the components. This undermines cross-app consistency and makes future design-system changes expensive.

Evidence:
- No current package manifest references `@dzup-ui`, `@datazup/dzup-theme`, `tailwind`, `postcss`, `@vitejs/plugin-vue`, or `vue`; the dependency scan over package manifests/config files returned no matches.
- `packages/agent/src/playground/ui/TraceTimeline.vue:68` through `TraceTimeline.vue:89` maps status directly to `bg-red-500`, `bg-emerald-500`, `bg-yellow-500`, and `bg-gray-400`.
- `packages/agent/src/playground/ui/TraceTimeline.vue:147` through `TraceTimeline.vue:181` hardcodes row, badge, and bar classes including `rounded-md`, `border-blue-500`, `bg-blue-50`, `bg-gray-100`, and `dark:bg-gray-800`.
- `packages/agent/src/playground/ui/TraceNodeDetail.vue:38` through `TraceNodeDetail.vue:45` and `TraceNodeDetail.vue:85` through `TraceNodeDetail.vue:197` hardcode semantic color classes, card styling, radii, spacing, text sizes, and dark-mode variants.
- `packages/agent/src/playground/ui/TraceSummary.vue:93` through `TraceSummary.vue:236` repeats card, badge, table, chart-bar, and event-chip styling with direct utility classes.
- `packages/agent/src/playground/ui/TraceStateInspector.vue:121` through `TraceStateInspector.vue:249` repeats state color classes and panel styling directly.

Remediation: Define the supported design-system boundary before expanding these components. Prefer semantic tokens such as surface, border, muted text, danger, warning, success, selected, and chart-bar tokens, then map those to CSS variables or shared components. If the framework should stay UI-agnostic, remove SFCs from the runtime package and keep only typed view models/utilities for consuming apps to render with their own design system.

### DESIGN-003 - Medium - Scaffold presets advertise a dashboard UI but generate only backend route stubs

Impact: New projects generated from `starter` or `full` are described as having a dashboard UI, but the dashboard overlay only creates JSON route handlers and adds `@dzupagent/server`. This creates a product/design expectation that the scaffold does not satisfy and encourages each consuming app to invent its own dashboard shell, controls, tokens, and component vocabulary.

Evidence:
- `packages/create-dzupagent/README.md:80` says the `starter` preset enables auth and dashboard.
- `packages/create-dzupagent/README.md:81` says the `full` preset includes auth, dashboard, billing, teams, and AI overlays.
- `packages/create-dzupagent/src/presets.ts:27` through `presets.ts:42` wires both `starter` and `full` to include the `dashboard` feature.
- `packages/create-dzupagent/src/features.ts:41` through `features.ts:69` describes `dashboard` as an "Admin dashboard UI with agent monitoring", but only emits `src/routes/dashboard.ts` with JSON `getStatus` and `getMetrics` handlers.
- `packages/create-dzupagent/src/templates/package-json.ts:69` through `package-json.ts:71` adds only `@dzupagent/server` for `dashboard`; there are no frontend, design-token, theme, or component dependencies.
- `packages/create-dzupagent/src/templates/readme.ts:133` through `readme.ts:140` labels the feature as `Dashboard UI`.

Remediation: Rename the overlay to `dashboard-api` or add an actual frontend/dashboard scaffold. If adding UI, include an app-owned shell, token/theme setup, shared component dependencies, route mounting guidance, and a generated smoke test. Given the repository boundary, product dashboard UX should route to consuming apps such as Codev rather than expanding `packages/server` or a compatibility playground.

### DESIGN-004 - Low - Interactive rows use plain clickable containers instead of native or shared controls

Impact: The components implement button-like interactions with `div` elements and utility classes. This bypasses browser-native control semantics and any future shared button/list-item component behavior, making focus, disabled states, density, hover styling, and accessibility consistency harder to guarantee across apps.

Evidence:
- `packages/agent/src/playground/ui/TraceTimeline.vue:142` through `TraceTimeline.vue:156` renders each selectable timeline row as a `div` with `role="listitem"`, `tabindex="0"`, click, and keydown handlers.
- `packages/agent/src/playground/ui/TraceStateInspector.vue:192` through `TraceStateInspector.vue:199` renders an expandable row header as a `div` with `role="button"`, `tabindex="0"`, click, and keydown handlers.
- There is no shared control import in either component.

Remediation: Use native `button` elements for interactive row headers, or consume a shared row/action component from the app design system. Keep list semantics on the parent/list item separately from activation semantics, and standardize focus-visible, hover, selected, and disabled styles through tokens.

### DESIGN-005 - Low - UI helper behavior is duplicated between SFCs and shared utilities

Impact: Formatting and ordering rules can drift between direct component usage and programmatic utility usage. This is already visible in duration formatting and state-diff ordering, which weakens cross-component consistency even before theme integration is addressed.

Evidence:
- `packages/agent/src/playground/ui/utils.ts:39` through `utils.ts:44` formats durations above 60 seconds as minutes, while `packages/agent/src/playground/ui/TraceTimeline.vue:100` through `TraceTimeline.vue:104` always formats durations above one second as seconds.
- `packages/agent/src/playground/ui/utils.ts:118` through `utils.ts:119` sorts diff rows as added, modified, removed, unchanged, while `packages/agent/src/playground/ui/TraceStateInspector.vue:101` through `TraceStateInspector.vue:107` sorts added, removed, modified, unchanged.
- `packages/agent/src/__tests__/playground-ui-utils.test.ts:1` through `playground-ui-utils.test.ts:21` tests utility functions, but the scan found no SFC rendering tests for the duplicated component-local logic.

Remediation: Make SFCs import and use `getNodeStatus`, `formatMs`, `formatCost`, `barWidthPercent`, `computeDiffRows`, and related helpers from `utils.ts`. Add component-level tests for rendered labels/order or keep all rendering-independent logic exclusively in tested utilities.

### DESIGN-006 - Info - Static playground hosting has no theme contract and still points to an absent workspace package

Impact: The server route can host arbitrary built assets, but it does not define how hosted assets should receive theme tokens, color mode, or component version compatibility. The fallback message also points operators to a removed workspace package, so future playground/dashboard work may reintroduce a UI package without a clear design-system contract.

Evidence:
- `packages/server/src/composition/optional-routes.ts:133` through `optional-routes.ts:136` conditionally mounts `/playground` when `runtimeConfig.playground` is configured.
- `packages/server/src/routes/playground.ts:85` through `playground.ts:113` only serves static assets and SPA fallback content.
- `packages/server/src/routes/playground.ts:113` returns `Playground not built. Run: yarn workspace @dzupagent/playground build`.
- `packages/playground/docs/ARCHITECTURE.md:6` through `ARCHITECTURE.md:8` states that there is no local `packages/playground/src`, `packages/playground/package.json`, or README in this checkout.

Remediation: Update the fallback guidance to current source-of-truth locations and document the route as an asset host, not a design-system host. If a hosted UI is reintroduced, require a token/theme bootstrap contract and app-owned component adoption plan before mounting it as a product surface.

```json
{
  "domain": "design system",
  "counts": { "critical": 0, "high": 1, "medium": 2, "low": 2, "info": 1 },
  "findings": [
    { "id": "DESIGN-001", "severity": "high", "title": "Playground Vue components are not packaged as a consumable design-system surface", "file": "packages/agent/package.json" },
    { "id": "DESIGN-002", "severity": "medium", "title": "Active Vue components hardcode Tailwind visual primitives instead of consuming design tokens", "file": "packages/agent/src/playground/ui/TraceTimeline.vue" },
    { "id": "DESIGN-003", "severity": "medium", "title": "Scaffold presets advertise a dashboard UI but generate only backend route stubs", "file": "packages/create-dzupagent/src/features.ts" },
    { "id": "DESIGN-004", "severity": "low", "title": "Interactive rows use plain clickable containers instead of native or shared controls", "file": "packages/agent/src/playground/ui/TraceStateInspector.vue" },
    { "id": "DESIGN-005", "severity": "low", "title": "UI helper behavior is duplicated between SFCs and shared utilities", "file": "packages/agent/src/playground/ui/utils.ts" },
    { "id": "DESIGN-006", "severity": "info", "title": "Static playground hosting has no theme contract and still points to an absent workspace package", "file": "packages/server/src/routes/playground.ts" }
  ]
}
```

## Scope Reviewed

- Read first: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-28/run-001/codex-prep/context/repo-snapshot.md`.
- Reviewed current source/config paths relevant to design-system concerns:
  - `package.json`
  - `packages/agent/package.json`
  - `packages/agent/tsconfig.json`
  - `packages/agent/tsup.config.ts`
  - `packages/agent/src/playground/ui/*`
  - `packages/agent/src/__tests__/playground-ui-utils.test.ts`
  - `packages/agent/src/replay/ARCHITECTURE.md`
  - `packages/server/src/routes/playground.ts`
  - `packages/server/src/composition/optional-routes.ts`
  - `packages/playground/docs/ARCHITECTURE.md`
  - `packages/create-dzupagent/src/features.ts`
  - `packages/create-dzupagent/src/presets.ts`
  - `packages/create-dzupagent/src/templates/*`
  - `packages/create-dzupagent/README.md`
- Excluded generated/dependency/old-audit artifacts. Coverage HTML/CSS under package `coverage/` directories was identified and intentionally excluded.
- No runtime validation was run for this audit.

## Strengths

- The current checkout keeps most product UI out of `packages/server` and the absent `packages/playground` package, matching the repository guidance that new product capabilities should live in consuming apps.
- The playground-related server route is limited to static asset hosting and includes path traversal protection before serving files.
- The trace UI components are small and domain-specific, with clear prop contracts and basic keyboard handlers.
- Shared utility functions under `packages/agent/src/playground/ui/utils.ts` have focused unit coverage in `packages/agent/src/__tests__/playground-ui-utils.test.ts`.
- Existing architecture documentation acknowledges that `packages/playground` is not an active workspace package in this checkout, reducing the chance of mistaking it for the forward product UI path.

## Open Questions Or Assumptions

- Assumption: DzupAgent framework packages should remain mostly UI-agnostic, and rich product dashboard/operator UX should be owned by consuming apps such as Codev.
- Open question: Should the replay trace SFCs remain supported public assets, or should the framework expose only view models/utilities and let consuming apps render them with their own design system?
- Open question: Is the `dashboard` scaffold feature intended to mean "dashboard API endpoints" or an actual generated UI? The current code and README disagree.
- Open question: If a hosted playground is reintroduced, which design-token source is authoritative for this workspace: `@dzup-ui`, `@datazup/dzup-theme`, app-local `DESIGN.md`, or a DzupAgent-specific minimal token contract?

## Recommended Next Actions

1. Decide the public boundary for `packages/agent/src/playground/ui`: either remove/deprecate SFCs from the framework package or make them a real packaged subpath with Vue peer dependency, build support, exports, and import smoke tests.
2. Rename `create-dzupagent`'s `dashboard` overlay to `dashboard-api`, or add a real app-owned dashboard scaffold with explicit theme/component dependencies and a generated validation path.
3. Replace hardcoded visual utilities in the trace components with semantic tokens or app-design-system components if the SFCs remain supported.
4. Refactor SFCs to consume the tested `playground/ui/utils.ts` helpers and add component rendering tests for duration labels, status styles/classes, and diff ordering.
5. Update `packages/server/src/routes/playground.ts` fallback guidance so it no longer points to the absent `@dzupagent/playground` workspace package.
