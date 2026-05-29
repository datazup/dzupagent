---
name: fleet:design-run
description: Use when designing a multi-repo fleet run — picks the right scenario, scopes repos, defines tasks, and seeds knowledge.
---

# fleet:design-run

When the user wants to run work across multiple repos with the dzupagent Fleet primitive, walk them through these decisions in order:

1. **Scenario.** Which preset fits?

   - `audit-fanout` — same task, every repo, results merged.
   - `independent-tasks` — different tasks, may have dependencies, parallel where possible.
   - `coordinated-feature` — cross-repo change requiring contract reconciliation.
   - `continuous-fleet` — long-running, queue-fed, bids over time.

2. **Repos.** Which workspace repos participate? Resolve to filesystem paths under the workspace root.

3. **Tasks.** For fan-out and continuous: one task template. For independent and coordinated: a list with `dependsOn` where needed.

4. **Seed knowledge.** Any cross-repo contracts, ADRs, or prior lessons the fleet should start with? Add them as `seedKnowledge` entries on the `FleetRunSpec`.

5. **Budgets.** Wallclock, tokens, tool calls. Defaults are generous; tighten for cost-sensitive runs.

Output: a `FleetRunSpec` JSON the user can pass to `yarn fleet:run --task <file>`.
