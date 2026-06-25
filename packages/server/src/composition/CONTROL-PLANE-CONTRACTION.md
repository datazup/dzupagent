# Control-Plane Contraction Schedule

> Audit reference: `full-dzupagent-2026-06-23/run-001` MC-5 (ARCH-H-01).
> Owner of this document: `dzupagent-architect`.

## Why this exists

`packages/server` historically accreted product-control-plane route families
(prompts, personas, presets, marketplace, …) as built-in server routes. Per the
DzupAgent architecture principles, **product behavior belongs in consuming apps**
(codev-app, research-app, …) and should be mounted through `routePlugins` or
app-level Hono composition around `createForgeApp` — not added to or grown inside
`packages/server`.

These route families are now frozen as `compatibility-maintenance`
infrastructure: they stay source-compatible for existing framework hosts, but
they are **not the forward path** for new product features, and they must
**contract over time** rather than grow. This document is the written
contraction schedule the audit (ARCH-H-01) asked for, plus the binding policy
that freezes the `ForgeControlPlaneRouteFamilyConfig` injection surface.

## Status legend

| Status             | Meaning                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **keep**           | Core framework/runtime infrastructure. Stays in `packages/server`. Not a product control plane.                                                                   |
| **extract-to-app** | Product behavior that belongs in consuming apps. The server surface remains only as a compatibility shim and should be reimplemented app-side via `routePlugins`. |
| **deprecate**      | Removable with a migration path. Slated for removal once the documented replacement seam is adopted by all consumers.                                             |

`Target Version` is the earliest release in which the contraction step (removal,
or hard-deprecation warning) becomes eligible. `—` means no contraction step is
scheduled (kept indefinitely as framework infrastructure).

## Classification of the `compatibility-maintenance` route families

Route families are grouped by product concept. The `serverRouteBoundaries`
section of `config/architecture-boundaries.json` is the authoritative
file-level classification (32 files under `compatibility-maintenance`); this
table is the concept-level contraction plan that maps those files to the 16
product concepts they implement.

| Family        | Status         | Owner  | Target Version | Notes                                                                                                                                                                                                                                                         |
| ------------- | -------------- | ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openai-compat | keep           | server | —              | External `/v1/*` API surface (chat/completions, models). Framework-level compatibility with the OpenAI wire protocol; not a product control plane. Stays.                                                                                                     |
| a2a           | keep           | server | —              | Agent-to-agent (`/a2a`, `/.well-known/agent.json`) is a framework interop protocol, not product behavior. Stays as runtime infrastructure.                                                                                                                    |
| deploy        | keep           | server | —              | Deploy confidence/history is a framework runtime primitive consumed by `ForgeCompatibilityRouteFamilyConfig.deploy`, not a product UX surface. Stays.                                                                                                         |
| playground    | keep           | server | —              | Static framework dev playground asset server. Stays as a dev convenience; not product behavior.                                                                                                                                                               |
| prompts       | extract-to-app | —      | v2.0           | Prompt CRUD/publish/rollback is product prompt-template UX. Belongs in the consuming app. Server `promptStore` is a compatibility shim. Mount app-side via `routePlugins`.                                                                                    |
| personas      | extract-to-app | —      | v2.0           | Persona CRUD is product persona UX. Belongs in the consuming app. Server `personaStore` is a compatibility shim.                                                                                                                                              |
| presets       | extract-to-app | —      | v2.0           | Preset listing/config is product UX. Belongs in the consuming app. Server `presetRegistry` is a compatibility shim.                                                                                                                                           |
| marketplace   | extract-to-app | —      | v2.0           | Catalog CRUD is product marketplace UX. Belongs in the consuming app. Server `catalogStore` is a compatibility shim.                                                                                                                                          |
| clusters      | extract-to-app | —      | v2.0           | Cluster/role/mail management is product orchestration UX. Belongs in the consuming app. Server `clusterStore` is a compatibility shim.                                                                                                                        |
| mailbox       | extract-to-app | —      | v2.0           | Agent mailbox send/ack/DLQ is product messaging behavior. Belongs in the consuming app. Server `mailboxStore` + `mailDelivery` are compatibility shims.                                                                                                       |
| reflections   | extract-to-app | —      | v2.1           | Run-reflection read surface is product analytics UX. Belongs in the consuming app. Server `reflectionStore` is a compatibility shim.                                                                                                                          |
| learning      | extract-to-app | —      | v2.1           | Learning ingest/dashboard/feedback/skill-packs is product learning-loop UX. Belongs in the consuming app. Server `learningEventProcessor` + `promptFeedbackLoop` are compatibility lifecycle shims.                                                           |
| evals         | extract-to-app | —      | v2.1           | Eval run lifecycle is product evaluation UX. Belongs in the consuming app (or `@dzupagent/evals` host wiring) via `routePlugins`. Framework eval **contracts** stay in `@dzupagent/eval-contracts`.                                                           |
| benchmarks    | extract-to-app | —      | v2.1           | Benchmark run/baseline/compare is product evaluation UX. Belongs in the consuming app.                                                                                                                                                                        |
| schedules     | deprecate      | —      | v2.0           | Schedule CRUD/trigger duplicates app scheduling. Migration path: app-owned scheduler mounted via `routePlugins`; framework retains only `scheduleStore` + HA `scheduleTickWorker` (QF-11) as runtime primitives. Remove route surface once consumers migrate. |
| triggers      | deprecate      | —      | v2.0           | Trigger CRUD/enable duplicates app trigger config. Migration path: app-owned trigger config via `routePlugins`; framework retains only `triggerStore` as a runtime primitive. Remove route surface once consumers migrate.                                    |

### Contraction summary

- **keep (4):** openai-compat, a2a, deploy, playground — framework/runtime infrastructure.
- **extract-to-app (10):** prompts, personas, presets, marketplace, clusters, mailbox, reflections, learning, evals, benchmarks — product behavior; server surface is a compatibility shim only.
- **deprecate (2):** schedules, triggers — removable route surfaces with a documented `routePlugins` migration path; only the underlying stores/HA workers are retained as runtime primitives.

## Migration path for `extract-to-app` and `deprecate` families

1. The consuming app implements its product routes (CRUD, UX endpoints) in its
   own codebase.
2. The app mounts them via `ForgeIntegrationsConfig.routePlugins` (the
   server-owned extension seam) or app-level Hono composition around
   `createForgeApp`.
3. The corresponding `ForgeControlPlaneRouteFamilyConfig` injection field
   (e.g. `promptStore`, `personaStore`) remains available as a compatibility
   shim until the target version, then is removed in a major release with this
   document updated and a changeset migration note.

New product-control-plane concepts (workspaces, projects, tasks/subtasks,
operator dashboards, persona/prompt/marketplace product UX, memory-policy
controls) must **not** add fields to `ForgeControlPlaneRouteFamilyConfig`. They
define app-owned config and mount through `routePlugins`.

## Hard gate: `ForgeControlPlaneRouteFamilyConfig` is frozen

`ForgeControlPlaneRouteFamilyConfig` (declared in
`packages/server/src/composition/types.ts`, mirrored in
`packages/server/src/composition/control-plane-types.ts`) is a **frozen
compatibility surface**. Its field set may only **shrink** (as families
contract per the schedule above). Adding a new field is a governance event.

### Baseline

The frozen baseline lives in
`config/architecture-boundaries.json` under
`serverRouteBoundaries.controlPlaneFreezeBaseline`:

- `interface` — `ForgeControlPlaneRouteFamilyConfig`
- `sourceFiles` — `packages/server/src/composition/types.ts` and
  `packages/server/src/composition/control-plane-types.ts` (the field set must
  match in both — they are kept mirrored)
- `fieldCount` — the frozen field count
- `fields` — the frozen, sorted field-name list

### Enforcement

`yarn check:control-plane-freeze`
(`scripts/check-control-plane-freeze.mjs`) recomputes the interface's fields
from source and fails CI when:

- a field is **added** without updating the baseline (regression — new product
  control plane snuck into `packages/server`), or
- the baseline drifts from source in either direction (count or names), or
- the two mirrored source files disagree on the field set, or
- this contraction schedule (`CONTROL-PLANE-CONTRACTION.md`) is missing.

The gate is wired into `verify:strict`. It is complementary to the existing
`check:domain-boundaries` route-family drift check (which keeps the
`forgeServerConfigRouteFamilies` manifest in sync); this gate additionally
**freezes the count** and ties any change to this written schedule.

### How to legitimately change the frozen surface

**Removing** a field (contraction — the desired direction):

1. Remove the field from `ForgeControlPlaneRouteFamilyConfig` in both
   `types.ts` and `control-plane-types.ts`.
2. Update this document (mark the family removed / advance its `Target Version`).
3. Update the `controlPlaneFreezeBaseline` (`fieldCount` and `fields`) and the
   `forgeServerConfigRouteFamilies` manifest in
   `config/architecture-boundaries.json`.
4. Add a changeset with the migration note.

**Adding** a field is **not permitted** without an approved RFC. Adding a field
without updating this doc and the baseline fails CI. If an RFC is approved,
update this document with the rationale, the baseline, and the manifest in the
same change.
