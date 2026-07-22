/**
 * Security policy slice of {@link ForgeServerConfig}: safety monitor toggle,
 * per-key resource quotas, the input guard, and the compliance audit store.
 *
 * Split out of `composition/types.ts` so composition helpers can ask for the
 * narrow security slice without importing the full aggregate. Re-exported from
 * `composition/types.ts` to preserve every existing import path.
 */
import type { ComplianceAuditStore } from "@dzupagent/core/security";

import type { ResourceQuotaManager } from "../security/resource-quota.js";
import type { TenantRunQuota } from "../security/tenant-run-quota.js";
import type { InputGuardConfig } from "../security/input-guard.js";

/**
 * Security policy: safety monitor, quotas, input guard.
 *
 * @deprecated Internal composition building block for {@link ForgeServerConfig}
 * and {@link ForgeHostRuntimeConfig}. The standalone re-export through
 * `@dzupagent/server/app` is a legacy compatibility alias with zero workspace
 * consumers and is not part of the package-root public surface. Prefer the
 * aggregate `ForgeServerConfig` or `ForgeHostRuntimeConfig` types.
 */
export interface ForgeSecurityConfig {
  /** Skip attaching the built-in runtime safety monitor (default false). */
  disableSafetyMonitor?: boolean;
  /** Per-key resource quota manager (MC-S01). */
  resourceQuota?: ResourceQuotaManager;
  /** Per-tenant concurrent-run cap. When set, each run-creation request checks the tenant's active count. */
  tenantRunQuota?: TenantRunQuota;
  /** MC-S03 input guard configuration. Pass `false` to opt out. */
  security?: {
    inputGuard?: InputGuardConfig | false;
  };
  /**
   * RF-36: Compliance audit store. When provided, a ComplianceAuditLogger is
   * attached to the event bus and all security-relevant events are recorded.
   * Use PostgresAuditStore for durable audit trails in production.
   */
  auditStore?: ComplianceAuditStore;
}
