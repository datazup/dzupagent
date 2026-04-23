## Summary

Describe what changed and why.

## Affected Packages

- [ ] `@dzupagent/core`
- [ ] `@dzupagent/agent`
- [ ] `@dzupagent/memory`
- [ ] `@dzupagent/context`
- [ ] `@dzupagent/rag`
- [ ] `@dzupagent/connectors`
- [ ] `@dzupagent/agent-adapters`
- [ ] `@dzupagent/otel`
- [ ] `@dzupagent/codegen`
- [ ] `@dzupagent/runtime-contracts`
- [ ] other:

## Change Classification

- [ ] bug fix with no public surface expansion
- [ ] internal refactor
- [ ] public contract change
- [ ] feature addition
- [ ] promotion from app-local or shared-kit code
- [ ] new package

## Consumer Ownership

Owning consumer repo:

Why this belongs in `dzupagent` instead of the app repo or `shared-kit`:

Expected tier impact:

## Contract Impact

- [ ] no public contract change
- [ ] public types changed
- [ ] runtime behavior changed
- [ ] event/schema/API contract changed

Contract notes:

## Validation

Commands run:

- [ ] `yarn typecheck`
- [ ] `yarn test`
- [ ] `yarn check:package-tiers`
- [ ] consumer matrix baseline
- [ ] other:

## Promotion Checklist

Complete this section only when the change expands framework surface.

- [ ] named consumer repo is documented
- [ ] framework vs app/shared-kit rationale is documented
- [ ] tier impact is documented
- [ ] validation target is documented
- [ ] contract shape is documented
- [ ] second-consumer evidence exists, or a strategic exception is explicitly stated
