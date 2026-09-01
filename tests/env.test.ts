import { afterEach, describe, expect, it } from "vitest";

import { jwtSecret } from "../netlify/functions/_shared/env";

const watchedVariables = [
  "JWT_SECRET",
  "NETLIFY_DEV",
  "AWS_LAMBDA_FUNCTION_NAME",
  "CONTEXT",
] as const;

const originalEnvironment = Object.fromEntries(
  watchedVariables.map((name) => [name, process.env[name]])
);

afterEach(() => {
  for (const name of watchedVariables) {
    const originalValue = originalEnvironment[name];
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }
});

describe("jwtSecret", () => {
  it("uses the development secret inside Netlify's local function runtime", () => {
    delete process.env.JWT_SECRET;
    delete process.env.CONTEXT;
    process.env.NETLIFY_DEV = "true";
    process.env.AWS_LAMBDA_FUNCTION_NAME = "ai-settings";

    expect(jwtSecret()).toBe("dev-only-running-platform-secret");
  });

  it("still requires an explicit secret in production", () => {
    delete process.env.JWT_SECRET;
    delete process.env.NETLIFY_DEV;
    process.env.CONTEXT = "production";

    expect(() => jwtSecret()).toThrow(
      "JWT_SECRET must be configured in production."
    );
  });
});
