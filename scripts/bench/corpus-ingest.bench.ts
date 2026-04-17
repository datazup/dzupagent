import { describe, bench } from 'vitest';

// Benchmark corpus ingest throughput using simulated operations.
// Deliberately avoids importing @dzupagent/rag to stay self-contained.

describe('Corpus ingest throughput', () => {
  const sampleText =
    'The quick brown fox jumps over the lazy dog. '.repeat(50);

  bench('chunk text into ~200-char segments (1000 chars)', () => {
    const chunkSize = 200;
    const chunks: string[] = [];
    for (let i = 0; i < sampleText.length; i += chunkSize) {
      chunks.push(sampleText.slice(i, i + chunkSize));
    }
  });

  bench('chunk 10 documents', () => {
    const chunkSize = 200;
    const allChunks: string[] = [];
    for (let d = 0; d < 10; d++) {
      for (let i = 0; i < sampleText.length; i += chunkSize) {
        allChunks.push(sampleText.slice(i, i + chunkSize));
      }
    }
  });

  bench('generate chunk IDs (100 chunks)', () => {
    Array.from({ length: 100 }, (_, i) => `chunk_corpus1_source1_${i}`);
  });

  bench('build metadata objects (100 chunks)', () => {
    Array.from({ length: 100 }, (_, i) => ({
      corpusId: 'corpus-1',
      sourceId: 'source-1',
      chunkIndex: i,
      text: sampleText.slice(i * 20, (i + 1) * 20),
    }));
  });

  bench('Map lookup for 100 chunk IDs', () => {
    const map = new Map<string, string[]>();
    map.set(
      'source-1',
      Array.from({ length: 100 }, (_, i) => `chunk_${i}`),
    );
    map.get('source-1');
  });
});
