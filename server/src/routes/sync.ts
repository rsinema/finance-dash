import { Hono } from "hono";
import { lastSyncByItem } from "../db/queries";
import { syncAllItems, syncItem, classifyUnclassified } from "../services/sync";

export const syncRouter = new Hono();

syncRouter.post("/reclassify-failed", async (c) => {
  const result = await classifyUnclassified(2000);
  return c.json(result);
});

syncRouter.post("/", async (c) => {
  const itemId = c.req.query("itemId");
  if (itemId) {
    const result = await syncItem(itemId);
    return c.json({ results: [result] });
  }
  const results = await syncAllItems();
  return c.json({ results });
});

syncRouter.get("/status", (c) => {
  const rows = lastSyncByItem();
  return c.json({ items: rows });
});
