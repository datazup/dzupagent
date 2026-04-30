# dzupagent

[![Connectors Verified Build](https://img.shields.io/badge/Connectors%20Verified%20Build-required-0A7B34)](./.github/workflows/connectors-verified.yml)

Modular monorepo for DzupAgent packages.

## Requirements

- Node.js `>=20`
- Yarn `1.22.22` (see `packageManager` in `package.json`)

## Quick Start

```bash
yarn install
yarn build
```

## Development

```bash
yarn dev
```

`yarn start` is an alias of `yarn dev`.

Run a single package in development mode when needed:

```bash
yarn workspace @dzupagent/rag dev
```

## Package-Scoped Workflow (Recommended for LLM/Automation)

When you change one package, prefer filtered checks first:

```bash
yarn build --filter=@dzupagent/<package-name>
yarn typecheck --filter=@dzupagent/<package-name>
yarn lint --filter=@dzupagent/<package-name>
yarn test --filter=@dzupagent/<package-name>
```

For a complete pre-PR validation, run:

```bash
yarn verify
```

## Build, Quality Gates, and Docs

```bash
yarn build
yarn typecheck
yarn lint
yarn test
```

Equivalent one-command validation:

```bash
yarn verify
```

Generate API docs:

```bash
yarn docs:generate
```

Run the connectors verified build gate:

```bash
yarn build:connectors:verified
```

Use the connectors gate when changes touch `packages/connectors/**`.

## Playground UI Ownership

DzupAgent does not currently own a product playground design-system package or
a dedicated playground workspace. The framework may host prebuilt static
playground assets for compatibility through `@dzupagent/server`, but debugger,
operator, workspace, project, task, and product UX work belongs in consuming
applications such as Codev.

Internal trace formatting helpers under `@dzupagent/agent` are framework
maintenance utilities, not a reusable product UI package. Create a dedicated
package with an explicit public contract before documenting those helpers as a
design-system surface.

## Core API Tiers

Use the narrowest core entrypoint that fits your use case:

- `@dzupagent/core/stable` for new code and the default curated surface.
- `@dzupagent/core/advanced` when you need the broader API set.
- `@dzupagent/core` only for legacy imports and back-compat while migrating.

Migration example:

```ts
// Old
import { createQuickAgent } from '@dzupagent/core'

// Recommended
import { createQuickAgent } from '@dzupagent/core/stable'
```

## Production Tool Governance

`@dzupagent/agent` keeps tool governance opt-in for backwards compatibility.
Canonical tool lifecycle telemetry, governance gates, permission policy checks,
argument validation, per-tool timeouts, and result scanning are wired when a
caller configures `DzupAgentConfig.toolExecution` or applies the
`createProductionToolGovernancePreset` / `withProductionToolGovernancePreset`
helpers.

The production preset composes the existing primitives into a fail-closed
configuration bundle, including safety scanning, durable run IDs, canonical
tool lifecycle events, and a default-deny permission policy unless the caller
supplies an allowlist or custom policy. Omitting `toolExecution` preserves the
legacy tool-loop behavior. See [`packages/agent/README.md`](./packages/agent/README.md)
and [`packages/agent/src/agent/ARCHITECTURE.md`](./packages/agent/src/agent/ARCHITECTURE.md)
for the wiring example and implementation notes.

For protected branches, use the `Verify Strict` CI workflow/check as the required merge gate.

GitHub branch protection itself is still a repository-setting step:

1. Open the repository in GitHub.
2. Go to `Settings` -> `Branches`.
3. Edit the protection rule for the target branch, then enable required status checks.
4. Require these checks:
   - `Verify Strict / verify-strict`
   - `Coverage Gate / workspace-coverage-gate`

The workflows are defined in:

- [`.github/workflows/verify-strict.yml`](./.github/workflows/verify-strict.yml)
- [`.github/workflows/coverage-gate.yml`](./.github/workflows/coverage-gate.yml)

## Documentation Hub

- See [`docs/README.md`](./docs/README.md)
