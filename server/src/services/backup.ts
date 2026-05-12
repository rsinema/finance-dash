import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { env } from "../env";
import { db } from "../db";
import {
  isS3Configured,
  pruneS3Backups,
  uploadBackup as s3Upload,
} from "./s3-backup";

const BACKUP_PREFIX = "finance-";
const BACKUP_SUFFIX = ".db";

function backupDir(): string {
  return isAbsolute(env.BACKUP_DIR) ? env.BACKUP_DIR : resolve(process.cwd(), env.BACKUP_DIR);
}

function timestamp(d = new Date()): string {
  // 2026-05-09T04-30-00-123 — filesystem-safe, sorts lexicographically,
  // includes ms to avoid collisions on rapid manual triggers.
  return d.toISOString().slice(0, 23).replace(/[:.]/g, "-");
}

export interface BackupResult {
  path: string;
  bytes: number;
  pruned: number;
  s3?: {
    key: string;
    bytes: number;
    pruned: number;
    error?: string;
  };
}

// SQLite's `VACUUM INTO` writes a consistent snapshot of the live DB to a new file.
// It plays nicely with WAL mode and doesn't block writers for long.
export async function backupNow(): Promise<BackupResult> {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });

  const filename = `${BACKUP_PREFIX}${timestamp()}${BACKUP_SUFFIX}`;
  const target = resolve(dir, filename);

  // Escape single quotes in case the path contains any (unlikely on a sane host).
  const escaped = target.replace(/'/g, "''");
  db().exec(`VACUUM INTO '${escaped}'`);

  const bytes = statSync(target).size;
  const pruned = pruneOldBackups();
  const result: BackupResult = { path: target, bytes, pruned };

  if (isS3Configured()) {
    try {
      const upload = await s3Upload(target);
      const { pruned: s3Pruned } = await pruneS3Backups(env.S3_RETAIN);
      result.s3 = { key: upload.key, bytes: upload.bytes, pruned: s3Pruned };
    } catch (err) {
      const message = (err as Error).message ?? "unknown error";
      result.s3 = { key: "", bytes: 0, pruned: 0, error: message };
      // eslint-disable-next-line no-console
      console.error("[backup] S3 upload failed:", message);
    }
  }

  return result;
}

export interface S3OnlyBackupResult {
  key: string;
  bytes: number;
  pruned: number;
}

// VACUUM INTO a temp file, upload to S3, then delete the temp file.
// Used by the "Back up to S3 now" button — useful when the user wants to push
// a fresh snapshot off-host without consuming local backup-retention slots.
export async function backupS3Only(): Promise<S3OnlyBackupResult> {
  if (!isS3Configured()) {
    throw new Error("S3 is not configured (S3_BUCKET is unset)");
  }

  const filename = `${BACKUP_PREFIX}${timestamp()}${BACKUP_SUFFIX}`;
  const target = resolve(tmpdir(), filename);
  const escaped = target.replace(/'/g, "''");
  db().exec(`VACUUM INTO '${escaped}'`);

  try {
    const upload = await s3Upload(target);
    const { pruned } = await pruneS3Backups(env.S3_RETAIN);
    return { key: upload.key, bytes: upload.bytes, pruned };
  } finally {
    try {
      unlinkSync(target);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[backup] failed to remove temp snapshot ${target}:`, (err as Error).message);
    }
  }
}

function pruneOldBackups(): number {
  const dir = backupDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const backups = entries
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .sort(); // ascending = oldest first

  const excess = backups.length - env.BACKUP_RETAIN;
  if (excess <= 0) return 0;

  let pruned = 0;
  for (let i = 0; i < excess; i++) {
    try {
      unlinkSync(resolve(dir, backups[i]!));
      pruned += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[backup] failed to prune ${backups[i]}:`, (err as Error).message);
    }
  }
  return pruned;
}

export function listBackups(): Array<{ name: string; bytes: number; mtime: number }> {
  const dir = backupDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .map((name) => {
      const stat = statSync(resolve(dir, name));
      return { name, bytes: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

if (import.meta.main) {
  const result = await backupNow();
  // eslint-disable-next-line no-console
  console.log(`[backup] wrote ${result.path} (${result.bytes} bytes, pruned ${result.pruned})`);
  if (result.s3) {
    // eslint-disable-next-line no-console
    console.log(
      result.s3.error
        ? `[backup] S3 upload FAILED: ${result.s3.error}`
        : `[backup] S3 uploaded ${result.s3.key} (pruned ${result.s3.pruned})`,
    );
  }
}
