/** Provider-neutral host isolation capabilities. */
export interface HostCapabilities {
  cgroupsV2: boolean
  namespaces: boolean
  ulimits: boolean
  processGroups: boolean
}

export class HostCapabilityError extends Error {
  constructor(
    message: string,
    public readonly missingCapabilities: (keyof HostCapabilities)[],
  ) {
    super(message)
    this.name = 'HostCapabilityError'
  }
}

export function assertCapabilities(
  capabilities: HostCapabilities,
  required: Partial<Record<keyof HostCapabilities, boolean>>,
): void {
  const missing = (Object.entries(required) as [keyof HostCapabilities, boolean][])
    .filter(([key, needed]) => needed && !capabilities[key])
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new HostCapabilityError(
      `Host is missing required isolation capabilities: ${missing.join(', ')}. `
        + 'This worker cannot safely execute the dispatch on this host.',
      missing,
    )
  }
}

export function describeCapabilities(capabilities: HostCapabilities): string {
  const parts: string[] = []
  if (capabilities.cgroupsV2) parts.push('cgroups-v2')
  if (capabilities.namespaces) parts.push('user-namespaces')
  if (capabilities.ulimits) parts.push('ulimits')
  if (capabilities.processGroups) parts.push('process-groups')
  return parts.length > 0 ? parts.join(', ') : 'none'
}
