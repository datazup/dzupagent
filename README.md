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
yarn workspace @dzupagent/playground dev
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
