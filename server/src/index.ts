import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "./env";
import { runMigrations } from "./db/migrate";
import { bearerAuth } from "./middleware/auth";
import { healthRouter } from "./routes/health";
import { plaidRouter } from "./routes/plaid";
import { syncRouter } from "./routes/sync";
import { transactionsRouter } from "./routes/transactions";
import { summaryRouter } from "./routes/summary";
import { rulesRouter } from "./routes/rules";
import { agentRouter } from "./routes/agent";
import { backupRouter } from "./routes/backup";
import { startCron } from "./services/cron";

runMigrations();

const app = new Hono();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: (origin) => origin ?? "*",
    credentials: false,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use("/api/*", bearerAuth);

app.route("/api/health", healthRouter);
app.route("/api/plaid", plaidRouter);
app.route("/api/sync", syncRouter);
app.route("/api/transactions", transactionsRouter);
app.route("/api/summary", summaryRouter);
app.route("/api/rules", rulesRouter);
app.route("/api/agent", agentRouter);
app.route("/api/backups", backupRouter);

app.onError((err, c) => {
  // Axios errors (e.g. from the Plaid SDK) carry the upstream response on err.response.
  // Surface that body so client-side banners show the real cause instead of "Request failed
  // with status code 400".
  const ax = err as {
    isAxiosError?: boolean;
    response?: { status?: number; data?: { error_message?: string; error_code?: string; error_type?: string } };
  };
  if (ax.isAxiosError && ax.response) {
    const data = ax.response.data ?? {};
    // eslint-disable-next-line no-console
    console.error(
      `[error] upstream ${ax.response.status}: ${data.error_code ?? "?"} — ${data.error_message ?? "(no message)"}`,
    );
    return c.json(
      {
        error: data.error_message ?? err.message ?? "upstream_error",
        error_code: data.error_code,
        error_type: data.error_type,
        upstream_status: ax.response.status,
      },
      (ax.response.status ?? 500) as 400 | 401 | 403 | 404 | 409 | 422 | 500,
    );
  }
  // eslint-disable-next-line no-console
  console.error("[error]", err);
  const status = (err as { status?: number }).status ?? 500;
  return c.json(
    { error: err.message || "internal_error" },
    status as 400 | 401 | 403 | 404 | 409 | 422 | 500,
  );
});

// Serve frontend in production. In dev, Vite handles the UI on its own port.
const webDist = resolve(import.meta.dir, "../../web/dist");
if (existsSync(webDist)) {
  app.get(
    "*",
    serveStatic({
      root: "./web/dist",
      rewriteRequestPath: (path) => path,
    }),
  );
  // SPA fallback for client-side routes.
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));
}

if (env.SYNC_ENABLED || env.BACKUP_ENABLED) {
  startCron();
}

if (!env.ENCRYPTION_KEY.trim()) {
  // eslint-disable-next-line no-console
  console.warn(
    "[server] WARNING: ENCRYPTION_KEY is unset. Plaid access tokens will be stored in plaintext.\n" +
      "         Generate one with: bun -e \"console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))\"",
  );
}
if (!env.MOONSHOT_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    "[server] MOONSHOT_API_KEY is unset. Transactions will fall back to category 'Other' until set.",
  );
}

// eslint-disable-next-line no-console
console.log(`[server] listening on :${env.PORT} (env=${env.NODE_ENV}, plaid=${env.PLAID_ENV})`);

export default {
  port: env.PORT,
  fetch: app.fetch,
};
