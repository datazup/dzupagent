import { counter } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const personaRegistryMetricMap = {
  'persona:created': [
    counter(
      'dzip_persona_created_total',
      'Total personas created',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'persona:version_created': [
    counter(
      'dzip_persona_versions_created_total',
      'Total persona versions created',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'persona:version_activated': [
    counter(
      'dzip_persona_versions_activated_total',
      'Total persona versions activated',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'persona:version_deprecated': [
    counter(
      'dzip_persona_versions_deprecated_total',
      'Total persona versions deprecated',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'persona:version_archived': [
    counter(
      'dzip_persona_versions_archived_total',
      'Total persona versions archived',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'persona:compiled': [
    counter(
      'dzip_persona_compiled_total',
      'Total persona compilations',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'persona:matched': [
    counter(
      'dzip_persona_matched_total',
      'Total persona match operations',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],
} satisfies MetricMapFragment
