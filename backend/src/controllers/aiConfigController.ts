import type { Request, Response } from 'express';
import { ensureAIConfigForTenant, updateAIConfig } from '../db/models/aiConfig';
import { findTenantById } from '../db/models/tenant';
import { searchProducts, type Product } from '../db/models/product';
import { groq, GROQ_MODEL } from '../services/groqClient';
import { sendSuccess, sendError } from '../utils/response';
import type { TestAIConfigInput } from '../validators/aiConfig';

export async function show(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const config = await ensureAIConfigForTenant(tenantId);

    sendSuccess(res, config);
  } catch (err) {
    sendError(res, 'Failed to fetch AI configuration', 500, err);
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;

    await ensureAIConfigForTenant(tenantId);

    const updated = await updateAIConfig(tenantId, req.body);
    sendSuccess(res, updated, 'AI configuration updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update AI configuration', 500, err);
  }
}

export async function test(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const body = req.body as TestAIConfigInput;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Tenant not found', 404);
      return;
    }

    const products = await searchProducts(tenantId, '', 5);

    const config = {
      tone: body.tone ?? 'professional',
      personality_description: body.personality_description ?? null,
      restrictions: body.restrictions ?? [],
      sales_strategy: body.sales_strategy ?? null,
      objection_handling: body.objection_handling ?? null,
      qa_pairs: body.qa_pairs ?? [],
      custom_model_id: body.custom_model_id ?? null,
    };

    const systemPrompt = buildTestSystemPrompt(tenant.name, config, products);
    const model = config.custom_model_id || GROQ_MODEL;

    const completion = await groq.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: body.testMessage },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    });

    const reply = completion.choices[0]?.message?.content;
    if (!reply) {
      sendError(res, 'AI returned an empty response', 500);
      return;
    }

    sendSuccess(res, { reply: reply.trim() }, 'Test reply generated');
  } catch (err) {
    sendError(res, 'Failed to generate test reply', 500, err);
  }
}

interface TestConfig {
  tone: string;
  personality_description: string | null;
  restrictions: string[];
  sales_strategy: string | null;
  objection_handling: string | null;
  qa_pairs: { question: string; answer: string }[];
}

function buildTestSystemPrompt(
  businessName: string,
  config: TestConfig,
  products: Product[],
): string {
  const lines: string[] = [
    `You are the AI sales assistant for "${businessName}".`,
    `Your tone should be: ${config.tone}.`,
  ];

  if (config.personality_description) {
    lines.push(`Personality: ${config.personality_description}`);
  }

  if (config.sales_strategy) {
    lines.push('', `Sales strategy: ${config.sales_strategy}`);
  }

  if (config.objection_handling) {
    lines.push('', `Objection handling approach: ${config.objection_handling}`);
  }

  if (config.restrictions.length > 0) {
    lines.push('', `RESTRICTIONS — you MUST follow these rules:\n${config.restrictions.map((r) => `- ${r}`).join('\n')}`);
  }

  if (products.length > 0) {
    const catalog = products
      .map((p) => {
        const parts = [`- ${p.name}: $${Number(p.price).toFixed(2)}`];
        if (p.description) parts.push(`  ${p.description}`);
        if (p.category) parts.push(`  Category: ${p.category}`);
        if (p.stock_quantity !== null) parts.push(`  In stock: ${p.stock_quantity}`);
        return parts.join('\n');
      })
      .join('\n');
    lines.push('', 'Product catalog:', catalog);
  }

  if (config.qa_pairs.length > 0) {
    const qa = config.qa_pairs
      .map((pair) => `Q: ${pair.question}\nA: ${pair.answer}`)
      .join('\n\n');
    lines.push('', `Frequently Asked Questions:\n${qa}`);
  }

  lines.push(
    '',
    'Guidelines:',
    '- Keep replies concise and conversational — this is a chat, not an email.',
    '- If the customer asks about a product you don\'t have, say so honestly.',
    '- Never fabricate product details, prices, or availability.',
    '- If a question is outside your scope, politely let the customer know a human agent can help.',
    '- Do not use markdown formatting — reply in plain text suitable for a messaging app.',
  );

  return lines.join('\n');
}
