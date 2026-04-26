# DzupAgent API Tier Governance

Status: active.
Owners: framework architects.
Scope: every package whose root facade aggregates exports across multiple
subsystems.

This document defines the four-tier classification model that every
high-density `@dzupagent/*` package facade follows. It is the contract that
keeps reviewers honest when a single PR touches dozens of root exports.

The model exists because the framework root facades have grown to thousands
of lines (`packages/agent/src/index.ts` alone exports several hundred
symbols). Without explicit tiers, every export becomes implicitly stable
the moment it ships, and consumers cannot tell which APIs are safe to rely
on.

## Tiers

Each export from a governed root facade MUST live in exactly one tier.

### `stable`

- Public, documented, semver-protected.
- Breaking changes require a major bump and a documented migration path.
- This is the surface that should appear in marketing/onboarding docs.

### `advanced`

- Public, but power-user surface (registries, runtimes, middleware,
  guardrail engines, integration ports).
- Stable signature, but internal data shapes may evolve in a minor release
  with release notes.
- Treat additions to advanced as additive, not breaking.

### `experimental`

- Shipped through the same root entry, but not stability protected.
- Signatures and behaviour can change in any release.
- New exports should default to `experimental` unless there is a clear case
  for higher stability.

### `internal`

- Exported only because consumers in the workspace currently depend on
  them.
- Not part of the supported surface — plan to move them to a subpath or
  remove in a future major.
- Do not extend the internal tier; new internals should not be added to
  root facades.

## Compatibility windows

| Change | Required runway |
|---|---|
| Add export at any tier | Same release. |
| Promote (`experimental` → `advanced` → `stable`) | Same release; PR description must note the promotion. |
| Demote (`stable` → `advanced` → `experimental`) | Treated as a removal candidate: ship the export with a `@deprecated` JSDoc tag for at least one minor before re-tiering. |
| Remove an export | Requires at least one minor release where the export is still emitted with a `@deprecated` JSDoc tag pointing to the replacement. |
| Move export from root to subpath | Treat as a soft removal (re-export from root with `@deprecated`, then drop the root re-export in a later major). |

Demotions and removals MUST be reflected in the package `CHANGELOG`/release
notes for the minor in which they ship.

## Governed packages

| Package | Tier doc | Notes |
|---|---|---|
| `@dzupagent/core` | `packages/core/src/stable.ts`, `packages/core/src/advanced.ts`, `packages/core/src/facades/*` | Core ships subpath entries (`@dzupagent/core/stable`, `@dzupagent/core/advanced`, `@dzupagent/core/facades`, `@dzupagent/core/quick-start`, `@dzupagent/core/orchestration`, `@dzupagent/core/security`). Subpaths are the canonical mechanism for core. |
| `@dzupagent/agent` | `packages/agent/docs/api-tiers.md` | Highest-density facade after server (~700 LOC root). Tier doc inventories every export across stable / advanced / experimental / internal. |
| `@dzupagent/agent-adapters` | `packages/agent-adapters/docs/api-tiers.md` | Multi-provider adapter surface (~545 LOC root). Tier doc separates protocol-level stable contracts from provider-specific advanced/experimental clusters. |
| `@dzupagent/codegen` | `packages/codegen/docs/api-tiers.md` | Codegen + sandbox + pipeline + repo-map surface (~440 LOC root). Tier doc separates the stable VFS/Git/CodeGen entry points from preview cloud/wasm/k8s sandbox tiers. |
| `@dzupagent/server` | covered separately by audit task **MJ-ARCH-02** | Server surface review is tracked in its own work item and not duplicated here. |

Packages not yet listed (`@dzupagent/memory`, `@dzupagent/context`,
`@dzupagent/connectors`, etc.) are governed by the package's normal review
process. They are candidates for tier inventories if their root facade
crosses ~400 LOC or aggregates exports across multiple stability domains.

## How to add a new export

1. Add the export to the package's `src/index.ts` as usual.
2. Append a row to the matching tier table in the package's
   `docs/api-tiers.md` (or, for `@dzupagent/core`, ensure the export lands
   in the appropriate facade module).
3. If the export is brand-new and its stability is not yet proven,
   classify it as `experimental`.
4. If the export crosses tiers (promotion or demotion), call this out
   explicitly in the PR description.
5. Removals and demotions require a `@deprecated` JSDoc tag for at least
   one minor release before the change ships.

PR reviewers MUST reject changes that add a root export without a
corresponding tier entry. If the export is intentionally internal, prefer
exporting it from a subpath rather than the root facade.

## How to promote between tiers

1. Open a PR that:
   - moves the entry between tier tables in `docs/api-tiers.md`,
   - updates JSDoc on the export to remove any `@deprecated` or
     `@internal` markers (or add `@deprecated` for demotions),
   - notes the promotion in the package's release notes.
2. For promotions to `stable`, the export must:
   - have at least one consumer in the framework or in `apps/codev-app`,
   - have a JSDoc example,
   - have unit-test coverage of its public surface.

## How to remove an export

1. Add `@deprecated` JSDoc with a replacement reference.
2. Move the entry to the `internal` tier in `docs/api-tiers.md`.
3. Wait at least one minor release.
4. Remove the export and the tier entry in a major release; document the
   removal in the release notes.

## Scope guard

This document does not introduce build-time checks. It is a review
checklist. CI may add an automated check in future (e.g. a script that
diffs the root facade against the tier doc); until then, reviewers carry
the responsibility.
