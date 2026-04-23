# Supported Kernel Policy

Date: 2026-04-22

## Purpose

This document defines the supported DzupAgent kernel, the package tier model, and the promotion rules for framework changes. The goal is to keep `dzupagent` aligned with real consumer demand rather than letting speculative or dormant surfaces drive scope.

The machine-readable source of truth is:

- `config/package-tiers.json`
- `docs/PACKAGE_SUPPORT_INDEX.md`

This document is the human-readable policy that explains how the tier map should be interpreted and maintained.

## Support Model

DzupAgent packages are split into three tiers.

### Tier 1: Supported Kernel

Tier 1 packages are the main supported application-platform surface. They are expected to be stable, consumer-driven, and covered by the active consumer matrix.

Current Tier 1 packages:

- `@dzupagent/core`
- `@dzupagent/agent`
- `@dzupagent/memory`
- `@dzupagent/context`
- `@dzupagent/rag`
- `@dzupagent/connectors`
- `@dzupagent/agent-adapters`
- `@dzupagent/otel`
- `@dzupagent/codegen`
- `@dzupagent/runtime-contracts`
- `@dzupagent/cache`

Tier 1 expectations:

- changes must name at least one owning consumer repo
- public contract changes should be treated as high-scrutiny changes
- changes should be validated against the active consumer matrix
- these packages are allowed to drive roadmap and architecture decisions

### Tier 2: Supported Secondary Packages

Tier 2 packages are real and supported, but they are not the primary roadmap center. They should remain narrow, consumer-aware, and aligned with Tier 1.

Examples:

- `@dzupagent/server`
- `@dzupagent/express`
- `@dzupagent/memory-ipc`
- `@dzupagent/scraper`
- `@dzupagent/connectors-browser`
- `@dzupagent/connectors-documents`
- `@dzupagent/flow-*`
- `@dzupagent/evals`
- `@dzupagent/testing`
- `@dzupagent/test-utils`
- `@dzupagent/adapter-types`
- `@dzupagent/adapter-rules`

Tier 2 expectations:

- changes should still name a consumer when they widen public surface
- packages should not expand into product directions without explicit promotion
- changes may use narrower validation than Tier 1, but should still be traceable to consumer need

### Tier 3: Parked or Non-Driving Surfaces

Tier 3 packages are present in the repo but are not allowed to drive framework roadmap by default. They may be useful, but they are not part of the active supported kernel.

Current Tier 3 packages:

- `@dzupagent/playground`
- `create-dzupagent`
- `@dzupagent/app-tools`
- `@dzupagent/code-edit-kit`
- `@dzupagent/hitl-kit`

Tier 3 expectations:

- they are not roadmap drivers
- they should not justify new framework abstractions on their own
- work here should be conservative unless a named consumer and promotion case exists

## Consumer-Driven Rule

DzupAgent is maintained as an app-platform kernel for real consumers in this workspace. A framework change is justified when it improves a stable cross-app seam, removes duplicated consumer workaround logic, or promotes a proven abstraction out of app-local code.

The main active consumer set today is:

- `apps/ai-saas-starter-kit`
- `apps/codev-app`
- `apps/nl2sql`
- `apps/testman-app`

Important but non-primary demand sources:

- `apps/research-app`
- `shared-kit`
- `apps/seo-batch`

Low-signal or non-driving repos must not expand framework scope on their own.

## Promotion Rules

The following rule applies to new packages, new major features, promotions from app-local code, and public contract expansions.

A change must document:

1. the owning consumer repo
2. why it belongs in `dzupagent` instead of the app repo or `shared-kit`
3. expected package tier impact
4. validation target or matrix scenario
5. the contract shape being added or widened

Additional rule for domain-shaped features:

- promotion requires either two consumers or explicit approval as a strategic exception

The following usually do not require a full promotion record:

- bug fixes that do not widen public surface
- documentation-only changes
- internal refactors with no public contract change

## Demotion and Parking

A package or feature may be demoted or parked when:

- it has no active owning consumer
- it has repeated drift with no validated roadmap value
- it behaves like a product surface without adoption
- the maintenance cost outweighs current platform value

Demotion should be documented in `config/package-tiers.json` and reflected in this document.

## Ownership Rules

- Tier 1 packages must list at least one owning consumer repo in `config/package-tiers.json`
- Tier 2 packages should list consumers when known
- Tier 3 packages may omit owners
- `shared-kit` can be a consumer of `dzupagent`, but it is not the owner of framework contracts

## Review Checklist

Reviewers should ask:

1. which consumer repo needs this change?
2. is the package tier correct?
3. is this framework work, or should it stay in app/shared-kit?
4. does the change widen public contract or only fix existing behavior?
5. what validation proves the change against real consumers?

## Implementation Notes

- keep `config/package-tiers.json` as the authoritative tier inventory
- keep `docs/PACKAGE_SUPPORT_INDEX.md` generated from the tier inventory so support visibility stays easy to inspect
- keep the consumer matrix small enough to run routinely
- prefer a simple rule that the team actually follows over a perfect policy that no one enforces
