# Security Boundaries Stabilization (2026-04-23)

## Goal

Restore secure-by-default behavior on active control-plane and secret-bearing routes so current server changes do not normalize permissive behavior.

Current shared status:
- `partially done`

Primary control references:
- [`../STABILIZATION_REBASELINE_2026-04-23.md`](../STABILIZATION_REBASELINE_2026-04-23.md)
- [`STABILIZATION_MATRIX_2026-04-23.md`](./STABILIZATION_MATRIX_2026-04-23.md)

Detailed analysis references:
- [`../analyze-full_2026_04_21/04_security_review.md`](../analyze-full_2026_04_21/04_security_review.md)
- [`../analyze-full_2026_04_21/11_recommendations_and_roadmap.md`](../analyze-full_2026_04_21/11_recommendations_and_roadmap.md)
- [`../analyze-full_2026_04_21/08_product_and_docs_consistency.md`](../analyze-full_2026_04_21/08_product_and_docs_consistency.md)

## Scope

Primary paths:
- `packages/server/src/app.ts`
- `packages/server/src/routes/api-keys.ts`
- `packages/server/src/routes/openai-compat/`
- `packages/server/src/routes/compile.ts`
- `packages/server/src/routes/compile-result-event.ts`
- `packages/server/src/routes/a2a/`
- `packages/server/src/routes/mcp.ts`
- `packages/server/src/middleware/`

Secret-bearing or policy-adjacent paths:
- `packages/server/src/triggers/`
- `packages/server/src/persistence/api-key-store.ts`
- `packages/server/src/a2a/drizzle-a2a-task-store.ts`
- `packages/core/src/mcp/`
- `packages/create-dzupagent/`

## Risks To Remove

1. Unauthenticated or weakly authenticated control-plane access.
2. Owner/tenant boundary bypass on key or task mutation.
3. Secret-bearing payload exposure in normal API responses.
4. Unbounded outbound callback behavior on sensitive server-driven egress paths.

## Evidence Baseline

Tracked 2026-04-23 proof already recorded in the rebaseline:
- `yarn workspace @dzupagent/server test -- src/__tests__/api-key-wiring.test.ts src/routes/__tests__/api-keys.test.ts src/routes/openai-compat/__tests__/routes.test.ts src/routes/openai-compat/__tests__/completions.test.ts`

High-risk findings that remain the reference baseline:
- unauthenticated A2A task control risk
- permissive `/v1/*` auth when validator is absent
- admin/control-plane overexposure on `/api/mcp/*`
- missing owner checks on API key rotate/revoke
- trigger and push-notification secret exposure/egress risks

## Required Work

### 1. Fail closed on A2A and `/v1/*`

Required outcome:
- task-control A2A routes are not publicly mutable by default
- `/v1/*` does not accept arbitrary non-empty bearer tokens in normal secure mode

Exit condition:
- auth behavior is explicit in code, tests, and docs

### 2. Tighten mutation authorization

Required outcome:
- caller ownership or stronger role policy is enforced on sensitive mutation paths

Primary examples:
- API key rotate/revoke
- A2A task cancel/message/push config mutation
- compile and compile-result control-plane endpoints where applicable

Exit condition:
- touched mutation paths have explicit denial coverage for wrong-owner or unauthorized callers

### 3. Redact secret-bearing responses

Required outcome:
- ordinary API responses do not expose MCP secrets, webhook secrets, or callback tokens

Primary examples:
- MCP server definitions
- trigger configs
- callback-bearing task config

Exit condition:
- redaction behavior is covered and documented

### 4. Add outbound policy where the server calls out

Required outcome:
- push/webhook/MCP callback behavior has explicit transport and destination policy

Exit condition:
- callback flows do not silently normalize arbitrary internal-network egress

## Verification Requirements

Minimum proof before closing this area:

1. `yarn workspace @dzupagent/server test -- src/__tests__/api-key-wiring.test.ts src/routes/__tests__/api-keys.test.ts src/routes/openai-compat/__tests__/routes.test.ts src/routes/openai-compat/__tests__/completions.test.ts`
2. Denial-path coverage for every touched endpoint that mutates keys, prompts, compile execution, task state, or compatibility routes
3. Redaction coverage for every touched secret-bearing response

Recommended additional proof:

1. A2A unauthenticated denial tests
2. non-admin MCP denial tests
3. outbound callback validation tests
4. scaffolder/config examples updated with secure defaults if auth behavior changes

## Completion Rule

Do not mark this area `done` unless:

1. unauthorized and wrong-owner scenarios are explicitly covered on touched routes
2. secure defaults are documented for the mounted route families
3. secret-bearing payloads are redacted or intentionally justified

## Explicit Non-Goals During This Tranche

1. Full RBAC redesign across the whole product
2. Large auth-system rewrites not required for secure defaults
3. Broad control-plane feature additions
