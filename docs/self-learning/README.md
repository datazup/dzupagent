# Self-Learning Docs

This directory contains repo-local planning and handoff documents for DzupAgent autonomous workflow learning.

## Documents

| Document | Status | Purpose |
|---|---|---|
| [`AUTONOMOUS_WORKFLOW_LEARNING_PLAN_2026-04-25.md`](./AUTONOMOUS_WORKFLOW_LEARNING_PLAN_2026-04-25.md) | Plan / Proposal | Full gap analysis and implementation handoff for candidate-first learning promotion, command lifecycle, completion protocol, evidence-backed scoring, and operator review. |

## Current Next Task

Implement candidate-first learning promotion in `@dzupagent/server`:

1. Add `LearningCandidate`.
2. Make `LearningEventProcessor` and `/api/learning/ingest` write candidates first.
3. Add candidate approve/reject/promote routes.
4. Apply promotion policy before durable lesson writes.
5. Preserve candidate, run, trace, validation, and policy provenance.

Focused validation:

```bash
yarn workspace @dzupagent/server test -- learning-event-processor learning-ingest learning-routes
yarn workspace @dzupagent/server typecheck
```
