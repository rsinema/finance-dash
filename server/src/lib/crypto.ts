// AES-GCM encryption for at-rest secrets (Plaid access tokens).
// Key is derived from ENCRYPTION_KEY env var (base64, 32 bytes / 256 bits).
//
// Stored format: base64( iv(12 bytes) || ciphertext+tag )
// If ENCRYPTION_KEY is unset, fall back to a development passthrough that
// prefixes "plain:" — explicit so it's grep-able in the DB.

import { env } from "../env";

let keyPromise: Promise<CryptoKey> | null = null;

function decodeKey(): Uint8Array | null {
  const raw = env.ENCRYPTION_KEY.trim();
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length !== 32) {
      throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${decoded.length}`);
    }
    return decoded;
  } catch (err) {
    throw new Error(`Failed to decode ENCRYPTION_KEY as base64: ${(err as Error).message}`);
  }
}

async function getKey(): Promise<CryptoKey | null> {
  if (!keyPromise) {
    const raw = decodeKey();
    if (!raw) return null;
    keyPromise = crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }
  return keyPromise;
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getKey();
  if (!key) return `plain:${plaintext}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const out = new Uint8Array(iv.length + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(out).toString("base64");
}

export async function decryptSecret(stored: string): Promise<string> {
  if (stored.startsWith("plain:")) return stored.slice("plain:".length);
  const key = await getKey();
  if (!key) {
    throw new Error("ENCRYPTION_KEY required to decrypt stored secret");
  }
  const buf = Buffer.from(stored, "base64");
  if (buf.length < 13) throw new Error("Encrypted secret is malformed");
  const iv = buf.subarray(0, 12);
  const ct = buf.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export function generateEncryptionKeyB64(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}
