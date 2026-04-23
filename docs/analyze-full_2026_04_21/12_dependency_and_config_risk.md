# 12 Dependency And Config Risk

## Repository Overview
`dzupagent` is a Yarn 1 monorepo (`packageManager: yarn@1.22.22`) with a single workspace pattern (`packages/*`) and a single lockfile (`yarn.lock`). The dependency graph is broad: 30 package manifests under `packages/**/package.json`, with 68 direct dependencies, 52 peer dependencies, and 2 optional dependencies across packages. The primary runtime concentration is `@dzupagent/server`, which also has the largest direct dependency set (14). Secondary artifact evidence in `out/code-features-current/scored/dzupagent-packages-server.json` reports 18 implemented server API feature groups, which increases configuration and operational coupling risk.

## Dependency Surface
- Monorepo dependency topology is mostly internal version coupling (`"0.2.0"`), not protocol-based workspace linking (`workspace:` is not used in package manifests).
- Internal package versioning is mostly aligned at `0.2.0`, but there are active `0.1.0` islands:
  - `packages/adapter-rules/package.json` is `0.1.0`.
  - `packages/create-dzupagent/node/package.json` is `0.1.0` and depends on `@dzupagent/agent`/`@dzupagent/core` as `^0.1.0`.
- High-risk infrastructure dependency concentration is in `packages/connectors/package.json`:
  - DB/warehouse clients: `pg`, `mysql2`, `mssql`, `snowflake-sdk`, `@google-cloud/bigquery`, `@clickhouse/client`, `duckdb`, `better-sqlite3`.
- Runtime/server dependencies include operationally sensitive components:
  - `packages/server/package.json`: `drizzle-orm`, optional `bullmq` peer, `postgres` peer.
- Adapter layer uses optional runtime SDK loading:
  - `packages/agent-adapters/package.json` optional deps `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`.
  - Dynamic import and runtime failure path exist in `packages/agent-adapters/src/codex/codex-adapter.ts`.
- Peer dependency policy is broad (`>=` heavily used), increasing compatibility variance across consumer environments.

## Configuration Surface
- Config layering exists in core (`runtime > env > file > defaults`) via `packages/core/src/config/config-loader.ts`.
- Config inputs are split across several runtime surfaces:
  - Core env config (`DZIP_*`) in `packages/core/src/config/config-loader.ts`.
  - Server operational env toggles in `packages/server/src/app.ts` and `packages/server/src/routes/runs.ts` (`USE_DRIZZLE_A2A`, `SSE_KEEPALIVE_INTERVAL_MS`, `RUN_TIMEOUT_MS`, webhook URLs).
  - MCP metadata policy env toggles in `packages/server/src/runtime/tool-resolver.ts` (`DZIP_MCP_ALLOW_METADATA_STDIO`, `DZIP_MCP_ALLOWED_*`).
- Secrets expectations are distributed across server, adapters, memory, and scaffolding templates:
  - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `DZIP_API_KEY`, `OTEL_EXPORTER_OTLP_ENDPOINT`, provider-specific keys.
- Env-file footprint in tracked files is intentionally small (`.gitignore` excludes `.env*` and `*.env`), but scaffolding templates generate many env-driven operational defaults (`packages/create-dzupagent/src/templates/*.ts`, `packages/create-dzupagent/src/templates/env-example.ts`).
- Operational defaults are permissive unless explicitly configured:
  - CORS default `*` in `packages/server/src/app.ts`.
  - `/api/*` auth only applied when `config.auth` is provided.
  - OpenAI-compat auth accepts any non-empty bearer token if no validator is configured (`packages/server/src/routes/openai-compat/auth-middleware.ts`).

## Strengths
- Single package manager declaration and single lockfile reduce accidental multi-lock drift (`package.json`, `yarn.lock`).
- Changesets config is present with internal dependency update policy (`.changeset/config.json`, `updateInternalDependencies: "patch"`).
- Core config path is typed and layered (`packages/core/src/config/config-loader.ts`, `packages/core/src/config/config-schema.ts`).
- Operational self-diagnostics are built in (`packages/server/src/cli/doctor.ts`) with checks for DB, queue backend, LLM keys, and OTEL reachability.
- MCP process hardening exists:
  - Blocked env var override list and executable-path validation in `packages/core/src/mcp/mcp-security.ts`.
  - Metadata MCP allowlist controls in `packages/server/src/runtime/tool-resolver.ts`.
- Optional heavyweight integrations are lazy-loaded rather than hard-required, reducing default install footprint (`agent-adapters`, `bullmq` path).

## Findings
1. **Critical: Scaffold output is materially version-drifted from the monorepo runtime.**  
Evidence: `create-dzupagent` templates and generator still emit `^0.1.0` for many `@dzupagent/*` dependencies and `version: '0.1.0'` (`packages/create-dzupagent/src/templates/*.ts`, `packages/create-dzupagent/src/templates/package-json.ts`, `packages/create-dzupagent/src/features.ts`, `packages/create-dzupagent/src/cli.ts`), while most repository packages are `0.2.0`.

2. **Critical: Several scaffold templates do not match `ForgeServerConfig` and are likely to fail typecheck or runtime intent.**  
Evidence: templates pass unsupported fields (`cors`, `queue`, `database`, `otel`) and unsupported auth mode `'bearer'` (`packages/create-dzupagent/src/templates/production-saas-agent.ts`, `packages/create-dzupagent/src/templates/secure-internal-assistant.ts`), while server config expects `corsOrigins`, `runQueue`, etc., and auth mode is `'api-key' | 'none'` (`packages/server/src/app.ts`, `packages/server/src/middleware/auth.ts`).

3. **High: Generated API-key server templates can boot into broken auth configuration.**  
Evidence: template sets `auth: { mode: 'api-key' }` without `validateKey` or `apiKeyStore` (`packages/create-dzupagent/src/templates/server.ts`, `production-saas-agent.ts`); middleware returns `503 INVALID_CONFIG` when validator is absent (`packages/server/src/middleware/auth.ts`).

4. **High: Package-manager selection and container scaffolding are inconsistent.**  
Evidence: wizard supports `npm|yarn|pnpm` and may default to npm (`packages/create-dzupagent/src/wizard.ts`, `packages/create-dzupagent/src/utils.ts`), but server/production template Dockerfiles are hardcoded to `yarn` and `yarn.lock` (`packages/create-dzupagent/src/templates/server.ts`, `production-saas-agent.ts`).

5. **Medium: Security and traffic controls default to permissive behavior when config is omitted.**  
Evidence: wildcard CORS default (`packages/server/src/app.ts`), auth middleware only mounted when `config.auth` exists (`packages/server/src/app.ts`), and OpenAI-compat dev acceptance of any non-empty bearer token without validator (`packages/server/src/routes/openai-compat/auth-middleware.ts`).

6. **Medium: Config parsing and fallback behavior can mask misconfiguration.**  
Evidence: file-config loader swallows errors and returns `{}` (`packages/core/src/config/config-loader.ts`), env port parsing uses raw `Number()` without explicit NaN rejection (`packages/core/src/config/config-loader.ts`), and Redis reference tracker silently falls back to in-memory on setup failure (`packages/memory/src/provenance/redis-reference-tracker.ts`).

7. **Medium: Local-vs-published package ambiguity risk from non-workspace internal linking strategy.**  
Evidence: internal deps use plain semver (`0.2.0`) rather than `workspace:` protocol (no `workspace:` references found), with mixed package versions (`0.2.0` plus `0.1.0` packages including `@dzupagent/adapter-rules` and `packages/create-dzupagent/node`).

8. **Low: Tooling/version drift is visible across packages.**  
Evidence: mixed Vitest major ranges (`^3.2.4`, `^2.1.9`, `^2.1.0` in `app-tools` and `flow-compiler`), and OTEL peer/dev mismatch (`@opentelemetry/sdk-metrics` peer `^1.21.0` vs dev `^2.6.0`) in `packages/otel/package.json`.

## Drift And Upgrade Risk
- Internal dependency references are tightly coupled to explicit versions and not workspace-protocol constrained, so partial release bumps can produce non-obvious local/published resolution behavior.
- Peer dependency surface is large and broad (52 peer deps, with many `>=` ranges), increasing cross-project compatibility uncertainty during upgrades.
- Optional dependency model is extensive (including optional peers/meta), which helps modularity but increases “works in one install, fails in another” risk.
- Scaffolder drift is the highest practical upgrade hazard because it propagates stale contracts into new downstream projects.
- Diagnostic output can itself drift from reality (`packages/server/src/cli/doctor.ts` fallback reports `v0.1.0 (self)`).

## Recommended Hardening Actions
1. Automate scaffolder version synchronization from monorepo package versions (`create-dzupagent` templates, generator defaults, CLI version string) so generated projects target current `@dzupagent/*` contracts.
2. Add CI that compiles and smoke-runs every scaffold template output (`minimal`, `server`, `full-stack`, `production-saas-agent`, `secure-internal-assistant`, etc.) against current server/core types.
3. Replace invalid scaffold config shapes with typed `ForgeServerConfig`-compatible generation (`corsOrigins`, valid `auth.mode`, explicit `apiKeyStore`/`validateKey` wiring strategy).
4. Make Dockerfile generation package-manager aware (npm/yarn/pnpm variants) and consistent with selected scaffold package manager.
5. Add fail-fast validation for merged env/runtime config (explicit NaN/invalid numeric rejection, surfaced file-parse errors instead of silent `{}`).
6. Tighten production defaults or add production guards:
   - Require explicit CORS in production.
   - Require explicit auth policy for `/api/*` and `/v1/*` in production.
   - Disable OpenAI-compat dev token bypass unless explicitly enabled.
7. Adopt an explicit internal dependency policy (`workspace:^` or `workspace:*`) and enforce via CI checks to reduce local-vs-published ambiguity.
8. Normalize cross-package tooling versions (Vitest, OTEL package families) and add a dependency drift checker as part of `verify`.

## Overall Assessment
Dependency and configuration health is **moderate but currently exposed by high-impact scaffolding drift**. Core runtime patterns are reasonably structured (typed config layer, diagnostics, MCP hardening), but generated-project contract mismatches, permissive defaults, and non-workspace internal linking create avoidable production misconfiguration and upgrade risk. The most effective hardening move is to treat `create-dzupagent` as a first-class release artifact with strict contract tests and synchronized dependency/version metadata.