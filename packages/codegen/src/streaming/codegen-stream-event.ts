/**
 * Stream event types emitted by the codegen pipeline.
 *
 * Each event is tagged with a discriminant `type` field so consumers
 * can narrow with a simple switch/if check.
 */

export type CodegenStreamEvent =
  | { type: 'codegen:file_patch'; filePath: string; patch: string }
  | { type: 'codegen:test_result'; passed: boolean; output: string; testFile?: string }
  | { type: 'codegen:pipeline_step'; step: string; status: 'started' | 'completed' | 'failed'; durationMs?: number }
  | { type: 'codegen:done'; summary: string; filesChanged: string[] }
  | { type: 'codegen:error'; message: string; step?: string }
