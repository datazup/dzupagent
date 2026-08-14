import { defaultLogger } from '@dzupagent/core/utils'
import { describe, expect, it, vi } from 'vitest'

import { InteractionResolver } from '../interaction-resolver.js'
import type { InteractionPolicy } from '../../types.js'

const request = {
  interactionId: 'invalid-policy-mode',
  question: 'Allow write access?',
  kind: 'permission' as const,
}

describe('InteractionResolver — invalid mode', () => {
  it('rejects an unrecognised mode at the policy boundary', () => {
    const policy = { mode: 'auto-aprove' } as unknown as InteractionPolicy

    expect(() => new InteractionResolver(policy)).toThrow(
      'Unrecognised interaction policy mode: auto-aprove',
    )
  })

  it('denies and logs exactly once when the defensive default arm is reached', async () => {
    const resolver = new InteractionResolver({ mode: 'auto-deny' })
    const corruptedPolicy = resolver as unknown as {
      policy: { mode: string }
    }
    corruptedPolicy.policy = { mode: 'version-skewed-mode' }
    const errorSpy = vi.spyOn(defaultLogger, 'error').mockImplementation(() => {})

    const result = await resolver.resolve(request)

    expect(result).toEqual({ answer: 'no', resolvedBy: 'auto-deny' })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      '[InteractionResolver] Unrecognised interaction policy mode: version-skewed-mode; denying prompt',
    )
    errorSpy.mockRestore()
  })
})
