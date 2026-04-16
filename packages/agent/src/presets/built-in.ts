import type { AgentPreset } from './types.js'

/** Conversational retrieval with citations */
export const RAGChatPreset: AgentPreset = {
  name: 'rag-chat',
  description: 'Conversational retrieval with citations',
  instructions:
    'You are a helpful assistant that answers questions using retrieved context. ' +
    'Always cite your sources. If you cannot find relevant information, say so.',
  toolNames: ['rag_query'],
  guardrails: {
    maxIterations: 5,
    maxCostCents: 20,
  },
  memoryProfile: 'balanced',
}

/** Multi-step autonomous research and report synthesis */
export const ResearchPreset: AgentPreset = {
  name: 'research',
  description: 'Multi-step autonomous research and report synthesis',
  instructions:
    'You are an autonomous research agent. Gather information from multiple sources, ' +
    'cross-reference findings, and produce a structured report with citations. ' +
    'Prioritize authoritative and primary sources.',
  toolNames: [
    'web_search',
    'ingest_source',
    'rag_query',
    'create_note',
    'generate_content',
    'synthesize_report',
  ],
  guardrails: {
    maxIterations: 20,
    maxCostCents: 100,
    maxTokens: 100_000,
  },
  memoryProfile: 'balanced',
  selfCorrection: {
    enabled: true,
    reflectionThreshold: 0.7,
    maxReflectionIterations: 3,
  },
  defaultModelTier: 'reasoning',
}

/** Summarize retrieved material without hallucination */
export const SummarizerPreset: AgentPreset = {
  name: 'summarizer',
  description: 'Summarize retrieved material without hallucination',
  instructions:
    'You are a summarization assistant. Produce concise, accurate summaries of the provided material. ' +
    'Do not add information not present in the source material. Use clear, direct language.',
  toolNames: ['rag_query', 'generate_content'],
  guardrails: {
    maxIterations: 5,
    maxCostCents: 10,
  },
  memoryProfile: 'minimal',
}

/** Focused question answering over indexed sources with citations */
export const QAPreset: AgentPreset = {
  name: 'qa',
  description: 'Focused question answering over indexed sources with citations',
  instructions:
    'You are a question-answering assistant. Answer questions using only the indexed sources available. ' +
    'Always cite the sources you rely on. If the answer is not in the sources, say so explicitly.',
  toolNames: ['rag_query'],
  guardrails: {
    maxIterations: 8,
    maxCostCents: 30,
  },
  memoryProfile: 'balanced',
}

/** All built-in presets for convenient iteration */
export const BUILT_IN_PRESETS: readonly AgentPreset[] = [
  RAGChatPreset,
  ResearchPreset,
  SummarizerPreset,
  QAPreset,
]
