import { z } from "zod";
import { loadEnvWalkingUp } from "./lib/load-env";

// Load .env from cwd or any parent directory (Bun's auto-loader only checks the workspace
// root — server/ — but the file lives at the repo root in this monorepo).
const loadedFiles = loadEnvWalkingUp([".env.local", ".env"]);
if (loadedFiles.length > 0 && process.env.DEBUG_ENV) {
  // eslint-disable-next-line no-console
  console.log("[env] loaded:", loadedFiles.join(", "));
}

const EnvSchema = z.object({
  PLAID_CLIENT_ID: z.string().default(""),
  PLAID_SECRET: z.string().default(""),
  PLAID_ENV: z.enum(["sandbox", "development", "production"]).default("sandbox"),
  PLAID_PRODUCTS: z.string().default("transactions"),
  PLAID_COUNTRY_CODES: z.string().default("US"),
  PLAID_REDIRECT_URI: z.string().default(""),

  MOONSHOT_API_KEY: z.string().default(""),
  MOONSHOT_BASE_URL: z.string().default("https://api.moonshot.ai/v1"),
  MOONSHOT_CLASSIFY_MODEL: z.string().default("kimi-k2-turbo-preview"),
  MOONSHOT_AGENT_MODEL: z.string().default("kimi-k2.6"),

  DB_PATH: z.string().default("./data/finance.db"),
  ENCRYPTION_KEY: z.string().default(""),
  PORT: z.coerce.number().int().positive().default(8090),
  TZ: z.string().default("America/Denver"),
  REVIEW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  REVIEW_AMOUNT_THRESHOLD: z.coerce.number().nonnegative().default(200),
  SYNC_CRON: z.string().default("0 4 * * *"),
  SYNC_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),

  BACKUP_DIR: z.string().default("./data/backups"),
  BACKUP_CRON: z.string().default("30 4 * * *"),
  BACKUP_RETAIN: z.coerce.number().int().min(1).max(365).default(14),
  BACKUP_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),

  S3_BUCKET: z.string().default(""),
  S3_PREFIX: z.string().default("finance-dash/"),
  S3_REGION: z.string().default(""),
  S3_ENDPOINT_URL: z.string().default(""),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  S3_RETAIN: z.coerce.number().int().min(1).max(3650).default(90),
  S3_STORAGE_CLASS: z
    .enum([
      "STANDARD",
      "STANDARD_IA",
      "INTELLIGENT_TIERING",
      "ONEZONE_IA",
      "GLACIER_IR",
      "GLACIER",
      "DEEP_ARCHIVE",
      "REDUCED_REDUNDANCY",
    ])
    .default("STANDARD"),
  AWS_REGION: z.string().default(""),

  APP_AUTH_TOKEN: z.string().default(""),
  NODE_ENV: z.string().default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;

export function plaidProductsArray(): string[] {
  return env.PLAID_PRODUCTS.split(",").map((s) => s.trim()).filter(Boolean);
}

export function plaidCountriesArray(): string[] {
  return env.PLAID_COUNTRY_CODES.split(",").map((s) => s.trim()).filter(Boolean);
}
