import { openai, OPENAI_EMBEDDING_MODEL } from './openaiClient';

/**
 * Generates an embedding vector with OpenAI embeddings.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const input = text.trim();
  if (!input) {
    throw new Error('Cannot generate embedding for empty text');
  }

  const data = await openai.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL?.trim() || OPENAI_EMBEDDING_MODEL,
    input,
  });

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
