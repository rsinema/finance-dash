import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { CATEGORIES } from "../lib/categories";
import {
  clearNeedsReview,
  getTransaction,
  queryTransactions,
  setTransactionClassification,
} from "../db/queries";
import { applyManualClassification, classifyTransaction } from "../services/classifier";

export const transactionsRouter = new Hono();

const ListQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  category: z.string().optional(),
  account: z.string().optional(),
  search: z.string().optional(),
  review: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

transactionsRouter.get("/", zValidator("query", ListQuery), (c) => {
  const params = c.req.valid("query");
  const result = queryTransactions(params);
  return c.json({
    transactions: result.rows,
    total: result.total,
    limit: params.limit ?? 100,
    offset: params.offset ?? 0,
  });
});

transactionsRouter.get("/:id", (c) => {
  const tx = getTransaction(c.req.param("id"));
  if (!tx) return c.json({ error: "not_found" }, 404);
  return c.json(tx);
});

const PatchBody = z.object({
  category: z.enum(CATEGORIES),
});

transactionsRouter.patch("/:id", zValidator("json", PatchBody), (c) => {
  const id = c.req.param("id");
  const tx = getTransaction(id);
  if (!tx) return c.json({ error: "not_found" }, 404);
  const { category } = c.req.valid("json");

  setTransactionClassification({
    id,
    category,
    confidence: 1.0,
    source: "manual",
    needs_review: false,
    reviewed_at: Date.now(),
  });
  applyManualClassification({
    rawMerchant: tx.merchant_name ?? tx.name,
    category,
  });
  return c.json({ ok: true });
});

transactionsRouter.post("/:id/accept", (c) => {
  const id = c.req.param("id");
  const tx = getTransaction(id);
  if (!tx) return c.json({ error: "not_found" }, 404);
  clearNeedsReview(id);
  return c.json({ ok: true });
});

transactionsRouter.post("/:id/reclassify", async (c) => {
  const id = c.req.param("id");
  const tx = getTransaction(id);
  if (!tx) return c.json({ error: "not_found" }, 404);

  const classification = await classifyTransaction(tx, { treatAsKnown: true });
  setTransactionClassification({
    id,
    category: classification.category,
    confidence: classification.confidence,
    source: classification.source,
    needs_review: classification.needs_review,
  });
  return c.json({ ok: true, classification });
});
