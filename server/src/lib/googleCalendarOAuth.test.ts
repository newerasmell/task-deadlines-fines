import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { env } from "./env";
import { signOAuthState, verifyOAuthState } from "./googleCalendarOAuth";

describe("OAuth state token", () => {
  it("round-trips the user id through sign/verify", () => {
    const state = signOAuthState("user_123");
    expect(verifyOAuthState(state)).toBe("user_123");
  });

  it("rejects a token that isn't a valid OAuth-state JWT", () => {
    expect(() => verifyOAuthState("not-a-real-token")).toThrow();
  });

  it("rejects a JWT signed for a different purpose (can't replay a login token as OAuth state)", () => {
    // Simulates a real login JWT — same secret, different payload shape —
    // to confirm verifyOAuthState checks `purpose`, not just the signature.
    const loginToken = jwt.sign({ sub: "user_123", role: "ADMIN", email: "a@b.com", isSuperAdmin: false }, env.jwtSecret);
    expect(() => verifyOAuthState(loginToken)).toThrow();
  });
});
