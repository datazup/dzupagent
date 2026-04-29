import type { StructuredToolInterface } from '@langchain/core/tools'
import { importFirstAvailable } from './runtime-module-imports.js'

export async function resolveGitFactory(): Promise<{
  createGitTools: ((executor: unknown, policy?: { allowMutatingTools?: boolean }) => StructuredToolInterface[]) | null
  GitExecutor: (new (cfg?: { cwd?: string; allowedRoots?: string[] }) => unknown) | null
}> {
  // Prefer monorepo source during local development/tests; packaged builds fall
  // back to @dzupagent/codegen when the source path is unavailable.
  const toolsMod = await importFirstAvailable(['../../../codegen/src/git/git-tools.ts'])
  const execMod = await importFirstAvailable(['../../../codegen/src/git/git-executor.ts'])
  if (
    toolsMod && execMod
    && typeof toolsMod['createGitTools'] === 'function'
    && typeof execMod['GitExecutor'] === 'function'
  ) {
    return {
      createGitTools: toolsMod['createGitTools'] as (
        executor: unknown,
        policy?: { allowMutatingTools?: boolean },
      ) => StructuredToolInterface[],
      GitExecutor: execMod['GitExecutor'] as new (cfg?: { cwd?: string; allowedRoots?: string[] }) => unknown,
    }
  }

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
  const pkg = await importFirstAvailable(['@dzupagent/connectors'])
  if (pkg) return pkg

  // Dev-only monorepo fallbacks - only resolve when package isn't published.
  const github = await importFirstAvailable(['../../../connectors/src/github/github-connector.ts'])
  const slack = await importFirstAvailable(['../../../connectors/src/slack/slack-connector.ts'])
  const http = await importFirstAvailable(['../../../connectors/src/http/http-connector.ts'])
  if (!github && !slack && !http) return null

  return {
    ...github,
    ...slack,
    ...http,
  }
}
