import { describe, expect, it } from "vitest";
import { buildPrediction } from "../shared/predictions";
import type { RunningRecord, WeightRecord } from "../shared/types";

function run(partial: Partial<RunningRecord>): RunningRecord {
  const dateTime = partial.dateTime ?? new Date().toISOString();
  return {
    id: partial.id ?? crypto.randomUUID(),
    dateTime,
    distanceKm: partial.distanceKm ?? 5,
    durationSec: partial.durationSec ?? 1800,
    avgPaceSecPerKm: partial.avgPaceSecPerKm ?? 360,
    avgPowerW: partial.avgPowerW ?? 180,
    avgCadenceSpm: partial.avgCadenceSpm ?? 170,
    avgHeartRateBpm: partial.avgHeartRateBpm ?? 145,
    weather: { temperatureC: null, humidityPct: null, aqi: null },
    splits: [],
    screenshotKeys: [],
    createdAt: dateTime,
    updatedAt: dateTime
  };
}

describe("buildPrediction", () => {
  it("returns insufficient-data for fewer than three runs", () => {
    const prediction = buildPrediction([run({}), run({})], [], 10);
    expect(prediction.status).toBe("insufficient-data");
    expect(prediction.predictedTargetFinishSec).toBeNull();
  });

  it("predicts finish time and a target date from improving history", () => {
    const runs = [
      run({ dateTime: "2026-01-01T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 360 }),
      run({ dateTime: "2026-01-08T00:00:00.000Z", distanceKm: 8, avgPaceSecPerKm: 350 }),
      run({ dateTime: "2026-01-15T00:00:00.000Z", distanceKm: 11, avgPaceSecPerKm: 340 })
    ];
    const prediction = buildPrediction(runs, [], 21.1);
    expect(prediction.status).toBe("ready");
    expect(prediction.predictedTargetFinishSec).toBeGreaterThan(0);
    expect(prediction.predictedTargetDate).toMatch(/2026-/);
  });

  it("uses the achieved run date when the target distance already exists", () => {
    const runs = [
      run({ dateTime: "2026-01-01T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 360 }),
      run({ dateTime: "2026-01-08T00:00:00.000Z", distanceKm: 10, avgPaceSecPerKm: 350 }),
      run({ dateTime: "2026-01-15T00:00:00.000Z", distanceKm: 8, avgPaceSecPerKm: 340 })
    ];
    const prediction = buildPrediction(runs, [], 10);
    expect(prediction.achievedTargetDate).toBe("2026-01-08");
    expect(prediction.predictedDistanceDate).toBe("2026-01-08");
  });

  it("supports finish-time and target-date goal modes", () => {
    const runs = [
      run({ dateTime: "2026-01-01T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 390 }),
      run({ dateTime: "2026-01-08T00:00:00.000Z", distanceKm: 8, avgPaceSecPerKm: 360 }),
      run({ dateTime: "2026-01-15T00:00:00.000Z", distanceKm: 11, avgPaceSecPerKm: 330 })
    ];
    const prediction = buildPrediction(runs, [], 10, {
      targetFinishSec: 3200,
      targetDate: "2026-02-01"
    });
    expect(prediction.predictedGoalFinishDate).toMatch(/2026-/);
    expect(prediction.predictedFinishSecAtTargetDate).toBeGreaterThan(0);
  });

  it("calculates weight and pace correlation when dates are close", () => {
    const runs = [
      run({ dateTime: "2026-01-01T00:00:00.000Z", avgPaceSecPerKm: 360 }),
      run({ dateTime: "2026-01-05T00:00:00.000Z", avgPaceSecPerKm: 350 }),
      run({ dateTime: "2026-01-09T00:00:00.000Z", avgPaceSecPerKm: 340 })
    ];
    const weights: WeightRecord[] = [
      { date: "2026-01-01", weightKg: 72, createdAt: "", updatedAt: "" },
      { date: "2026-01-05", weightKg: 71, createdAt: "", updatedAt: "" },
      { date: "2026-01-09", weightKg: 70, createdAt: "", updatedAt: "" }
    ];
    const prediction = buildPrediction(runs, weights, 10);
    expect(prediction.weightPaceCorrelation).toBeGreaterThan(0.9);
  });
});
