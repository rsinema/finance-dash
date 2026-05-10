// Walks up from cwd looking for .env files and loads them into process.env.
//
// Bun auto-loads .env from the nearest package.json directory, which in a workspace
// monorepo is the workspace dir (server/) — not the repo root where .env actually lives.
// This walker covers that gap. Existing process.env values always win, so explicit
// shell exports continue to take precedence.

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  // Strip surrounding quotes if balanced.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  // Strip inline comments after unquoted values.
  else {
    const hashIdx = value.indexOf(" #");
    if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
  }
  return [key, value];
}

function loadFile(path: string): void {
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    // Don't clobber values already set by the shell or by Bun's auto-loader.
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function loadEnvWalkingUp(filenames: string[] = [".env"]): string[] {
  const loaded: string[] = [];
  let dir = process.cwd();
  // Stop at filesystem root.
  while (true) {
    for (const name of filenames) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate) && !loaded.includes(candidate)) {
        loadFile(candidate);
        loaded.push(candidate);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return loaded;
}
