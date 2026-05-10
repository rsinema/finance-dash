import { Hono } from "hono";
import { db } from "../db";

export const healthRouter = new Hono();

healthRouter.get("/", (c) => {
  let dbOk = false;
  try {
    db().query("SELECT 1").get();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return c.json({
    ok: dbOk,
    db: dbOk,
    timestamp: Date.now(),
  });
});
