import { describe, it, expect } from 'vitest'
import { InMemoryRegistry } from '../registry/in-memory-registry.js'
import type { RegisterAgentInput } from '../registry/types.js'

function makeInput(name: string): RegisterAgentInput {
  return {
    name,
    description: `Test agent ${name}`,
    capabilities: [{ name: 'test-cap', version: '1.0.0' }],
  }
}

describe('InMemoryRegistry idCounter isolation', () => {
  it('separate instances have independent counters', async () => {
    const reg1 = new InMemoryRegistry()
    const reg2 = new InMemoryRegistry()

    const a1 = await reg1.register(makeInput('alpha'))
    const a2 = await reg1.register(makeInput('beta'))

    const b1 = await reg2.register(makeInput('gamma'))

    // Both first registrations should produce an id ending in counter=1
    // Extract the counter suffix (last segment after the last '-')
    const counterOf = (id: string) => id.split('-').pop()

    expect(counterOf(a1.id)).toBe(counterOf(b1.id))
    expect(counterOf(a2.id)).not.toBe(counterOf(a1.id))
  })
})
