// Thin composition root for the Stage-3 semantic walk. The two independent
// passes that previously lived fused in this file are now cohesive leaf
// modules under ./semantic-walk/:
//   • dispatch.ts            — recursive AST traversal that dispatches each
//                              node variant to its resolver/validator sub-pass
//                              (plus the for_each scalar-export check).
//   • checkpoint-restore.ts  — the separate two-pass checkpoint/restore
//                              cross-node validator.
//   • terminality.ts         — the DSL-03 terminal-continuation validator
//                              (unreachable siblings after `complete`).
// Public surface (visit, validateCheckpointRestore, ...) is unchanged;
// consumers keep importing from "./semantic-walk.js".
export { visit } from "./semantic-walk/dispatch.js";
export { validateCheckpointRestore } from "./semantic-walk/checkpoint-restore.js";
export { validateTerminalContinuations } from "./semantic-walk/terminality.js";
