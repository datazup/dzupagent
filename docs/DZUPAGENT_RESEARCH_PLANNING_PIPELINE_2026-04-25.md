# DzupAgent Research Planning Pipeline (2026-04-25)

## Purpose

This document preserves the recommended approach for a DzupAgent-assisted workflow that can:

1. brainstorm and research implementation topics,
2. compare the research to the current `dzupagent` codebase,
3. produce an evidence-backed implementation plan,
4. split that plan into narrow task packets, and
5. loop on each packet until it has enough concrete detail for cheaper or simpler models to implement safely.

This is a planning-memory artifact. It should be treated as design guidance until the scripts and validation described here are implemented and verified.

## Placement

Start this as repo-adjacent workflow automation, not as a core runtime feature inside `packages/*`.

Recommended first home:

```txt
/media/ninel/Second/code/datazup/ai-internal-dev/scripts/dzupagent-analysis/planning/
```

Recommended output location:

```txt
out/dzupagent-planning/<YYYY-MM-DD>/<topic-slug>/
  00-index.md
  01-topic-brief.md
  02-research-pack.md
  03-implementation-map.md
  04-implementation-plan.md
  05-task-packets/
    task-001.md
    task-002.md
  planning-manifest.json
```

Only extract generic pieces into `dzupagent/packages/*` after the workflow is stable. Likely later homes are `packages/codegen`, `packages/evals`, `packages/testing`, or a new planning-focused package.

## Pipeline Stages

### 1. Topic Intake

Input:
- a topic such as `runtime MCP wiring`, `adapter contract`, `multi-tenant control plane`, `codegen policy compiler`, or `server runtime truth`
- optional target packages or docs
- optional known source reports

Output:
- research questions
- expected implementation surfaces
- likely package and file areas
- initial acceptance criteria
- initial verification commands

Artifact:

```txt
01-topic-brief.md
```

### 2. Research Pack

Gather and label relevant context before comparing it to code.

Allowed inputs:
- local docs and prior reports
- package `ARCHITECTURE.md` files
- current `docs/*` roadmaps and stabilization notes
- previous `out/` analysis packs
- external docs or papers when the topic requires them

Every source claim must be labeled as one of:
- `external blueprint`
- `existing repo claim`
- `verified current implementation`
- `unverified historical note`

Artifact:

```txt
02-research-pack.md
```

### 3. Current Implementation Mapping

Map every research claim to the live repository.

Required questions:
- Is this already implemented?
- Is it implemented only as a utility or library?
- Is it wired into the runtime path?
- Is it partially wired?
- Is it missing?
- Which files prove the status?
- Which tests prove or fail to prove the status?

Suggested matrix:

```md
| Requirement | Status | Evidence | Gap | Risk | Verification |
| --- | --- | --- | --- | --- | --- |
| Canonical run contract across adapters, codegen, and server | partial | packages/adapter-types/src/index.ts; packages/server/src/routes/... | Current wire contract is narrower than the planning blueprint. | high | yarn typecheck --filter=@dzupagent/server |
```

Artifact:

```txt
03-implementation-map.md
```

### 4. Implementation Plan Synthesis

Convert the implementation map into ordered slices. Each slice must be smaller than a feature and concrete enough to verify independently.

Avoid broad tasks such as:

```txt
Finish MCP runtime integration.
```

Prefer narrow tasks such as:

```txt
Add a contract test proving which RunRequest fields are accepted by the adapter boundary before changing server route behavior.
```

Artifact:

```txt
04-implementation-plan.md
```

### 5. Task Detail Loop

Before a task is handed to a cheaper implementation model, validate that it contains enough detail.

A task packet is ready only when it includes:
- exact files to inspect
- exact files likely to edit
- forbidden files or forbidden scope
- expected behavior before and after the change
- tests to add or update
- commands to run
- rollback-safe constraints
- public API and export impact
- dependency impact
- acceptance criteria
- known pitfalls from current code

If any field is missing, send the packet through a detail-expansion prompt instead of sending it to an implementation worker.

Artifacts:

```txt
05-task-packets/task-001.md
05-task-packets/task-002.md
```

## Model Roles

Use different model strengths for different responsibilities.

| Role | Model Class | Responsibility |
| --- | --- | --- |
| Research planner | stronger | Expand topic, compare research to current code, rank gaps. |
| Task packet generator | medium | Turn plan slices into complete implementation packets. |
| Implementation worker | cheaper | Implement exactly one ready packet with narrow validation. |
| Reviewer/evaluator | stronger | Compare the diff to the packet, detect scope creep, and accept or reject the task. |

The cheaper implementation worker should not be asked to understand the whole repository. It should receive one narrow packet with explicit files, constraints, and validation commands.

## Manifest Contract

Use a structured manifest so the workflow can be validated mechanically.

```ts
type PlanningManifest = {
  topic: string;
  createdAt: string;
  targetRepo: "dzupagent";
  researchSources: ResearchSource[];
  implementationClaims: ImplementationClaim[];
  gaps: GapFinding[];
  tasks: ImplementationTask[];
};

type ImplementationClaim = {
  claim: string;
  status: "implemented" | "partial" | "utility-only" | "missing" | "unclear";
  evidenceFiles: string[];
  evidenceSummary: string;
  verificationCommands: string[];
  risk: "low" | "medium" | "high";
};

type ImplementationTask = {
  id: string;
  title: string;
  packageScope: string[];
  filesToInspect: string[];
  filesLikelyToEdit: string[];
  forbiddenScope: string[];
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  validationCommands: string[];
  modelReadiness: "ready" | "needs-detail" | "blocked";
};
```

## Guardrails

- Do not create implementation tasks without live code evidence.
- Do not label a capability as `missing` unless current source was checked.
- Do not hand broad feature tasks to cheaper models.
- Do not allow cross-package edits unless the package boundary and validation commands are explicit.
- Do not change public API, exports, or package metadata without explicit export-surface review.
- Do not treat historical research as current truth without re-checking source.
- Do not hand off a task unless `modelReadiness` is `ready`.
- Keep deterministic stages as commands where possible; use model calls for synthesis, comparison, and packet expansion.

## First Implementation Slice

Build the dry-run skeleton first.

Task:

```txt
Add scripts/dzupagent-analysis/planning/run-planning-loop.js as a dry-run-only pipeline.
```

Initial behavior:
- accepts `--topic`
- creates a dated topic output folder
- writes `planning-manifest.json`
- writes `00-index.md`
- writes stub artifacts for the five pipeline stages
- creates task packet stubs from a static markdown template
- validates that each task packet includes files, commands, acceptance criteria, constraints, and model readiness
- exits non-zero when a packet is incomplete

Likely files to create:

```txt
scripts/dzupagent-analysis/planning/run-planning-loop.js
scripts/dzupagent-analysis/planning/task-packet-template.md
scripts/dzupagent-analysis/planning/README.md
```

Likely package-script addition:

```txt
dzupagent-analysis:planning
```

Required validation:

```txt
node scripts/dzupagent-analysis/planning/run-planning-loop.js --topic "adapter contract" --dry-run
node scripts/dzupagent-analysis/planning/run-planning-loop.js --topic "runtime MCP wiring" --dry-run
```

Exit rule:
- The first slice is complete only when the generated folder, manifest, index, stage stubs, and task-packet validation can be inspected without invoking any model.

## Later Implementation Slices

1. Add topic brief generation from local docs and package metadata.
2. Add research-pack assembly from docs, package `ARCHITECTURE.md`, and prior `out/` reports.
3. Add current-code mapping prompts that require file evidence.
4. Add implementation-plan synthesis from the gap matrix.
5. Add task-packet detail expansion until all packets pass validation.
6. Add one-task implementation runner for cheaper models.
7. Add reviewer pass that compares the diff, tests, and touched files against the packet.
8. Add crash-safe resume metadata for partially completed planning runs.

## Current Recommendation

The highest-leverage next step is the dry-run skeleton. It gives the repo a deterministic planning shape before any model orchestration is added, and it makes task readiness measurable instead of subjective.
