/**
 * `fanout_template` — v1 (template-only) batch fan-out tool
 * (dynamic-subagents Spec 01). This module is a thin barrel that preserves the
 * public `../tools/fanout-tool.js` import surface; the implementation lives in
 * focused leaf modules under `./fanout/`:
 *
 *   - `fanout/types.ts`                    — contract shapes + type guards
 *   - `fanout/helpers.ts`                  — pure placeholder/cap/budget helpers
 *   - `fanout/schema.ts`                   — static tool name/description/params
 *   - `fanout/create-fanout-template-tool.ts` — the coordinator descriptor
 *   - `fanout/record-to-report.ts`         — durable-ledger → report rebuild
 *
 * Script mode (`fanout_script`) is deliberately NOT implemented here — it is a
 * later, flag-gated track (decision OQ1) that must never make this package
 * depend on a sandbox implementation (NFR3).
 */

export {
  DEFAULT_FANOUT_LIMITS,
  isFanoutValidationError,
  type FanoutItem,
  type FanoutItemStatus,
  type FanoutLimits,
  type FanoutReport,
  type FanoutReportItem,
  type FanoutTemplateArgs,
  type FanoutToolConfig,
  type FanoutValidationError,
} from "./fanout/types.js";
export { createFanoutTemplateTool } from "./fanout/create-fanout-template-tool.js";
export { fanoutBatchRecordToReport } from "./fanout/record-to-report.js";
