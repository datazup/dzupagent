---
name: fleet:reconcile-contracts
description: Use when a fleet run reports a contract conflict (escalation) — guides the human through ratifying or rejecting competing proposals.
---

# fleet:reconcile-contracts

When `SupervisorPolicy.onContractChange` returns `escalate: true`, two or more workers proposed incompatible contract changes for the same `surface`. Steps to resolve:

1. Read the run's `knowledge/snapshots/contracts/` directory. Each `<surface>.json` may be the latest version; check `entries.ndjson` for the full proposal history.
2. For each conflicting proposal, identify the proposing repo (`authorWorkerId` → look up worker in `run.json`).
3. Decide: ratify one, reject others, or merge into a new proposal.
4. Write the ratified contract via `yarn fleet:promote-contract --run <dir> --surface <name> --from <proposalId>` (Phase 1b CLI; for Phase 1a, append the entry manually as a `kind=contract status=ratified` envelope).
5. Resume the run: `yarn fleet:resume --run <dir> --run-id <id>`.

Default bias: ratify the proposal from the repo that owns the surface (if clear). If unclear, surface the question to the human.
