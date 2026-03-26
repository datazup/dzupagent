// Contract types
export type {
  AdapterType,
  ComplianceLevel,
  ComplianceReport,
  ContractRunConfig,
  ContractRunFilter,
  ContractSuite,
  ContractTest,
  ContractTestCategory,
  ContractTestReport,
  ContractTestResult,
} from './contract-types.js';

// Contract builder & helpers
export { ContractSuiteBuilder, timedTest } from './contract-test-generator.js';

// Contract runner
export { runContractSuite, runContractSuites } from './contract-test-runner.js';

// Contract reporter
export {
  complianceBadge,
  complianceSummary,
  complianceToCIAnnotations,
  complianceToJSON,
  complianceToMarkdown,
} from './contract-test-reporter.js';

// Built-in contract suites
export {
  createVectorStoreContract,
  VECTOR_STORE_CONTRACT,
  createSandboxContract,
  SANDBOX_CONTRACT,
  createLLMProviderContract,
  LLM_PROVIDER_CONTRACT,
  createEmbeddingProviderContract,
  EMBEDDING_PROVIDER_CONTRACT,
} from './suites/index.js';
