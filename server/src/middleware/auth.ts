import type { MiddlewareHandler } from "hono";
import { env } from "../env";

// Bearer-token middleware. No-op if APP_AUTH_TOKEN is unset (default for v1, intended
// for Tailscale-only access). Set APP_AUTH_TOKEN to require Authorization: Bearer <token>.
export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const expected = env.APP_AUTH_TOKEN.trim();
  if (!expected) return next();

  const header = c.req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};
