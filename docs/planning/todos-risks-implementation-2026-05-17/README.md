# DzupAgent TODO/Risk Implementation Pack

Date: 2026-05-17
Repository: `dzupagent`
Purpose: convert current TODO/risk review into an implementation-ready, multi-document plan.

## Documents

- `01-gap-analysis.md` - evidence-backed gaps, severity, affected packages, and validation gates.
- `02-feature-and-architecture-decisions.md` - features to add/change/remove and architectural decisions that need documentation or code updates.
- `03-implementation-roadmap.md` - packetized implementation sequence with ownership, dependencies, and acceptance criteria.
- `04-validation-and-closeout.md` - focused and broad verification strategy, CI/governance gates, and closeout rules.
- `05-feature-catalog.md` - named feature/capability catalog for add/change/document/defer decisions.
- `06-architecture-change-inventory.md` - architecture decisions, public API/export choices, docs, and validation gate changes.
- `07-gap-detail-sheets.md` - implementation-level analysis and test guidance for high-impact gaps.

## Scope Boundaries

DzupAgent is the reusable framework layer. This plan intentionally avoids adding app product behavior to `packages/server` or `packages/playground`. Product UX and app-specific workflows should land in consuming apps first, then promote reusable primitives back into DzupAgent only when the framework contract is proven.

## Latest Rebaseline Notes

- The latest dirty tree already adds gitleaks allowlist hardening and wires `check:gitleaks-allowlist` into root verification. The implementation pack now treats that as an active hardening slice that needs validation and docs closeout, not as a missing feature.
- The generated architecture refresh exposes additional real gaps: flow-to-planning/team lowering is future-only, `AgentAuthConfig.requiredCapabilities` is not enforced, and document connector validation/telemetry is incomplete.
- Playground TODOs remain maintenance-only and should not be promoted into product implementation work.

## Highest-Value First Slice

Start with remote memory transport contract completion or MCP transport semantics. Both are explicit framework gaps with bounded package ownership and clear test strategy.
