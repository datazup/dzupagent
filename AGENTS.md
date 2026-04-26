# Repository Guidelines

## Project Structure & Module Organization
This repository is a Yarn workspace monorepo (`packages/*`) for the DzupAgent framework. Core runtime modules live in `packages/core`, `packages/agent`, `packages/context`, and `packages/memory*`. Integrations and adapters are in `packages/connectors*` and `packages/express`. Supporting modules include `packages/codegen`, `packages/evals`, `packages/testing`, `packages/test-utils`, `packages/rag`, and `packages/scraper`.

Most package source code is in `packages/<name>/src`. Build artifacts are emitted to `packages/<name>/dist` via `tsup`.

## Product Feature Boundary
DzupAgent framework capabilities should be developed as reusable primitives in the framework packages, then productized in applications such as `apps/codev-app`.

Do not add new product features to:
- `packages/server`
- `packages/playground`

Those packages are retained for compatibility, tests, examples, and maintenance. They are not the forward path for new agent product capabilities. If a task asks for workspaces, projects, tasks/subtasks, personas, prompt templates, workflow DSLs, memory policies, multi-tenant filtering, adapter orchestration, or Codev operator UX, route that work to the consuming app instead of expanding server/playground.

## Build, Test, and Development Commands
Run commands from the repo root:

- `yarn build` — Turbo-powered, dependency-aware build orchestration across workspaces.
- `yarn dev` — runs available package `dev` tasks in parallel through Turbo.
- `yarn typecheck` — Turbo-powered TypeScript checks across workspaces.
- `yarn lint` — Turbo-powered linting across workspaces.
- `yarn test` — Turbo-powered tests across workspaces.
- `yarn verify` — runs build + typecheck + lint + test via Turbo in one command.
- `yarn docs:generate` — generates API docs from TypeDoc using `typedoc.json` + `tsconfig.docs.json`.

Preferred quality gate before opening a PR:
`yarn build && yarn typecheck && yarn lint && yarn test`

For focused local checks, use Turbo filters (examples):
- `yarn build --filter=@dzupagent/core`
- `yarn typecheck --filter=@dzupagent/core`
- `yarn test --filter=@dzupagent/connectors`

## LLM / Automation Workflow
- Prefer package-scoped verification first using `--filter=@dzupagent/<package>`.
- Run `yarn verify` before finalizing cross-package or shared API changes.
- If changes touch `packages/connectors/**`, run `yarn build:connectors:verified`.
- Regenerate docs with `yarn docs:generate` when exported APIs, TSDoc, or TypeDoc config changes.
- Treat `packages/server` and `packages/playground` changes as maintenance-only unless the user explicitly asks for them by name.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM), Node.js 20+.
- Keep strict typing; avoid `any` unless absolutely necessary.
- Use clear, descriptive names: `kebab-case` for files, `camelCase` for variables/functions, `PascalCase` for types/classes.
- Keep modules focused and package boundaries explicit (avoid app-specific logic in framework packages).

## Testing Guidelines
Vitest is used across the monorepo (see `vitest.config.ts` in packages). Place tests under `src/__tests__` or alongside modules using `*.test.ts` naming.

Run all tests with `yarn test`, or run package-local checks with workspace commands, e.g.:
`yarn workspace @dzupagent/core test`

## Commit & Pull Request Guidelines
Follow Conventional Commits used in history: `feat:`, `fix:`, `chore:`, optionally scoped (e.g., `feat(core): ...`). Keep messages imperative and specific.

For PRs, include:
- A short summary of what changed and why.
- Affected packages (e.g., `packages/core`, `packages/connectors`).
- Validation performed (build/typecheck/lint/test commands and outcomes).
- Any migration or breaking-change notes.
