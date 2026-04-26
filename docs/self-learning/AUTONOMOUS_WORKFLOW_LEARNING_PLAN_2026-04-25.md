# Autonomous Workflow Learning Plan

Date: 2026-04-25

Status: Plan / Proposal

Source artifacts:
- Workspace review: `out/reviews/dzupagent-automation-self-learning-review-2026-04-25.md`
- Full workspace plan: `out/reviews/dzupagent-self-learning-gap-implementation-plan-2026-04-25.md`

## Purpose

This document preserves the current findings for building automated, self-learning DzupAgent workflows in the repo-local documentation tree.

Use this as the implementation handoff for future work on:
- candidate-first learning promotion,
- workflow command lifecycle,
- completion protocol,
- scoring improvements,
- provenance-backed memory curation,
- operator review surfaces.

## Executive Finding

DzupAgent already has the core primitives needed for autonomous workflow learning:
- workflow execution,
- pipeline runtime events,
- self-learning runtime wrappers,
- post-run analysis,
- reflection,
- memory services,
- policy-aware memory staging,
- learning routes,
- scored run event processing,
- eval/scorer packages,
- server runtime and trace routes.

The current gap is not another memory primitive. The gap is the missing contract between packages:

```text
command -> run -> trace -> validation -> reflection -> candidate -> policy review -> promotion -> future retrieval
```

Today, several parts of that chain exist independently, but the handoffs are incomplete. The highest-value next step is to make learning candidate-first and reviewable before it can become durable memory.

## Current-State Map

### `@dzupagent/server`

What exists:
- `/api/learning` routes expose dashboard, trends, lessons, rules, feedback, skill-packs, and ingest.
- `LearningEventProcessor` subscribes to `run:scored` and stores extracted patterns.
- Server wiring starts prompt feedback and learning processors when configured.
- Run trace and event routes exist nearby, which can anchor provenance.

Primary gap:
- Learning ingestion can still write directly into durable `lessons`, rather than staging reviewable candidates first.

### `@dzupagent/agent`

What exists:
- `SelfLearningRuntime` wraps `PipelineRuntime`.
- `PostRunAnalyzer` stores trajectories, lessons, rules, history, and suboptimal-node signals.
- Reflection and self-correction modules exist.
- Workflow builder and workflow execution tests exist.

Primary gap:
- Successful nodes are scored too coarsely. A completed node can be treated as `1.0` even if it was unvalidated or low quality.

### `@dzupagent/app-tools`

What exists:
- `workflow.list`, `workflow.run`, and `workflow.status`.
- Built-in tool registry patterns.

Primary gap:
- Workflow tools are generic. They do not expose a productized lifecycle like `/plan`, `/implement`, `/review`, `/reflect`, `/memorize`.

### `@dzupagent/memory`

What exists:
- `defaultWritePolicy` classifies writes as `auto`, `confirm-required`, or `reject`.
- `PolicyAwareStagedWriter` prevents sensitive or decision-like records from bypassing review.
- Memory architecture includes provenance, staged writes, consolidation, and safety concepts.

Primary gap:
- The learning ingestion/promotion path does not consistently route through those policies.

## Gap Analysis

### Gap 1: Learning Candidates Are Not First-Class

Problem:
- Learning ingestion can create durable lessons too early.
- A failed, partial, or low-context run can become future context if the scorer payload looks confident enough.
- Project policy or architectural decisions may bypass confirmation.

Target:
- Introduce `LearningCandidate` as the mandatory pre-promotion object.
- Store all reflection/ingest/completion lessons as candidates first.
- Promote only after policy review and explicit approval when required.

Suggested candidate shape:

```ts
export type LearningCandidateStatus =
  | 'candidate'
  | 'approved'
  | 'rejected'
  | 'promoted'
  | 'expired'

export interface LearningCandidate {
  id: string
  tenantId: string
  runId: string
  traceId?: string
  taskId?: string
  agentId?: string
  source: 'run_scored' | 'ingest' | 'reflect' | 'completion' | 'manual'
  kind: 'success_pattern' | 'failure_pattern' | 'decision' | 'rule' | 'warning'
  content: string
  context: string
  confidence: number
  evidence: Array<{
    type: 'validation' | 'trace' | 'file' | 'metric' | 'feedback' | 'error'
    ref: string
    summary?: string
    passed?: boolean
  }>
  policy: {
    action: 'auto' | 'confirm-required' | 'reject'
    policyName: string
    reason?: string
  }
  status: LearningCandidateStatus
  createdAt: string
  reviewedAt?: string
  reviewerId?: string
  promotedLessonKey?: string
  expiresAt?: string
}
```

First implementation package:
- `@dzupagent/server`

Files to add or change:
- `packages/server/src/learning/learning-candidate.ts`
- `packages/server/src/routes/learning.ts`
- `packages/server/src/services/learning-event-processor.ts`
- server route/service tests.

Required routes:
- `GET /api/learning/candidates`
- `POST /api/learning/candidates/:id/approve`
- `POST /api/learning/candidates/:id/reject`
- `POST /api/learning/candidates/:id/promote`

Validation:

```bash
yarn workspace @dzupagent/server test -- learning-event-processor learning-ingest learning-routes
yarn workspace @dzupagent/server typecheck
```

Exit criteria:
- `run:scored` creates candidates, not direct durable lessons.
- `/api/learning/ingest` creates candidates, not direct durable lessons.
- Rejected candidates remain queryable for audit.
- Promotion preserves candidate id, run id, evidence, policy decision, and promoted lesson key.

### Gap 2: Memory Policy Is Not A Promotion Gate

Problem:
- Memory policy utilities exist, but learning routes can bypass them.

Target:
- Promotion evaluates candidate content through an explicit `LearningPromotionPolicy`.
- Policy actions align with memory semantics:
  - `auto`
  - `confirm-required`
  - `reject`

Suggested server-side adapter:

```ts
export interface LearningPromotionPolicy {
  evaluate(candidate: LearningCandidate): {
    action: 'auto' | 'confirm-required' | 'reject'
    policyName: string
    reason?: string
  }
}
```

Validation:

```bash
yarn workspace @dzupagent/server test -- learning
yarn workspace @dzupagent/memory test -- policy-aware-staged-writer
```

Exit criteria:
- PII/secret-like content is rejected.
- Decision/policy content requires confirmation.
- Low-risk observations can be promoted only when confidence and policy allow it.

### Gap 3: Workflow Commands Are Not Productized

Problem:
- `workflow.*` tools are generic and do not encode a repeatable self-learning lifecycle.

Target command lifecycle:
- `/plan`: create/update structured task plan.
- `/implement`: execute a bounded plan step.
- `/review`: run deterministic checks and optional evaluator/judge passes.
- `/reflect`: produce learning candidates with evidence.
- `/memorize`: promote approved candidates through policy.

Initial slice:
- Implement `/reflect` and `/memorize` first because they directly close the learning safety gap.

Likely packages:
- `@dzupagent/app-tools`
- `@dzupagent/server`
- `@dzupagent/agent`

Validation:

```bash
yarn workspace @dzupagent/app-tools test
yarn workspace @dzupagent/app-tools typecheck
yarn workspace @dzupagent/server test -- learning routes
```

Exit criteria:
- `/reflect` creates candidates only.
- `/reflect` cannot promote durable memory.
- `/memorize` cannot promote rejected or policy-blocked candidates.
- Every command emits a typed event or persisted command record.

### Gap 4: Completion Protocol Is Missing

Problem:
- Agents can finish work without one authoritative completion record.
- Learning candidates may miss changed files, validation commands, blockers, and cleanup state.

Target:
- Add a completion protocol that captures:
  - task id,
  - run id,
  - status,
  - changed files,
  - validation commands and outcomes,
  - blockers,
  - lessons/candidates,
  - reservation release/expiry behavior.

Suggested input:

```ts
export interface CompleteWorkInput {
  taskId: string
  runId: string
  status: 'completed' | 'failed' | 'cancelled' | 'blocked'
  changedFiles: string[]
  validations: Array<{
    command: string
    status: 'passed' | 'failed' | 'skipped'
    outputRef?: string
    summary?: string
  }>
  blockers?: string[]
  lessons?: Array<{
    kind: LearningCandidate['kind']
    content: string
    context: string
    confidence: number
  }>
  reservations?: Array<{
    path: string
    action: 'release' | 'expire' | 'keep'
  }>
}
```

Initial route:
- `POST /api/work/complete`

Validation:

```bash
yarn workspace @dzupagent/server test -- complete learning
yarn workspace @dzupagent/app-tools test
```

Exit criteria:
- Missing validation downgrades confidence.
- Failed validation creates failure candidates only.
- Completion creates candidates linked to run id.
- Completion does not promote lessons.

### Gap 5: `SelfLearningRuntime` Uses Binary Quality

Problem:
- Completed nodes can be treated as perfect.
- Error-free execution is not the same as validated quality.

Target scoring inputs:
- runtime success/failure,
- tool errors,
- retry count,
- validation pass/fail,
- `RunReflector` score,
- optional eval/judge score,
- user approval/rejection.

Suggested shape:

```ts
export interface LearningScoreInput {
  runId: string
  nodeId?: string
  completed: boolean
  errorCount: number
  retryCount: number
  toolCalls: number
  toolErrors: number
  validationPassed?: boolean
  reflectorScore?: number
  judgeScore?: number
  approved?: boolean
}
```

Likely package:
- `@dzupagent/agent`

Validation:

```bash
yarn workspace @dzupagent/agent test -- self-learning-runtime
yarn workspace @dzupagent/agent typecheck
```

Exit criteria:
- Completed but validation-failed runs do not store success trajectories above threshold.
- Tool errors lower score.
- User rejection prevents success-pattern extraction.
- Successful validated runs can produce high-confidence candidates.

### Gap 6: Promotion Does Not Require Traceable Evidence

Problem:
- A durable lesson is hard to trust if it cannot be traced back to evidence.

Target:
- Every promoted lesson must include:
  - candidate id,
  - run id,
  - trace id or event refs,
  - task id when available,
  - validation summary,
  - source command,
  - reviewer/policy decision.

Validation:

```bash
yarn workspace @dzupagent/server test -- learning run-trace
```

Exit criteria:
- Promotion without provenance fails or marks the candidate non-promotable.
- Candidate list filters by `runId`, `taskId`, `status`, and `source`.
- Promoted lessons trace back to candidate and run.

### Gap 7: Operator Approval Surface Is Missing

Problem:
- Reviewable learning as API data is useful but not enough for daily operation.

Target:
- API-first candidate review.
- Playground UI later.

API requirements:
- list candidates,
- inspect evidence,
- approve/reject/promote,
- list promoted lessons by source run,
- export learning audit.

UI requirements:
- learning candidates tab,
- run trace link,
- validation status,
- approve/reject controls,
- promoted lesson history.

Validation:

```bash
yarn workspace @dzupagent/server test -- learning
yarn workspace @dzupagent/playground test
```

Exit criteria:
- Operator can inspect why a candidate exists.
- Operator can approve/reject.
- Operator can jump to trace/evidence.
- UI state is not source of truth.

## Implementation Roadmap

### Phase 1: Candidate-First Learning Promotion

Goal:
- Stop direct learning promotion.

Deliverables:
- `LearningCandidate` schema.
- Candidate storage helper.
- Candidate list/promote/reject routes.
- `LearningEventProcessor` writes candidates.
- `/api/learning/ingest` writes candidates.
- Promotion applies policy and provenance.

Validation:

```bash
yarn workspace @dzupagent/server test -- learning-event-processor learning-ingest learning-routes
yarn workspace @dzupagent/server typecheck
```

### Phase 2: `/reflect` And `/memorize`

Goal:
- Make learning explicit and operator-controlled.

Deliverables:
- Minimal command handler or app-tool entries for reflect/memorize.
- Reflect creates candidates.
- Memorize promotes/rejects candidates.

Validation:

```bash
yarn workspace @dzupagent/app-tools test
yarn workspace @dzupagent/server test -- learning
```

### Phase 3: Completion Protocol

Goal:
- Make task closure authoritative.

Deliverables:
- Completion input schema.
- Completion route/tool.
- Validation-aware candidate confidence.
- Completion records linked to run/trace.

Validation:

```bash
yarn workspace @dzupagent/server test -- complete learning
yarn workspace @dzupagent/app-tools test
```

### Phase 4: Better Runtime Scoring

Goal:
- Replace binary learning quality with evidence-based scoring.

Deliverables:
- Score adapter around runtime/error/tool/validation/reflection signals.
- `SelfLearningRuntime` uses score input.
- `PostRunAnalyzer` respects validation/user approval.

Validation:

```bash
yarn workspace @dzupagent/agent test -- self-learning-runtime
yarn workspace @dzupagent/agent typecheck
```

### Phase 5: Decision Trace And Audit

Goal:
- Every durable lesson is explainable.

Deliverables:
- Candidate evidence model linked to run traces.
- Audit export endpoint.
- Promotion stores reviewer/policy decisions.

Validation:

```bash
yarn workspace @dzupagent/server test -- learning run-trace
```

### Phase 6: Operator Surface

Goal:
- Make approval/debugging usable.

Deliverables:
- API-first candidate dashboard data.
- Later playground tab.

Validation:

```bash
yarn workspace @dzupagent/server test -- learning
yarn workspace @dzupagent/playground test
```

### Phase 7: Channel/Runtime Automation

Goal:
- Bring autonomous learning into real user/team channels safely.

Do this only after candidate promotion and completion protocol are stable.

Deliverables:
- Generic channel event contract.
- Dedup/retry/policy/routing.
- Learning candidates from channel failures.

Validation:

```bash
yarn workspace @dzupagent/connectors test
yarn workspace @dzupagent/server test -- channel learning
```

## Suggested First Pull Request

Title:
- `feat(server): stage learning candidates before promotion`

Write scope:
- `packages/server/src/learning/learning-candidate.ts`
- `packages/server/src/routes/learning.ts`
- `packages/server/src/services/learning-event-processor.ts`
- related server tests only.

Do not touch yet:
- channel connectors,
- playground UI,
- codegen reservations,
- broad `SelfLearningRuntime` scoring.

Acceptance:
- Existing learning route behavior remains backwards-compatible where possible.
- New candidate endpoints are additive.
- Direct `/ingest` lesson writes are replaced by candidate writes.
- Promotion path preserves old lesson shape enough for existing dashboard counts.

Focused validation:

```bash
yarn workspace @dzupagent/server test -- learning-event-processor learning-ingest learning-routes
yarn workspace @dzupagent/server typecheck
```

Broader validation after PR stabilizes:

```bash
yarn workspace @dzupagent/server lint
yarn workspace @dzupagent/server build
```

## Stop Rules

- Do not call this AGI in docs or product APIs.
- Use "autonomous workflow learning", "self-learning runtime", or "operational learning".
- Do not widen into channel connectors until the command/completion/learning loop is trustworthy.
- Do not let reflection write durable project memory directly.
- Do not treat run completion as proof of quality without validation evidence.
- Do not make UI the source of truth.

## Next Task

Implement Phase 1 in `@dzupagent/server`: candidate-first learning promotion.

This is the smallest change that materially improves safety and quality. It creates the stable object that later commands, completion records, reservations, dashboards, and channel automation can build on.
