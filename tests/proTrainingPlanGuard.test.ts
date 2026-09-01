import { describe, expect, it, vi } from "vitest";
import type { AiPredictionAnalysis } from "../shared/types";

const deepseek = vi.hoisted(() => ({ callDeepseekJson: vi.fn() }));

vi.mock("../netlify/functions/_shared/deepseek", () => deepseek);

import { generateDeepAnalysis } from "../netlify/functions/_shared/aiPrediction";

const standard: AiPredictionAnalysis = {
  kind: "standard",
  model: "deepseek-v4-flash",
  generatedAt: "2026-08-30T00:00:00.000Z",
  cached: false,
  dataFingerprint: "standard-fingerprint",
  algorithmPredictionSec: 9600,
  aiPredictionSec: 9600,
  requestedAdjustmentPercent: 0,
  appliedAdjustmentPercent: 0,
  adjustmentStatus: "no-adjustment",
  dynamicRangeSec: { optimistic: 9000, conservative: 10200 },
  summary: "摘要",
  predictionExplanation: "说明",
  recentTrend: "趋势",
  anomalies: [],
  risks: [],
  recommendations: [],
  evidence: []
};

describe("Pro weekly training-plan guard", () => {
  it("rejects a past target date before calling the model", async () => {
    deepseek.callDeepseekJson.mockResolvedValue({});
    await expect(generateDeepAnalysis(
      "sk-test-only",
      [],
      [],
      null,
      { targetDistanceKm: 21.0975, targetFinishSec: null, targetDate: "2026-01-01" },
      standard,
      "fingerprint",
      ""
    )).rejects.toMatchObject({ message: expect.stringContaining("目标比赛日期") });
    expect(deepseek.callDeepseekJson).not.toHaveBeenCalled();
  });
});
