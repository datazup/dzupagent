import { describe, it, expect } from "vitest";
// Import the entire schema module so we can iterate over every exported table.
import * as schema from "../persistence/drizzle-schema.js";

/**
 * Tables that are intentionally tenant-agnostic or inherit scope from a parent.
 * Any new table added here must justify its exemption in a comment.
 */
const TENANT_EXEMPT = new Set([
  "forgeVectors", // embedding store — shared across tenants by design
  "clusterRoles", // child of agentClusters (inherits tenant via cluster_id FK)
  "traceSteps", // child of runTraces (inherits tenant via run_id FK)
  "a2aTaskMessages", // child of a2aTasks (inherits tenant via task_id FK)
  "flowNodeAdapterMeta", // run_id scopes to tenant via forge_runs.tenant_id; no redundant column
]);

describe("schema tenant conformance", () => {
  it("every non-exempt pgTable has a tenantId column", () => {
    for (const [exportName, table] of Object.entries(schema)) {
      // Drizzle pgTable instances carry an internal config under the `_`
      // property; this reliably distinguishes them from type exports,
      // helper functions, and other non-table exports.
      if (typeof table !== "object" || table === null || !("_" in table))
        continue;
      // Skip tables that are intentionally exempt from tenant scoping.
      if (TENANT_EXEMPT.has(exportName)) continue;

      // Drizzle exposes each column as a direct property on the table object,
      // so a present `tenantId` column means `table.tenantId` is defined.
      expect(
        table,
        `Table "${exportName}" is missing tenantId — add it or add it to TENANT_EXEMPT`
      ).toHaveProperty("tenantId");
    }
  });
});
