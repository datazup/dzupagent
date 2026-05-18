import { describe, it, expect } from 'vitest'
import { AgentAuth } from '../security/agent-auth.js'

describe('AgentAuth capability authorization', () => {
  it('rejects insufficient capabilities, then succeeds when required capability is present', () => {
    const auth = new AgentAuth({ requiredCapabilities: ['deploy'] })
    const credential = auth.generateCredential('agent-alpha')

    const insufficient = auth.signMessage({ capabilities: ['read'] }, credential)
    const insufficientResult = auth.verifyMessage(insufficient, credential.publicKey)
    expect(insufficientResult.valid).toBe(false)
    expect(insufficientResult.stage).toBe('capability')
    expect(insufficientResult.failure?.code).toBe('insufficient_capabilities')
    expect(insufficientResult.failure?.missingCapabilities).toEqual(['deploy'])

    const sufficient = auth.signMessage({ capabilities: ['read', 'deploy'] }, credential)
    const sufficientResult = auth.verifyMessage(sufficient, credential.publicKey)
    expect(sufficientResult.valid).toBe(true)
    expect(sufficientResult.stage).toBe('success')
    expect(sufficientResult.failure).toBeUndefined()
  })

  it('rejects missing capabilities claim, then succeeds with a valid claim object', () => {
    const auth = new AgentAuth({ requiredCapabilities: ['deploy'] })
    const credential = auth.generateCredential('agent-alpha')

    const missingClaim = auth.signMessage({ subject: 'agent-alpha' }, credential)
    const missingResult = auth.verifyMessage(missingClaim, credential.publicKey)
    expect(missingResult.valid).toBe(false)
    expect(missingResult.stage).toBe('capability')
    expect(missingResult.failure?.code).toBe('missing_capability_claim')

    const recoveredClaim = auth.signMessage({ capabilities: ['deploy'] }, credential)
    const recoveredResult = auth.verifyMessage(recoveredClaim, credential.publicKey)
    expect(recoveredResult.valid).toBe(true)
    expect(recoveredResult.stage).toBe('success')
  })

  it('rejects malformed capabilities claim, then succeeds after claim repair', () => {
    const auth = new AgentAuth({ requiredCapabilities: ['deploy'] })
    const credential = auth.generateCredential('agent-alpha')

    const malformed = auth.signMessage({ capabilities: 'deploy' }, credential)
    const malformedResult = auth.verifyMessage(malformed, credential.publicKey)
    expect(malformedResult.valid).toBe(false)
    expect(malformedResult.stage).toBe('capability')
    expect(malformedResult.failure?.code).toBe('malformed_capability_claim')

    const corrected = auth.signMessage({ capabilities: ['deploy'] }, credential)
    const correctedResult = auth.verifyMessage(corrected, credential.publicKey)
    expect(correctedResult.valid).toBe(true)
    expect(correctedResult.stage).toBe('success')
  })

  it('rejects expired capability claim, then succeeds with future expiry', () => {
    const auth = new AgentAuth({ requiredCapabilities: ['deploy'] })
    const credential = auth.generateCredential('agent-alpha')

    const expired = auth.signMessage(
      {
        capabilities: ['deploy'],
        capabilitiesExp: Math.floor(Date.now() / 1000) - 10,
      },
      credential,
    )
    const expiredResult = auth.verifyMessage(expired, credential.publicKey)
    expect(expiredResult.valid).toBe(false)
    expect(expiredResult.stage).toBe('capability')
    expect(expiredResult.failure?.code).toBe('expired_capability_claim')

    const active = auth.signMessage(
      {
        capabilities: ['deploy'],
        capabilitiesExp: Math.floor(Date.now() / 1000) + 60,
      },
      credential,
    )
    const activeResult = auth.verifyMessage(active, credential.publicKey)
    expect(activeResult.valid).toBe(true)
    expect(activeResult.stage).toBe('success')
  })
})
