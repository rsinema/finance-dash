import { z } from "zod";
import { CATEGORIES, type Category } from "../lib/categories";
import { merchantKey } from "../lib/merchant";
import { env } from "../env";
import { moonshot, isMoonshotConfigured } from "./moonshot";
import {
  bumpRuleHit,
  getRule,
  upsertRule,
  type TransactionRow,
} from "../db/queries";

const SYSTEM_PROMPT = `You categorize personal financial transactions into exactly one of these categories:
- Bills/Utilities: electric, water, gas, internet, phone, insurance.
- Rent/Mortgage: rent payments, mortgage payments, HOA fees.
- Groceries: supermarkets, grocery stores, food markets. NOT restaurants.
- Dining Out: restaurants, cafes, coffee shops, fast food, food delivery.
- Transport: gas stations, rideshare, parking, transit, vehicle maintenance, tolls.
- Shopping: general retail, household goods, clothing, online marketplaces.
- Entertainment: streaming services, games, events, concerts, hobbies.
- Health: medical, dental, pharmacy, gym, wellness, therapy.
- Subscriptions: recurring software, cloud services, professional tools.
- Travel: flights, hotels, lodging, vacation rentals, travel booking.
- Income: paychecks, deposits, refunds received, interest earned.
- Transfer: movement between the user's own accounts, credit card payments, Venmo/Zelle to self, investment contributions.
- Other: anything that genuinely fits no category above.

Critical:
- Credit card payments and bank-to-bank moves are ALWAYS Transfer, not Bills.
- Amazon, Costco, Target, Walmart default to Shopping unless the merchant string strongly suggests groceries (e.g. "AMZN FRESH").
- A negative amount (money coming in) from a known income source is Income.
- Output strict JSON: {"category": "<one of above>", "confidence": <0.0-1.0>, "reasoning": "<brief>"}.
- confidence reflects how sure you are; ambiguous merchants like "Amazon" should be <= 0.6.`;

// Reasoning is debug-only (logs and the agent's tool trace) — never stored. No length cap.
const ClassificationSchema = z.object({
  category: z.enum(CATEGORIES),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional().default(""),
});

export type Classification = z.infer<typeof ClassificationSchema>;

export type ClassificationResult = Classification & {
  source: "rule" | "llm";
  needs_review: boolean;
  rule_hit: boolean;
  first_sighting: boolean;
};

interface ClassifyContext {
  // Override the "first sighting" rule (used when reclassifying an existing tx).
  treatAsKnown?: boolean;
}

function buildUserMessage(tx: {
  name: string;
  merchant_name: string | null;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  plaid_category: string | null;
}): string {
  return [
    `Merchant: ${tx.merchant_name ?? tx.name}`,
    `Raw description: ${tx.name}`,
    `Amount: ${tx.amount.toFixed(2)} ${tx.iso_currency_code ?? "USD"}`,
    `Date: ${tx.date}`,
    `Plaid hint (may be wrong): ${tx.plaid_category ?? "none"}`,
  ].join("\n");
}

// Errors thrown by the OpenAI SDK for HTTP failures carry a `status` field. Retrying
// won't help a 4xx — the request itself is wrong. Only retry parse-shape failures.
function isHttpError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number";
}

async function callLlm(userMessage: string): Promise<Classification> {
  const client = moonshot();

  const attempt = async (extraInstruction?: string): Promise<Classification> => {
    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: extraInstruction ? `${userMessage}\n\n${extraInstruction}` : userMessage },
    ];
    const resp = await client.chat.completions.create({
      model: env.MOONSHOT_CLASSIFY_MODEL,
      messages,
      response_format: { type: "json_object" },
    });
    const content = resp.choices[0]?.message?.content;
    if (!content) throw new Error("empty response from classifier");
    const parsed = JSON.parse(content);
    return ClassificationSchema.parse(parsed);
  };

  try {
    return await attempt();
  } catch (err) {
    if (isHttpError(err)) {
      // Don't retry on HTTP errors — same request will fail the same way.
      // eslint-disable-next-line no-console
      console.error("[classifier] HTTP error, falling back to Other:", (err as Error).message);
      return { category: "Other", confidence: 0, reasoning: "fallback after HTTP error" };
    }
    // eslint-disable-next-line no-console
    console.warn("[classifier] parse/validation failure, retrying:", (err as Error).message);
    try {
      return await attempt("Respond ONLY with JSON.");
    } catch (err2) {
      // eslint-disable-next-line no-console
      console.error("[classifier] retry failed, falling back to Other:", (err2 as Error).message);
      return { category: "Other", confidence: 0, reasoning: "fallback after retry failure" };
    }
  }
}

export async function classifyTransaction(
  tx: Pick<
    TransactionRow,
    "name" | "merchant_name" | "amount" | "iso_currency_code" | "date" | "plaid_category"
  >,
  ctx: ClassifyContext = {},
): Promise<ClassificationResult> {
  const rawMerchant = tx.merchant_name ?? tx.name;
  const key = merchantKey(rawMerchant);

  // 1. Rule lookup.
  if (key) {
    const rule = getRule(key);
    if (rule) {
      bumpRuleHit(key);
      const needsReview =
        rule.confidence < env.REVIEW_CONFIDENCE_THRESHOLD ||
        Math.abs(tx.amount) > env.REVIEW_AMOUNT_THRESHOLD;
      return {
        category: rule.category,
        confidence: rule.confidence,
        reasoning: `cached rule (source=${rule.source}, hits=${rule.hit_count + 1})`,
        source: "rule",
        needs_review: needsReview,
        rule_hit: true,
        first_sighting: false,
      };
    }
  }

  // 2. LLM classification.
  let classification: Classification;
  if (isMoonshotConfigured()) {
    classification = await callLlm(buildUserMessage(tx));
  } else {
    classification = {
      category: "Other",
      confidence: 0,
      reasoning: "MOONSHOT_API_KEY not set; defaulted to Other",
    };
  }

  // 3. Persist as a rule (only if we have a real merchant key and Moonshot answered).
  if (key && classification.confidence > 0) {
    upsertRule({
      merchant_key: key,
      category: classification.category,
      confidence: classification.confidence,
      source: "llm",
      sample_name: rawMerchant,
    });
    bumpRuleHit(key);
  }

  const firstSighting = !ctx.treatAsKnown;
  const needsReview =
    classification.confidence < env.REVIEW_CONFIDENCE_THRESHOLD ||
    Math.abs(tx.amount) > env.REVIEW_AMOUNT_THRESHOLD ||
    firstSighting;

  return {
    ...classification,
    source: "llm",
    needs_review: needsReview,
    rule_hit: false,
    first_sighting: firstSighting,
  };
}

// Used when the user manually recategorizes — write a manual rule that overrides future LLM rules.
export function applyManualClassification(input: {
  rawMerchant: string;
  category: Category;
}): void {
  const key = merchantKey(input.rawMerchant);
  if (!key) return;
  upsertRule({
    merchant_key: key,
    category: input.category,
    confidence: 1.0,
    source: "manual",
    sample_name: input.rawMerchant,
  });
}
