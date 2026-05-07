/**
 * @dzupagent/core/tools — Tool factory, permission tiers, governance, stats,
 * connector contract, and human-in-the-loop contact types.
 *
 * @example
 * ```ts
 * import {
 *   createForgeTool,
 *   ToolGovernance,
 *   ToolStatsTracker,
 * } from '@dzupagent/core/tools'
 * ```
 */

// ---------------------------------------------------------------------------
// Connector contract
// ---------------------------------------------------------------------------
export type {
  BaseConnectorTool,
  BaseConnectorToolLike,
} from './tools/connector-contract.js'
export {
  isBaseConnectorTool,
  normalizeBaseConnectorTool,
  normalizeBaseConnectorTools,
} from './tools/connector-contract.js'

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------
export { createForgeTool } from './tools/create-tool.js'
export type { ForgeToolConfig } from './tools/create-tool.js'

// ---------------------------------------------------------------------------
// Permission tiers
// ---------------------------------------------------------------------------
export { tierSatisfies } from './tools/permission-tier.js'
export type { PermissionTier } from './tools/permission-tier.js'

// ---------------------------------------------------------------------------
// Tool stats tracking
// ---------------------------------------------------------------------------
export { ToolStatsTracker } from './tools/tool-stats-tracker.js'
export type {
  ToolCallRecord,
  ToolStats,
  ToolRanking,
  ToolStatsTrackerConfig,
} from './tools/tool-stats-tracker.js'

// ---------------------------------------------------------------------------
// Tool governance
// ---------------------------------------------------------------------------
export { ToolGovernance } from './tools/tool-governance.js'
export type {
  ToolGovernanceConfig,
  ToolValidationResult,
  ToolAuditHandler,
  ToolAuditEntry,
  ToolResultAuditEntry,
  ToolResultAuditMetadata,
  ToolResultAuditRetention,
  ToolAccessResult,
} from './tools/tool-governance.js'

// ---------------------------------------------------------------------------
// Human contact (human-in-the-loop)
// ---------------------------------------------------------------------------
export type {
  ContactType,
  ContactChannel,
  ApprovalRequest,
  ClarificationRequest,
  InputRequest,
  EscalationRequest,
  GenericContactRequest,
  HumanContactRequest,
  ApprovalResponse,
  ClarificationResponse,
  InputResponse,
  EscalationResponse,
  TimeoutResponse,
  LateResponse,
  GenericContactResponse,
  HumanContactResponse,
  PendingHumanContact,
} from './tools/human-contact-types.js'
