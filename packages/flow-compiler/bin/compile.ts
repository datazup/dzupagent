#!/usr/bin/env node
/**
 * dzupagent-compile — CLI wrapper around `createFlowCompiler`.
 *
 * Reads a flow definition from `--input <path>` or from stdin (when `--input`
 * is omitted), runs the four-stage compile pipeline
 * with `forwardInnerEvents: true`, and streams every emitted
 * `flow:compile_*` lifecycle event to stdout as newline-delimited JSON
 * (NDJSON). The final line carries either the compiled artifact
 * (`{ type: 'result', ... }`) on success or an error envelope
 * (`{ type: 'error', ... }`) on failure.
 *
 * Exit codes: 0 on successful compile, 1 on any compile/parse/argument error
 * or unhandled exception.
 *
 * Consumers (e.g. the playground `/compile` route, editor integrations, test
 * harnesses) spawn this binary, pipe the flow JSON on stdin, and parse each
 * stdout line to drive a progress UI.
 */
import { readFile } from 'node:fs/promises'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent } from '@dzupagent/core'
import type { ToolResolver } from '@dzupagent/flow-ast'
import { compileTextInput, createFlowCompiler } from '../src/index.js'

type FlowCompileEvent = Extract<
  DzupEvent,
  {
    type:
      | 'flow:compile_started'
      | 'flow:compile_parsed'
      | 'flow:compile_shape_validated'
      | 'flow:compile_semantic_resolved'
      | 'flow:compile_lowered'
      | 'flow:compile_completed'
      | 'flow:compile_failed'
  }
>

const FLOW_COMPILE_EVENT_TYPES: ReadonlySet<FlowCompileEvent['type']> = new Set<
  FlowCompileEvent['type']
>([
  'flow:compile_started',
  'flow:compile_parsed',
  'flow:compile_shape_validated',
  'flow:compile_semantic_resolved',
  'flow:compile_lowered',
  'flow:compile_completed',
  'flow:compile_failed',
])

interface CliArgs {
  input?: string
  help: boolean
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
    } else if (arg === '--input' || arg === '-i') {
      const next = argv[i + 1]
      if (next === undefined) {
        throw new Error('--input requires a path argument')
      }
      out.input = next
      i++
    } else if (typeof arg === 'string' && arg.startsWith('--input=')) {
      out.input = arg.slice('--input='.length)
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`)
    }
  }
  return out
}

function usage(): string {
  return [
    'Usage: dzupagent-compile [--input <path>]',
    '',
    'Reads a flow-definition (FlowNode JSON, FlowDocument JSON, or dzupflow DSL) from <path> or stdin and streams',
    'flow:compile_* lifecycle events as newline-delimited JSON on stdout.',
    '',
    'Exit 0 on success, 1 on error.',
  ].join('\n')
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

// Permissive no-op resolver. The CLI is framework-agnostic; any ref that
// requires a real domain catalog will surface as a stage-3 error — exactly as
// the HTTP /compile route behaves when no resolver is wired.
const NOOP_TOOL_RESOLVER: ToolResolver = {
  resolve: () => null,
  listAvailable: () => [],
}

async function main(): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    writeLine({ type: 'error', phase: 'args', message: (err as Error).message })
    process.stderr.write(`${usage()}\n`)
    return 1
  }

  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }

  let rawInput: string
  try {
    rawInput = args.input !== undefined
      ? await readFile(args.input, 'utf8')
      : await readStdin()
  } catch (err) {
    writeLine({ type: 'error', phase: 'read', message: (err as Error).message })
    return 1
  }

  const trimmed = rawInput.trim()
  if (trimmed.length === 0) {
    writeLine({ type: 'error', phase: 'read', message: 'Empty input' })
    return 1
  }

  const bus = createEventBus()
  const compiler = createFlowCompiler({
    toolResolver: NOOP_TOOL_RESOLVER,
    eventBus: bus,
    forwardInnerEvents: true,
  })

  const unsubscribe = bus.onAny((event: DzupEvent) => {
    if (FLOW_COMPILE_EVENT_TYPES.has(event.type as FlowCompileEvent['type'])) {
      writeLine(event)
    }
  })

  try {
    const result = await compileTextInput(compiler, trimmed)
    if ('errors' in result) {
      writeLine({
        type: 'error',
        phase: 'compile',
        compileId: result.compileId,
        errors: result.errors,
      })
      return 1
    }
    writeLine({
      type: 'result',
      compileId: result.compileId,
      target: result.target,
      artifact: result.artifact,
      warnings: result.warnings,
      reasons: result.reasons,
    })
    return 0
  } catch (err) {
    writeLine({
      type: 'error',
      phase: 'compile',
      message: (err as Error).message ?? String(err),
    })
    return 1
  } finally {
    unsubscribe()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    // Last-resort safety net — main() is already wrapped in try/catch.
    writeLine({
      type: 'error',
      phase: 'fatal',
      message: err instanceof Error ? err.message : String(err),
    })
    process.exitCode = 1
  })
