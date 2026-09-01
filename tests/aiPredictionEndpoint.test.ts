import { describe, expect, it, vi } from "vitest";

vi.mock("../netlify/functions/_shared/session", () => ({
  requireAiUsername: () => "runner"
}));

vi.mock("../netlify/functions/_shared/data", () => ({
  getAiDeepAnalysis: vi.fn(async () => null),
  getAiPrediction: vi.fn(async () => null),
  getDeepseekSecret: vi.fn(async () => ({ updatedAt: "key-version" })),
  getDeepseekCustomPrompt: vi.fn(async () => ""),
  getRunnerProfile: vi.fn(async () => null),
  listRuns: vi.fn(async () => []),
  listWeights: vi.fn(async () => []),
  saveAiDeepAnalysis: vi.fn(async () => undefined),
  saveAiPrediction: vi.fn(async () => undefined),
  withAiPredictionLock: vi.fn(async (_username, _target, task) => task())
}));

vi.mock("../netlify/functions/_shared/secrets", () => ({
  decryptDeepseekApiKey: () => "sk-test-only"
}));

vi.mock("../netlify/functions/_shared/aiPrediction", () => ({
  aiDataFingerprint: () => "fingerprint",
  predictionTargetHash: () => "target-hash",
  generateDeepAnalysis: vi.fn(),
  generateStandardAnalysis: vi.fn(async () => {
    const error = new Error("DeepSeek 服务暂时不可用：模型返回了空内容");
    (error as Error & { status: number }).status = 502;
    throw error;
  })
}));

import aiPrediction from "../netlify/functions/ai-prediction";

describe("AI prediction endpoint", () => {
  it("converts an asynchronous DeepSeek failure into the intended JSON response", async () => {
    const response = await aiPrediction(new Request("http://localhost/api/ai-prediction", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost"
      },
      body: JSON.stringify({ kind: "standard", targetDistanceKm: 21.0975 })
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "DeepSeek 服务暂时不可用：模型返回了空内容",
      status: 502
    });
  });
});
