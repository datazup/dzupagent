import type { DomainConfig, DomainScorerParams, EvalDomain } from './types.js';
import {
  analysisCitationDeterministic,
  codeErrorHandlingDeterministic,
  codeSecurityDeterministic,
  codeTestCoverageDeterministic,
  codeTypeCorrectnessDeterministic,
  opsIdempotencyDeterministic,
  opsMonitoringDeterministic,
  opsPermissionScopeDeterministic,
  opsRollbackSafetyDeterministic,
  sqlCorrectnessDeterministic,
  sqlEfficiencyDeterministic,
  sqlInjectionSafetyDeterministic,
  sqlReadabilityDeterministic,
} from './deterministic-checks.js';

const SQL_CONFIG: DomainConfig = {
  domain: 'sql',
  name: 'SQL Quality',
  description: 'Evaluates SQL query quality across correctness, efficiency, safety, schema compliance, and readability.',
  criteria: [
    {
      name: 'queryCorrectness',
      description: 'Does the SQL produce correct results?',
      weight: 0.35,
      deterministicCheck: sqlCorrectnessDeterministic,
      llmRubric: 'Evaluate whether this SQL query correctly solves the stated problem. Check for logical errors, missing conditions, wrong joins, and incorrect aggregations. Score 0-10.',
    },
    {
      name: 'queryEfficiency',
      description: 'Is the query efficient?',
      weight: 0.20,
      deterministicCheck: sqlEfficiencyDeterministic,
      llmRubric: 'Evaluate the efficiency of this SQL query. Check for SELECT *, unnecessary DISTINCT, subqueries that could be JOINs, missing indexes hints, and unbounded queries. Score 0-10.',
    },
    {
      name: 'injectionSafety',
      description: 'Is the query safe from SQL injection?',
      weight: 0.20,
      deterministicCheck: sqlInjectionSafetyDeterministic,
      llmRubric: 'Evaluate whether this SQL query is safe from SQL injection. Check for parameterized queries, no string concatenation of user input, no raw interpolation. Score 0-10.',
    },
    {
      name: 'schemaCompliance',
      description: 'Does the query match the provided schema?',
      weight: 0.15,
      llmRubric: 'Evaluate whether this SQL query correctly references the provided database schema. Check table names, column names, data types, and relationships. Score 0-10.',
    },
    {
      name: 'readability',
      description: 'Is the SQL readable?',
      weight: 0.10,
      deterministicCheck: sqlReadabilityDeterministic,
      llmRubric: 'Evaluate the readability of this SQL query. Check keyword casing, consistent aliasing, indentation, and appropriate line breaks. Score 0-10.',
    },
  ],
};

const CODE_CONFIG: DomainConfig = {
  domain: 'code',
  name: 'Code Quality',
  description: 'Evaluates code quality across type safety, testing, security, error handling, and style.',
  criteria: [
    {
      name: 'typeCorrectness',
      description: 'TypeScript type safety',
      weight: 0.30,
      deterministicCheck: codeTypeCorrectnessDeterministic,
      llmRubric: 'Evaluate the TypeScript type safety of this code. Check for proper type annotations, no `any` types, correct generic usage, and discriminated unions where appropriate. Score 0-10.',
    },
    {
      name: 'testCoverage',
      description: 'Are there tests?',
      weight: 0.20,
      deterministicCheck: codeTestCoverageDeterministic,
      llmRubric: 'Evaluate the test coverage of this code. Check for describe/it/test blocks, edge case coverage, assertion quality, and mock usage. Score 0-10.',
    },
    {
      name: 'securityPractices',
      description: 'No hardcoded secrets, no eval(), no innerHTML',
      weight: 0.20,
      deterministicCheck: codeSecurityDeterministic,
      llmRubric: 'Evaluate the security practices in this code. Check for hardcoded secrets, eval() usage, innerHTML/dangerouslySetInnerHTML, and proper input validation. Score 0-10.',
    },
    {
      name: 'errorHandling',
      description: 'Proper try/catch, error types, no swallowed errors',
      weight: 0.15,
      deterministicCheck: codeErrorHandlingDeterministic,
      llmRubric: 'Evaluate error handling in this code. Check for proper try/catch blocks, typed errors, no swallowed errors (empty catch), and proper error propagation. Score 0-10.',
    },
    {
      name: 'codeStyle',
      description: 'Consistent naming, no magic numbers, proper imports',
      weight: 0.15,
      llmRubric: 'Evaluate the code style. Check for consistent naming conventions, no magic numbers, proper imports (no circular, no barrel re-exports of everything), clear function signatures, and appropriate documentation. Score 0-10.',
    },
  ],
};

const ANALYSIS_CONFIG: DomainConfig = {
  domain: 'analysis',
  name: 'Analysis Quality',
  description: 'Evaluates analytical output quality across accuracy, completeness, citations, methodology, and clarity.',
  criteria: [
    {
      name: 'accuracy',
      description: 'Are the conclusions correct?',
      weight: 0.35,
      llmRubric: 'Evaluate the factual accuracy of this analysis. Are the conclusions logically supported by the data? Are there any factual errors or misleading claims? Score 0-10.',
    },
    {
      name: 'completeness',
      description: 'All aspects covered?',
      weight: 0.25,
      llmRubric: 'Evaluate the completeness of this analysis. Are all relevant aspects addressed? Are there significant gaps or missing perspectives? Score 0-10.',
    },
    {
      name: 'citationQuality',
      description: 'Are sources cited?',
      weight: 0.20,
      deterministicCheck: analysisCitationDeterministic,
      llmRubric: 'Evaluate the citation and sourcing quality. Are claims backed by data or references? Are sources credible and properly attributed? Score 0-10.',
    },
    {
      name: 'methodology',
      description: 'Sound analytical approach?',
      weight: 0.10,
      llmRubric: 'Evaluate the analytical methodology. Is the approach sound and appropriate for the problem? Are assumptions stated? Is the reasoning transparent? Score 0-10.',
    },
    {
      name: 'clarity',
      description: 'Clear communication?',
      weight: 0.10,
      llmRubric: 'Evaluate the clarity of communication. Is the analysis well-structured, easy to follow, and appropriately targeted for its audience? Score 0-10.',
    },
  ],
};

const OPS_CONFIG: DomainConfig = {
  domain: 'ops',
  name: 'Operations Quality',
  description: 'Evaluates operational scripts/configs across idempotency, rollback safety, permissions, monitoring, and documentation.',
  criteria: [
    {
      name: 'idempotency',
      description: 'Can the operation be safely re-run?',
      weight: 0.25,
      deterministicCheck: opsIdempotencyDeterministic,
      llmRubric: 'Evaluate whether this operation is idempotent. Can it be safely re-run without side effects? Does it use CREATE IF NOT EXISTS, upsert patterns, or conditional creates? Score 0-10.',
    },
    {
      name: 'rollbackSafety',
      description: 'Is there a rollback path?',
      weight: 0.25,
      deterministicCheck: opsRollbackSafetyDeterministic,
      llmRubric: 'Evaluate rollback safety. Is there a clear rollback path? Are transactions used? Are backups mentioned? Is there a migration down method? Score 0-10.',
    },
    {
      name: 'permissionScope',
      description: 'Least-privilege?',
      weight: 0.20,
      deterministicCheck: opsPermissionScopeDeterministic,
      llmRubric: 'Evaluate the permission scope. Does this follow least-privilege principles? Are there unnecessary sudo/root usages, chmod 777, or wildcard IAM policies? Score 0-10.',
    },
    {
      name: 'monitoring',
      description: 'Observability included?',
      weight: 0.15,
      deterministicCheck: opsMonitoringDeterministic,
      llmRubric: 'Evaluate the monitoring and observability. Are there logging, health checks, alerts, or metrics? Is the operation observable in production? Score 0-10.',
    },
    {
      name: 'documentation',
      description: 'Runbook/docs?',
      weight: 0.15,
      llmRubric: 'Evaluate the documentation quality. Is there a runbook, inline comments explaining why, or operational documentation? Are prerequisites and dependencies documented? Score 0-10.',
    },
  ],
};

const RESEARCH_CONFIG: DomainConfig = {
  domain: 'research',
  name: 'Research Quality',
  description: 'Evaluates research output quality across evidence coverage, source reliability, corroboration, methodology, and clarity.',
  criteria: [
    {
      name: 'evidenceCoverage',
      description: 'Are claims backed by sources?',
      weight: 0.30,
      deterministicCheck: (input) => {
        // Simple heuristic: count citation-like patterns
        const output = input.output
        const citationPatterns = [/\[\d+\]/g, /\bhttps?:\/\//g, /\(source[:\s]/gi, /according to/gi]
        let citationCount = 0
        for (const pattern of citationPatterns) {
          const matches = output.match(pattern)
          if (matches) citationCount += matches.length
        }
        const score = Math.min(1, citationCount / 5)
        return {
          score: score * 10,
          reasoning: `Found ${citationCount} citation-like patterns in the output`,
        }
      },
      llmRubric: 'Evaluate whether the claims in this research output are backed by cited sources. Check for source attribution, citation density, and unsupported assertions. Score 0-10.',
    },
    {
      name: 'sourceReliability',
      description: 'Are sources credible and diverse?',
      weight: 0.25,
      llmRubric: 'Evaluate the quality and reliability of sources cited. Are they authoritative, recent, peer-reviewed, or from reputable outlets? Is there source diversity? Score 0-10.',
    },
    {
      name: 'corroboration',
      description: 'Are key claims supported by multiple sources?',
      weight: 0.20,
      llmRubric: 'Evaluate whether key claims are corroborated by multiple independent sources. Single-source claims should score lower. Score 0-10.',
    },
    {
      name: 'methodology',
      description: 'Sound research approach?',
      weight: 0.15,
      llmRubric: 'Evaluate the research methodology. Is the approach systematic? Are limitations acknowledged? Is the scope appropriate? Score 0-10.',
    },
    {
      name: 'clarity',
      description: 'Clear presentation of findings?',
      weight: 0.10,
      llmRubric: 'Evaluate the clarity and structure of the research output. Is it well-organized, logically presented, and accessible to the target audience? Score 0-10.',
    },
  ],
};

const GENERAL_CONFIG: DomainConfig = {
  domain: 'general',
  name: 'General Quality',
  description: 'General-purpose quality evaluation across correctness, completeness, clarity, relevance, and safety.',
  criteria: [
    {
      name: 'correctness',
      description: 'Is the output factually correct?',
      weight: 0.30,
      llmRubric: 'Evaluate the factual correctness of this output. Are the statements accurate? Does it solve the stated problem correctly? Score 0-10.',
    },
    {
      name: 'completeness',
      description: 'All aspects addressed?',
      weight: 0.25,
      llmRubric: 'Evaluate the completeness. Are all parts of the task addressed? Are there significant omissions? Score 0-10.',
    },
    {
      name: 'clarity',
      description: 'Clear and well-structured?',
      weight: 0.20,
      llmRubric: 'Evaluate the clarity and structure. Is the output well-organized, easy to understand, and appropriately detailed? Score 0-10.',
    },
    {
      name: 'relevance',
      description: 'Directly addresses the task?',
      weight: 0.15,
      llmRubric: 'Evaluate the relevance. Does the output directly address what was asked? Is there unnecessary padding or off-topic content? Score 0-10.',
    },
    {
      name: 'safety',
      description: 'Free from harmful content?',
      weight: 0.10,
      llmRubric: 'Evaluate the safety. Is the output free from harmful, biased, or inappropriate content? Score 0-10.',
    },
  ],
};

/** Map of all built-in domain configurations. */
export const DOMAIN_CONFIGS: Record<EvalDomain, DomainConfig> = {
  sql: SQL_CONFIG,
  code: CODE_CONFIG,
  analysis: ANALYSIS_CONFIG,
  ops: OPS_CONFIG,
  research: RESEARCH_CONFIG,
  general: GENERAL_CONFIG,
};

/** Pattern sets for domain auto-detection, ordered by specificity. */
export const DOMAIN_DETECTION_PATTERNS: Array<{ domain: EvalDomain; patterns: RegExp[] }> = [
  {
    domain: 'sql',
    patterns: [
      /\bSELECT\b/i,
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bCREATE\s+TABLE\b/i,
      /\bALTER\s+TABLE\b/i,
    ],
  },
  {
    domain: 'research',
    patterns: [
      /\bresearch\b/i,
      /\bevidence\b/i,
      /\bcorroborat/i,
      /\bcitation/i,
      /\bsource.*reliab/i,
      /\bpeer.?review/i,
      /\bliterature\s+review/i,
      /\bfindings\s+suggest/i,
    ],
  },
  {
    domain: 'ops',
    patterns: [
      /\bdeploy/i,
      /\bkubernetes\b/i,
      /\bk8s\b/i,
      /\bdocker\b/i,
      /\bterraform\b/i,
      /\bansible\b/i,
      /\bmigration\b/i,
      /\brollback\b/i,
      /\bhelm\b/i,
      /\bci\/?cd\b/i,
    ],
  },
  {
    domain: 'code',
    patterns: [
      /\bfunction\s+\w+/,
      /\bclass\s+\w+/,
      /\bimport\s+/,
      /\bexport\s+/,
      /\bconst\s+\w+/,
      /\blet\s+\w+/,
      /\bdef\s+\w+/,
      /\breturn\s+/,
    ],
  },
  {
    domain: 'analysis',
    patterns: [
      /\banalyze\b/i,
      /\banalysis\b/i,
      /\breport\b/i,
      /\bfindings\b/i,
      /\bmetrics?\b/i,
      /\btrend\b/i,
      /\binsight/i,
      /\bcorrelat/i,
    ],
  },
];

function cloneCriteria(criteria: DomainConfig['criteria']): DomainConfig['criteria'] {
  return criteria.map((criterion) => ({ ...criterion }));
}

export function buildDomainConfig(params: DomainScorerParams): DomainConfig {
  const builtInConfig = DOMAIN_CONFIGS[params.domain];
  const baseConfig: DomainConfig = {
    ...builtInConfig,
    criteria: cloneCriteria(builtInConfig.criteria),
  };

  if (params.customConfig) {
    if (params.customConfig.name !== undefined) baseConfig.name = params.customConfig.name;
    if (params.customConfig.description !== undefined) baseConfig.description = params.customConfig.description;
    if (params.customConfig.criteria !== undefined) baseConfig.criteria = cloneCriteria(params.customConfig.criteria);
  }

  if (params.weightOverrides) {
    baseConfig.criteria = baseConfig.criteria.map((c) => {
      const override = params.weightOverrides?.[c.name];
      return override !== undefined ? { ...c, weight: override } : c;
    });

    // Normalize weights to sum to 1
    const totalWeight = baseConfig.criteria.reduce((sum, c) => sum + c.weight, 0);
    if (totalWeight > 0 && Math.abs(totalWeight - 1) > 0.001) {
      baseConfig.criteria = baseConfig.criteria.map((c) => ({
        ...c,
        weight: c.weight / totalWeight,
      }));
    }
  }

  return baseConfig;
}

export function cloneDomainConfig(domain: EvalDomain): DomainConfig {
  const config = DOMAIN_CONFIGS[domain];
  return {
    ...config,
    criteria: cloneCriteria(config.criteria),
  };
}
