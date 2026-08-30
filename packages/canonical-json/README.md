# @dzupagent/canonical-json

Vendored mirror of **`@datazup/canonical-json`** (shared-kit,
`shared-app-kit/canonical-json`, introduced at shared-kit `cf84bcb1`).

dzupagent cannot take a cross-repo dependency today (the GitHub Packages
registry needs `NODE_AUTH_TOKEN`, which is operator-walled), so the package
is mirrored here under the `@dzupagent` scope. `src/` is kept byte-identical
to the shared-kit package's `src/` — sync by copying, never by editing one
side. The cross-repo drift pin is the shared golden-vector fixture
(`src/__fixtures__/dzupagent-golden-vectors.json`): both repos run the same
suite against the same pinned digests, so a semantic change on either side
goes red locally.

When the registry wall lifts, replace this package with a real dependency on
`@datazup/canonical-json` and update importers' package.json entries; the
API is identical by construction.

See `src/index.ts` for the preset semantics (`idempotency-v1`,
`authoring-v1`, `classification-envelope-v1`, `compile-evidence-v1`) and the
listed divergences from the historical in-repo copies.
