import { describe, expect, it } from "vitest";
import { comparePassword, createSessionToken, hashPassword, verifySessionToken } from "../netlify/functions/_shared/auth";

describe("auth helpers", () => {
  it("hashes and compares passwords", async () => {
    const hash = await hashPassword("secret123");
    expect(hash).not.toBe("secret123");
    expect(await comparePassword("secret123", hash)).toBe(true);
    expect(await comparePassword("wrong", hash)).toBe(false);
  });

  it("creates and verifies session tokens", () => {
    const token = createSessionToken("fish", "test-secret");
    expect(verifySessionToken(token, "test-secret")?.sub).toBe("fish");
    expect(verifySessionToken(token, "other-secret")).toBeNull();
  });
});
