import { Hono } from "hono";
import { stream } from "hono/streaming";
import { lastSyncByItem } from "../db/queries";
import { syncAllItems, syncItem, classifyUnclassifiedStreaming } from "../services/sync";

export const syncRouter = new Hono();

syncRouter.post("/reclassify-failed", (c) => {
  return stream(c, async (s) => {
    await classifyUnclassifiedStreaming(2000, async (event) => {
      await s.write(JSON.stringify(event) + "\n");
    });
  });
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
