/**
 * LLM-backed product-information answerability assessor.
 *
 * Given a customer's message and the CATALOG KNOWLEDGE for product(s) that have
 * ALREADY been identified, it returns:
 *   - `answer`  : a grounded reply covering ONLY the requested info that is present
 *                 in the catalog knowledge (empty when nothing requested is known).
 *   - `missing` : short labels for each requested piece of info that is NOT present.
 *
 * This is the engine behind partial answers: the caller sends `answer` plus a
 * "we will notify you shortly" notice for `missing`, and escalates the missing
 * parts to a human. It NEVER tells the customer the product does not exist — the
 * product is known to exist; only specific details may be unavailable.
 *
 * Kept separate from the pure helpers (productInformationGapHelpers.ts) because it
 * imports the OpenAI client, which is not import-safe in unit tests.
 */
import { openai, OPENAI_CHAT_MODEL } from './openaiClient';

export interface ProductInfoAssessment {
  /** Grounded answer for the parts we can answer; '' when nothing is answerable. */
  answer: string;
  /** Customer-language labels for requested info NOT present in the catalog knowledge. */
  missing: string[];
  /**
   * False when the assessment could not be performed (empty context, empty model
   * response, or transport/parse error). When fail-closed, callers should escalate
   * even if `missing` is empty, using a generic "we'll notify you shortly" notice.
   */
  ok: boolean;
}

const SYSTEM_PROMPT = `You are a customer-support assistant for an online store.

You receive the customer's message and the CATALOG KNOWLEDGE for the product(s) that have ALREADY been identified for this customer. The product(s) DO exist in the catalog — your only job is to report which requested details are available and which are not.

Reply in the SAME language as the customer (Albanian/Shqip or English), including informal spellings.

Return JSON only: {"answer": string, "missing": string[]}

"answer":
- A concise, friendly reply containing ONLY the facts that ARE present in the catalog knowledge and that the customer asked about.
- If the catalog knowledge contains NONE of the requested information, set "answer" to an empty string "".
- Do NOT invent, infer, or guess any value.
- Do NOT mention the missing information here.
- Do NOT say or imply the product does not exist, is unavailable, or is not in the catalog.

"missing":
- An array of SHORT lowercase labels (in the customer's language) naming each distinct piece of requested information that is NOT present in the catalog knowledge.
- Examples: ["brand"], ["ingredients"], ["marka"], ["përbërësit"].
- Empty array [] when every requested detail was answered.

Critical rules:
- A price counts as answered ONLY if a concrete price value appears in the catalog knowledge.
- Treat any "Verified packaging details read from product images" block as reliable, available knowledge.
- If the customer asked for ONE thing and it is missing → answer="" and missing=[that thing].
- If the customer asked for MULTIPLE things, put the available ones in "answer" and the unavailable ones in "missing".
- NEVER place the same concept in both "answer" and "missing".
- MULTI-PRODUCT RULE: When the catalog knowledge contains MULTIPLE products and the customer asked about a specific attribute (e.g. flavor, brand, weight) for several of them, include that attribute in "missing" if it is absent from AT LEAST ONE of those products — even if it IS present for some of them. Example: 3 products but only 1 has a flavor value → include the flavor label in "missing" because the other 2 cannot be answered for that attribute. Do NOT omit it from "missing" just because one product already provided it.`;

/**
 * Assess answerability. Fail-closed by default: on empty context, an empty model
 * response, or a parse/transport error we report the request as unanswered (so the
 * caller escalates) rather than risk sending an ungrounded answer.
 */
export async function assessProductInformationRequest(
  inboundMessage: string,
  catalogKnowledgeContext: string,
  options?: { failClosed?: boolean },
): Promise<ProductInfoAssessment> {
  const failClosed = options?.failClosed !== false;
  const failed: ProductInfoAssessment = { answer: '', missing: [], ok: !failClosed };

  if (!catalogKnowledgeContext.trim() || !inboundMessage.trim()) {
    return failed;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_CHAT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Customer message:\n${inboundMessage}\n\nCatalog knowledge:\n${catalogKnowledgeContext}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 400,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw?.trim()) return failed;

    const parsed = JSON.parse(raw) as { answer?: unknown; missing?: unknown };
    const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
    const missing = Array.isArray(parsed.missing)
      ? parsed.missing
          .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
          .map((m) => m.trim())
      : [];

    return { answer, missing, ok: true };
  } catch (err) {
    console.warn('[productInformationGap] assessment failed — failing closed', { err });
    return failed;
  }
}
