# Repository Guidelines

## Project Structure & Module Organization
This repository is a Yarn workspace monorepo (`packages/*`) for the DzipAgent framework. Core runtime modules live in `packages/core`, `packages/agent`, `packages/context`, and `packages/memory*`. Integrations and adapters are in `packages/connectors*`, `packages/express`, and `packages/server`. Supporting modules include `packages/codegen`, `packages/evals`, `packages/testing`, `packages/test-utils`, `packages/rag`, and `packages/scraper`.

Most package source code is in `packages/<name>/src`. Build artifacts are emitted to `packages/<name>/dist` via `tsup`.

## Build, Test, and Development Commands
Run commands from the repo root:

- `yarn build` — builds workspace packages in dependency order.
- `yarn typecheck` — runs TypeScript checks across all workspaces.
- `yarn lint` — runs each package linter.
- `yarn test` — runs all package test suites.

Preferred quality gate before opening a PR:
`yarn build && yarn typecheck && yarn lint && yarn test`

## Coding Style & Naming Conventions
- Language: TypeScript (ESM), Node.js 20+.
- Keep strict typing; avoid `any` unless absolutely necessary.
- Use clear, descriptive names: `kebab-case` for files, `camelCase` for variables/functions, `PascalCase` for types/classes.
- Keep modules focused and package boundaries explicit (avoid app-specific logic in framework packages).

## Testing Guidelines
Vitest is used across the monorepo (see `vitest.config.ts` in packages). Place tests under `src/__tests__` or alongside modules using `*.test.ts` naming.

Run all tests with `yarn test`, or run package-local checks with workspace commands, e.g.:
`yarn workspace @dzipagent/server test`

## Commit & Pull Request Guidelines
Follow Conventional Commits used in history: `feat:`, `fix:`, `chore:`, optionally scoped (e.g., `feat(core): ...`). Keep messages imperative and specific.

For PRs, include:
- A short summary of what changed and why.
- Affected packages (e.g., `packages/core`, `packages/connectors`).
- Validation performed (build/typecheck/lint/test commands and outcomes).
- Any migration or breaking-change notes.
