# Task 20 — CORS warning for wildcard origins

## Files changed
- `packages/server/src/app.ts`

## Placement
The warning is emitted **immediately after** the CORS middleware is
registered on `app.use('*', cors(...))`, so the warning fires once per
`createForgeApp()` invocation at startup, not per request.

## Code
```ts
app.use('*', cors({
  origin: config.corsOrigins ?? '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Warn operators when CORS is left wide open. We keep the permissive
// default for backwards compatibility but flag it so production
// deployments set an explicit allow-list via `corsOrigins`.
const corsValue = config.corsOrigins ?? '*'
if (corsValue === '*' || !config.corsOrigins) {
  console.warn(
    '[ForgeServer] WARNING: CORS is open to all origins (*). Set corsOrigins in ForgeServerConfig for production deployments.',
  )
}
```

## Backward compatibility
The default `origin: '*'` fallback on the `cors()` call is unchanged.
Only the `console.warn` is added. Existing deployments that rely on the
wildcard continue to behave identically at runtime; they merely receive
one startup warning.

## Trigger conditions
The warning fires when either:
1. `config.corsOrigins` is `undefined` — default fallback used.
2. `config.corsOrigins === '*'` — explicit wildcard.

Any other value (string or array of origins) suppresses the warning.

## Validation
Placement confirmed: the `console.warn` block appears at
`packages/server/src/app.ts` directly below the `app.use('*', cors(...))`
call, before the auth and rate-limit middleware registrations.
`yarn typecheck` on the server package succeeds (see sibling task
VALIDATION.md files for the full typecheck output).
