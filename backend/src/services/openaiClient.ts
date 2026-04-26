import OpenAI from 'openai';

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not configured');
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
export const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';
export const OPENAI_EVAL_MODEL = process.env.OPENAI_EVAL_MODEL || 'gpt-4o';
export const OPENAI_INTENT_MODEL = process.env.OPENAI_INTENT_MODEL || 'gpt-4o';
export const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
export const OPENAI_FINETUNING_BASE_MODEL =
  process.env.OPENAI_FINETUNING_BASE_MODEL || 'gpt-4o-mini-2024-07-18';
