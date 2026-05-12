import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
  type StorageClass,
} from "@aws-sdk/client-s3";
import { readFileSync, createWriteStream } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../env";

let _client: S3Client | null = null;

export function isS3Configured(): boolean {
  return env.S3_BUCKET.trim().length > 0;
}

function s3(): S3Client {
  if (_client) return _client;
  if (!isS3Configured()) {
    throw new Error("S3_BUCKET is not configured");
  }
  const region = env.S3_REGION || env.AWS_REGION || "us-east-1";
  _client = new S3Client({
    region,
    endpoint: env.S3_ENDPOINT_URL || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
  return _client;
}

function normalizedPrefix(): string {
  // Always end with a single slash unless empty.
  const raw = env.S3_PREFIX.replace(/^\/+|\/+$/g, "");
  return raw ? `${raw}/` : "";
}

function s3Key(filename: string): string {
  return `${normalizedPrefix()}${filename}`;
}

export interface S3UploadResult {
  key: string;
  bytes: number;
  etag: string | undefined;
}

export async function uploadBackup(localPath: string): Promise<S3UploadResult> {
  const filename = basename(localPath);
  const key = s3Key(filename);
  // Buffer body (not createReadStream) — Bun's node:fs streams can terminate
  // before all bytes flush to the AWS SDK's HTTP handler, causing S3 to reject
  // the request with IncompleteBody when the declared ContentLength isn't met.
  // Loading into memory is fine for SQLite backups (single- to low-hundreds-of-MB).
  const body = readFileSync(localPath);
  const bytes = body.byteLength;
  const resp = await s3().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentLength: bytes,
      ContentType: "application/octet-stream",
      ServerSideEncryption: "AES256",
      StorageClass: env.S3_STORAGE_CLASS as StorageClass,
    }),
  );
  return { key, bytes, etag: resp.ETag };
}

export interface S3BackupEntry {
  key: string;
  filename: string;
  bytes: number;
  lastModified: number | null;
}

export async function listS3Backups(): Promise<S3BackupEntry[]> {
  const prefix = normalizedPrefix();
  const out: S3BackupEntry[] = [];
  let continuationToken: string | undefined;
  do {
    const resp = await s3().send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      const filename = obj.Key.slice(prefix.length);
      // Only count our own snapshots — never touch unrelated objects in the bucket.
      if (!filename.startsWith("finance-") || !filename.endsWith(".db")) continue;
      out.push({
        key: obj.Key,
        filename,
        bytes: obj.Size ?? 0,
        lastModified: obj.LastModified ? obj.LastModified.getTime() : null,
      });
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  // Newest first.
  out.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
  return out;
}

export async function pruneS3Backups(retain: number): Promise<{ pruned: number }> {
  const all = await listS3Backups();
  if (all.length <= retain) return { pruned: 0 };
  const toDelete = all.slice(retain);
  // S3 caps DeleteObjects at 1000 keys per request; chunk just in case.
  let pruned = 0;
  for (let i = 0; i < toDelete.length; i += 1000) {
    const chunk = toDelete.slice(i, i + 1000);
    const resp = await s3().send(
      new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET,
        Delete: {
          Objects: chunk.map((b) => ({ Key: b.key })),
          Quiet: true,
        },
      }),
    );
    pruned += chunk.length - (resp.Errors?.length ?? 0);
    if (resp.Errors && resp.Errors.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[s3-backup] ${resp.Errors.length} delete error(s):`,
        resp.Errors.map((e) => `${e.Key}: ${e.Code}`).join(", "),
      );
    }
  }
  return { pruned };
}

export async function downloadBackup(key: string, destPath: string): Promise<void> {
  const resp = await s3().send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
  if (!resp.Body) {
    throw new Error(`S3 object ${key} returned an empty body`);
  }
  // Body is a Node Readable in the Node SDK.
  const stream = resp.Body as Readable;
  await pipeline(stream, createWriteStream(destPath));
}
