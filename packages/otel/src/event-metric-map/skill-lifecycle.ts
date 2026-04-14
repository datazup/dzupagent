import { counter } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const skillLifecycleMetricMap = {
  'skill:created': [
    counter(
      'dzip_skill_created_total',
      'Total skills created',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'skill:updated': [
    counter(
      'dzip_skill_updated_total',
      'Total skill updates',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'skill:refactored': [
    counter(
      'dzip_skill_refactored_total',
      'Total skill refactors',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'skill:review_requested': [
    counter(
      'dzip_skill_reviews_requested_total',
      'Total skill review requests',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'skill:review_completed': [
    counter(
      'dzip_skill_reviews_completed_total',
      'Total skill reviews completed',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'skill:activated': [
    counter(
      'dzip_skill_activated_total',
      'Total skills activated',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'skill:deprecated': [
    counter(
      'dzip_skill_deprecated_total',
      'Total skills deprecated',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'skill:archived': [
    counter(
      'dzip_skill_archived_total',
      'Total skills archived',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'skill:used': [
    counter(
      'dzip_skill_used_total',
      'Total skill usages',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'skill:suggestion_created': [
    counter(
      'dzip_skill_suggestions_created_total',
      'Total skill suggestions created',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],
} satisfies MetricMapFragment
