import type { MCPTransport } from './mcp-types.js'

export interface MCPTransportCapabilityDescriptor {
  transport: MCPTransport
  supportsPersistentSessions: boolean
  supportsStreaming: boolean
  supported: boolean
  unsupportedReason?: string
}

export class MCPTransportCapabilityValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MCPTransportCapabilityValidationError'
  }
}

export class MCPUnsupportedTransportError extends Error {
  readonly transport: MCPTransport
  readonly capability: MCPTransportCapabilityDescriptor
  readonly metadata: {
    signal: 'mcp_transport_capability_reported'
    transport: MCPTransport
    supportsPersistentSessions: boolean
    supportsStreaming: boolean
    supported: boolean
    unsupportedReason?: string
  }

  constructor(capability: MCPTransportCapabilityDescriptor) {
    const reason = capability.unsupportedReason ?? 'Transport is not supported in this runtime'
    super(`MCP transport "${capability.transport}" is unsupported: ${reason}`)
    this.name = 'MCPUnsupportedTransportError'
    this.transport = capability.transport
    this.capability = capability
    this.metadata = {
      signal: 'mcp_transport_capability_reported',
      transport: capability.transport,
      supportsPersistentSessions: capability.supportsPersistentSessions,
      supportsStreaming: capability.supportsStreaming,
      supported: capability.supported,
      ...(capability.unsupportedReason !== undefined ? { unsupportedReason: capability.unsupportedReason } : {}),
    }
  }
}

const CAPABILITIES: Record<MCPTransport, MCPTransportCapabilityDescriptor> = {
  http: {
    transport: 'http',
    supportsPersistentSessions: false,
    supportsStreaming: false,
    supported: true,
  },
  sse: {
    transport: 'sse',
    supportsPersistentSessions: false,
    supportsStreaming: false,
    supported: false,
    unsupportedReason: 'SSE transport is declared but not yet implemented in @dzupagent/core MCPClient',
  },
  stdio: {
    transport: 'stdio',
    supportsPersistentSessions: false,
    supportsStreaming: false,
    supported: true,
  },
}

function validateBooleanField(
  capability: MCPTransportCapabilityDescriptor,
  field: 'supportsPersistentSessions' | 'supportsStreaming' | 'supported',
): void {
  if (typeof capability[field] !== 'boolean') {
    throw new MCPTransportCapabilityValidationError(
      `Invalid MCP transport capability for "${capability.transport}": "${field}" must be boolean`,
    )
  }
}

export function validateTransportCapabilityDescriptor(
  capability: MCPTransportCapabilityDescriptor,
): MCPTransportCapabilityDescriptor {
  if (!capability.transport) {
    throw new MCPTransportCapabilityValidationError('MCP transport capability requires a transport id')
  }

  validateBooleanField(capability, 'supportsPersistentSessions')
  validateBooleanField(capability, 'supportsStreaming')
  validateBooleanField(capability, 'supported')

  if (!capability.supported) {
    if (!capability.unsupportedReason || capability.unsupportedReason.trim().length === 0) {
      throw new MCPTransportCapabilityValidationError(
        `Unsupported transport "${capability.transport}" must include a non-empty unsupportedReason`,
      )
    }
  }

  return capability
}

export function getMcpTransportCapability(transport: MCPTransport): MCPTransportCapabilityDescriptor {
  return validateTransportCapabilityDescriptor({ ...CAPABILITIES[transport] })
}

export function listMcpTransportCapabilities(): MCPTransportCapabilityDescriptor[] {
  return (Object.keys(CAPABILITIES) as MCPTransport[]).map(transport =>
    getMcpTransportCapability(transport),
  )
}

