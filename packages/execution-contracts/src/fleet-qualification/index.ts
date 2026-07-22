/**
 * X4 Fleet qualification receipt types and factory functions.
 *
 * Seals sanitized evidence for multi-worker cancellation isolation,
 * worker restart attribution (fencing tokens), batch concurrency,
 * cross-worker egress audit, and the final fleet-qualification summary.
 *
 * Rules:
 *  - No raw URLs, credentials, local paths, or command payloads in any receipt.
 *  - All receipts are sealed with SHA-256 of canonical JSON (excluding the seal field).
 *  - Schema versions follow the `datazup.<name>/v1` pattern.
 *
 * This module is a barrel that re-exports the focused leaf modules. The public
 * surface is identical to the original single-file module.
 */

export type { FleetEgressAuditEntry } from "./_seal.js";
export * from "./cancellation.js";
export * from "./takeover.js";
export * from "./batch.js";
export * from "./egress-audit.js";
export * from "./summary.js";
export * from "./gateway-correlation.js";
