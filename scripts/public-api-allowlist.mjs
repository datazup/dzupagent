export const PUBLIC_API_SUBPATH_LIFECYCLES = Object.freeze([
  'stable',
  'deprecated-transitional',
  'experimental',
])

const validSubpathLifecycles = new Set(PUBLIC_API_SUBPATH_LIFECYCLES)

function requireNonEmptyString(value, field, packageName, subpath) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${packageName} public API subpath ${subpath} must define a non-empty ${field}`,
    )
  }

  return value.trim()
}

export function normalizePublicApiSubpaths(packageName, rawSubpaths = {}) {
  if (
    rawSubpaths === null ||
    typeof rawSubpaths !== 'object' ||
    Array.isArray(rawSubpaths)
  ) {
    throw new Error(`${packageName} public API subpaths must be an object`)
  }

  return Object.entries(rawSubpaths).map(([subpath, rawValue]) => {
    if (!subpath.startsWith('./')) {
      throw new Error(
        `${packageName} public API subpath ${subpath} must start with ./`,
      )
    }

    if (typeof rawValue === 'string') {
      return {
        subpath,
        purpose: requireNonEmptyString(
          rawValue,
          'purpose',
          packageName,
          subpath,
        ),
        lifecycle: 'stable',
      }
    }

    if (
      rawValue === null ||
      typeof rawValue !== 'object' ||
      Array.isArray(rawValue)
    ) {
      throw new Error(
        `${packageName} public API subpath ${subpath} must be a purpose string or an object with purpose and lifecycle`,
      )
    }

    const unknownFields = Object.keys(rawValue).filter(
      (field) => field !== 'purpose' && field !== 'lifecycle',
    )
    if (unknownFields.length > 0) {
      throw new Error(
        `${packageName} public API subpath ${subpath} has unknown fields: ${unknownFields.join(', ')}`,
      )
    }

    const purpose = requireNonEmptyString(
      rawValue.purpose,
      'purpose',
      packageName,
      subpath,
    )
    const lifecycle = requireNonEmptyString(
      rawValue.lifecycle,
      'lifecycle',
      packageName,
      subpath,
    )
    if (!validSubpathLifecycles.has(lifecycle)) {
      throw new Error(
        `${packageName} public API subpath ${subpath} has invalid lifecycle ${lifecycle}; expected one of ${PUBLIC_API_SUBPATH_LIFECYCLES.join(', ')}`,
      )
    }

    return { subpath, purpose, lifecycle }
  })
}
