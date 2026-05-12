import { Hono } from "hono";
import pkg from "../../package.json";

export const versionRouter = new Hono();

versionRouter.get("/", (c) => {
  return c.json({ version: (pkg as { version: string }).version });
});
