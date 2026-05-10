import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { stream } from "hono/streaming";
import { runAgent } from "../services/agent";

export const agentRouter = new Hono();

const Body = z.object({
  question: z.string().min(1).max(2000),
});

agentRouter.post("/query", zValidator("json", Body), async (c) => {
  const { question } = c.req.valid("json");
  return stream(c, async (s) => {
    await runAgent(question, async (event) => {
      await s.write(JSON.stringify(event) + "\n");
    });
  });
});
