# Task 09 — Harden OpenAI-compat auth default

## Files changed
- `packages/server/src/routes/openai-compat/auth-middleware.ts`

## Problem
The previous middleware accepted any non-empty Bearer token when
`config.validateKey` was omitted, even if `config.enabled` was not
`false`. This silent dev-mode fall-through made it possible to deploy
an open OpenAI-compatible endpoint by forgetting to configure a
validator.

## Fix
Dev-mode now requires an **explicit opt-in**. The middleware only
passes through without authenticating when `config.enabled === false`.
When `validateKey` is absent and `enabled !== false`, the request is
rejected with a 401 in OpenAI's error format.

## Before
```ts
// Delegate to custom validator if provided
if (config?.validateKey) {
  const keyMeta = await config.validateKey(token)
  if (!keyMeta) {
    return c.json(
      errorResponse('Incorrect API key provided. …', 'invalid_api_key'),
      401,
    )
  }
  c.set('apiKey' as never, keyMeta as never)
}

// Dev mode: non-empty token accepted without further validation

return next()
```

Effective behaviour:
| enabled | validateKey | Token present | Result  |
|---------|-------------|---------------|---------|
| unset   | unset       | any           | **200** (silent dev mode) |
| unset   | set         | valid         | 200     |
| unset   | set         | invalid       | 401     |
| false   | *           | *             | 200     |

## After
```ts
if (config?.validateKey) {
  const keyMeta = await config.validateKey(token)
  if (!keyMeta) {
    return c.json(errorResponse('Incorrect API key provided. …', 'invalid_api_key'), 401)
  }
  c.set('apiKey' as never, keyMeta as never)
  return next()
}

// Secure-by-default: when no validator is configured and auth was not
// explicitly disabled, reject the request.
return c.json(
  errorResponse('API key authentication is not configured on this server.', 'invalid_api_key'),
  401,
)
```

The early `if (config?.enabled === false) return next()` branch at the
top of the middleware remains untouched — that is the single, explicit
disable path.

Effective behaviour:
| enabled | validateKey | Token present | Result  |
|---------|-------------|---------------|---------|
| unset   | unset       | any           | **401** |
| unset   | set         | valid         | 200     |
| unset   | set         | invalid       | 401     |
| false   | *           | *             | 200 (explicit dev bypass) |

## Docstring changes
Updated the module-level JSDoc and the `OpenAIAuthConfig` interface docs
so that the two supported modes (Delegate + explicit Disable) are
described accurately and so that callers know they must either provide a
`validateKey` or set `enabled: false` to obtain pass-through behaviour.

## Validation
```
cd packages/server && yarn typecheck
Done in 40.84s.
```
Zero errors.
