/**
 * Factory function to create a sandbox instance based on provider configuration.
 */

import type { SandboxProtocol } from './sandbox-protocol.js'
import type { DockerSandboxConfig } from './docker-sandbox.js'
import type { E2BSandboxConfig } from './e2b-sandbox.js'
import type { FlySandboxConfig } from './fly-sandbox.js'
import { DockerSandbox } from './docker-sandbox.js'
import { E2BSandbox } from './e2b-sandbox.js'
import { FlySandbox } from './fly-sandbox.js'
import { MockSandbox } from './mock-sandbox.js'

export type SandboxProvider = 'docker' | 'e2b' | 'fly' | 'mock'

export interface SandboxFactoryConfig {
  provider: SandboxProvider
  docker?: DockerSandboxConfig
  e2b?: E2BSandboxConfig
  fly?: FlySandboxConfig
}

/**
 * Create a sandbox instance based on provider configuration.
 * Throws if required config for the chosen provider is missing.
 */
export function createSandbox(config: SandboxFactoryConfig): SandboxProtocol {
  switch (config.provider) {
    case 'docker':
      return new DockerSandbox(config.docker)
    case 'e2b': {
      if (!config.e2b) {
        throw new Error('E2B sandbox requires "e2b" configuration with at least an apiKey')
      }
      return new E2BSandbox(config.e2b)
    }
    case 'fly': {
      if (!config.fly) {
        throw new Error('Fly sandbox requires "fly" configuration with apiToken and appName')
      }
      return new FlySandbox(config.fly)
    }
    case 'mock':
      return new MockSandbox()
    default: {
      const exhaustive: never = config.provider
      throw new Error(`Unknown sandbox provider: ${String(exhaustive)}`)
    }
  }
}
