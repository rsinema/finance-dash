import { Hono } from "hono";
import { backupNow, listBackups } from "../services/backup";
import { isS3Configured, listS3Backups } from "../services/s3-backup";
import { env } from "../env";

export const backupRouter = new Hono();

backupRouter.get("/", async (c) => {
  const local = listBackups();
  let s3: {
    enabled: boolean;
    bucket: string;
    prefix: string;
    backups: Array<{ key: string; filename: string; bytes: number; lastModified: number | null }>;
    error?: string;
  } = {
    enabled: isS3Configured(),
    bucket: env.S3_BUCKET,
    prefix: env.S3_PREFIX,
    backups: [],
  };
  if (isS3Configured()) {
    try {
      s3.backups = await listS3Backups();
    } catch (err) {
      s3.error = (err as Error).message;
    }
  }
  return c.json({ local, s3 });
});

backupRouter.post("/", async (c) => {
  const result = await backupNow();
  return c.json(result);
});
