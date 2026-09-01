import { beforeEach, describe, expect, it, vi } from "vitest";

const standard = { kind: "standard", dataFingerprint: "fingerprint", cached: false };
const deep = { kind: "deep", dataFingerprint: "deep-fingerprint", cached: false };
const data = vi.hoisted(() => ({
  getAiDeepAnalysis: vi.fn(),
  getAiPrediction: vi.fn(),
  getDeepseekSecret: vi.fn(),
  getDeepseekCustomPrompt: vi.fn(),
  getRunnerProfile: vi.fn(),
  listRuns: vi.fn(),
  listWeights: vi.fn(),
  saveAiDeepAnalysis: vi.fn(),
  saveAiPrediction: vi.fn(),
  withAiPredictionLock: vi.fn()
}));
const model = vi.hoisted(() => ({
  aiDataFingerprint: vi.fn(),
  buildPlanningContext: vi.fn(),
  deepAnalysisFingerprint: vi.fn(),
  generateDeepAnalysis: vi.fn(),
  generateStandardAnalysis: vi.fn(),
  hasCurrentStructuredTrainingPlan: vi.fn(),
  hydrateCachedDeepAnalysis: vi.fn(),
  predictionTargetHash: vi.fn()
}));

vi.mock("../netlify/functions/_shared/session", () => ({ requireAiUsername: () => "runner" }));
vi.mock("../netlify/functions/_shared/data", () => data);
vi.mock("../netlify/functions/_shared/secrets", () => ({ decryptDeepseekApiKey: () => "sk-test-only" }));
vi.mock("../netlify/functions/_shared/aiPrediction", () => model);

import aiPrediction from "../netlify/functions/ai-prediction";

function currentRequest() {
  return aiPrediction(new Request("http://localhost/api/ai-prediction", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ kind: "current", targetDistanceKm: 21.0975, targetDate: "2026-10-25" })
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  data.getAiPrediction.mockResolvedValue(standard);
  data.getAiDeepAnalysis.mockResolvedValue(deep);
  data.getDeepseekSecret.mockResolvedValue({ updatedAt: "key-version" });
  data.getDeepseekCustomPrompt.mockResolvedValue("");
  data.getRunnerProfile.mockResolvedValue(null);
  data.listRuns.mockResolvedValue([]);
  data.listWeights.mockResolvedValue([]);
  data.withAiPredictionLock.mockImplementation(async (_username: string, _target: string, task: () => Promise<unknown>) => task());
  model.aiDataFingerprint.mockReturnValue("fingerprint");
  model.deepAnalysisFingerprint.mockReturnValue("deep-fingerprint");
  model.predictionTargetHash.mockReturnValue("target-hash");
  model.buildPlanningContext.mockReturnValue({ status: "active" });
  model.hasCurrentStructuredTrainingPlan.mockReturnValue(true);
  model.hydrateCachedDeepAnalysis.mockReturnValue({ ...deep, cached: true });
});

describe("current AI analysis cache", () => {
  it("restores a valid Pro cache before Flash without calling either model", async () => {
    const response = await currentRequest();
    await expect(response.json()).resolves.toMatchObject({
      analysis: { kind: "deep", cached: true },
      standard: { kind: "standard", cached: true },
      proCacheStatus: "restored"
    });
    expect(model.generateStandardAnalysis).not.toHaveBeenCalled();
    expect(model.generateDeepAnalysis).not.toHaveBeenCalled();
  });

  it("rebuilds one unified analysis when a legacy cache has the old plan shape", async () => {
    model.hasCurrentStructuredTrainingPlan.mockReturnValue(false);
    model.generateDeepAnalysis.mockResolvedValue(deep);
    const response = await currentRequest();
    await expect(response.json()).resolves.toMatchObject({
      analysis: { kind: "deep", cached: false },
      standard: { kind: "standard", cached: false }
    });
    expect(model.generateStandardAnalysis).not.toHaveBeenCalled();
    expect(model.generateDeepAnalysis).toHaveBeenCalledTimes(1);
  });
});
