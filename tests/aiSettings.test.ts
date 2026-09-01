import { describe, expect, it } from "vitest";

import { validateDeepseekCustomPrompt } from "../netlify/functions/ai-settings";

describe("DeepSeek custom prompt", () => {
  it("normalizes an account prompt and enforces the token-cost guard", () => {
    expect(validateDeepseekCustomPrompt("  重点关注半程马拉松\r\n耐力  ")).toBe("重点关注半程马拉松\n耐力");
    expect(() => validateDeepseekCustomPrompt("x".repeat(1001))).toThrow(/1000/);
    expect(() => validateDeepseekCustomPrompt(null)).toThrow(/格式/);
  });
});
