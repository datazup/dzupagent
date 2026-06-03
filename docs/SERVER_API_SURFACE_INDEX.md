# Server API Surface Index

Date: 2026-06-03

Generated from `packages/server/src/index.ts` and `config/server-api-tiers.json`.

## Summary

- Unique export sources in root index: `30`
- Tier counts: stable=`30`, secondary=`0`, experimental=`0`, internal=`0`
- Recommended root exposure: keep-root=`30`, candidate-subpath=`0`, remove-root=`0`

## Current Direct Root Imports

No direct `@dzupagent/server` root imports found in scanned workspace code.

## Root Export Inventory

| Source Module | Tier | Area | Root Exposure | Export Count | Sample Exports |
| --- | --- | --- | --- | ---: | --- |
| `./app.js` | `stable` | `app` | `keep-root` | 12 | `createForgeApp`, `ForgeServerConfig`, `ForgeHostRuntimeConfig`, `ForgeRouteFamiliesConfig` |
| `./route-plugin.js` | `stable` | `extensibility` | `keep-root` | 2 | `ServerRoutePlugin`, `ServerRoutePluginContext` |
| `./routes/runs.js` | `stable` | `routes-core` | `keep-root` | 1 | `createRunRoutes` |
| `./routes/agents.js` | `stable` | `routes-core` | `keep-root` | 2 | `createAgentDefinitionRoutes`, `createAgentRoutes` |
| `./routes/approval.js` | `stable` | `routes-core` | `keep-root` | 1 | `createApprovalRoutes` |
| `./routes/health.js` | `stable` | `routes-core` | `keep-root` | 1 | `createHealthRoutes` |
| `./routes/events.js` | `stable` | `realtime` | `keep-root` | 2 | `createEventRoutes`, `EventRouteConfig` |
| `./middleware/auth.js` | `stable` | `middleware` | `keep-root` | 2 | `authMiddleware`, `AuthConfig` |
| `./middleware/rate-limiter.js` | `stable` | `middleware` | `keep-root` | 3 | `rateLimiterMiddleware`, `TokenBucketLimiter`, `RateLimiterConfig` |
| `./middleware/identity.js` | `stable` | `middleware` | `keep-root` | 4 | `identityMiddleware`, `getForgeIdentity`, `getForgeCapabilities`, `IdentityMiddlewareConfig` |
| `./middleware/capability-guard.js` | `stable` | `middleware` | `keep-root` | 1 | `capabilityGuard` |
| `./middleware/rbac.js` | `stable` | `middleware` | `keep-root` | 14 | `rbacMiddleware`, `rbacGuard`, `hasPermission`, `resolveRoutePermission` |
| `./middleware/tenant-scope.js` | `stable` | `middleware` | `keep-root` | 3 | `tenantScopeMiddleware`, `getTenantId`, `TenantScopeConfig` |
| `./queue/run-queue.js` | `stable` | `queue` | `keep-root` | 7 | `InMemoryRunQueue`, `RunQueue`, `RunJob`, `RunQueueConfig` |
| `./queue/bullmq-run-queue.js` | `stable` | `queue` | `keep-root` | 2 | `BullMQRunQueue`, `BullMQRunQueueConfig` |
| `./lifecycle/graceful-shutdown.js` | `stable` | `lifecycle` | `keep-root` | 3 | `GracefulShutdown`, `ShutdownConfig`, `ShutdownState` |
| `./ws/event-bridge.js` | `stable` | `realtime` | `keep-root` | 4 | `EventBridge`, `WSClient`, `ClientFilter`, `EventBridgeConfig` |
| `./ws/control-protocol.js` | `stable` | `realtime` | `keep-root` | 6 | `createWsControlHandler`, `WSControlClientMessage`, `WSControlServerMessage`, `WSControlHandlerOptions` |
| `./ws/authorization.js` | `stable` | `realtime` | `keep-root` | 3 | `createScopedAuthorizeFilter`, `WSClientScope`, `ScopedAuthorizeFilterOptions` |
| `./ws/scope-registry.js` | `stable` | `realtime` | `keep-root` | 1 | `WSClientScopeRegistry` |
| `./ws/scoped-control-handler.js` | `stable` | `realtime` | `keep-root` | 2 | `createScopedWsControlHandler`, `ScopedWsControlHandlerOptions` |
| `./ws/session-manager.js` | `stable` | `realtime` | `keep-root` | 2 | `WSSessionManager`, `WSSessionManagerOptions` |
| `./ws/node-adapter.js` | `stable` | `realtime` | `keep-root` | 3 | `attachNodeWsSession`, `NodeWSLike`, `AttachNodeWsSessionOptions` |
| `./ws/node-upgrade-handler.js` | `stable` | `realtime` | `keep-root` | 4 | `createNodeWsUpgradeHandler`, `createPathUpgradeGuard`, `NodeWebSocketServerLike`, `NodeWsUpgradeHandlerOptions` |
| `./events/event-gateway.js` | `stable` | `realtime` | `keep-root` | 8 | `InMemoryEventGateway`, `EventGateway`, `EventEnvelope`, `EventSubscription` |
| `./streaming/sse-streaming-adapter.js` | `stable` | `realtime` | `keep-root` | 3 | `streamRunHandleToSSE`, `SSEStreamLike`, `StreamRunHandleToSSEOptions` |
| `./platforms/lambda.js` | `stable` | `platforms` | `keep-root` | 1 | `toLambdaHandler` |
| `./platforms/vercel.js` | `stable` | `platforms` | `keep-root` | 1 | `toVercelHandler` |
| `./platforms/cloudflare.js` | `stable` | `platforms` | `keep-root` | 1 | `toCloudflareHandler` |
| `./security/input-guard.js` | `stable` | `security` | `keep-root` | 5 | `createInputGuard`, `DEFAULT_MAX_INPUT_LENGTH`, `InputGuard`, `InputGuardConfig` |

## Notes

- `stable` means keep in the root package unless a strong compatibility reason appears.
- `secondary` means supported, but a candidate for subpath exports to keep the root surface smaller.
- `experimental` means feature-rich or optional planes that should not silently define the default server contract.
- `internal` means the symbol source is currently exposed from the root index but should be treated as a root-surface leak and moved or hidden over time.

Regenerate with `yarn docs:server-api-surface`.
