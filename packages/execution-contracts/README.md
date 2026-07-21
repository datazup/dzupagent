# @dzupagent/execution-contracts

Provider-neutral execution isolation contracts proven by Codev and reusable by
worker hosts and adapters. The package owns resource-policy and command-catalog
validation, sanitized egress records, host-capability shapes, and sealed
isolation/fleet qualification receipts.

It has no runtime DzupAgent package dependencies. Product execution identity,
tenant/user scope, authorization, persistence, and outbox semantics remain in
the consuming application.

## Signed policy temporal validity

`ResourcePolicy` v1 may include `issuedAt` and `expiresAt`; v2 requires them.
They must be provided together as canonical UTC ISO 8601 timestamps with
exactly millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`), and `expiresAt`
must be later than `issuedAt`. Both fields are part of the canonical policy
signature.

Legacy v1 policies without these fields remain structurally valid through
`validateSignedExecutionPolicy`, preserving existing consumers. Claiming
consumers that require temporal validity must instead call
`validateSignedExecutionPolicyForClaim` with an explicit `claimedAt` timestamp.
That strict path fails closed for legacy policies, rejects claims before
issuance, and treats `expiresAt` as an exclusive boundary: a claim at or after
expiration is invalid. The validator never reads the system clock.

Consumers that require a versioned v2 policy and bounded clock-skew handling
can call `validateTemporallyValidSignedExecutionPolicy` with trusted
`trustedNowMs` and `clockSkewMs` values. Use `createTemporalResourcePolicy` to
construct that policy form.
