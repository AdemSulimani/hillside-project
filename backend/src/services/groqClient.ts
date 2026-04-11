import Groq from 'groq-sdk';

if (!process.env.GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY is not configured');
}

export const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
/** Groq-recommended replacement for deprecated llama-3.2-90b-vision-preview (multimodal). */
export const VISION_MODEL =
  process.env.VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
