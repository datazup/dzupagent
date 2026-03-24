/**
 * @forgeagent/memory — Reusable memory management for LLM agents.
 *
 * Provides namespace-scoped memory service, decay engine, consolidation,
 * sanitization, staged writing, working memory, retrieval (vector, FTS,
 * graph, RRF fusion), and store backends.
 */

// --- Store ---
export { createStore } from './store-factory.js'
export type { StoreConfig } from './store-factory.js'

// --- Core Service ---
export { MemoryService } from './memory-service.js'

// --- Types ---
export type { NamespaceConfig, FormatOptions, DecayConfig } from './memory-types.js'

// --- Decay Engine ---
export { calculateStrength, reinforceMemory, createDecayMetadata, scoreWithDecay, findWeakMemories } from './decay-engine.js'
export type { DecayMetadata } from './decay-engine.js'

// --- Sanitization ---
export { sanitizeMemoryContent, stripInvisibleUnicode } from './memory-sanitizer.js'
export type { SanitizeResult } from './memory-sanitizer.js'

// --- Consolidation ---
export { consolidateNamespace, consolidateAll } from './memory-consolidation.js'
export type { ConsolidationConfig, ConsolidationResult } from './memory-consolidation.js'

// --- Healer ---
export { findDuplicates, findContradictions, findStaleRecords, healMemory } from './memory-healer.js'
export type { HealingIssue, HealingReport, MemoryHealerConfig } from './memory-healer.js'

// --- Working Memory ---
export { WorkingMemory } from './working-memory.js'
export type { WorkingMemoryConfig } from './working-memory.js'

// --- Observation Extractor ---
export { ObservationExtractor } from './observation-extractor.js'
export type { ObservationExtractorConfig, Observation, ObservationCategory } from './observation-extractor.js'

// --- Frozen Snapshot ---
export { FrozenMemorySnapshot } from './frozen-snapshot.js'

// --- Staged Writer ---
export { StagedWriter } from './staged-writer.js'
export type { StagedRecord, MemoryStage, StagedWriterConfig } from './staged-writer.js'

// --- Write Policy ---
export { defaultWritePolicy, composePolicies } from './write-policy.js'
export type { WritePolicy, WriteAction } from './write-policy.js'

// --- Retrieval ---
export { StoreVectorSearch } from './retrieval/vector-search.js'
export type { VectorSearchResult, VectorSearchProvider } from './retrieval/vector-search.js'

export { KeywordFTSSearch } from './retrieval/fts-search.js'
export type { FTSSearchResult } from './retrieval/fts-search.js'

export { EntityGraphSearch } from './retrieval/graph-search.js'
export type { GraphSearchResult } from './retrieval/graph-search.js'

export { fusionSearch } from './retrieval/rrf-fusion.js'
export type { FusedResult } from './retrieval/rrf-fusion.js'
