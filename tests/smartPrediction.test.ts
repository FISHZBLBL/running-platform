import { describe, expect, it } from "vitest";
import { buildSmartPrediction } from "../shared/smartPrediction";
import type { RunningRecord, RunSplit } from "../shared/types";

function splits(paces: number[]): RunSplit[] {
  return paces.map((paceSecPerKm, index) => ({
    index: index + 1,
    distanceKm: 1,
    paceSecPerKm,
    heartRateBpm: 165,
    powerW: 220,
    cadenceSpm: 176
  }));
}

function detailedSplits(
  paces: number[],
  heartRates: number[],
  powers: number[],
  cadences: number[]
): RunSplit[] {
  return paces.map((paceSecPerKm, index) => ({
    index: index + 1,
    distanceKm: 1,
    paceSecPerKm,
    heartRateBpm: heartRates[index],
    powerW: powers[index],
    cadenceSpm: cadences[index]
  }));
}

function run(partial: Partial<RunningRecord>): RunningRecord {
  const dateTime = partial.dateTime ?? "2026-06-01T00:00:00.000Z";
  return {
    id: partial.id ?? crypto.randomUUID(),
    dateTime,
    shoeId: null,
    distanceKm: partial.distanceKm ?? 5,
    durationSec: partial.durationSec ?? 1800,
    avgPaceSecPerKm: partial.avgPaceSecPerKm ?? 360,
    avgPowerW: 200,
    avgCadenceSpm: 172,
    avgHeartRateBpm: partial.avgHeartRateBpm ?? 150,
    effortScore: partial.effortScore ?? null,
    effortSource: partial.effortScore === null ? null : "apple-watch",
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

describe("smart prediction", () => {
  it("does not count a slower ordinary run as a direct performance sample", () => {
    const runs = [
      run({ id: "race", dateTime: "2026-06-01T00:00:00.000Z", durationSec: 1800, effortScore: 9, performanceType: "race" }),
      run({ id: "ordinary", dateTime: "2026-06-08T00:00:00.000Z", durationSec: 1950, avgPaceSecPerKm: 390, effortScore: 3 })
    ];
    const prediction = buildSmartPrediction(runs, 5, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });
    expect(prediction?.performanceSampleCount).toBe(1);
    expect(prediction?.factors[0].detail).toContain("1 条 PB/比赛成绩");
  });

  it("uses a low energy-score PB as a direct performance sample", () => {
    const prediction = buildSmartPrediction([
      run({ id: "race", dateTime: "2026-06-01T00:00:00.000Z", durationSec: 1800, effortScore: 9, performanceType: "race" }),
      run({ id: "pb", dateTime: "2026-06-08T00:00:00.000Z", durationSec: 1650, avgPaceSecPerKm: 330, effortScore: 3 })
    ], 5, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });
    expect(prediction?.performanceSampleCount).toBe(2);
    expect(prediction?.factors[0].detail).toContain("2 条 PB/比赛成绩");
  });

  it("uses high-heart-rate split efficiency without requiring Z2 data", () => {
    const runs = [
      run({ id: "race", dateTime: "2026-04-01T00:00:00.000Z", durationSec: 1900, effortScore: 9, performanceType: "race", splits: splits([380, 380, 380, 380, 380]) }),
      run({ id: "a", dateTime: "2026-04-15T00:00:00.000Z", durationSec: 2200, effortScore: 5, splits: splits([440, 440, 440, 440, 440]) }),
      run({ id: "b", dateTime: "2026-05-01T00:00:00.000Z", durationSec: 2100, effortScore: 5, splits: splits([420, 420, 420, 420, 420]) }),
      run({ id: "c", dateTime: "2026-05-15T00:00:00.000Z", durationSec: 2000, effortScore: 5, splits: splits([400, 400, 400, 400, 400]) }),
      run({ id: "d", dateTime: "2026-06-01T00:00:00.000Z", durationSec: 1950, effortScore: 5, splits: splits([390, 390, 390, 390, 390]) })
    ];
    const prediction = buildSmartPrediction(runs, 5, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });
    expect(prediction?.factors.find((factor) => factor.key === "aerobic")?.detail).toContain("全部心率区间");
    expect(prediction?.factors.find((factor) => factor.key === "cadence")).toBeDefined();
  });

  it("keeps existing prediction output unchanged when a time-only tail is present", () => {
    const baseline = run({
      id: "race-10k-tail-check",
      dateTime: "2026-05-01T00:00:00.000Z",
      distanceKm: 10,
      durationSec: 3900,
      avgPaceSecPerKm: 390,
      performanceType: "race"
    });
    const fullSplits = detailedSplits(Array(18).fill(420), Array(18).fill(160), Array(18).fill(220), Array(18).fill(176));
    const longRun = run({
      id: "long-run-tail-check",
      dateTime: "2026-06-08T00:00:00.000Z",
      distanceKm: 18.01,
      durationSec: 7563,
      avgPaceSecPerKm: 420,
      effortScore: 6,
      splits: fullSplits
    });
    const withTail = run({
      ...longRun,
      splits: [...fullSplits, {
        index: 19,
        kind: "tail",
        durationSec: 3,
        distanceKm: 0,
        paceSecPerKm: 0,
        heartRateBpm: 0,
        powerW: 0,
        cadenceSpm: 0
      }]
    });

    const withoutTailPrediction = buildSmartPrediction([baseline, longRun], 21.0975, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });
    const withTailPrediction = buildSmartPrediction([baseline, withTail], 21.0975, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });

    expect(withTailPrediction?.predictedFinishSec).toBe(withoutTailPrediction?.predictedFinishSec);
    expect(withTailPrediction?.nearTargetLongRun?.blendWeightPercent).toBe(withoutTailPrediction?.nearTargetLongRun?.blendWeightPercent);
    expect(withTailPrediction?.nearTargetLongRun?.splitCount).toBe(18);
  });

  it("returns a confidence score and an ordered calibrated range", () => {
    const runs = [
      run({ id: "race-a", dateTime: "2026-05-01T00:00:00.000Z", durationSec: 1900, effortScore: 9, performanceType: "race" }),
      run({ id: "race-b", dateTime: "2026-06-01T00:00:00.000Z", distanceKm: 10, durationSec: 3900, avgPaceSecPerKm: 390, effortScore: 9, performanceType: "race" })
    ];
    const uncalibrated = buildSmartPrediction(runs, 10, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });
    const prediction = buildSmartPrediction(runs, 10, {
      referenceDate: new Date("2026-06-15T00:00:00.000Z"),
      calibration: {
        sampleCount: 3,
        absoluteErrorPercentile: 8,
        finishTimeAdjustmentPercent: 2,
        rawBiasPercent: 5,
        strengthPercent: 40,
        factorWeights: { longRun: 1, aerobic: 1, power: 1, endurance: 1, trainingLoad: 1 }
      }
    });
    expect(prediction?.confidenceScore).toBeGreaterThan(0);
    expect(prediction?.rangeSec.optimistic).toBeLessThan(prediction?.predictedFinishSec ?? 0);
    expect(prediction?.rangeSec.conservative).toBeGreaterThan(prediction?.predictedFinishSec ?? Number.POSITIVE_INFINITY);
    expect(prediction?.calibrationSampleCount).toBe(3);
    expect(prediction?.calibrationAdjustmentPercent).toBe(2);
    expect(prediction?.predictedFinishSec).toBeCloseTo((uncalibrated?.predictedFinishSec ?? 0) * 1.02, 5);
    expect(prediction?.factors.find((factor) => factor.key === "calibration")?.detail).toContain("整体偏快 5.0%");
  });

  it("directly blends a recent near-target long run into a half-marathon prediction", () => {
    const prediction = buildSmartPrediction([
      run({ id: "race-10k", dateTime: "2026-05-01T00:00:00.000Z", distanceKm: 10, durationSec: 3900, avgPaceSecPerKm: 390, performanceType: "race" }),
      run({
        id: "long-18k",
        dateTime: "2026-06-08T00:00:00.000Z",
        distanceKm: 18,
        durationSec: 7560,
        avgPaceSecPerKm: 420,
        effortScore: 6,
        splits: detailedSplits(
          Array(18).fill(420),
          Array(18).fill(160),
          Array(18).fill(220),
          Array(18).fill(176)
        )
      })
    ], 21.0975, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });

    expect(prediction?.modelVersion).toBe("smart-v6");
    expect(prediction?.nearTargetLongRun).toMatchObject({ sourceRunId: "long-18k", supportingRunCount: 1, splitCount: 18, energyScore: 6 });
    expect(prediction?.nearTargetLongRun?.coveragePercent).toBeCloseTo(85.3, 1);
    expect(prediction?.nearTargetLongRun?.blendWeightPercent).toBeGreaterThan(35);
    expect(prediction?.factors.find((factor) => factor.key === "long-run")?.detail).toContain("18.0 km");
  });

  it("applies a learned personal weight only to its matching prediction factor", () => {
    const runs = [
      run({ id: "race-10k", dateTime: "2026-05-01T00:00:00.000Z", distanceKm: 10, durationSec: 3900, avgPaceSecPerKm: 390, performanceType: "race" }),
      run({
        id: "long-18k",
        dateTime: "2026-06-08T00:00:00.000Z",
        distanceKm: 18,
        durationSec: 7560,
        avgPaceSecPerKm: 420,
        effortScore: 6,
        splits: detailedSplits(Array(18).fill(420), Array(18).fill(160), Array(18).fill(220), Array(18).fill(176))
      })
    ];
    const referenceDate = new Date("2026-06-15T00:00:00.000Z");
    const defaultPrediction = buildSmartPrediction(runs, 21.0975, { referenceDate });
    const personalizedPrediction = buildSmartPrediction(runs, 21.0975, {
      referenceDate,
      calibration: {
        sampleCount: 1,
        absoluteErrorPercentile: null,
        finishTimeAdjustmentPercent: 0,
        rawBiasPercent: 0,
        strengthPercent: 20,
        factorWeights: { longRun: 1.5, aerobic: 1, power: 1, endurance: 1, trainingLoad: 1 }
      }
    });
    const defaultLongRunImpact = defaultPrediction?.factors.find((factor) => factor.key === "long-run")?.impactPercent ?? 0;
    const personalLongRunImpact = personalizedPrediction?.factors.find((factor) => factor.key === "long-run")?.impactPercent ?? 0;

    expect(personalizedPrediction?.personalWeights.longRun).toBe(1.5);
    expect(personalLongRunImpact).toBeCloseTo(defaultLongRunImpact * 1.5, 8);
    if (defaultLongRunImpact > 0) {
      expect(personalizedPrediction?.predictedFinishSec).toBeGreaterThan(defaultPrediction?.predictedFinishSec ?? 0);
    } else {
      expect(personalizedPrediction?.predictedFinishSec).toBeLessThan(defaultPrediction?.predictedFinishSec ?? 0);
    }
  });

  it("makes a fading long-run projection more conservative than a stable run at the same average pace", () => {
    const baseline = run({
      id: "race-10k",
      dateTime: "2026-05-01T00:00:00.000Z",
      distanceKm: 10,
      durationSec: 3900,
      avgPaceSecPerKm: 390,
      performanceType: "race",
      splits: detailedSplits(Array(10).fill(390), Array(10).fill(165), Array(10).fill(225), Array(10).fill(176))
    });
    const stable = run({
      id: "stable",
      dateTime: "2026-06-08T00:00:00.000Z",
      distanceKm: 18,
      durationSec: 7560,
      avgPaceSecPerKm: 420,
      effortScore: 6,
      splits: detailedSplits(Array(18).fill(420), Array(18).fill(160), Array(18).fill(220), Array(18).fill(176))
    });
    const fading = run({
      id: "fading",
      dateTime: "2026-06-08T00:00:00.000Z",
      distanceKm: 18,
      durationSec: 7560,
      avgPaceSecPerKm: 420,
      effortScore: 6,
      splits: detailedSplits(
        [...Array(9).fill(390), ...Array(9).fill(450)],
        [...Array(9).fill(150), ...Array(9).fill(175)],
        [...Array(9).fill(230), ...Array(9).fill(200)],
        [...Array(9).fill(178), ...Array(9).fill(168)]
      )
    });

    const stablePrediction = buildSmartPrediction([baseline, stable], 21.0975, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });
    const fadingPrediction = buildSmartPrediction([baseline, fading], 21.0975, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });
    expect(fadingPrediction?.nearTargetLongRun?.projectedFinishSec).toBeGreaterThan(stablePrediction?.nearTargetLongRun?.projectedFinishSec ?? 0);
    expect(fadingPrediction?.predictedFinishSec).toBeGreaterThan(stablePrediction?.predictedFinishSec ?? 0);
    expect(fadingPrediction?.nearTargetLongRun?.secondHalfPaceChangePercent).toBeGreaterThan(10);
    expect(fadingPrediction?.nearTargetLongRun?.cardioDriftPercent).toBeGreaterThan(10);
    expect(fadingPrediction?.nearTargetLongRun?.powerChangePercent).toBeLessThan(0);
    expect(fadingPrediction?.nearTargetLongRun?.cadenceChangePercent).toBeLessThan(0);
  });

  it("uses a near-target run without splits at a capped low weight", () => {
    const prediction = buildSmartPrediction([
      run({ id: "race-10k", distanceKm: 10, durationSec: 3900, avgPaceSecPerKm: 390, performanceType: "race" }),
      run({ id: "long-no-splits", dateTime: "2026-06-08T00:00:00.000Z", distanceKm: 18, durationSec: 7560, avgPaceSecPerKm: 420, splits: [] })
    ], 21.0975, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });
    expect(prediction?.nearTargetLongRun?.splitCount).toBe(0);
    expect(prediction?.nearTargetLongRun?.blendWeightPercent).toBeLessThanOrEqual(30);
    expect(prediction?.factors.find((factor) => factor.key === "long-run")?.detail).toContain("未录入足够分段");
  });

  it("keeps a marathon prediction low-confidence when long-distance coverage is below half", () => {
    const prediction = buildSmartPrediction([
      run({ id: "race-5k", dateTime: "2026-05-01T00:00:00.000Z", distanceKm: 5, durationSec: 1800, avgPaceSecPerKm: 360, performanceType: "race" }),
      run({ id: "run-10k", dateTime: "2026-05-15T00:00:00.000Z", distanceKm: 10, durationSec: 3900, avgPaceSecPerKm: 390 }),
      run({ id: "run-13k", dateTime: "2026-06-08T00:00:00.000Z", distanceKm: 13, durationSec: 5460, avgPaceSecPerKm: 420 })
    ], 42.195, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });

    expect(prediction?.confidence).toBe("low");
    expect(prediction?.confidenceScore).toBeLessThan(45);
  });

  it("does not treat a 10 km run as near-target evidence for a half marathon", () => {
    const prediction = buildSmartPrediction([
      run({ id: "race-5k", distanceKm: 5, durationSec: 1800, avgPaceSecPerKm: 360, performanceType: "race" }),
      run({ id: "ordinary-10k", dateTime: "2026-06-08T00:00:00.000Z", distanceKm: 10, durationSec: 4200, avgPaceSecPerKm: 420 })
    ], 21.0975, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });

    expect(prediction?.nearTargetLongRun).toBeNull();
  });

  it("adds support for repeated consistent near-target long runs", () => {
    const baseline = run({
      id: "race-10k",
      dateTime: "2026-05-01T00:00:00.000Z",
      distanceKm: 10,
      durationSec: 3900,
      avgPaceSecPerKm: 390,
      performanceType: "race"
    });
    const firstLongRun = run({
      id: "long-18k-a",
      dateTime: "2026-06-01T00:00:00.000Z",
      distanceKm: 18,
      durationSec: 7560,
      avgPaceSecPerKm: 420,
      effortScore: 6,
      splits: detailedSplits(Array(18).fill(420), Array(18).fill(160), Array(18).fill(220), Array(18).fill(176))
    });
    const secondLongRun = run({
      ...firstLongRun,
      id: "long-18k-b",
      dateTime: "2026-06-08T00:00:00.000Z"
    });

    const single = buildSmartPrediction([baseline, firstLongRun], 21.0975, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });
    const repeated = buildSmartPrediction([baseline, firstLongRun, secondLongRun], 21.0975, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });

    expect(repeated?.nearTargetLongRun?.supportingRunCount).toBe(2);
    expect(repeated?.nearTargetLongRun?.blendWeightPercent).toBeGreaterThan(single?.nearTargetLongRun?.blendWeightPercent ?? 0);
    expect(repeated?.factors.find((factor) => factor.key === "long-run")?.detail).toContain("另有 1 次相近长跑");
  });

  it("uses 32 km per week as a continuous half-marathon reference rather than an eligibility gate", () => {
    const monthlyHundredKmProfile = Array.from({ length: 24 }, (_, index) => run({
      id: `volume-${index}`,
      dateTime: "2026-06-01T00:00:00.000Z",
      distanceKm: 5.75,
      durationSec: 5.75 * 450,
      avgPaceSecPerKm: 450
    }));
    const prediction = buildSmartPrediction([
      run({ id: "race-10k", dateTime: "2026-04-01T00:00:00.000Z", distanceKm: 10, durationSec: 3900, avgPaceSecPerKm: 390, performanceType: "race" }),
      run({ id: "long-18k", dateTime: "2026-04-15T00:00:00.000Z", distanceKm: 18, durationSec: 7560, avgPaceSecPerKm: 420 }),
      ...monthlyHundredKmProfile
    ], 21.0975, { referenceDate: new Date("2026-06-15T00:00:00.000Z") });
    const endurance = prediction?.factors.find((factor) => factor.key === "endurance");

    expect(prediction).not.toBeNull();
    expect(endurance?.impactPercent).toBeCloseTo(1.125, 2);
    expect(endurance?.detail).toContain("不是参与门槛");
  });
});
