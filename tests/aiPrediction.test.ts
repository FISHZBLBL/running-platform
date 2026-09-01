import { afterEach, describe, expect, it } from "vitest";
import { buildPrediction } from "../shared/predictions";
import type { RunnerProfile, RunningRecord, WeightRecord } from "../shared/types";
import {
  aiDataFingerprint,
  buildPlanningContext,
  deepAnalysisFingerprint,
  hydrateCachedDeepAnalysis,
  normalizeDeepAnalysis,
  normalizeStandardAnalysis
} from "../netlify/functions/_shared/aiPrediction";
import {
  decryptDeepseekApiKey,
  encryptDeepseekApiKey,
  maskedDeepseekKey,
  validateDeepseekApiKey
} from "../netlify/functions/_shared/secrets";

const originalJwtSecret = process.env.JWT_SECRET;

afterEach(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

function run(id: string, dateTime: string, distanceKm: number, pace: number): RunningRecord {
  return {
    id,
    dateTime,
    shoeId: null,
    distanceKm,
    durationSec: distanceKm * pace,
    avgPaceSecPerKm: pace,
    avgPowerW: 210,
    avgCadenceSpm: 172,
    avgHeartRateBpm: 152,
    effortScore: 7,
    effortSource: "manual",
    performanceType: id === "race" ? "race" : null,
    elevationGainM: 20,
    weather: { temperatureC: 18, humidityPct: 55, aqi: 35 },
    notes: "",
    splits: [],
    screenshotKeys: [],
    createdAt: dateTime,
    updatedAt: dateTime
  };
}

const runs = [
  run("one", "2026-06-01T08:00:00.000Z", 5, 330),
  run("two", "2026-06-15T08:00:00.000Z", 10, 345),
  run("race", "2026-07-01T08:00:00.000Z", 15, 355),
  run("four", "2026-07-20T08:00:00.000Z", 8, 335)
];

const profile: RunnerProfile = {
  birthDate: "2000-01-01",
  sex: "male",
  heightCm: 175,
  restingHeartRateBpm: null,
  measuredMaxHeartRateBpm: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("user-bound DeepSeek secrets", () => {
  it("encrypts with account-bound authenticated encryption and only exposes a mask", () => {
    process.env.JWT_SECRET = "test-secret-that-is-long-enough";
    const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const encrypted = encryptDeepseekApiKey("runner-a", apiKey);
    expect(JSON.stringify(encrypted)).not.toContain(apiKey);
    expect(decryptDeepseekApiKey("runner-a", encrypted)).toBe(apiKey);
    expect(maskedDeepseekKey(encrypted)).toBe("sk-••••3456");
    expect(() => decryptDeepseekApiKey("runner-b", encrypted)).toThrow(/无法解密/);
  });

  it("rejects malformed keys before any upstream validation", () => {
    expect(() => validateDeepseekApiKey("not-a-key")).toThrow(/sk-/);
    expect(validateDeepseekApiKey("sk-abcdefghijklmnop")).toBe("sk-abcdefghijklmnop");
  });
});

describe("AI prediction guardrails and cache fingerprints", () => {
  it("accepts adjustments inside the dynamic range and rejects outside adjustments", () => {
    const prediction = buildPrediction(runs, [], 21.0975, { runnerProfile: profile });
    const range = prediction.smartPrediction?.rangeSec;
    const baseline = prediction.smartPrediction?.predictedFinishSec;
    expect(range).toBeTruthy();
    expect(baseline).toBeTruthy();
    const maxInsidePercent = ((Math.max(range!.optimistic, range!.conservative) / baseline!) - 1) * 100;
    const inside = normalizeStandardAnalysis({ adjustmentPercent: maxInsidePercent / 2 }, prediction, "fingerprint");
    expect(inside.adjustmentStatus).toBe("accepted");
    expect(inside.aiPredictionSec).not.toBe(inside.algorithmPredictionSec);

    const outside = normalizeStandardAnalysis({ adjustmentPercent: maxInsidePercent + 100 }, prediction, "fingerprint");
    expect(outside.adjustmentStatus).toBe("rejected-outside-range");
    expect(outside.aiPredictionSec).toBe(outside.algorithmPredictionSec);
    expect(outside.appliedAdjustmentPercent).toBe(0);
  });

  it("changes the fingerprint for meaningful data or prompt changes but not input ordering", () => {
    const target = { targetDistanceKm: 21.0975, targetFinishSec: null, targetDate: null };
    const weights: WeightRecord[] = [{ date: "2026-07-01", weightKg: 70, createdAt: "", updatedAt: "" }];
    const first = aiDataFingerprint(runs, weights, profile, target, "key-version");
    const reordered = aiDataFingerprint([...runs].reverse(), weights, profile, target, "key-version");
    const changed = aiDataFingerprint(runs, [{ ...weights[0], weightKg: 69.5 }], profile, target, "key-version");
    const personalized = aiDataFingerprint(runs, weights, profile, target, "key-version", "重点关注半马耐力");
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
    expect(personalized).not.toBe(first);
  });

  it("lets Pro refine the Flash prediction only inside the local dynamic range", () => {
    const prediction = buildPrediction(runs, [], 21.0975, { runnerProfile: profile });
    const standard = normalizeStandardAnalysis({ adjustmentPercent: 0 }, prediction, "standard-fingerprint");
    const range = standard.dynamicRangeSec;
    const maxInsidePercent = ((Math.max(range.optimistic, range.conservative) / standard.aiPredictionSec) - 1) * 100;
    const accepted = normalizeDeepAnalysis(
      { adjustmentPercent: maxInsidePercent / 2, predictionExplanation: "依据长距离能力调整。" },
      "deep-fingerprint",
      standard
    );
    expect(accepted.adjustmentStatus).toBe("accepted");
    expect(accepted.aiPredictionSec).not.toBe(standard.aiPredictionSec);

    const rejected = normalizeDeepAnalysis(
      { adjustmentPercent: maxInsidePercent + 100 },
      "deep-fingerprint",
      standard
    );
    expect(rejected.adjustmentStatus).toBe("rejected-outside-range");
    expect(rejected.aiPredictionSec).toBe(standard.aiPredictionSec);
  });

  it("separates Pro caches for different account prompts", () => {
    const base = "standard-fingerprint";
    expect(deepAnalysisFingerprint(base, "关注半马耐力"))
      .not.toBe(deepAnalysisFingerprint(base, "关注体重变化"));
    expect(deepAnalysisFingerprint(base, " 关注半马耐力 "))
      .toBe(deepAnalysisFingerprint(base, "关注半马耐力"));
  });

  it("anchors Pro training weeks to the current date and target race date", () => {
    const context = buildPlanningContext(
      { targetDistanceKm: 21.0975, targetFinishSec: null, targetDate: "2026-10-25" },
      "2026-08-26"
    );
    expect(context).toMatchObject({
      currentDate: "2026-08-26",
      targetDate: "2026-10-25",
      daysUntilTarget: 60,
      weeksUntilTarget: 9,
      status: "active"
    });

    const prediction = buildPrediction(runs, [], 21.0975, { runnerProfile: profile });
    const standard = normalizeStandardAnalysis({ adjustmentPercent: 0 }, prediction, "standard-fingerprint");
    const analysis = normalizeDeepAnalysis({
      trainingPlan: [{
        label: "第 1 周 · 建立节奏",
        startDate: "2026-08-26",
        endDate: "2026-09-01",
        weeklyDistanceKm: { min: 22, max: 26 },
        sessionsPerWeek: 4,
        longRunKm: { min: 11, max: 12 },
        keySession: "1 次轻松节奏跑。",
        easyRunFocus: "保持可交谈强度。",
        recovery: "至少休息 1 天。",
        adjustmentReason: "基于当前最长距离保守递增。"
      }]
    }, "deep-fingerprint", standard, "2026-08-26T00:00:00.000Z", context);
    expect(analysis.trainingPlan).toHaveLength(1);
    expect(analysis.trainingPlan[0].weeklyDistanceKm).toEqual({ min: 22, max: 26 });
    expect(analysis.trainingPlanDaysRemaining).toBe(60);

    expect(buildPlanningContext(
      { targetDistanceKm: 21.0975, targetFinishSec: null, targetDate: "2026-08-25" },
      "2026-08-26"
    ).status).toBe("target-date-passed");
  });

  it("hydrates a paid legacy Pro cache without requiring another model call", () => {
    const prediction = buildPrediction(runs, [], 21.0975, { runnerProfile: profile });
    const standard = normalizeStandardAnalysis({ adjustmentPercent: 0 }, prediction, "standard-fingerprint");
    const hydrated = hydrateCachedDeepAnalysis({
      generatedAt: "2026-08-24T10:00:00.000Z",
      overview: "结合 PA 数据给出结论。",
      capabilityEvolution: "能力稳定。",
      metricConflicts: [],
      riskCauses: [],
      trainingPlan: []
    }, standard, "deep-fingerprint");

    expect(hydrated.cached).toBe(true);
    expect(hydrated.aiPredictionSec).toBe(standard.aiPredictionSec);
    expect(hydrated.overview).toContain("跑步表现分析数据");
    expect(hydrated.dataFingerprint).toBe("deep-fingerprint");
  });
});
