# Contract Convergence Stabilization (2026-04-23)

## Goal

Stop active producer-consumer drift on the current highest-risk seams and move the live workspace toward one canonical contract story.

Current shared status:
- `not done`

Primary control references:
- [`../STABILIZATION_REBASELINE_2026-04-23.md`](../STABILIZATION_REBASELINE_2026-04-23.md)
- [`STABILIZATION_MATRIX_2026-04-23.md`](./STABILIZATION_MATRIX_2026-04-23.md)
- [`../ADR-002-agent-registry-primary-control-plane.md`](../ADR-002-agent-registry-primary-control-plane.md)
- [`../AGENT_CONTROL_PLANE_ROADMAP_2026-04-23.md`](../AGENT_CONTROL_PLANE_ROADMAP_2026-04-23.md)

Detailed analysis references:
- [`../analyze-full_2026_04_21/14_api_surface_and_contracts.md`](../analyze-full_2026_04_21/14_api_surface_and_contracts.md)
- [`../analyze-full_2026_04_21/09_feature_gap_matrix.md`](../analyze-full_2026_04_21/09_feature_gap_matrix.md)
- [`../analyze-full_2026_04_21/03_architecture_review.md`](../analyze-full_2026_04_21/03_architecture_review.md)

## Scope

Primary paths:
- `packages/server/src/routes/`
- `packages/server/src/a2a/`
- `packages/playground/src/`
- `packages/core/src/protocol/`
- `packages/create-dzupagent/`
- `docs/`

Supporting paths:
- `packages/core/src/events/`
- `packages/runtime-contracts/`

## Risks To Remove

1. Route path and envelope mismatches between producers and consumers.
2. Duplicate DTO ownership across packages with drifting field names or enum values.
3. Mocked consumer tests that do not prove live wire compatibility.
4. Contract changes landing without matching docs or consumer updates.

## High-Risk Seams

### A2A

Known drift from the analysis pack:
- `/a2a/*` vs `/api/a2a/*`
- raw task payloads vs `{ success, data, count }`
- `state` at root vs `result.status.state`
- `cancelled` vs `canceled`
- `pushNotificationConfig` vs `pushNotification`

### Marketplace

Known drift from the analysis pack:
- server `catalog*` endpoints
- playground `agents` and `install` endpoints
- scaffolder `templates` endpoint expectation

### Event taxonomy

Known drift from the analysis pack:
- event union does not fully match playground subscription expectations on A2A/task and cancel-related events

## Required Work

### 1. Choose canonical ownership for active seams

Required outcome:
- A2A and marketplace each have one declared canonical wire contract owner

Suggested direction:
- one route base path
- one envelope policy
- one status spelling policy
- one DTO definition source for active server/playground/scaffolder consumers

Exit condition:
- contract decisions are written down before more compatibility patches land

### 2. Add temporary compatibility policy where needed

Required outcome:
- compatibility aliases or mappers are explicit, temporary, and documented

Exit condition:
- no silent drift remains hidden behind ad-hoc mapping in one consumer only

### 3. Prove live producer-consumer compatibility

Required outcome:
- server and real consumers are tested against each other, not only against mocks

Minimum target:
- playground store/view calls against a live server test app
- core A2A client adapter against server A2A JSON-RPC handlers
- scaffolder fetch path against the chosen marketplace/template contract

Exit condition:
- at least one live contract test exists per active seam

### 4. Tie doc updates to contract changes

Required outcome:
- docs/examples move in the same wave as envelope or path changes

Exit condition:
- no contract-affecting change closes with stale examples

## Verification Requirements

Minimum proof before closing this area:

1. Focused server tests for each changed route family
2. Smallest consumer-facing checks that prove payload and status semantics still match
3. Matching doc/example update or explicit compatibility note in the same change

Recommended additional proof:

1. generated or shared DTO validation where practical
2. runtime schema/version tags on active wire contracts
3. event subscription compatibility tests for A2A/task streams

## Completion Rule

Do not mark this area `done` unless:

1. A2A and marketplace active seams no longer rely on contradictory route/envelope assumptions
2. a live producer-consumer test exists for the changed seam
3. compatibility windows and deprecations are documented if old clients still need support

## Explicit Non-Goals During This Tranche

1. Full workspace-wide contract generation rollout
2. Large semver/export redesign outside active seams
3. New client-surface expansion before existing seam truth is restored
