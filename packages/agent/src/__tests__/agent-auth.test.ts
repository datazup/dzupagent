import { describe, it, expect, beforeEach } from 'vitest'
import { AgentAuth } from '../security/agent-auth.js'
import type { AgentCredential } from '../security/agent-auth.js'

describe('AgentAuth', () => {
  let auth: AgentAuth
  let credential: AgentCredential

  beforeEach(() => {
    auth = new AgentAuth({ maxMessageAgeMs: 60_000 })
    credential = auth.generateCredential('agent-alpha')
  })

  // -----------------------------------------------------------------------
  // Key generation
  // -----------------------------------------------------------------------

  it('generateCredential produces a valid key pair', () => {
    expect(credential.agentId).toBe('agent-alpha')
    expect(credential.publicKey).toBeInstanceOf(Uint8Array)
    expect(credential.publicKey.length).toBe(32)
    expect(credential.privateKey).toBeInstanceOf(Uint8Array)
    expect(credential.privateKey.length).toBe(32)
    expect(credential.createdAt).toBeInstanceOf(Date)
  })

  it('generateCredential produces unique keys per call', () => {
    const c2 = auth.generateCredential('agent-beta')
    expect(Buffer.from(credential.publicKey).equals(Buffer.from(c2.publicKey))).toBe(false)
    expect(Buffer.from(credential.privateKey).equals(Buffer.from(c2.privateKey))).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Sign / Verify round-trip
  // -----------------------------------------------------------------------

  it('signMessage/verifyMessage round-trip succeeds', () => {
    const msg = auth.signMessage({ action: 'deploy', target: 'prod' }, credential)
    const result = auth.verifyMessage(msg, credential.publicKey)
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('verifyMessage fails with wrong key', () => {
    const msg = auth.signMessage({ data: 'secret' }, credential)
    const other = auth.generateCredential('agent-beta')
    const result = auth.verifyMessage(msg, other.publicKey)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('Invalid signature')
  })

  it('verifyMessage fails with tampered payload', () => {
    const msg = auth.signMessage({ amount: 100 }, credential)
    // Tamper with the payload
    const tampered = { ...msg, payload: JSON.stringify({ amount: 999 }) }
    const result = auth.verifyMessage(tampered, credential.publicKey)
    expect(result.valid).toBe(false)
  })

  it('verifyMessage rejects expired messages', () => {
    const shortAuth = new AgentAuth({ maxMessageAgeMs: 1 })
    const cred = shortAuth.generateCredential('agent-x')
    const msg = shortAuth.signMessage({ data: 'hello' }, cred)
    // Manually set timestamp far in the past
    const expired = { ...msg, timestamp: Date.now() - 100_000 }
    const result = shortAuth.verifyMessage(expired, cred.publicKey)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('Message expired')
  })

  // -----------------------------------------------------------------------
  // Nonce uniqueness
  // -----------------------------------------------------------------------

  it('nonce is unique per message', () => {
    const msg1 = auth.signMessage({ n: 1 }, credential)
    const msg2 = auth.signMessage({ n: 2 }, credential)
    expect(msg1.nonce).not.toBe(msg2.nonce)
    expect(msg1.nonce.length).toBe(32) // 16 bytes hex = 32 chars
  })

  // -----------------------------------------------------------------------
  // Replay prevention
  // -----------------------------------------------------------------------

  it('checkReplay rejects duplicate nonce', () => {
    const msg = auth.signMessage({ data: 'test' }, credential)
    const first = auth.checkReplay(msg)
    expect(first.allowed).toBe(true)

    const second = auth.checkReplay(msg)
    expect(second.allowed).toBe(false)
    expect(second.reason).toContain('Duplicate nonce')
  })

  it('checkReplay rejects expired message', () => {
    const msg = auth.signMessage({ data: 'old' }, credential)
    const expired = { ...msg, timestamp: Date.now() - 120_000 }
    const result = auth.checkReplay(expired)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('too old')
  })

  // -----------------------------------------------------------------------
  // Public key registry
  // -----------------------------------------------------------------------

  it('registerPublicKey + verifyWithRegisteredKey round-trip', () => {
    auth.registerPublicKey(credential.agentId, credential.publicKey)
    const msg = auth.signMessage({ request: 'status' }, credential)
    const result = auth.verifyWithRegisteredKey(msg)
    expect(result.valid).toBe(true)
  })

  it('verifyWithRegisteredKey fails for unregistered agent', () => {
    const msg = auth.signMessage({ request: 'status' }, credential)
    // Do not register the key
    const result = auth.verifyWithRegisteredKey(msg)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('No registered key')
  })

  it('verifyWithRegisteredKey fails when wrong key is registered', () => {
    const other = auth.generateCredential('agent-beta')
    // Register the wrong key for agent-alpha
    auth.registerPublicKey(credential.agentId, other.publicKey)
    const msg = auth.signMessage({ data: 'test' }, credential)
    const result = auth.verifyWithRegisteredKey(msg)
    expect(result.valid).toBe(false)
  })
})
