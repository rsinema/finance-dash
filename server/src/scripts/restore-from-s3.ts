// Restore a SQLite snapshot from S3 to a local file.
//
// Usage:
//   bun run server/src/scripts/restore-from-s3.ts                # downloads newest backup to ./data/restore.db
//   bun run server/src/scripts/restore-from-s3.ts <key>          # downloads specific S3 key
//   bun run server/src/scripts/restore-from-s3.ts <key> <dest>   # downloads to <dest>
//
// IMPORTANT: this never overwrites the live DB automatically. After downloading,
// stop the server, replace data/finance.db with the restored file, and start it again.

import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { downloadBackup, isS3Configured, listS3Backups } from "../services/s3-backup";
import { env } from "../env";

async function main(): Promise<void> {
  if (!isS3Configured()) {
    console.error("S3_BUCKET is not configured. Set it in .env first.");
    process.exit(1);
  }

  const [keyArg, destArg] = process.argv.slice(2);
  let key = keyArg;
  if (!key) {
    const all = await listS3Backups();
    if (all.length === 0) {
      console.error("No S3 backups found under prefix", env.S3_PREFIX);
      process.exit(1);
    }
    key = all[0]!.key;
    console.log(`[restore] using newest S3 backup: ${key}`);
  }

  const dest = resolve(destArg ?? "./data/restore.db");
  if (existsSync(dest)) {
    console.error(`[restore] refusing to overwrite existing file: ${dest}`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });

  console.log(`[restore] downloading s3://${env.S3_BUCKET}/${key} → ${dest}`);
  await downloadBackup(key, dest);
  console.log(`[restore] done.\n`);
  console.log("Next steps:");
  console.log("  1. Stop the server (docker compose down or kill the bun process).");
  console.log(`  2. Move the live DB aside:  mv data/finance.db data/finance.db.bak`);
  console.log(`  3. Move the restored file:  mv ${dest} data/finance.db`);
  console.log(
    "  4. Delete any leftover WAL/SHM:  rm -f data/finance.db-shm data/finance.db-wal",
  );
  console.log("  5. Start the server again. It will recreate WAL/SHM as needed.");
}

main().catch((err) => {
  console.error("[restore] failed:", err);
  process.exit(1);
});
