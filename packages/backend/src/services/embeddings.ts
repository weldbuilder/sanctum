// Semantic embedding service — local all-MiniLM-L6-v2 via @huggingface/transformers
// Lazy-loads model on first use. No external API calls.

import type { FeatureExtractionPipeline } from '@huggingface/transformers';

const MODEL_ID = 'sentence-transformers/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

let pipeline: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (pipeline) return pipeline;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const { pipeline: createPipeline } = await import('@huggingface/transformers');
    console.log('[embeddings] Loading model…');
    const p = await createPipeline('feature-extraction', MODEL_ID, {
      dtype: 'fp32',
      revision: 'main',
    });
    console.log('[embeddings] Model loaded.');
    pipeline = p as FeatureExtractionPipeline;
    return pipeline;
  })();

  return loadingPromise;
}

/** Generate a 384-dim embedding for a text string. */
export async function embed(text: string): Promise<Float32Array> {
  const p = await getPipeline();
  // Truncate very long text to ~first 2000 chars (well within 512 token limit)
  const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
  const output = await p(truncated, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data as Float32Array);
}

/** Cosine similarity between two normalized vectors (dot product since L2-normalized). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/** Convert Float32Array to Buffer for SQLite storage. */
export function vectorToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Convert Buffer back to Float32Array. */
export function bufferToVector(b: Buffer): Float32Array {
  const arrayBuffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Float32Array(arrayBuffer);
}

export { EMBEDDING_DIM };
