/**
 * Shared leaf error (ARCH27-T-10): thrown by lifecycle resume validation and
 * by executor-internals stage dispatch, so it lives below both to keep the
 * directory graph acyclic.
 */

/** A resume was rejected because its checkpoint binds to a different artifact. */
export class PipelineSourceBindingMismatchError extends Error {
  override readonly name = "PipelineSourceBindingMismatchError";
}
