// Zero-knowledge vault crypto — every function here runs entirely in the
// browser via the native Web Crypto API (no npm dependency, nothing to
// audit beyond this file). Nothing exported from this module should ever
// be sent to the server except the return values explicitly documented as
// "safe to send" below — those are ciphertext, salts, IVs and public keys,
// none of which are useful without a master password that never leaves
// the browser.
//
// Shape (see prisma/schema.prisma's VaultUserKey/VaultTableMember comments
// for the full picture): each table gets its own random AES-256 "table
// key" (TK), generated once and never stored anywhere in the clear. Each
// member of a table gets TK wrapped (RSA-OAEP encrypted) under THEIR OWN
// public key — a keypair they generated once, themselves, when they set
// up their personal master password. Granting someone access therefore
// never requires their password, or their presence: only their public key,
// which the server can hand out freely since it isn't secret.

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

// A table key (TK) — generated once, ever, per table, by whichever admin
// creates it. Extractable, since it has to be exported to be wrapped (RSA-
// OAEP, to each member's public key) — but it is NEVER sent to the server
// in this exported form, only its wrapped (encrypted) form.
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

// Safe to send to the server: ciphertext of a vault entry's JSON, under TK.
export async function encryptJson(vaultKey: CryptoKey, value: unknown): Promise<{ ciphertext: string; iv: string }> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  return encryptBytes(vaultKey, data.buffer as ArrayBuffer);
}

export async function decryptJson<T>(vaultKey: CryptoKey, ciphertext: string, iv: string): Promise<T> {
  const raw = await decryptBytes(vaultKey, ciphertext, iv);
  return JSON.parse(new TextDecoder().decode(raw)) as T;
}

const RSA_OAEP_PARAMS = { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;

// Generated once, ever, by each person themselves when they set up their
// personal vault password — see the VaultUserKey comment in
// prisma/schema.prisma. The public half gets uploaded in the clear (it
// isn't secret); the private half never leaves this function un-wrapped.
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(RSA_OAEP_PARAMS, true, ["wrapKey", "unwrapKey"]);
}

// Safe to send to the server: a public key is not secret by definition.
export async function exportPublicKeyB64(publicKey: CryptoKey): Promise<string> {
  return toBase64(await crypto.subtle.exportKey("spki", publicKey));
}

export async function importPublicKeyB64(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", fromBase64(b64), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["wrapKey"]);
}

// Safe to send to the server: ciphertext of this person's own private key,
// under their own stretched master key — only their own browser, after
// they type their own password, can ever decrypt it.
export async function wrapPrivateKey(
  privateKey: CryptoKey,
  wrappingKey: CryptoKey
): Promise<{ wrappedPrivateKey: string; wrappedPrivateKeyIv: string }> {
  const raw = await crypto.subtle.exportKey("pkcs8", privateKey);
  const { ciphertext, iv } = await encryptBytes(wrappingKey, raw);
  return { wrappedPrivateKey: ciphertext, wrappedPrivateKeyIv: iv };
}

// Throws on a wrong master password (see decryptBytes above) — this is how
// "unlock the vault" verifies a typed password without any separate
// verifier ever being stored.
export async function unwrapPrivateKey(wrappedPrivateKey: string, wrappedPrivateKeyIv: string, wrappingKey: CryptoKey): Promise<CryptoKey> {
  const raw = await decryptBytes(wrappingKey, wrappedPrivateKey, wrappedPrivateKeyIv);
  return crypto.subtle.importKey("pkcs8", raw, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["unwrapKey"]);
}

// Safe to send to the server: ciphertext of TK, under the RECIPIENT's own
// public key — this is the entire "grant access" operation. The granter
// never needs the recipient's password, or even their presence, to do
// this; only their public key, fetched from the server.
export async function wrapTableKey(tableKey: CryptoKey, recipientPublicKey: CryptoKey): Promise<string> {
  const wrapped = await crypto.subtle.wrapKey("raw", tableKey, recipientPublicKey, { name: "RSA-OAEP" });
  return toBase64(wrapped);
}

// Throws if wrappedKeyB64 wasn't wrapped to the public key matching this
// private key.
export async function unwrapTableKey(wrappedKeyB64: string, myPrivateKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    fromBase64(wrappedKeyB64),
    myPrivateKey,
    { name: "RSA-OAEP" },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}
