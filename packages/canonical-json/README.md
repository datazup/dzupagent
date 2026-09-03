# @dzupagent/canonical-json

Vendored mirror of **`@datazup/canonical-json`** (shared-kit,
`shared-app-kit/canonical-json`, introduced at shared-kit `cf84bcb1`).

dzupagent cannot take a cross-repo dependency today (the GitHub Packages
registry needs `NODE_AUTH_TOKEN`, which is operator-walled), so the package
is mirrored here as a private workspace leaf.

It is mirrored under `@dzupagent/canonical-json`, NOT under the upstream
`@datazup/canonical-json`. Mirroring under the original name was tried and
does not work: the combined workspace root at `ai-internal-dev` globs both
`dzupagent/packages/*` and `shared-kit/shared-app-kit/*`, and Yarn 4 treats
two workspaces sharing an ident as a hard error, not as a shadow —
`Duplicate workspace name @datazup/canonical-json` aborts EVERY root `yarn`
command, including per-repo `build:deps`/`typecheck` in repos that look
self-contained. There is no root-only escape: a `!` negation glob in the
root `workspaces` array is inert in Yarn 4.16.0 (probed in both positions),
and Yarn recurses into this repo's own `workspaces` field regardless of how
the root lists it. Renaming the mirror is the only fix that stays inside a
tracked repo. `src/` is still kept byte-identical
to the shared-kit package's `src/` — sync by copying, never by editing one
side. The cross-repo drift pin is the shared golden-vector fixture
(`src/__fixtures__/dzupagent-golden-vectors.json`): both repos run the same
suite against the same pinned digests, so a semantic change on either side
goes red locally.

When the registry wall lifts, delete this directory and point importers'
package.json entries at the registry version; that also flips the import
specifier back to `@datazup/canonical-json`, which is a mechanical sed over
the importing packages (`flow-compiler`, `flow-dsl`, `agent-adapters`,
`runtime-contracts`) — the export surface is unchanged.

See `src/index.ts` for the preset semantics (`idempotency-v1`,
`authoring-v1`, `classification-envelope-v1`, `compile-evidence-v1`) and the
listed divergences from the historical in-repo copies.
