# Security Audit

## Findings

### SECURITY-001: API key revoke and rotate endpoints are not owner- or tenant-scoped

Severity: high

Impact: Any authenticated caller that can reach `/api/keys/:id` can revoke or rotate another owner's key if they know or obtain the key id. Rotation returns a fresh raw key, so this can become credential takeover for another owner, not just denial of service.

Evidence: API-key routes resolve an owner for create/list, but `DELETE /:id` and `POST /:id/rotate` call `store.get(id)` and then `store.revoke(id)` / `store.create(existing.ownerId, ...)` without comparing `existing.ownerId` or `existing.tenantId` to the authenticated caller. The store-level `get` and `revoke` methods are also global by id. See [packages/server/src/routes/api-keys.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/api-keys.ts:168), [packages/server/src/routes/api-keys.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/api-keys.ts:182), and [packages/server/src/persistence/api-key-store.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/persistence/api-key-store.ts:199).

Remediation: Enforce owner and tenant checks before revoke/rotate, returning 404 for non-owned keys. Prefer store methods such as `getForOwner(id, ownerId, tenantId)` and `revokeForOwner(id, ownerId, tenantId)` so callers cannot accidentally use global operations in HTTP routes. Add tests for cross-owner revoke and rotate attempts.

### SECURITY-002: RBAC only protects a small route vocabulary and lets many authenticated API routes pass through unclassified

Severity: high

Impact: When API-key auth is enabled, non-admin roles can still reach any `/api/*` route whose path is not mapped to `agents`, `runs`, `tools`, or `approvals`, unless the route is separately protected. This weakens authorization for sensitive management surfaces such as `/api/keys`, `/api/registry`, compile, memory, schedules, prompts, personas, marketplace, and other optional routes.

Evidence: `pathToResource` maps only five path segments and `rbacMiddleware` calls `next()` when no resource is found. `DEFAULT_ADMIN_ONLY_PATHS` covers only `/api/mcp` and `/api/clusters`. Core route mounting includes `/api/keys`, but `keys` is not an RBAC resource. See [packages/server/src/middleware/rbac.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/middleware/rbac.ts:41), [packages/server/src/middleware/rbac.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/middleware/rbac.ts:100), [packages/server/src/middleware/rbac.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/middleware/rbac.ts:172), and [packages/server/src/composition/core-routes.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/composition/core-routes.ts:35).

Remediation: Move from permissive "unknown route means allow" to an explicit route authorization matrix. At minimum, classify all mounted `/api/*` prefixes and require admin/operator roles for management and mutation surfaces. Add negative tests proving viewer/agent/user roles cannot mutate keys, registry entries, schedules, prompts, memory, MCP, clusters, and compile state.

### SECURITY-003: Metadata-controlled HTTP tool base URL enables SSRF when the HTTP connector is enabled

Severity: high

Impact: A run that activates the `http_request` tool can set `metadata.httpBaseUrl` to internal services such as cloud metadata endpoints, localhost admin ports, or private network APIs. The connector prevents per-call origin escape, but it trusts the initial base origin, so the attacker-controlled base still determines the target network location.

Evidence: `resolveAgentTools` accepts `context.metadata.httpBaseUrl` before falling back to `DZIP_HTTP_BASE_URL`, passes it directly to `createHTTPConnector`, and the connector only checks that the tool call path stays on the configured origin. The run executor passes run metadata into tool resolution. See [packages/server/src/runtime/tool-resolver.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/tool-resolver.ts:639), [packages/connectors/src/http/http-connector.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/connectors/src/http/http-connector.ts:40), and [packages/server/src/runtime/dzip-agent-run-executor.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/dzip-agent-run-executor.ts:97).

Remediation: Do not accept `httpBaseUrl` from run metadata by default. Require host-configured allowlists for HTTP connector origins, reject private/link-local/loopback targets unless explicitly allowed, and bind sensitive headers to configured origins rather than run metadata. Add SSRF tests for `169.254.169.254`, `127.0.0.1`, `localhost`, RFC1918 ranges, and IPv6 loopback.

### SECURITY-004: Metadata-controlled Git working directory can expose or mutate arbitrary local repositories

Severity: high

Impact: Agents with Git tools can be pointed at any local path supplied in run metadata. If a caller can submit a run for an agent that has `git_commit` or branch tools enabled, the tool layer may read diffs/logs from unrelated repositories or stage and commit files outside the intended workspace.

Evidence: `resolveAgentTools` reads `context.metadata.cwd` and passes it to `new GitExecutor({ cwd })`. `GitExecutor` resolves but does not confine that path to an approved workspace root. Git tools include mutating operations such as `git_commit` with `addAll` and branch switching. See [packages/server/src/runtime/tool-resolver.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/tool-resolver.ts:550), [packages/codegen/src/git/git-executor.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/git/git-executor.ts:53), and [packages/codegen/src/git/git-tools.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/git/git-tools.ts:109).

Remediation: Treat workspace root as a trusted server-side run context, not caller-controlled metadata. Add an allowed workspace root policy, reject absolute paths outside that root, and split read-only Git tools from mutating Git tools so mutation requires an explicit elevated capability.

### SECURITY-005: LocalWorkspace allows absolute paths and `..` traversal for workspace-backed file tools

Severity: high

Impact: Workspace-backed `write_file` and `edit_file` can read or write outside the configured project root if given an absolute path or traversal path. In any flow that exposes `LocalWorkspace` to agent tools, prompt-injected or attacker-supplied tool calls could overwrite files outside the intended workspace boundary.

Evidence: `LocalWorkspace.resolvePath` returns absolute paths unchanged and otherwise resolves relative paths without checking that the result stays under `rootDir`. `write_file` and `edit_file` call `context.workspace.writeFile/readFile` directly. A safer implementation already exists in `DiskWorkspaceFS.resolveSafe`, which demonstrates the intended confinement check. See [packages/codegen/src/workspace/local-workspace.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/workspace/local-workspace.ts:106), [packages/codegen/src/tools/write-file.tool.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/tools/write-file.tool.ts:12), [packages/codegen/src/tools/edit-file.tool.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/tools/edit-file.tool.ts:53), and [packages/codegen/src/vfs/workspace-fs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/vfs/workspace-fs.ts:108).

Remediation: Reuse the `DiskWorkspaceFS` confinement pattern in `LocalWorkspace`: resolve every path against `rootDir`, reject absolute paths outside the root, reject traversal escapes, and add tests for `../`, absolute `/tmp/...`, sibling-prefix paths, reads, writes, and command cwd.

### SECURITY-006: Prometheus metrics are mounted without app-level authentication

Severity: medium

Impact: `/metrics` can expose operational details such as route names, status distribution, request volume, error paths, and timing. In production this can aid reconnaissance and leak tenant or workflow activity patterns if ingress does not block it.

Evidence: `mountPrometheusMetricsRoute` mounts `/metrics` on the public Hono app whenever a `PrometheusMetricsCollector` is configured. The code comment states that it bypasses auth and expects ingress/load-balancer blocking. See [packages/server/src/composition/optional-routes.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/composition/optional-routes.ts:279).

Remediation: Provide an app-level protection option for `/metrics`: bind it to an internal listener, require a metrics token, or enforce an IP allowlist before route dispatch. Keep ingress controls as defense in depth rather than the only visible control.

### SECURITY-007: HTTP and MCP tool credentials can be supplied through run metadata

Severity: medium

Impact: Secrets passed in run metadata can be persisted in run records, logs, traces, or event streams before reaching connector code. That creates a credential-retention and accidental-disclosure risk, especially for `githubToken`, `slackToken`, `httpHeaders`, and MCP `headers`/`env`.

Evidence: Tool resolution reads `metadata.githubToken`, `metadata.slackToken`, `metadata.httpHeaders`, and `metadata.mcpServers[*].headers/env`. Run creation persists request metadata on the run before queue execution, while the executor also logs activated tool warnings and tool-call data. MCP management responses redact registered server secrets, but metadata-defined tool credentials do not get equivalent route-boundary redaction before persistence. See [packages/server/src/runtime/tool-resolver.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/tool-resolver.ts:592), [packages/server/src/runtime/tool-resolver.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/tool-resolver.ts:617), [packages/server/src/runtime/tool-resolver.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/tool-resolver.ts:648), [packages/server/src/runtime/tool-resolver.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/tool-resolver.ts:336), and [packages/server/src/routes/runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:273).

Remediation: Remove secret-bearing connector configuration from run metadata. Resolve credentials server-side from named secret references, redact or reject sensitive metadata keys at run creation, and add trace/log redaction for tool inputs and run metadata.

## Scope Reviewed

Reviewed the prepared repo snapshot first: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-27/run-001/codex-prep/context/repo-snapshot.md`.

Selective current-code review covered:

- Server composition, auth, RBAC, tenant helpers, metrics mounting, OpenAI-compatible auth, and core route mounting under `packages/server/src`.
- API-key persistence and management routes.
- Run creation, queued execution, input guard wiring, tool resolution, MCP routes, and MCP client execution.
- Codegen workspace and Git tool execution boundaries.
- Connector HTTP request behavior and dependency/security CI markers.

Excluded generated output, dependency folders, coverage, `out`, and old audit artifacts. No runtime validation or dependency audit command was run for this document.

## Strengths

- OpenAI-compatible `/v1/*` auth is fail-closed unless explicitly disabled.
- MCP management responses redact `env` and sensitive headers before returning server definitions.
- MCP stdio registration through the management route is allowlist-gated.
- The queued run worker applies an input guard by default and persists redacted input when PII redaction fires.
- API keys are generated with `randomBytes(32)` and only SHA-256 hashes are stored.
- Dependency audit, secret scanning, and SAST jobs are present in `.github/workflows/security.yml`.
- `DiskWorkspaceFS` already has a root-confinement pattern that can be reused for `LocalWorkspace`.

## Open Questions Or Assumptions

- I treated `ForgeServerConfig.auth` as enabled for production deployments, but the framework still allows auth omission or `mode: 'none'` for hosts.
- I did not verify deployed ingress, reverse proxy, network policy, or whether `/metrics` is externally reachable in any environment.
- I did not run `yarn audit`; dependency risk was reviewed only from scripts and CI posture, not current advisory output.
- The tool-execution findings assume untrusted or lower-privilege users can create runs for agents with HTTP/Git/MCP-capable tools. If consuming apps enforce stricter app-level policy before run creation, exploitability is reduced but the framework primitive remains unsafe by default.

## Recommended Next Actions

1. Fix `SECURITY-001` first with scoped API-key store methods and route tests for cross-owner/cross-tenant revoke and rotate.
2. Replace route-prefix inference RBAC with an explicit authorization matrix for every mounted `/api/*` and `/v1/*` surface.
3. Lock down tool configuration: move credentials and target origins out of run metadata, add SSRF host/IP controls, and require trusted workspace roots for Git tools.
4. Apply `DiskWorkspaceFS` path confinement semantics to `LocalWorkspace` and add traversal tests for read, write, edit, search, and command cwd.
5. Add app-level protection for `/metrics` so production safety does not rely only on external ingress configuration.
6. Run and capture `yarn audit --level moderate` or the CI security workflow separately before synthesizing dependency status.

## Finding Manifest

```json
{
  "domain": "security",
  "counts": { "critical": 0, "high": 5, "medium": 2, "low": 0, "info": 0 },
  "findings": [
    { "id": "SECURITY-001", "severity": "high", "title": "API key revoke and rotate endpoints are not owner- or tenant-scoped", "file": "packages/server/src/routes/api-keys.ts" },
    { "id": "SECURITY-002", "severity": "high", "title": "RBAC only protects a small route vocabulary and lets many authenticated API routes pass through unclassified", "file": "packages/server/src/middleware/rbac.ts" },
    { "id": "SECURITY-003", "severity": "high", "title": "Metadata-controlled HTTP tool base URL enables SSRF when the HTTP connector is enabled", "file": "packages/server/src/runtime/tool-resolver.ts" },
    { "id": "SECURITY-004", "severity": "high", "title": "Metadata-controlled Git working directory can expose or mutate arbitrary local repositories", "file": "packages/server/src/runtime/tool-resolver.ts" },
    { "id": "SECURITY-005", "severity": "high", "title": "LocalWorkspace allows absolute paths and traversal for workspace-backed file tools", "file": "packages/codegen/src/workspace/local-workspace.ts" },
    { "id": "SECURITY-006", "severity": "medium", "title": "Prometheus metrics are mounted without app-level authentication", "file": "packages/server/src/composition/optional-routes.ts" },
    { "id": "SECURITY-007", "severity": "medium", "title": "HTTP and MCP tool credentials can be supplied through run metadata", "file": "packages/server/src/runtime/tool-resolver.ts" }
  ]
}
```
