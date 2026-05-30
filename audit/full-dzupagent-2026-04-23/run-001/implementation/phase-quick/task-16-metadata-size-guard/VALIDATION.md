# Task 16 — Add metadata size guard on run creation

## Files changed
- `packages/server/src/routes/runs.ts`

## Change
Inside the `POST /api/runs` handler, immediately after the `agentId`
validation and **before** any call to `runStore.create` or the queue,
a size guard rejects metadata payloads larger than 64 KB:

```ts
if (body.metadata && JSON.stringify(body.metadata).length > 65_536) {
  return c.json(
    { error: { code: 'VALIDATION_ERROR', message: 'metadata too large (max 64 KB)' } },
    400,
  )
}
```

The guard runs before:
- the cost-aware router classification (which would otherwise read the
  metadata),
- `injectTraceContext`,
- `runStore.create(...)`,
- `runQueue.enqueue(...)`.

So oversized payloads never reach persistence or the queue.

## Error shape
We reuse the server's `VALIDATION_ERROR` code / response shape rather
than the bare `{ error: 'metadata too large (max 64 KB)' }` sketched in
the task brief, because every other validation response in this route
(`agentId is required`, `NOT_FOUND`, `INVALID_STATE`, …) uses the
`{ error: { code, message } }` envelope. Staying consistent keeps the
server contract predictable for clients.

## Limit rationale
64 KB (`65_536` bytes, measured on the JSON-serialised form) comfortably
fits normal routing hints, trace context, a couple of user-supplied
tags, and resume checkpoints while making it easy to detect
misbehaving or malicious clients trying to bloat run rows.

## Validation
```
cd packages/server && yarn typecheck
Done in 40.84s.
```
Zero errors.
