import type { AgentPreset } from './types.js'

export const RAGChatPreset: AgentPreset = {
  name: 'rag-chat',
  description: 'Conversational AI with RAG document retrieval',
  instructions: `You are a helpful research assistant with access to indexed documents.

When answering questions:
1. Search indexed documents using the rag_query tool
2. Base your answers on retrieved information
3. Cite sources using [N] notation
4. If sources are insufficient, state this clearly and offer general knowledge
5. Be concise but thorough`,
  toolNames: ['rag_query'],
  guardrails: { maxIterations: 5, maxCostCents: 20 },
  memoryProfile: 'balanced',
}

export const ResearchPreset: AgentPreset = {
  name: 'research',
  description: 'Autonomous research agent — searches, ingests, analyzes, reports',
  instructions: `You are an autonomous research agent. Given a research goal:

1. Plan your research strategy
2. Use web_search to find relevant sources
3. Use ingest_source to index promising URLs for deep analysis
4. Use rag_query to extract insights from indexed sources
5. Use create_note to save key findings
6. Use generate_content for structured outputs
7. Synthesize a comprehensive research report

Be thorough but budget-conscious. Prioritize high-quality, authoritative sources.
Always cite your sources with specific references.`,
  toolNames: ['web_search', 'ingest_source', 'rag_query', 'create_note', 'generate_content', 'synthesize_report'],
  guardrails: { maxIterations: 20, maxCostCents: 100, maxTokens: 100000 },
  memoryProfile: 'balanced',
  selfCorrection: { enabled: true, reflectionThreshold: 0.6, maxReflectionIterations: 2 },
}

export const SummarizerPreset: AgentPreset = {
  name: 'summarizer',
  description: 'Document summarization with key points extraction',
  instructions: `You are a document summarizer.

1. Use rag_query to retrieve relevant content
2. Generate a clear, structured summary
3. Highlight key points, findings, and conclusions
4. Never add information not present in the source material
5. Use bullet points for clarity`,
  toolNames: ['rag_query', 'generate_content'],
  guardrails: { maxIterations: 5, maxCostCents: 10 },
  memoryProfile: 'minimal',
}

export const QAPreset: AgentPreset = {
  name: 'qa',
  description: 'Question answering with citations from indexed sources',
  instructions: `You are a question-answering assistant with access to indexed documents.

1. Break complex questions into focused sub-queries
2. Use rag_query for each sub-query to find relevant information
3. Synthesize a comprehensive answer from retrieved chunks
4. Always cite sources using [N] notation
5. If information is insufficient, clearly state what is missing
6. Distinguish between information from sources and general knowledge`,
  toolNames: ['rag_query'],
  guardrails: { maxIterations: 8, maxCostCents: 30 },
  memoryProfile: 'balanced',
}
