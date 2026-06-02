/**
 * Governed Process-Tool-Call (PTC) LangChain tool.
 *
 * Wraps the QuickJS WASM sandbox with the full governance pipeline:
 *   1. Kill-switch / disabled check
 *   2. ToolGovernance.checkAccess (blocked-list → rate-limit → validator → approval-gate)
 *   3. Optional TypeScript transpilation via WasmTypeScriptTranspiler
 *   4. WasmSandbox.execute with resource limits inherited from the sandbox config
 *   5. ToolGovernance.auditResult on completion
 *
 * The tool name is `'ptc'` by default, matching the governance key so
 * operators configure it via the standard `ToolGovernanceConfig`:
 *   ```ts
 *   governance: { approvalRequired: ['ptc'], rateLimits: { ptc: 5 } }
 *   ```
 */

import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import { WasmSandbox } from '../wasm/wasm-sandbox.js'
import { WasmTypeScriptTranspiler } from '../wasm/ts-transpiler.js'
import type { WasmSandboxConfig } from '../wasm/wasm-sandbox.js'
import type { ToolGovernance } from '@dzupagent/core/tools'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { PtcGovernanceConfig } from './ptc-types.js'
import { checkPtcAccess, buildBlockedPtcResult } from './ptc-governance-adapter.js'

export interface CreatePtcToolOptions {
  /** Governance instance — required to enforce the access policy. */
  governance: ToolGovernance
  /** Event bus for `approval:requested` events. Optional but recommended. */
  eventBus?: DzupEventBus
  /** Durable run identifier forwarded as the approval correlation id. */
  runId?: string
  /** PTC-specific governance overrides. */
  ptcConfig?: PtcGovernanceConfig
  /** WASM sandbox resource limits and capability overrides. */
  sandboxConfig?: WasmSandboxConfig
}

const PtcInputSchema = z.object({
  code: z.string().describe('JavaScript or TypeScript source code to execute in the sandbox'),
  language: z
    .enum(['javascript', 'typescript'])
    .optional()
    .describe('Source language (default: javascript)'),
  reason: z
    .string()
    .optional()
    .describe('Human-readable intent — forwarded to the audit trail'),
})

/**
 * Create the governed PTC tool.
 *
 * The returned tool is a standard LangChain `StructuredToolInterface` and
 * can be passed directly to `runToolLoop`.  Every invocation is checked by
 * `ToolGovernance.checkAccess` before the sandbox executes.
 */
export function createPtcTool(options: CreatePtcToolOptions) {
  const sandbox = new WasmSandbox(options.sandboxConfig)
  const transpiler = new WasmTypeScriptTranspiler()
  const toolName = options.ptcConfig?.toolName ?? 'ptc'

  return tool(
    async ({ code, language = 'javascript', reason }) => {
      const decision = checkPtcAccess(
        { code, language, reason },
        {
          governance: options.governance,
          eventBus: options.eventBus,
          runId: options.runId,
          ptcConfig: options.ptcConfig,
        },
      )

      if (!decision.allowed) {
        const blocked = buildBlockedPtcResult(decision)
        return JSON.stringify(blocked)
      }

      // Transpile TypeScript to JavaScript when requested
      let execCode = code
      if (language === 'typescript' && (options.ptcConfig?.transpileTypeScript ?? true)) {
        if (await transpiler.isAvailable()) {
          try {
            const transpiled = await transpiler.transpile(code, { filename: 'input.ts' })
            execCode = transpiled.code
          } catch {
            // Fall through with the original code — QuickJS will report
            // syntax errors for TS-specific constructs.
          }
        }
      }

      const start = Date.now()
      let execResult: Awaited<ReturnType<WasmSandbox['execute']>>
      try {
        execResult = await sandbox.execute(execCode)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const result = {
          stdout: '',
          stderr: msg,
          exitCode: 1,
          durationMs: Date.now() - start,
          blocked: false,
        }
        // Audit the failure
        void options.governance.auditResult({
          toolName,
          callerAgent: options.runId ?? 'ptc',
          timestamp: Date.now(),
          durationMs: result.durationMs,
          success: false,
          output: `error: ${msg}`,
          outputMetadata: { outputType: 'string', outputLength: msg.length, outputKeys: [] },
          resultAuditRetention: 'raw',
        })
        return JSON.stringify(result)
      }

      const ptcResult = {
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        exitCode: execResult.exitCode,
        durationMs: execResult.durationMs,
        blocked: false,
      }

      void options.governance.auditResult({
        toolName,
        callerAgent: options.runId ?? 'ptc',
        timestamp: Date.now(),
        durationMs: execResult.durationMs,
        success: execResult.exitCode === 0,
        output: execResult.stdout || execResult.stderr,
        outputMetadata: {
          outputType: 'string',
          outputLength: (execResult.stdout + execResult.stderr).length,
          outputKeys: [],
        },
        resultAuditRetention: 'raw',
      })

      return JSON.stringify(ptcResult)
    },
    {
      name: toolName,
      description:
        'Execute JavaScript or TypeScript code in a sandboxed QuickJS WASM environment. ' +
        'Every invocation is governed by the agent\'s tool-governance policy — ' +
        'the tool may be rate-limited, blocked, or require human approval.',
      schema: PtcInputSchema,
    },
  )
}
