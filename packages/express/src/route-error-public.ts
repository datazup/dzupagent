/**
 * Subpath entry: `@dzupagent/express/route-error`.
 *
 * The route-error sanitisation chokepoint (DZUPAGENT-ERR-C-04 / SEC-M-14) is
 * public API, but it is consumed by hosts that mount their own routes rather
 * than by every importer of the package root. Per the barrel-budgets ratchet
 * (config/barrel-budgets.json), new public API lands on a documented subpath
 * export instead of widening the growth-frozen root barrel.
 *
 * This module is the entry point only — the implementation stays in
 * ./route-error.ts so the package-internal importers (agent-router, mcp-router,
 * sse-handler) keep their direct relative import and gain no indirection.
 */

export {
  ClientSafeError,
  GENERIC_ERROR_CODE,
  GENERIC_ERROR_MESSAGE,
  isClientSafeError,
  routeError,
  sanitizeError,
  toError,
} from "./route-error.js";
export type { RouteErrorContext, SanitizedError } from "./route-error.js";
