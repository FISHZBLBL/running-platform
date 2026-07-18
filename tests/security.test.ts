import { afterEach, describe, expect, it } from "vitest";
import { inviteCode } from "../netlify/functions/_shared/env";
import { requireJsonRequest, requireSameOrigin } from "../netlify/functions/_shared/responses";
import auth, { config as authConfig } from "../netlify/functions/auth";
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

  it("uses one rate-limit rule for all authentication actions and one for uploads", () => {
    expect(authConfig.path).toBe("/api/auth/:action");
    expect(authConfig.rateLimit).toMatchObject({ windowLimit: 10, windowSize: 60 });
    expect(uploadConfig.rateLimit).toMatchObject({ windowLimit: 12, windowSize: 60 });
  });

  it("logs out through the consolidated authentication route", async () => {
    const response = await auth(
      new Request("https://running-platform.netlify.app/api/auth/logout", {
        method: "POST",
        headers: { Origin: "https://running-platform.netlify.app" }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
