import { describe, expect, it } from 'vitest'

import * as root from '../index.js'
import * as providers from '../providers.js'
import * as canonical from '../provider-catalog.js'

describe('runnable provider guard at public entrypoints', () => {
  it.each([['root', root], ['providers', providers]] as const)(
    '%s exposes the canonical guard and refuses unqualified execution', (_name, entrypoint) => {
      expect(entrypoint.ProviderNotRunnableError).toBe(canonical.ProviderNotRunnableError)
      expect(entrypoint.assertProviderRunnable).toBe(canonical.assertProviderRunnable)
      expect(entrypoint.getRunnableProviders).toBe(canonical.getRunnableProviders)
      expect(entrypoint.selectProviderForExecution).toBe(canonical.selectProviderForExecution)
      expect(entrypoint.getRunnableProviders().sort()).toEqual(['claude', 'codex'])
      for (const id of ['qwen', 'crush', 'goose', 'gemini', 'unknown', '__proto__']) {
        expect(() => entrypoint.selectProviderForExecution(id)).toThrow(canonical.ProviderNotRunnableError)
      }
      for (const id of ['codex', 'claude']) {
        expect(entrypoint.selectProviderForExecution(id)).toMatchObject({ runnable: true })
      }
    },
  )
})
