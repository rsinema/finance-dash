import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { CATEGORIES } from "../lib/categories";
import { deleteRule, getRule, listRules, upsertRule } from "../db/queries";

export const rulesRouter = new Hono();

rulesRouter.get("/", (c) => {
  return c.json({ rules: listRules() });
});

const PatchBody = z.object({
  category: z.enum(CATEGORIES),
});

rulesRouter.patch("/:key", zValidator("json", PatchBody), (c) => {
  const key = decodeURIComponent(c.req.param("key"));
  const existing = getRule(key);
  if (!existing) return c.json({ error: "not_found" }, 404);
  const { category } = c.req.valid("json");
  upsertRule({
    merchant_key: key,
    category,
    confidence: 1.0,
    source: "manual",
    sample_name: existing.sample_name,
  });
  return c.json({ ok: true });
});

rulesRouter.delete("/:key", (c) => {
  const key = decodeURIComponent(c.req.param("key"));
  deleteRule(key);
  return c.json({ ok: true });
});
