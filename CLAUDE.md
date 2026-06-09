# CLAUDE.md - DzupAgent Framework

## Overview

Reusable framework packages for agents, memory, context, connectors, flow DSLs, testing, and framework integrations.

## Work Here When

- `packages/core`, `packages/agent`, `packages/context`, `packages/memory*` - runtime foundations
- `packages/connectors*`, `packages/express` - integrations and adapters
- `packages/flow-*`, `packages/hitl-kit` - flow and human-in-the-loop primitives
- `packages/testing`, `packages/test-utils`, `packages/evals` - validation support

## Standard Commands

```bash
yarn build
yarn typecheck
yarn lint
yarn test
yarn verify
```

## Rules

- Use Yarn 1 + Turbo from this repo root.
- Prefer filtered Turbo checks such as `yarn test --filter=@dzupagent/core`.
- Do not add product features to `packages/server` or `packages/playground`; product behavior belongs in consuming apps such as codev-app.

## Deep Docs

- workspace-docs/repos/dzupagent/docs/
