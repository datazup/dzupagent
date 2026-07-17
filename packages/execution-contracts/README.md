# @dzupagent/execution-contracts

Provider-neutral execution isolation contracts proven by Codev and reusable by
worker hosts and adapters. The package owns resource-policy and command-catalog
validation, sanitized egress records, host-capability shapes, and sealed
isolation/fleet qualification receipts.

It has no runtime DzupAgent package dependencies. Product execution identity,
tenant/user scope, authorization, persistence, and outbox semantics remain in
the consuming application.
