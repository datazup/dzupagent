## Findings

### Medium - Design tokens and theming are local to the playground instead of a shared design-system contract

**Impact:** The only live design-token layer is embedded in `@dzupagent/playground`, so other DzupAgent packages and adjacent apps cannot consume the same color, radius, spacing, or component decisions through a package boundary. This makes cross-app consistency depend on copy/paste rather than a versioned contract.

**Evidence:**
- `packages/playground/src/assets/main.css:8` defines the `@theme` token set directly in the app stylesheet, including `--color-pg-*`, `--spacing-pg-sidebar`, and `--radius-pg*`.
- `packages/playground/src/main.ts:11` imports that local stylesheet directly as the app entry styling boundary.
- `packages/playground/package.json:16` lists only `pinia`, `vue`, and `vue-router` as runtime dependencies; there is no shared `@dzup-ui`, token, theme, or component package dependency.
- `packages/playground/vite.config.ts:7` wires Tailwind through the app-local Vite config, with no shared preset or design-system package import.

**Remediation:** Promote the playground token set into a shared package or documented preset, for example `@dzupagent/design-tokens` or an adopted workspace UI package. Keep `packages/playground/src/assets/main.css` as the app integration layer, but import canonical tokens/components from the shared boundary. Add a package-level check that prevents new app-local semantic color tokens without an explicit design-system review.

### Medium - Status, category, and alert colors bypass semantic playground tokens in several views

**Impact:** Status badges and category chips use Tailwind palette primitives such as `green`, `blue`, `red`, `yellow`, `purple`, `cyan`, and `rose` alongside `pg-*` semantic tokens. These values will not track the playground theme consistently, especially in dark mode, and tests currently lock some non-token palette classes in place.

**Evidence:**
- `packages/playground/src/views/RunHistoryBrowser.vue:35` maps run statuses to `bg-gray-200`, `bg-blue-100`, `bg-green-100`, `bg-red-100`, and `bg-yellow-100` instead of `bg-pg-*` semantic status tokens.
- `packages/playground/src/views/EvalDashboard.vue:64` repeats a similar non-token status map for eval runs.
- `packages/playground/src/views/CapabilityMatrixView.vue:76` uses `bg-green-500/20`, `bg-yellow-500/20`, and `bg-red-500/20`; the same file uses `bg-red-500/10` for errors at `packages/playground/src/views/CapabilityMatrixView.vue:152` and `bg-yellow-500/5` for warnings at `packages/playground/src/views/CapabilityMatrixView.vue:224`.
- `packages/playground/src/components/marketplace/AgentCard.vue:28` maps categories to raw palette classes such as `bg-purple-500/10`, `bg-amber-500/10`, and `bg-rose-500/10`.
- `packages/playground/src/__tests__/run-history-browser.test.ts:168` asserts the raw `bg-green-100`, `bg-blue-100`, `bg-red-100`, and `bg-gray-200` classes, making the drift part of the regression contract.
- `packages/playground/src/__tests__/capability-matrix-view.test.ts:193` asserts `bg-green-500/20` and `text-green-400`, with similar assertions for yellow and red at `packages/playground/src/__tests__/capability-matrix-view.test.ts:209` and `packages/playground/src/__tests__/capability-matrix-view.test.ts:225`.

**Remediation:** Centralize visual status/category mapping behind semantic helpers or components such as `statusBadgeClass`, `capabilityBadgeClass`, and `categoryBadgeClass` that return `pg-*` token classes. Replace raw palette assertions with semantic expectations. Add tokens for any missing distinct semantic roles before adding more palette families.

### Medium - Plain controls are hand-styled across the app instead of consistently using shared control primitives

**Impact:** Buttons, inputs, selects, tabs, filters, pagination controls, and badges are repeatedly hand-composed from Tailwind classes. This increases UI drift and makes focus, disabled, hover, sizing, density, and accessibility behavior hard to keep consistent.

**Evidence:**
- `packages/playground/src/assets/main.css:110` defines `pg-input`, `packages/playground/src/assets/main.css:126` defines `pg-btn-accent`, and `packages/playground/src/assets/main.css:138` defines `pg-badge`, but these utilities cover only a narrow subset of controls.
- A static source scan found 117 raw `<button>`, `<input>`, `<select>`, and `<textarea>` entries in `packages/playground/src`, while only 30 class uses reference `pg-input`, `pg-btn-accent`, or `pg-badge`.
- `packages/playground/src/components/TraceTimeline.vue:197` through `packages/playground/src/components/TraceTimeline.vue:237` hand-style replay buttons and the playback-speed select individually.
- `packages/playground/src/views/RunHistoryBrowser.vue:119` hand-builds a segmented status filter, and `packages/playground/src/views/RunHistoryBrowser.vue:285` hand-styles pagination buttons.
- `packages/playground/src/views/CapabilityMatrixView.vue:117` through `packages/playground/src/views/CapabilityMatrixView.vue:134` hand-style an input, primary button, and secondary button instead of using `pg-input` / button primitives.
- `packages/playground/src/components/inspector/InspectorPanel.vue:46` hand-builds tabs with per-callsite border/background classes.

**Remediation:** Add small shared Vue primitives or utilities for `BaseButton`, `IconButton`, `TextInput`, `SelectInput`, `Badge`, `Tabs`, `SegmentedControl`, and `PaginationButton`. Migrate the high-reuse surfaces first: inspector tabs, run status filters, replay controls, primary/secondary buttons, and status badges. Keep tests focused on behavior and semantic variant names rather than exact utility-class strings.

### Low - Theme integration is tied only to OS preference and lacks an explicit app/theme boundary

**Impact:** The playground can react to `prefers-color-scheme`, but it cannot participate in an explicit workspace theme, user preference, tenant theme, or cross-app theme handoff. This limits consistency if DzupAgent surfaces are embedded into another app or need deterministic screenshots.

**Evidence:**
- `packages/playground/src/assets/main.css:47` defines dark-mode overrides only inside `@media (prefers-color-scheme: dark)`.
- No `data-theme`, theme store, theme provider, or root theme class was found in `packages/playground/src` or `packages/playground/package.json` during static inspection.
- `packages/playground/src/assets/main.css:69` applies body-level theme styles globally rather than through an app root theme scope.

**Remediation:** Add an explicit theme boundary, such as `[data-theme="light"]` and `[data-theme="dark"]` token overrides on the app root, with OS preference as the default resolver. Expose a small theme API/store so embedded consumers and tests can set the active theme deterministically.

### Low - Arbitrary visual values still appear in component markup despite existing radius and text tokens

**Impact:** The app has `--radius-pg`, `--radius-pg-sm`, and `--radius-pg-lg`, but many callsites still use arbitrary radii, text sizes, and letter-spacing values. This creates small but visible inconsistencies and makes future token tuning incomplete.

**Evidence:**
- `packages/playground/src/assets/main.css:42` defines radius tokens, but `packages/playground/src/App.vue:235` and `packages/playground/src/App.vue:255` use `rounded-[10px]`.
- `packages/playground/src/App.vue:269` uses `text-[11px]` and `tracking-[0.08em]`; related compact labels use `text-[10px]` at `packages/playground/src/App.vue:280` and `packages/playground/src/App.vue:293`.
- `packages/playground/src/views/CapabilityMatrixView.vue:122`, `packages/playground/src/views/CapabilityMatrixView.vue:126`, `packages/playground/src/views/CapabilityMatrixView.vue:134`, and `packages/playground/src/views/CapabilityMatrixView.vue:171` use `rounded-[10px]`.
- A static source scan found 219 occurrences of arbitrary visual utilities or raw Tailwind palette classes across `packages/playground/src`.

**Remediation:** Extend the token layer with named compact text, label, nav-item, control, and badge variants where needed. Replace arbitrary radii with `rounded-pg`, `rounded-pg-sm`, or `rounded-pg-lg`, and reserve arbitrary utilities for one-off layout constraints that cannot be represented by existing tokens.

## Scope Reviewed

This baseline review covered the current design-system surface in the DzupAgent repository:

- `packages/playground/src/assets/main.css` for Tailwind 4 theme tokens, dark-mode setup, global base styles, and utility classes.
- `packages/playground/src/main.ts`, `packages/playground/vite.config.ts`, and `packages/playground/package.json` for theme wiring and shared design-system dependency boundaries.
- Playground Vue views and components under `packages/playground/src/views` and `packages/playground/src/components`, with emphasis on token usage, theming setup, component adoption, hardcoded visual values, and plain control patterns.
- Relevant playground tests that assert visual classes, especially status and capability badge tests.

No runtime validation, browser rendering, screenshot review, build, lint, or test command was run for this audit. Findings are based on static current-code inspection only. Prior audit artifacts were treated as comparison context, not as implementation status.

## Strengths

- The playground has a real token foundation: `packages/playground/src/assets/main.css:8` uses Tailwind 4 `@theme` to register `pg-*` colors, status colors, role backgrounds, sidebar spacing, and radius tokens.
- Dark-mode values exist for the core surface, text, border, and chat-role tokens at `packages/playground/src/assets/main.css:47`.
- Base focus styling is centralized through `:focus-visible` at `packages/playground/src/assets/main.css:85`, which is a good accessibility foundation.
- Some reusable utility classes already exist for common patterns: `pg-scrollbar` at `packages/playground/src/assets/main.css:92`, `pg-surface-glass` at `packages/playground/src/assets/main.css:105`, `pg-input` at `packages/playground/src/assets/main.css:110`, `pg-btn-accent` at `packages/playground/src/assets/main.css:126`, and `pg-badge` at `packages/playground/src/assets/main.css:138`.
- Several newer views already use semantic `pg-*` status tokens consistently, for example `packages/playground/src/views/EvalsView.vue:32`, `packages/playground/src/views/EvalRunDetailView.vue:23`, and `packages/playground/src/views/BenchmarksView.vue:36`.

## Open Questions Or Assumptions

- This audit assumes `packages/playground` is the only browser UI shipped from this repository. Other UI systems may live in sibling repositories, but they are outside the current repository scope.
- It is unclear whether the intended shared design-system package should be a DzupAgent-owned package or an adopted sibling UI package. The current repo does not expose a shared UI/token dependency from `@dzupagent/playground`.
- The current token names use the `pg-*` prefix, which may be appropriate for a playground-only skin but may need a framework-level namespace before becoming a cross-app design-system contract.
- The audit did not verify actual rendered contrast, dark-mode behavior, or responsive layout in a browser.

## Recommended Next Actions

1. Define the design-system boundary: decide whether to extract the existing `pg-*` tokens into a shared DzupAgent package or adopt an existing workspace UI/token package.
2. Centralize semantic visual mappings for statuses, capabilities, alerts, and marketplace categories, then update tests to assert semantic variants instead of raw Tailwind palette classes.
3. Introduce minimal shared control primitives for buttons, inputs, selects, badges, tabs, segmented controls, and pagination controls.
4. Migrate the highest-reuse callsites first: `RunHistoryBrowser`, `EvalDashboard`, `CapabilityMatrixView`, `TraceTimeline`, `InspectorPanel`, and `AgentCard`.
5. Add an explicit theme boundary with deterministic light/dark theme selection, while keeping OS preference as the default.
6. After static cleanup, run `yarn workspace @dzupagent/playground typecheck`, `yarn workspace @dzupagent/playground test`, and a browser/screenshot pass before claiming runtime validation.
