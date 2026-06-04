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
 * Builds a single text blob from a product's fields for embedding generation.
 * Brand and category are intentionally included so semantic search can resolve
 * queries like "Optimum Nutrition whey" or "facial care cream" against the
 * correct product even when brand/category live in dedicated columns.
 *
 * usage_description is included so that customer questions like "how do I use X?"
 * or "si ta perdor X?" are semantically matched against the correct product even
 * when the product name is not explicitly mentioned in the question.
 */
export function buildProductText(
  name: string,
  description: string | null,
  tags: string[],
  brand?: string | null,
  category?: string | null,
  usageDescription?: string | null,
  structured?: {
    flavor?: string | null;
    size?: string | null;
    color?: string | null;
    variant?: string | null;
    weight?: string | null;
  },
): string {
  const parts: string[] = [];
  if (brand) parts.push(brand);
  parts.push(name);
  if (category) parts.push(category);
  if (structured?.flavor) parts.push(`flavor ${structured.flavor}`);
  if (structured?.size) parts.push(`size ${structured.size}`);
  if (structured?.color) parts.push(`color ${structured.color}`);
  if (structured?.variant) parts.push(`variant ${structured.variant}`);
  if (structured?.weight) parts.push(`weight ${structured.weight}`);
  if (description) parts.push(description);
  if (usageDescription) parts.push(usageDescription);
  if (tags.length > 0) parts.push(tags.join(', '));
  return parts.join('. ');
}
