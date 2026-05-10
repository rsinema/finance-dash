import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { env } from "../env";

let _db: Database | null = null;

export function db(): Database {
  if (_db) return _db;
  const path = isAbsolute(env.DB_PATH) ? env.DB_PATH : resolve(process.cwd(), env.DB_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Database(path, { create: true });
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec("PRAGMA synchronous = NORMAL;");
  conn.exec("PRAGMA busy_timeout = 5000;");
  _db = conn;
  return conn;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
