import { afterEach, describe, expect, it } from "vitest";
import { inviteCode } from "../netlify/functions/_shared/env";
import { requireJsonRequest, requireSameOrigin } from "../netlify/functions/_shared/responses";
import { config as authConfig } from "../netlify/functions/auth";
import { config as uploadConfig } from "../netlify/functions/uploads";

const originalInviteCode = process.env.INVITE_CODE;

afterEach(() => {
  if (originalInviteCode === undefined) {
    delete process.env.INVITE_CODE;
  } else {
    process.env.INVITE_CODE = originalInviteCode;
  }
});

describe("production request security", () => {
  it("requires an explicitly configured invite code", () => {
    delete process.env.INVITE_CODE;
    expect(() => inviteCode()).toThrow(/INVITE_CODE/);
    process.env.INVITE_CODE = "private-test-code";
    expect(inviteCode()).toBe("private-test-code");
  });

  it("accepts only same-origin JSON authentication requests", () => {
    const valid = new Request("https://running-platform.netlify.app/api/auth/login", {
      method: "POST",
      headers: { Origin: "https://running-platform.netlify.app", "Content-Type": "application/json; charset=utf-8" }
    });
    expect(() => requireSameOrigin(valid)).not.toThrow();
    expect(() => requireJsonRequest(valid)).not.toThrow();

    const crossSite = new Request("https://running-platform.netlify.app/api/auth/login", {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }
    });
    expect(() => requireSameOrigin(crossSite)).toThrow(/来源/);

    const formPost = new Request("https://running-platform.netlify.app/api/auth/login", {
      method: "POST",
      headers: { Origin: "https://running-platform.netlify.app", "Content-Type": "application/x-www-form-urlencoded" }
    });
    expect(() => requireJsonRequest(formPost)).toThrow(/application\/json/);
  });

  it("defines edge rate limits for login, registration and screenshot uploads", () => {
    expect(authConfig.path).toEqual(["/api/auth/login", "/api/auth/register"]);
    expect(authConfig.rateLimit).toMatchObject({ windowLimit: 10, windowSize: 60 });
    expect(uploadConfig.rateLimit).toMatchObject({ windowLimit: 12, windowSize: 60 });
  });
});
