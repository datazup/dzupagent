# Server Root Allowlist

Date: 2026-04-23

## Purpose

This document turns the generated `@dzupagent/server` surface inventory into a
concrete phase-1 root allowlist and a migration matrix for the few symbols that
are currently imported from the root entrypoint.

The immediate goal is to reduce root-surface drift without doing a broad export
rewrite in the same pass.

## Baseline

Source of truth:

- `docs/SERVER_API_SURFACE_INDEX.md`
- `config/server-api-tiers.json`

Current root baseline from the passing report:

- unique export sources: `126`
- stable: `29`
- secondary: `30`
- experimental: `49`
- internal: `18`
- recommended root exposure:
  - `29` keep-root
  - `79` candidate-subpath
  - `18` remove-root

Current direct root-import usage is still narrow:

- stable root symbols in use: `3`
- secondary root symbols in use: `9`
- experimental root symbols in use: `0`
- internal root symbols in use: `0`

Implication:

- the main drift is not current consumer dependence
- the main drift is that the default root export surface is much larger than the
  observed consumer footprint

## Phase-1 Root Allowlist

Phase 1 keeps only the stable transport, app-hosting, realtime, and platform
seams as the intended default root surface.

Allowed root source modules:

| Source Module | Area | Reason |
| --- | --- | --- |
| `./app.js` | `app` | Minimal host bootstrap used by templates and current direct consumers. |
| `./route-plugin.js` | `extensibility` | Small route-extension contract with real downstream usage. |
| `./routes/runs.js` | `routes-core` | Core run lifecycle API. |
| `./routes/agents.js` | `routes-core` | Core agent-management route seam. |
| `./routes/approval.js` | `routes-core` | Primary approval-control route seam. |
| `./routes/health.js` | `routes-core` | Standard host-health surface. |
| `./routes/events.js` | `realtime` | First-class event transport surface. |
| `./middleware/*` | `middleware` | HTTP identity, auth, capability, RBAC, and tenant-scope policy seam. |
| `./queue/*` | `queue` | Primary run-execution queue seam. |
| `./lifecycle/graceful-shutdown.js` | `lifecycle` | Core host-runtime lifecycle hook. |
| `./ws/*` | `realtime` | WebSocket control and event bridge surface. |
| `./events/event-gateway.js` | `realtime` | Shared event transport infrastructure. |
| `./platforms/*` | `platforms` | Template-facing deployment adapters. |
| `./streaming/sse-streaming-adapter.js` | `realtime` | Narrow SSE helper aligned with run/event transport. |

Phase-1 non-goals:

- do not remove current root exports yet
- do not redesign route ownership
- do not extract packages
- do not widen the stable root set with optional operational or control-plane
  features

## Current Root-Import Migration Matrix

The current scanned workspace code only uses a small subset of the root surface.
That makes the first pruning tranche practical.

| Symbol | Source Module | Tier | Current Consumer Snapshot | Proposed Location | Action |
| --- | --- | --- | --- | --- | --- |
| `ServerRoutePlugin` | `./route-plugin.js` | `stable` | app-specific server-domain packages | keep root | no change in tranche 1 |
| `ForgeServerConfig` | `./app.js` | `stable` | CI-health script and server integration test | keep root | no change in tranche 1 |
| `createForgeApp` | `./app.js` | `stable` | server integration test | keep root | no change in tranche 1 |
| `DoctorContext` | `./cli/doctor.js` | `secondary` | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` | `@dzupagent/server/ops` | add subpath export, keep root alias temporarily |
| `DoctorReport` | `./cli/doctor.js` | `secondary` | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` | `@dzupagent/server/ops` | add subpath export, keep root alias temporarily |
| `formatDoctorReportJSON` | `./cli/doctor.js` | `secondary` | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` | `@dzupagent/server/ops` | add subpath export, keep root alias temporarily |
| `runDoctor` | `./cli/doctor.js` | `secondary` | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` | `@dzupagent/server/ops` | add subpath export, keep root alias temporarily |
| `Grade` | `./scorecard/index.js` | `secondary` | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` | `@dzupagent/server/ops` | add subpath export, keep root alias temporarily |
| `IntegrationScorecard` | `./scorecard/index.js` | `secondary` | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` | `@dzupagent/server/ops` | add subpath export, keep root alias temporarily |
| `ScorecardProbeInput` | `./scorecard/index.js` | `secondary` | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` | `@dzupagent/server/ops` | add subpath export, keep root alias temporarily |
| `ScorecardReport` | `./scorecard/index.js` | `secondary` | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` | `@dzupagent/server/ops` | add subpath export, keep root alias temporarily |
| `ScorecardReporter` | `./scorecard/index.js` | `secondary` | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` | `@dzupagent/server/ops` | add subpath export, keep root alias temporarily |

Interpretation:

- the first real migration target is operational tooling, not transport or
  runtime execution
- doctor and scorecard are the only observed direct `secondary` root imports
- that makes `@dzupagent/server/ops` the lowest-risk first subpath
- that first subpath now exists in `packages/server/src/ops.ts` and is exported
  from `@dzupagent/server/ops`

## Reserved Secondary Candidates

The following exports should not stay in the root allowlist, but they also do
not need to move in tranche 1 because there is no current direct-root-import
pressure for them:

| Source Module | Proposed Future Location | Reason |
| --- | --- | --- |
| `./services/agent-control-plane-service.js` | `@dzupagent/server/runtime` or `@dzupagent/server/control-plane` | Runtime/control-plane surface, not minimal host bootstrap. |
| `./services/executable-agent-resolver.js` | `@dzupagent/server/runtime` or `@dzupagent/server/control-plane` | Resolver seam belongs near runtime/control-plane composition, not root. |
| `./runtime/*` secondary modules | `@dzupagent/server/runtime` | Execution/runtime helpers should converge under one explicit runtime subpath. |
| `./routes/openai-compat/index.js` | `@dzupagent/server/compat` | Important wire surface, but not part of the minimal default hosting seam. |

## First Actual Pruning Tranche

Status: `completed`

Implemented in this tranche:

1. Add `@dzupagent/server/ops` subpath exports for:
   - `./cli/doctor.js`
   - `./scorecard/index.js`
2. Keep existing root exports temporarily for compatibility while the subpath is
   introduced.
3. Add focused package validation for the new non-root facade.
4. Keep `docs/SERVER_API_SURFACE_INDEX.md` green through the export-map change.
5. Do not remove root aliases in the same tranche.
6. Do not touch runtime/control-plane exports in the same tranche.

Success condition for tranche 1:

- operational helpers have an explicit non-root home
- the generated surface report remains green
- no stable root consumer changes are required in the same pass

## Next Pruning Tranche

Status: `next`

The next server export-reduction slice should stay planning-first and decide the
next explicit non-root seam without widening into consumer migration yet.

Priority candidates:

1. `@dzupagent/server/runtime`
   - likely home for:
     - `./runtime/*` secondary modules
     - `./services/agent-control-plane-service.js`
     - `./services/executable-agent-resolver.js`
   - reason:
     - these exports are implementation-heavy runtime composition seams, not
       minimal host bootstrap APIs
2. `@dzupagent/server/compat`
   - likely home for:
     - `./routes/openai-compat/index.js`
   - reason:
     - strong wire-facing seam with a runtime-compatibility pilot already in
       place, but not part of the default root contract

Recommended next order:

1. document the runtime/control-plane migration matrix first
2. decide whether `control-plane` stays folded into `runtime` or becomes its own
   subpath
3. only then implement the next non-root entrypoint

## Anti-Drift Rules

- No new `@dzupagent/server` root export without a classification entry in
  `config/server-api-tiers.json`.
- No new `secondary` root export without an intended destination subpath.
- No root pruning until a subpath exists or a removal/migration note is
  documented.
- No optional operational feature should be added to the root surface just
  because it is already exported there today.
- Keep `docs/SERVER_API_SURFACE_INDEX.md` and this allowlist aligned after every
  export-surface change.

## Verification

Documentation-only tranche:

1. `node scripts/server-api-surface-report.mjs`
2. `node scripts/server-api-surface-report.mjs --check`
3. `yarn workspace @dzupagent/testing test src/__tests__/boundary/architecture.test.ts`

Implemented export-map tranche:

1. `yarn workspace @dzupagent/server typecheck`
2. `yarn workspace @dzupagent/server build`
3. `yarn workspace @dzupagent/server test src/__tests__/ops-exports.test.ts src/__tests__/doctor.test.ts src/__tests__/integration-scorecard.test.ts`
4. rerun the surface report commands above
