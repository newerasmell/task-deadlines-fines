// Zero-knowledge vault crypto — every function here runs entirely in the
// browser via the native Web Crypto API (no npm dependency, nothing to
// audit beyond this file). Nothing exported from this module should ever
// be sent to the server except the return values explicitly documented as
// "safe to send" below — those are ciphertext, salts and IVs, which are
// meaningless without a master password that never leaves the browser.
//
// Shape (see prisma/schema.prisma's VaultKeyWrap comment for the full
// picture): one random AES-256 "vault key" (VK) is generated once and
// never stored anywhere in the clear. Each admin gets VK "wrapped"
// (encrypted) under a key derived from THEIR OWN master password via
// PBKDF2 — so N admins can each use a different password to recover the
// same VK, which is what actually encrypts/decrypts every vault entry.

export const PBKDF2_ITERATIONS = 600_000;

function toBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function generateSaltB64(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

// Derives this admin's "stretched master key" from their password + their
// own salt. Non-extractable: it's only ever used to encrypt/decrypt in
// place, never exported, so there's no reason to allow pulling its raw
// bytes back out of the SubtleCrypto API.
export async function deriveStretchedKey(password: string, saltB64: string, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: fromBase64(saltB64), iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// The one real vault key (VK) — generated once, ever, by whichever admin
// runs vault setup. Extractable, since it has to be exported to be wrapped
// (and re-wrapped for each newly granted admin) — but it is NEVER sent to
// the server in this exported form, only its wrapped (encrypted) form.
export async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function encryptBytes(key: CryptoKey, data: ArrayBuffer): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { ciphertext: toBase64(ct), iv: toBase64(iv.buffer) };
}

// Throws (DOMException) on a GCM authentication-tag mismatch — that failure
// IS the "wrong master password" signal everywhere in this app; there is no
// separately stored verifier to check against.
async function decryptBytes(key: CryptoKey, ciphertextB64: string, ivB64: string): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(ivB64) }, key, fromBase64(ciphertextB64));
}

// Safe to send to the server: ciphertext of VK's raw bytes, under this
// admin's own stretched master key.
export async function wrapVaultKey(
  vaultKey: CryptoKey,
  wrappingKey: CryptoKey
): Promise<{ wrappedKey: string; wrappedKeyIv: string }> {
  const raw = await crypto.subtle.exportKey("raw", vaultKey);
  const { ciphertext, iv } = await encryptBytes(wrappingKey, raw);
  return { wrappedKey: ciphertext, wrappedKeyIv: iv };
}

// Throws on a wrong master password (see decryptBytes above).
export async function unwrapVaultKey(wrappedKey: string, wrappedKeyIv: string, wrappingKey: CryptoKey): Promise<CryptoKey> {
  const raw = await decryptBytes(wrappingKey, wrappedKey, wrappedKeyIv);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

// Safe to send to the server: ciphertext of a vault entry's JSON, under VK.
export async function encryptJson(vaultKey: CryptoKey, value: unknown): Promise<{ ciphertext: string; iv: string }> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  return encryptBytes(vaultKey, data.buffer as ArrayBuffer);
}

export async function decryptJson<T>(vaultKey: CryptoKey, ciphertext: string, iv: string): Promise<T> {
  const raw = await decryptBytes(vaultKey, ciphertext, iv);
  return JSON.parse(new TextDecoder().decode(raw)) as T;
}
