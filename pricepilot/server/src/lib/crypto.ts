import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env } from "./env";

// AES-256-GCM at rest for Shopify admin API tokens. ENCRYPTION_KEY is a
// 64-char hex string (32 bytes) — see .env.example for how to generate one.
// Stored format: "<iv-hex>:<authTag-hex>:<ciphertext-hex>", so a single
// text column holds everything decrypt() needs.
const ALGO = "aes-256-gcm";

function key(): Buffer {
  const buf = Buffer.from(env.encryptionKey, "hex");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return buf;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decrypt(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted value");
  }
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}
