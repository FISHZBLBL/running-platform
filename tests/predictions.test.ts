import { describe, expect, it } from "vitest";
import { buildPrediction, buildPredictionBacktest } from "../shared/predictions";
import { buildSmartPrediction } from "../shared/smartPrediction";
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
    effortScore: partial.effortScore ?? null,
    effortSource: partial.effortSource ?? null,
    performanceType: partial.performanceType ?? null,
    elevationGainM: partial.elevationGainM ?? null,
    weather: { temperatureC: null, humidityPct: null, aqi: null },
    notes: "",
    splits: partial.splits ?? [],
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
      run({ dateTime: "2026-01-15T00:00:00.000Z", distanceKm: 1.55, avgPaceSecPerKm: 330 }),
      run({
        dateTime: "2026-01-22T00:00:00.000Z",
        distanceKm: 3.04,
        avgPaceSecPerKm: 360,
        splits: [330, 335, 340].map((paceSecPerKm, index) => ({
          index: index + 1,
          distanceKm: 1,
          paceSecPerKm,
          heartRateBpm: 160,
          powerW: 210,
          cadenceSpm: 170
        }))
      })
    ];
    const prediction = buildPrediction(runs, [], 5);
    const pbKeys = prediction.vdotModel.personalBests.map((pb) => pb.key);
    expect(pbKeys).toContain("1500m");
    expect(pbKeys).toContain("5km");
    expect(pbKeys).toContain("3km");
    expect(prediction.vdotModel.personalBests.filter((pb) => pb.key === "1500m")).toHaveLength(1);
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

  it("uses the fastest standard-distance PB regardless of energy score", () => {
    const runs = [
      run({ id: "easy", dateTime: "2026-01-01T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 350, effortScore: 3 }),
      run({ id: "hard", dateTime: "2026-01-08T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 370, effortScore: 8 }),
      run({ dateTime: "2026-01-15T00:00:00.000Z", distanceKm: 8, avgPaceSecPerKm: 390, effortScore: 4 })
    ];
    const prediction = buildPrediction(runs, [], 5);
    expect(prediction.vdotModel.personalBests.find((pb) => pb.key === "5km")?.sourceRunId).toBe("easy");
  });

  it("walk-forward backtests low-score PBs but skips later non-PB runs", () => {
    const runs = [
      run({ id: "pb-1", dateTime: "2026-01-01T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 390, durationSec: 1950, effortScore: 3 }),
      run({ id: "pb-2", dateTime: "2026-01-08T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 385, durationSec: 1925, effortScore: 4 }),
      run({ id: "pb-3", dateTime: "2026-01-15T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 380, durationSec: 1900, effortScore: 5 }),
      run({ id: "pb-4", dateTime: "2026-01-22T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 375, durationSec: 1875, effortScore: 6 }),
      run({ id: "ordinary", dateTime: "2026-01-29T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 430, durationSec: 2150, effortScore: 10 })
    ];
    const backtest = buildPredictionBacktest(runs, []);
    expect(backtest.status).toBe("ready");
    expect(backtest.sampleCount).toBe(1);
    expect(backtest.entries[0]).toMatchObject({
      runId: "pb-4",
      benchmarkType: "pb",
      benchmarkLabel: "5km PB",
      inputRunCount: 3,
      performanceSampleCount: 1,
      calibrationSampleCount: 0
    });
    expect(backtest.entries[0].smartConfidenceScore).toBeGreaterThan(0);
  });

  it("backtests a marked race even when it is not a PB", () => {
    const runs = [
      run({ id: "pb", dateTime: "2026-01-01T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 360, durationSec: 1800 }),
      run({ dateTime: "2026-01-08T00:00:00.000Z", distanceKm: 6, avgPaceSecPerKm: 390, durationSec: 2340 }),
      run({ dateTime: "2026-01-15T00:00:00.000Z", distanceKm: 8, avgPaceSecPerKm: 400, durationSec: 3200 }),
      run({ id: "race", dateTime: "2026-01-22T00:00:00.000Z", distanceKm: 5, avgPaceSecPerKm: 380, durationSec: 1900, performanceType: "race" })
    ];
    const backtest = buildPredictionBacktest(runs, []);
    expect(backtest.entries).toHaveLength(1);
    expect(backtest.entries[0]).toMatchObject({ runId: "race", benchmarkType: "race", benchmarkLabel: "5km比赛" });
  });

  it("does not derive shorter-distance PBs from splits", () => {
    const splitPaces = [330, 335, 340, 345, 350, 355];
    const splitRun = run({
      id: "split-pb",
      dateTime: "2026-01-15T00:00:00.000Z",
      distanceKm: 6.2,
      avgPaceSecPerKm: 380,
      splits: splitPaces.map((paceSecPerKm, index) => ({
        index: index + 1,
        distanceKm: 1,
        paceSecPerKm,
        heartRateBpm: 160,
        powerW: 210,
        cadenceSpm: 174
      }))
    });
    const prediction = buildPrediction([
      run({ dateTime: "2026-01-01T00:00:00.000Z", distanceKm: 4 }),
      run({ dateTime: "2026-01-08T00:00:00.000Z", distanceKm: 7 }),
      splitRun
    ], [], 5);
    const fiveKmPb = prediction.vdotModel.personalBests.find((pb) => pb.key === "5km");
    expect(fiveKmPb).toBeUndefined();
  });

  it("rejects split-derived pace when an OCR error makes it implausibly fast", () => {
    const recordedPaceSecPerKm = 6 * 60 + 17;
    const runs = [
      run({ dateTime: "2026-06-01T00:00:00.000Z", distanceKm: 3.04, avgPaceSecPerKm: 400 }),
      run({
        id: "june-24-5km",
        dateTime: "2026-06-24T00:00:00.000Z",
        distanceKm: 5.03,
        durationSec: 31 * 60 + 38,
        avgPaceSecPerKm: recordedPaceSecPerKm,
        splits: [365, 375, 325, 375, 380].map((paceSecPerKm, index) => ({
          index: index + 1,
          distanceKm: 1,
          paceSecPerKm,
          heartRateBpm: 170,
          powerW: 220,
          cadenceSpm: 170
        }))
      }),
      run({ dateTime: "2026-07-01T00:00:00.000Z", distanceKm: 10.02, avgPaceSecPerKm: 410 })
    ];

    const prediction = buildPrediction(runs, [], 5);
    const fiveKmPb = prediction.vdotModel.personalBests.find((pb) => pb.key === "5km");
    expect(fiveKmPb).toMatchObject({
      sourceRunId: "june-24-5km",
      sourceDate: "2026-06-24",
      sourceDistanceKm: 5.03,
      paceSecPerKm: recordedPaceSecPerKm,
      estimatedDurationSec: recordedPaceSecPerKm * 5
    });
  });

  it("uses trustworthy splits to exclude a slow partial tail from a near-standard run", () => {
    const recordedPaceSecPerKm = 6 * 60 + 17;
    const splitPaces = [374, 376, 375, 377, 376];
    const runs = [
      run({ dateTime: "2026-06-01T00:00:00.000Z", distanceKm: 3.04, avgPaceSecPerKm: 400 }),
      run({
        id: "valid-split-5km",
        dateTime: "2026-06-24T00:00:00.000Z",
        distanceKm: 5.03,
        durationSec: 31 * 60 + 38,
        avgPaceSecPerKm: recordedPaceSecPerKm,
        splits: splitPaces.map((paceSecPerKm, index) => ({
          index: index + 1,
          distanceKm: 1,
          paceSecPerKm,
          heartRateBpm: 170,
          powerW: 220,
          cadenceSpm: 170
        }))
      }),
      run({ dateTime: "2026-07-01T00:00:00.000Z", distanceKm: 10.02, avgPaceSecPerKm: 410 })
    ];

    const prediction = buildPrediction(runs, [], 5);
    const fiveKmPb = prediction.vdotModel.personalBests.find((pb) => pb.key === "5km");
    expect(fiveKmPb?.sourceRunId).toBe("valid-split-5km");
    expect(fiveKmPb?.estimatedDurationSec).toBe(splitPaces.reduce((sum, pace) => sum + pace, 0));
    expect(fiveKmPb?.paceSecPerKm).toBeCloseTo(375.6, 5);
  });

  it("uses total duration minus a time-only tail for an integer-distance PB", () => {
    const fullSplitPaces = [352, 386, 375, 387, 356];
    const tailAdjustedRun = run({
      id: "tail-adjusted-5km",
      dateTime: "2026-07-17T00:00:00.000Z",
      distanceKm: 5.01,
      durationSec: 1863,
      avgPaceSecPerKm: 1863 / 5.01,
      splits: [
        ...fullSplitPaces.map((paceSecPerKm, index) => ({
          index: index + 1,
          distanceKm: 1,
          paceSecPerKm,
          heartRateBpm: 165,
          powerW: 220,
          cadenceSpm: 170
        })),
        {
          index: 6,
          kind: "tail" as const,
          durationSec: 3,
          distanceKm: 0,
          paceSecPerKm: 0,
          heartRateBpm: 0,
          powerW: 0,
          cadenceSpm: 0
        }
      ]
    });

    const prediction = buildPrediction([
      run({ dateTime: "2026-07-01T00:00:00.000Z", distanceKm: 3 }),
      run({ dateTime: "2026-07-08T00:00:00.000Z", distanceKm: 4 }),
      tailAdjustedRun
    ], [], 5);
    const fiveKmPb = prediction.vdotModel.personalBests.find((pb) => pb.key === "5km");

    expect(fullSplitPaces.reduce((sum, pace) => sum + pace, 0)).toBe(1856);
    expect(fiveKmPb?.sourceRunId).toBe("tail-adjusted-5km");
    expect(fiveKmPb?.estimatedDurationSec).toBe(1860);
    expect(fiveKmPb?.paceSecPerKm).toBe(372);
  });

  it("matches the supplied Apple Watch five-kilometer splits plus 15-second tail", () => {
    const fullSplitPaces = [382, 407, 418, 421, 436];
    const totalDurationSec = 2079;
    const screenshotRun = run({
      id: "apple-watch-tail-example",
      dateTime: "2026-07-17T01:00:00.000Z",
      distanceKm: 5.04,
      durationSec: totalDurationSec,
      avgPaceSecPerKm: totalDurationSec / 5.04,
      splits: [
        ...fullSplitPaces.map((paceSecPerKm, index) => ({
          index: index + 1,
          distanceKm: 1,
          paceSecPerKm,
          heartRateBpm: [160, 172, 173, 174, 173][index],
          powerW: [237, 223, 217, 216, 211][index],
          cadenceSpm: [168, 167, 168, 168, 162][index]
        })),
        {
          index: 6,
          kind: "tail" as const,
          durationSec: 15,
          distanceKm: 0,
          paceSecPerKm: 0,
          heartRateBpm: 0,
          powerW: 0,
          cadenceSpm: 0
        }
      ]
    });

    const prediction = buildPrediction([
      run({ dateTime: "2026-07-01T00:00:00.000Z", distanceKm: 3 }),
      run({ dateTime: "2026-07-08T00:00:00.000Z", distanceKm: 4 }),
      screenshotRun
    ], [], 5);
    const fiveKmPb = prediction.vdotModel.personalBests.find((pb) => pb.key === "5km");

    expect(fiveKmPb?.estimatedDurationSec).toBe(totalDurationSec - 15);
    expect(fiveKmPb?.paceSecPerKm).toBe(412.8);
  });

  it("does not let a future PB change an earlier walk-forward result", () => {
    const history = [
      run({ id: "pb-1", dateTime: "2026-01-01T00:00:00.000Z", avgPaceSecPerKm: 390 }),
      run({ id: "pb-2", dateTime: "2026-01-08T00:00:00.000Z", avgPaceSecPerKm: 385 }),
      run({ id: "pb-3", dateTime: "2026-01-15T00:00:00.000Z", avgPaceSecPerKm: 380 }),
      run({ id: "pb-4", dateTime: "2026-01-22T00:00:00.000Z", avgPaceSecPerKm: 375 })
    ];
    const original = buildPredictionBacktest(history, []).entries.find((entry) => entry.runId === "pb-4");
    const withFuture = buildPredictionBacktest([
      ...history,
      run({ id: "future-pb", dateTime: "2026-02-01T00:00:00.000Z", avgPaceSecPerKm: 330 })
    ], []).entries.find((entry) => entry.runId === "pb-4");
    expect(withFuture).toEqual(original);
  });

  it("progressively corrects the finish time as walk-forward PB errors accumulate", () => {
    const runs = [
      run({ id: "pb-1", dateTime: "2026-05-01T00:00:00.000Z", distanceKm: 5, durationSec: 2100, avgPaceSecPerKm: 420 }),
      run({ id: "pb-2", dateTime: "2026-05-08T00:00:00.000Z", distanceKm: 5, durationSec: 2040, avgPaceSecPerKm: 408 }),
      run({ id: "pb-3", dateTime: "2026-05-15T00:00:00.000Z", distanceKm: 5, durationSec: 1980, avgPaceSecPerKm: 396 }),
      run({ id: "pb-4", dateTime: "2026-05-22T00:00:00.000Z", distanceKm: 5, durationSec: 1920, avgPaceSecPerKm: 384 }),
      run({ id: "pb-5", dateTime: "2026-05-29T00:00:00.000Z", distanceKm: 5, durationSec: 1860, avgPaceSecPerKm: 372 }),
      run({ id: "pb-6", dateTime: "2026-06-05T00:00:00.000Z", distanceKm: 5, durationSec: 1800, avgPaceSecPerKm: 360 })
    ];
    const rawPrediction = buildSmartPrediction(runs, 5);
    const calibratedPrediction = buildPrediction(runs, [], 5).smartPrediction;
    const halfMarathonPrediction = buildPrediction(runs, [], 21.0975).smartPrediction;

    expect(calibratedPrediction?.calibrationSampleCount).toBe(3);
    expect(calibratedPrediction?.calibrationAdjustmentPercent).toBeLessThan(0);
    expect(calibratedPrediction?.predictedFinishSec).toBeLessThan(rawPrediction?.predictedFinishSec ?? 0);
    expect(calibratedPrediction?.factors.find((factor) => factor.key === "calibration")?.detail).toContain("历史回测");
    expect(Object.values(calibratedPrediction?.personalWeights ?? {}).some((weight) => Math.abs(weight - 1) > 0.001)).toBe(true);
    expect(calibratedPrediction?.personalWeights.longRun).toBeGreaterThanOrEqual(0.35);
    expect(calibratedPrediction?.personalWeights.longRun).toBeLessThanOrEqual(1.75);
    expect(calibratedPrediction?.personalWeights.aerobic).toBeGreaterThanOrEqual(0);
    expect(calibratedPrediction?.personalWeights.aerobic).toBeLessThanOrEqual(2);
    expect(calibratedPrediction?.personalWeights.endurance).toBeGreaterThanOrEqual(0.35);
    expect(calibratedPrediction?.personalWeights.endurance).toBeLessThanOrEqual(1.75);
    expect(halfMarathonPrediction?.personalWeights.endurance).toBeGreaterThan(0.9);
    expect(halfMarathonPrediction?.personalWeights.longRun).toBeGreaterThan(0.9);
  });
});
