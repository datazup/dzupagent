---
"@dzupagent/dialogue-core": minor
"@dzupagent/dialogue-core-replay": minor
---

Add a versioned fail-closed continuation proposal and transition kernel under
`@dzupagent/dialogue-core/continuation/v1`, plus a separate replay conformance
fixture and divergence-ledger contract. Preserve the frozen v0.2 scheduler
parser behavior.

The replay package also validates and executes deterministic historical,
Codev-derived, and adversarial fixtures with explicit safety-dominance and
adoption-readiness gates.
