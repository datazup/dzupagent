# ADR-0008: RequestScope Workspace Isolation

## Status

Accepted — 2026-05-08

## Context

The Codev API memory promotions surface (`apps/codev-app/apps/api/src/routes/memory.routes.ts`)
exposes two enforcement gaps that were documented in
`apps/codev-app/apps/api/src/__tests__/memory-cross-workspace.test.ts` but not closed:

- **LIST cross-workspace gap.** `GET /memory` reads `workspaceId` from
  `req.query.workspaceId` and passes it directly to the service. The service
  filters by `req.user.tenantId` AND the supplied `workspaceId`, so the
  cross-tenant boundary is intact. However, within the same tenant any caller
  can pass any workspace identifier and read that workspace's memories.

- **WRITE cross-workspace gap.** `POST /memory` reads `workspaceId` from
  `req.body.workspaceId`. The service has a partial guard for the
  `cross_project` scope (it blocks promotions when the referenced project
  belongs to a different workspace within the same tenant), but no guard
  exists for the broader case: a caller can promote `scope: 'workspace'` or
  `scope: 'project'` memories into a foreign workspace by forging the body
  field.

The root cause is that Codev's authentication contract binds users to a
tenant only. There is no first-class `WorkspaceMembership` model, so the
auth middleware cannot answer the question "is this user a member of this
workspace?" without an extra database lookup that the route handlers do
not currently perform.

The cross-workspace data boundary is documented in `CLAUDE.md` for Codev:

> Memory: scoped to task/subtask, project, and cross-project reuse inside
> a workspace; never cross-workspace.

This ADR establishes the contract that closes the gap.

## Decision

1. **Add a `WorkspaceMembership` Prisma model.** It links users to
   workspaces with a role and carries a denormalised `tenantId` for
   tenant-scoped index lookups. The model is owned by Codev (the consuming
   application), not by any framework package.

2. **Extend the request scope.** All workspace-scoped HTTP handlers must
   resolve the active workspace from the authenticated session, not from
   query strings or request bodies. The intermediate step in this ADR is a
   reusable guard — `assertWorkspaceMembership(userId, workspaceId, tenantId)`
   — that throws a 403 when the caller is not a member.

3. **Memory route enforcement.**
   - `GET /memory` continues to accept `workspaceId` as a query argument
     for now (clients pass it explicitly because users may belong to many
     workspaces), but the route MUST call `assertWorkspaceMembership` before
     forwarding to the service. Cross-workspace LIST is rejected with 403.
   - `POST /memory` continues to accept `workspaceId` in the body but MUST
     call `assertWorkspaceMembership` before forwarding. Cross-workspace
     WRITE is rejected with 403.
   - `POST /memory/:id/revoke` continues to enforce tenancy through the
     service layer (404 mask for cross-tenant). Membership is implied by
     the existence of the promotion in the user's tenant; no additional
     check is required at this stage.

4. **Migration default.** The Prisma migration backfills membership rows
   for every existing `(user, workspace)` pair where the workspace's
   `tenantId` matches the user's `tenantId`. This preserves the current
   behaviour for existing installations: today every user can read every
   workspace in their tenant, and after the migration that remains true
   until administrators tighten memberships.

5. **Future extensions (out of scope for this ADR).**
   - Embedding the user's `workspaceIds` in the JWT access token, so the
     guard becomes O(1) instead of a database lookup.
   - Membership-aware `WorkspaceRole` enum with elevated permissions
     (`owner` / `admin` / `member` / `viewer`).
   - A request-scoped `RequestScope` object on `req.scope` consolidating
     `tenantId`, `workspaceId`, `projectId`, and role for downstream
     handlers.

## Consequences

### Positive

- Closes the cross-workspace LIST and WRITE gaps documented in
  `memory-cross-workspace.test.ts`.
- Establishes a reusable `WorkspaceMembership` primitive that future
  workspace-scoped routes (projects, tasks, repositories, runs) can rely
  on.
- The guard utility is small, testable, and free of HTTP coupling — it
  throws a typed error, which the route handlers translate to 403.
- Migration default preserves existing behaviour, so the change is not
  user-visible until administrators tighten memberships.

### Negative / Trade-offs

- Each workspace-scoped request now performs a `WorkspaceMembership`
  lookup. The lookup is keyed on the unique `(userId, workspaceId)` index
  and is `O(log n)` on the membership table. A future optimisation
  embeds the membership set in the JWT to remove the round-trip.
- The migration backfills memberships for every existing
  `(user, workspace)` pair. For large installations the migration is
  `O(users × workspaces)` and must run inside a transaction.
- This is a **breaking change for any caller that relied on the
  documented contract** that "cross-workspace within tenant is
  caller-supplied" (see `memory-cross-workspace.test.ts` lines 186–197 and
  330–347). Callers that were exploiting that gap will now receive 403.

### Risks

- A buggy migration that fails to backfill membership rows would lock
  every user out of every workspace. Mitigation: the migration is
  idempotent (`ON CONFLICT DO NOTHING`) and its row count is asserted in
  the migration test.
- Workspace deletion now cascades to memberships. Mitigation: the schema
  uses `onDelete: Cascade` on both `userId` and `workspaceId` foreign
  keys.

## Constraints

- Must not introduce a `core` → `agent`/`codegen` framework boundary
  violation. The change lives entirely in `apps/codev-app` and does not
  touch any `dzupagent/packages/*` package.
- Must compile under TypeScript strict mode with no `any`.
- Must work against both the local Postgres development database and the
  in-memory fixture-driven test database (Prisma client + Vitest mocks).
- Must preserve the existing 401 / 403 / 404 contract documented in the
  memory-cross-workspace tests (the cross-tenant 404 mask in particular
  must remain).

## Alternatives Considered

1. **Encode `workspaceIds` directly in the JWT.** Faster, but a
   user added to a new workspace would not see it until their token
   refreshes, and revoking access would require a token-revocation
   round-trip. We will revisit this once the access-token TTL is
   short enough to make refresh-on-change tolerable.
2. **Validate via an existing `Account` membership.** Codev already
   has accounts (parent groupings of workspaces) and team memberships,
   but neither maps cleanly to "this user can read this workspace".
   Modelling membership explicitly is clearer and matches the language
   in `CLAUDE.md`.
3. **Block cross-workspace at the service layer only.** Reusable across
   transports, but the service does not have access to the authenticated
   user identity today. Surfacing it would require threading `userId`
   into every service call. The route-level guard keeps the service
   contract narrow.
