# Design System Audit

Generated: 2026-04-29

## Findings

### DESIGN-001 [medium] No reusable design-token contract exists for the framework UI surface

Impact: The only first-party visual layer in this repository is tied to Tailwind utility names and local string constants, so host apps cannot map DzupAgent trace UI semantics onto their own token system without rewriting classes. This limits cross-app consistency if the trace/debugger UI is reused in Codev or another consuming app, and it makes theme changes a source edit rather than a theme configuration.

Evidence:
- `packages/agent/src/playground/ui/utils.ts:49` defines `traceUiStyles` as literal Tailwind class strings such as `border-gray-200`, `bg-white`, `dark:bg-gray-900`, and `text-gray-900`.
- `packages/agent/src/playground/ui/utils.ts:69` defines semantic tones, but the tone values are still fixed palette classes such as `bg-red-100`, `bg-emerald-500`, and `bg-yellow-950`.
- `packages/agent/package.json:39` lists runtime dependencies only on DzupAgent packages; there is no design-token, shared UI, Tailwind, Vue, or theming dependency.

Remediation: Keep framework packages product-neutral, but formalize a small semantic trace-theme contract if these helpers remain. Prefer CSS custom properties or a class-map injection API such as `TraceThemeClasses` with documented semantic slots (`surface`, `surfaceMuted`, `textMuted`, `toneDanger`, `toneSuccess`, `focusRing`). If product UIs are the forward path, move the actual visual implementation to the consuming app design system and leave only data/contracts in DzupAgent.

### DESIGN-002 [medium] Vue trace components are retained as source but are outside the build, typecheck, and public package surface

Impact: The repository contains SFC components that look like reusable trace UI, but `@dzupagent/agent` intentionally does not build or publish them. That boundary is reasonable for the framework, yet it means component adoption cannot be validated by the package quality gates and the source can drift from real app design systems. It also creates ambiguity for contributors deciding whether to improve framework UI or app UI.

Evidence:
- `packages/agent/docs/api-tiers.md:117` says `packages/agent/src/playground/ui/*.vue` is not a public design-system surface and is retained for framework-internal maintenance and tests only.
- `packages/agent/package.json:28` explicitly blocks `./playground/ui` and `./playground/ui/*` package subpaths.
- `packages/agent/tsup.config.ts:4` builds only TypeScript entrypoints and does not include Vue SFC entries.
- `packages/agent/tsconfig.json:24` includes only `src/**/*.ts`, so the Vue components are not typechecked by `yarn workspace @dzupagent/agent typecheck`.

Remediation: Choose one explicit path. If the trace UI should remain non-product source, mark it as example/internal more clearly and avoid treating it as a design-system asset. If the UI should be reused, create a real app-owned or shared UI package with Vue peer dependencies, Vite/Vue test tooling, token integration, and a public export contract.

### DESIGN-003 [medium] Trace UI uses raw controls and ad hoc component patterns instead of shared primitives

Impact: Interactive rows, badges, panels, metric tiles, tables, and code blocks are rebuilt directly in each SFC. This duplicates behavior that a design system would normally own: button states, focus treatment, compact badges, panel density, data-table styling, and code-block surfaces. As more debugger or operator views are added, the same patterns are likely to diverge.

Evidence:
- `packages/agent/src/playground/ui/TraceTimeline.vue:113` renders timeline rows as raw `<button>` elements with local utility classes and conditional class arrays.
- `packages/agent/src/playground/ui/TraceStateInspector.vue:104` renders collapsible rows as another raw `<button>` with a separate class list and a hardcoded disclosure glyph.
- `packages/agent/src/playground/ui/TraceSummary.vue:72` builds metric cards from plain `<div>`/`<p>` elements, and `packages/agent/src/playground/ui/TraceSummary.vue:181` builds a table shell directly in the component.
- `packages/agent/src/playground/ui/TraceNodeDetail.vue:136` builds alert, retry, metric, and preformatted data panels directly with repeated utility classes.

Remediation: If the UI stays, extract internal primitives around the actual repeated contracts (`TraceButtonRow`, `TraceBadge`, `TracePanel`, `TraceMetricTile`, `TraceCodeBlock`, `TraceDataTable`) and make those primitives consume the semantic theme contract. If the UI moves to an app, replace these SFCs with app-level components from that app's design system and keep DzupAgent focused on replay data contracts.

### DESIGN-004 [low] Layout, spacing, typography, and sizing values remain hardcoded across SFC templates

Impact: Even where color and surface classes are centralized, density and layout are not. Fixed widths (`w-36`, `w-16`, `w-32`), arbitrary text sizes (`text-[10px]`, `text-[11px]`), one-off gaps, padding, and radii make compact trace views harder to adapt across apps, viewport sizes, and design-system density modes.

Evidence:
- `packages/agent/src/playground/ui/TraceTimeline.vue:115` hardcodes `gap-3`, `rounded-md`, `px-3`, and `py-2`; `packages/agent/src/playground/ui/TraceTimeline.vue:133` and `packages/agent/src/playground/ui/TraceTimeline.vue:155` hardcode fixed label widths.
- `packages/agent/src/playground/ui/TraceSummary.vue:57` uses `gap-5`, while `packages/agent/src/playground/ui/TraceSummary.vue:75`, `packages/agent/src/playground/ui/TraceSummary.vue:98`, and `packages/agent/src/playground/ui/TraceSummary.vue:221` use arbitrary typography and repeated badge spacing.
- `packages/agent/src/playground/ui/TraceNodeDetail.vue:82` hardcodes `gap-4 p-4`, and `packages/agent/src/playground/ui/TraceNodeDetail.vue:197` hardcodes preformatted data sizing and spacing.

Remediation: Move density values into the same semantic adapter as color, or extract primitives with named size variants (`compact`, `default`). Keep the rendered defaults stable, but make spacing, fixed column widths, and text scale intentional tokens instead of scattered template literals.

### DESIGN-005 [low] Focus and accent color are hardcoded to blue outside the tone/theme abstraction

Impact: Selected and focused states may conflict with a consuming app's brand or accessibility token choices. The UI has semantic status tones, but the primary interaction tone is directly fixed to blue, which is exactly the kind of value a design system should control.

Evidence:
- `packages/agent/src/playground/ui/TraceTimeline.vue:115` hardcodes `focus-visible:outline-blue-500`.
- `packages/agent/src/playground/ui/TraceStateInspector.vue:106` hardcodes the same `focus-visible:outline-blue-500`.
- `packages/agent/src/playground/ui/utils.ts:57` hardcodes selected state classes with `border-blue-500`, `bg-blue-50`, `dark:border-blue-400`, and `dark:bg-blue-950`.

Remediation: Add semantic interaction tokens such as `focusRing`, `selectedSurface`, and `selectedBorder` to the style adapter, or source them from app-level CSS variables. Then replace all direct blue focus/selected classes with those slots.

### DESIGN-006 [low] Dark-mode support assumes Tailwind's global `dark:` selector without a theme integration contract

Impact: The components only work with dark mode when the host app uses the same Tailwind dark-mode mechanism expected by the class strings. Apps that use CSS variables, `[data-theme]`, media-query-only themes, or a different dark-mode class cannot integrate without replacing the class map.

Evidence:
- `packages/agent/src/playground/ui/utils.ts:50` through `packages/agent/src/playground/ui/utils.ts:66` embed `dark:` variants in every surface/text primitive.
- `packages/agent/src/playground/ui/utils.ts:71` through `packages/agent/src/playground/ui/utils.ts:103` repeat `dark:` variants for status tones.
- `packages/agent/src/playground/ui/index.ts:5` says the Vue SFCs are not a packaged design surface, so there is no public theme-provider or host integration API for these assumptions.

Remediation: If the components are retained, either document the dark-mode precondition explicitly or switch the style adapter to CSS custom properties that work under any host theme selector. If the UI is app-owned, remove dark-mode assumptions from DzupAgent source and let the consuming app render replay states with its own theme provider.

### DESIGN-007 [low] Playground UI documentation still points contributors at absent or legacy UI package paths

Impact: Stale playground instructions make it easy to route design-system work into the wrong package. That is a cross-app consistency risk because product UI should be owned by consuming apps, while this repo currently only hosts framework compatibility/static serving and internal replay helpers.

Evidence:
- `README.md:27` through `README.md:31` instruct contributors to run `yarn workspace @dzupagent/playground dev`, but no `packages/playground/package.json` exists in this checkout.
- `packages/playground/docs/ARCHITECTURE.md:6` through `packages/playground/docs/ARCHITECTURE.md:8` explicitly state that `packages/playground` is only a documentation file and has no source package.
- `packages/server/README.md:294` through `packages/server/README.md:303` still shows a `packages/dzupagent-playground/dist` path for static hosting.

Remediation: Update root and server docs to state that DzupAgent can host prebuilt static playground assets, but does not own a current playground design-system package. Link contributors to the app-owned UI/design-system location when a product debugger or operator UX is needed.

### DESIGN-008 [info] Design-system checks are limited to helper-unit tests, not rendered component or token-conformance tests

Impact: The current tests are useful for data formatting and class-map helper behavior, but they do not validate rendered SFC structure, theme integration, focus behavior, or token conformance. This is acceptable if the Vue files are retained only as internal source, but it is not enough for a reusable design-system surface.

Evidence:
- `packages/agent/src/__tests__/playground-ui-utils.test.ts:8` imports only utility functions and style maps from `../playground/ui/utils.js`.
- `packages/agent/src/__tests__/playground-ui-utils.test.ts:105` through `packages/agent/src/__tests__/playground-ui-utils.test.ts:132` assert semantic tone/class-map behavior, not rendered Vue components.
- `packages/agent/vitest.config.ts:8` includes `src/**/*.test.ts` and `src/**/*.spec.ts`, while `packages/agent/vitest.config.ts:12` includes only `src/**/*.ts` for coverage.

Remediation: If the source becomes a reusable UI package, add Vue render tests and a token-conformance lint/check that fails on direct palette, spacing, radius, and focus classes outside approved theme adapters. If it remains internal/non-public, document that no runtime or visual validation is expected for these SFCs.

```json
{
  "domain": "design system",
  "counts": { "critical": 0, "high": 0, "medium": 3, "low": 4, "info": 1 },
  "findings": [
    { "id": "DESIGN-001", "severity": "medium", "title": "No reusable design-token contract exists for the framework UI surface", "file": "packages/agent/src/playground/ui/utils.ts" },
    { "id": "DESIGN-002", "severity": "medium", "title": "Vue trace components are retained as source but are outside the build, typecheck, and public package surface", "file": "packages/agent/package.json" },
    { "id": "DESIGN-003", "severity": "medium", "title": "Trace UI uses raw controls and ad hoc component patterns instead of shared primitives", "file": "packages/agent/src/playground/ui/TraceTimeline.vue" },
    { "id": "DESIGN-004", "severity": "low", "title": "Layout, spacing, typography, and sizing values remain hardcoded across SFC templates", "file": "packages/agent/src/playground/ui/TraceTimeline.vue" },
    { "id": "DESIGN-005", "severity": "low", "title": "Focus and accent color are hardcoded to blue outside the tone/theme abstraction", "file": "packages/agent/src/playground/ui/TraceTimeline.vue" },
    { "id": "DESIGN-006", "severity": "low", "title": "Dark-mode support assumes Tailwind's global dark selector without a theme integration contract", "file": "packages/agent/src/playground/ui/utils.ts" },
    { "id": "DESIGN-007", "severity": "low", "title": "Playground UI documentation still points contributors at absent or legacy UI package paths", "file": "README.md" },
    { "id": "DESIGN-008", "severity": "info", "title": "Design-system checks are limited to helper-unit tests, not rendered component or token-conformance tests", "file": "packages/agent/src/__tests__/playground-ui-utils.test.ts" }
  ]
}
```

## Scope Reviewed

This audit reviewed the current repository code for design-system concerns after reading the prepared repository snapshot at `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-29/run-001/codex-prep/context/repo-snapshot.md`.

Primary files and surfaces reviewed:
- `package.json`
- `README.md`
- `packages/agent/package.json`
- `packages/agent/tsup.config.ts`
- `packages/agent/tsconfig.json`
- `packages/agent/vitest.config.ts`
- `packages/agent/docs/api-tiers.md`
- `packages/agent/docs/ARCHITECTURE.md`
- `packages/agent/src/replay/ARCHITECTURE.md`
- `packages/agent/src/playground/ui/*`
- `packages/agent/src/__tests__/playground-ui-utils.test.ts`
- `packages/playground/docs/ARCHITECTURE.md`
- `packages/server/src/routes/playground.ts`
- `packages/server/README.md`
- `packages/server/docs/ARCHITECTURE.md`
- `packages/create-dzupagent/src/**` and package metadata were checked for app-template UI surfaces; no first-party web UI design-system implementation was found there.

Explicitly out of scope:
- Generated build output such as `dist/**`.
- Dependency folders such as `node_modules/**`.
- Coverage output.
- Prior audit artifacts and old audit folders.
- Runtime/browser validation. No dev server, visual regression, Playwright, or component-render validation was run for this audit.

## Strengths

- The framework/product boundary is already documented: product UX should live in consuming apps, and server/playground surfaces are compatibility or maintenance-oriented rather than the forward path for new product features.
- The current trace UI at least centralizes color/status classes in `traceUiStyles` and `traceToneStyles`, which is better than scattering every palette class through templates.
- Status and change indicators are not purely color-only. The UI includes text labels such as status badges, change-type badges, error counts, and recovery labels.
- The agent package explicitly blocks `./playground/ui` package subpaths, reducing accidental public reliance on internal Vue SFCs.
- Helper tests cover formatting, status mapping, diff row ordering, and class-map behavior for the rendering-independent utilities.

## Open Questions Or Assumptions

- Assumption: Design-system ownership for production app UI is expected to remain outside this repository, likely in consuming apps or a separate shared UI package, because `packages/server` and `packages/playground` are not the forward path for product UX.
- Open question: Should the internal trace Vue files remain in DzupAgent at all, or should they be moved to an app-owned debugger UI where token/theming integration can be real?
- Open question: If DzupAgent should provide reusable trace visualization, should it expose a headless data-to-view-model package rather than framework-specific SFCs?
- Open question: Which shared design system should Codev or other consuming apps use for trace/debugger surfaces, and does it already define semantic tokens for status, trace timelines, code blocks, and metric tiles?

## Recommended Next Actions

1. Decide the ownership path for trace/debugger UI: app-owned visual implementation with DzupAgent exporting contracts, or a real reusable UI package with explicit theme and build support.
2. If app-owned, update `README.md` and `packages/server/README.md` to remove absent playground workspace and legacy dist-path guidance.
3. If reusable, introduce a semantic theme contract before adding more components. Start by replacing fixed palette/focus classes with slots for surface, text, accent, focus, and status tones.
4. Extract repeated trace primitives or adopt the consuming app's shared components for buttons, badges, panels, metric tiles, tables, alerts, and code blocks.
5. Add a lightweight style-conformance check if these components remain: direct palette, arbitrary text-size, radius, spacing, and focus classes should be allowed only inside the approved theme adapter or primitive layer.
6. Add rendered component tests only if the Vue SFCs become part of a maintained UI surface. Otherwise keep tests limited to headless helper behavior and document that no visual runtime validation is claimed.
