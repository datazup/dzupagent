import type { StructuredToolInterface } from '@langchain/core/tools'
import { importFirstAvailable } from './runtime-module-imports.js'

export async function resolveGitFactory(): Promise<{
  createGitTools: ((executor: unknown, policy?: { allowMutatingTools?: boolean }) => StructuredToolInterface[]) | null
  GitExecutor: (new (cfg?: { cwd?: string; allowedRoots?: string[] }) => unknown) | null
}> {
  const pkg = await importFirstAvailable(['@dzupagent/codegen'])
  if (pkg && typeof pkg['createGitTools'] === 'function' && typeof pkg['GitExecutor'] === 'function') {
    return {
      createGitTools: pkg['createGitTools'] as (
        executor: unknown,
        policy?: { allowMutatingTools?: boolean },
      ) => StructuredToolInterface[],
      GitExecutor: pkg['GitExecutor'] as new (cfg?: { cwd?: string; allowedRoots?: string[] }) => unknown,
    }
  }

  return { createGitTools: null, GitExecutor: null }
}

export async function resolveConnectorFactory(): Promise<Record<string, unknown> | null> {
  return importFirstAvailable(['@dzupagent/connectors'])
}
