import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto";

describe("crypto", () => {
  it("round-trips a plaintext string through encrypt/decrypt", () => {
    const plaintext = "1//0abc-some-google-refresh-token-XYZ";
    const stored = encrypt(plaintext);
    expect(decrypt(stored)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encrypt("same value");
    const b = encrypt("same value");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same value");
    expect(decrypt(b)).toBe("same value");
  });

  it("stores as iv:authTag:ciphertext hex triplet", () => {
    const stored = encrypt("x");
    const parts = stored.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-f]{24}$/); // 12-byte IV
  });

  it("rejects a tampered ciphertext (auth tag mismatch)", () => {
    const stored = encrypt("secret");
    const [iv, authTag, ciphertext] = stored.split(":");
    const tampered = `${iv}:${authTag}:${ciphertext.slice(0, -2)}00`;
    expect(() => decrypt(tampered)).toThrow();
  });
});
