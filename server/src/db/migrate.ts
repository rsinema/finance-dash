import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./index";

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = resolve(__filename, "../migrations");

export function runMigrations(): { applied: string[] } {
  const conn = db();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set<string>(
    conn.query<{ name: string }, []>("SELECT name FROM _migrations").all().map((r) => r.name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied: string[] = [];
  const insertMigration = conn.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    conn.transaction(() => {
      conn.exec(sql);
      insertMigration.run(file, Date.now());
    })();
    newlyApplied.push(file);
    // eslint-disable-next-line no-console
    console.log(`[migrate] applied ${file}`);
  }

  if (newlyApplied.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[migrate] no pending migrations");
  }
  return { applied: newlyApplied };
}

if (import.meta.main) {
  runMigrations();
  process.exit(0);
}
