# Dialogue Core replay

`@dzupagent/dialogue-core-replay` provides provider-free recorded ports,
GoldenTrace decoding, and deterministic Dialogue Core replay.

## GoldenTrace fixture admission v1

`loadGoldenTraceFixtureV1` accepts two explicit inputs: the UTF-8 JSON text of
a v1 sidecar manifest and a bounded array containing the named trace bytes as
an ordinary detached `ArrayBuffer`. The loader validates the exact manifest and
privacy shape, verifies the payload's raw UTF-8 byte count and SHA-256 before
parsing, and only then performs fatal UTF-8 decoding and routes the text through
`loadGoldenTrace`.

The v1 manifest deliberately does not hash its own bytes. Its `files` table
covers payloads only, while `custody.manifestBytes` requires a separate
external receipt to bind the sidecar bytes. This avoids a recursive or
fictional self-digest.

The core loader does not enumerate directories, resolve paths, or follow
links. V1 admits exactly one flat `<fixtureId>.golden.json` filename, which
removes traversal and symlink ambiguity from the pure admission boundary. A
future filesystem adapter must define separate `lstat`, real-root, and receipt
rules before reading any path.

Privacy admission permits only Datazup-authored `synthetic` evidence or
`sanitized` evidence bound to the exact v1 sanitizer policy. All raw-provider,
credential/secret, tenant/private-content, absolute-path, and production-
capture claims must be explicitly false. These are fail-closed custody claims,
not an automated content audit or a human publication review. The only
admitted publication status is `local-only-unreviewed`.

## Grouped exact replay

`replayDialogue` retains `GoldenTrace.turns` as ordered groups. One internal
coordinator exposes only the active group's agent, validator, workspace
snapshot, and workspace effect recordings to Dialogue Scheduler. A group
advances only after every supplied method recording is consumed exactly once
and an exact persisted-then-stream terminal event pair is observed.

The coordinator matches group position to runtime `turnIndex` and verb. Agent
requests carry that runtime identity; validator and workspace calls inherit
the active group through Dialogue Scheduler's awaited sequential execution.
`GoldenTraceTurn.turnId` remains fixture metadata because current runtime
events do not carry it.

Replay failures use bounded structured categories with only group, method, and
count evidence. They do not serialize fixture payloads, requests, provider
material, paths, or secrets. The existing recorded ports remain available as
standalone public test-support classes.

## Replay-owned scenarios

The checked-in `handoff-barrier` bundle exercises the production fixture loader
and replay path across an initial participant turn, an exact handoff, and a
post-handoff turn owned by the new active participant. Corruption,
missing/extra recordings, first-failure preservation, late recordings, and
wrong-side-of-handoff regrouping are derived from admitted synthetic bundles at
test time so intentionally invalid payloads do not enter the successful fixture
namespace.

These sidecars and replay scenarios are local provider-free test evidence.
They do not prove distributed handoff leases, cancellation, observer-failure
policy, live or hosted qualification, publication, deployment, or production
enablement.
