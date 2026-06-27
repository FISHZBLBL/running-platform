import { describe, expect, it } from "vitest";
import { buildPrediction } from "../shared/predictions";
import type { RunningRecord, WeightRecord } from "../shared/types";

function run(partial: Partial<RunningRecord>): RunningRecord {
  const dateTime = partial.dateTime ?? new Date().toISOString();
  return {
    id: partial.id ?? crypto.randomUUID(),
    dateTime,
    shoeId: partial.shoeId ?? null,
    distanceKm: partial.distanceKm ?? 5,
    durationSec: partial.durationSec ?? 1800,
    avgPaceSecPerKm: partial.avgPaceSecPerKm ?? 360,
    avgPowerW: partial.avgPowerW ?? 180,
    avgCadenceSpm: partial.avgCadenceSpm ?? 170,
    avgHeartRateBpm: partial.avgHeartRateBpm ?? 145,
    weather: { temperatureC: null, humidityPct: null, aqi: null },
    notes: "",
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

  it("uses conservative long-run progression for near-future distance goals", () => {
    const runs = [
      run({ dateTime: "2026-06-01T00:00:00.000Z", distanceKm: 5.01, avgPaceSecPerKm: 455 }),
      run({ dateTime: "2026-06-08T00:00:00.000Z", distanceKm: 13.14, avgPaceSecPerKm: 430 }),
      run({ dateTime: "2026-06-17T00:00:00.000Z", distanceKm: 5.01, avgPaceSecPerKm: 455 })
    ];
    const prediction = buildPrediction(runs, [], 15);
    expect(prediction.distanceProjectionBasis).toBe("long-run-progression");
    expect(prediction.predictedDistanceDate).toBe("2026-06-22");
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
    expect(prediction.requiredVdotForTargetFinish).toBeGreaterThan(0);
    expect(prediction.predictedFinishSecAtTargetDate).toBeGreaterThan(0);
  });

  it("builds a VDOT range from personal bests and highlights matching rows", () => {
    const runs = [
      run({ dateTime: "2026-01-01T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 360 }),
      run({ dateTime: "2026-01-08T00:00:00.000Z", distanceKm: 10, avgPaceSecPerKm: 370 }),
      run({ dateTime: "2026-01-15T00:00:00.000Z", distanceKm: 3, avgPaceSecPerKm: 330 })
    ];
    const prediction = buildPrediction(runs, [], 10);
    expect(prediction.vdotModel.range).not.toBeNull();
    expect(prediction.vdotModel.personalBests.length).toBeGreaterThanOrEqual(3);
    expect(prediction.vdotModel.table.some((row) => row.highlighted)).toBe(true);
    expect(prediction.vdotPredictedFinishRangeSec?.conservative).toBeGreaterThan(0);
  });

  it("uses only real-distance PB records for VDOT", () => {
    const runs = [
      run({ dateTime: "2026-01-01T00:00:00.000Z", distanceKm: 5.01, avgPaceSecPerKm: 360 }),
      run({ dateTime: "2026-01-08T00:00:00.000Z", distanceKm: 6.01, avgPaceSecPerKm: 350 }),
      run({ dateTime: "2026-01-15T00:00:00.000Z", distanceKm: 1.55, avgPaceSecPerKm: 330 })
    ];
    const prediction = buildPrediction(runs, [], 5);
    const pbKeys = prediction.vdotModel.personalBests.map((pb) => pb.key);
    expect(pbKeys).toContain("1500m");
    expect(pbKeys).toContain("5km");
    expect(pbKeys).not.toContain("3km");
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
