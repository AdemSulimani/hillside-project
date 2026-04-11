import axios from 'axios';

const EMBEDDING_API_URL =
  process.env.EMBEDDING_API_URL || 'https://api.groq.com/openai/v1/embeddings';
const EMBEDDING_API_KEY =
  process.env.EMBEDDING_API_KEY || process.env.GROQ_API_KEY || '';
const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || 'nomic-embed-text-v1_5';

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Generates an embedding vector via any OpenAI-compatible embedding endpoint.
 * Configure provider through EMBEDDING_API_URL, EMBEDDING_API_KEY, and
 * EMBEDDING_MODEL environment variables.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const input = text.trim();
  if (!input) {
    throw new Error('Cannot generate embedding for empty text');
  }

  const { data } = await axios.post<EmbeddingResponse>(
    EMBEDDING_API_URL,
    { model: EMBEDDING_MODEL, input },
    {
      headers: {
        Authorization: `Bearer ${EMBEDDING_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    },
  );

  const vector = data.data?.[0]?.embedding;
  if (!vector || vector.length === 0) {
    throw new Error('Embedding API returned an empty vector');
  }

  return vector;
}

/**
 * Builds a single text blob from a product's name, description, and tags
 * for embedding generation.
 */
export function buildProductText(
  name: string,
  description: string | null,
  tags: string[],
): string {
  const parts = [name];
  if (description) parts.push(description);
  if (tags.length > 0) parts.push(tags.join(', '));
  return parts.join('. ');
}
