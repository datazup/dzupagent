/**
 * Pipeline artifact contract — the persisted pipeline definition the flow
 * compiler emits and the agent runtime executes: hand-written types plus the
 * zod schemas pinned to them.
 *
 * @module pipeline-artifact
 */

export * from "./definition.js";
export * from "./schema.js";
