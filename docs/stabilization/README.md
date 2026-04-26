# Stabilization Control Docs

This directory turns the 2026-04-23 rebaseline into a small tracked control set that can be used during active stabilization work.

Primary control document:
- [`../STABILIZATION_REBASELINE_2026-04-23.md`](../STABILIZATION_REBASELINE_2026-04-23.md)

Detailed analysis baseline:
- [`../analyze-full_2026_04_21/README.md`](../analyze-full_2026_04_21/README.md)

## How To Use This Directory

1. Start with the tracked rebaseline document for current session status.
2. Use [`STABILIZATION_MATRIX_2026-04-23.md`](./STABILIZATION_MATRIX_2026-04-23.md) to decide which area is allowed to move next.
3. Use the area document for the active tranche before making or closing changes.
4. Update the rebaseline only after code, verification, and companion docs all agree.

## Documents

| Document | Purpose |
|---|---|
| [`STABILIZATION_MATRIX_2026-04-23.md`](./STABILIZATION_MATRIX_2026-04-23.md) | Shared stabilization matrix with area status, dependencies, proof requirements, and detailed references. |
| [`STABILIZATION_RUNTIME_TRUTH_2026-04-23.md`](./STABILIZATION_RUNTIME_TRUTH_2026-04-23.md) | Server run lifecycle, cancellation, persistence, and terminal-state truth. |
| [`STABILIZATION_SECURITY_BOUNDARIES_2026-04-23.md`](./STABILIZATION_SECURITY_BOUNDARIES_2026-04-23.md) | Authn/authz, secret boundaries, control-plane hardening, and denial-path proof. |
| [`STABILIZATION_CONTRACT_CONVERGENCE_2026-04-23.md`](./STABILIZATION_CONTRACT_CONVERGENCE_2026-04-23.md) | Producer-consumer contract convergence across server, playground, core, and scaffolder. |
| [`STABILIZATION_VERIFICATION_AND_RELEASE_2026-04-23.md`](./STABILIZATION_VERIFICATION_AND_RELEASE_2026-04-23.md) | Hermetic verification, integration lanes, migration controls, and release gating. |
| [`STABILIZATION_DOCS_AND_SCAFFOLDER_TRUTH_2026-04-23.md`](./STABILIZATION_DOCS_AND_SCAFFOLDER_TRUTH_2026-04-23.md) | Docs, version truth, capability matrix, scaffolder drift, and operator-facing accuracy. |
| [`STABILIZATION_HANDOFF_MEMORY_2026-04-23.md`](./STABILIZATION_HANDOFF_MEMORY_2026-04-23.md) | Detailed memory of unfinished analyzed features, remaining drift classes, and exact next-step verification guidance. |
| [`../DZUPAGENT_RESEARCH_PLANNING_PIPELINE_2026-04-25.md`](../DZUPAGENT_RESEARCH_PLANNING_PIPELINE_2026-04-25.md) | Planning-memory artifact for a research-to-implementation workflow that turns topics into evidence-backed task packets for cheaper implementation models. |
| [`../self-learning/AUTONOMOUS_WORKFLOW_LEARNING_PLAN_2026-04-25.md`](../self-learning/AUTONOMOUS_WORKFLOW_LEARNING_PLAN_2026-04-25.md) | Candidate-first autonomous workflow learning plan: learning candidates, policy-gated promotion, command lifecycle, completion protocol, scoring, and operator review. |

## Control Rules

1. Do not use a passing doc-drift check as proof that the workspace is stabilized.
2. Do not close a workstream without recording exact commands and outcomes.
3. If a route, auth surface, envelope, or migration behavior changes, update code, tests, and docs in the same wave.
4. If a stabilization task expands the active change surface, split it into a new explicit tranche instead of leaving one area permanently "partially done".
5. Do not resume net-new feature work until runtime truth, security defaults, contract convergence, and authoritative verification are all green together.
