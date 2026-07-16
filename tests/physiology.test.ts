import { describe, expect, it } from "vitest";
import { buildHeartRateBaseline, buildSplitAnalytics, heartRateZoneForBpm } from "../shared/physiology";
import type { RunnerProfile, RunningRecord, RunSplit } from "../shared/types";

function splits(paceSecPerKm: number, heartRates: number[]): RunSplit[] {
  return heartRates.map((heartRateBpm, index) => ({
    index: index + 1,
    distanceKm: 1,
    paceSecPerKm,
    heartRateBpm,
    powerW: 180,
    cadenceSpm: 170
  }));
}

function run(id: string, dateTime: string, paceSecPerKm: number, heartRates: number[], effortScore = 4): RunningRecord {
  return {
    id,
    dateTime,
    shoeId: null,
    distanceKm: heartRates.length,
    durationSec: paceSecPerKm * heartRates.length,
    avgPaceSecPerKm: paceSecPerKm,
    avgPowerW: 180,
    avgCadenceSpm: 170,
    avgHeartRateBpm: heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length,
    effortScore,
    effortSource: "apple-watch",
    weather: { temperatureC: null, humidityPct: null, aqi: null },
    notes: "",
    splits: splits(paceSecPerKm, heartRates),
    screenshotKeys: [],
    createdAt: dateTime,
    updatedAt: dateTime
  };
}

const profile: RunnerProfile = {
  birthDate: "1990-01-01",
  sex: "male",
  heightCm: 175,
  restingHeartRateBpm: 50,
  measuredMaxHeartRateBpm: 190,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("physiology analytics", () => {
  it("uses only the age formula for maximum heart rate and zones", () => {
    const baseline = buildHeartRateBaseline(profile, [], new Date("2026-07-15T00:00:00.000Z"));
    expect(baseline.effectiveMaxHeartRateBpm).toBe(183);
    expect(baseline.maxHeartRateSource).toBe("age-estimate");
    expect(baseline.restingHeartRateBpm).toBeNull();
    expect(baseline.zoneMethod).toBe("max-heart-rate");
    expect(baseline.zones.find((zone) => zone.zone === 2)).toMatchObject({ minBpm: 110, maxBpm: 127 });
    expect(heartRateZoneForBpm(120, baseline)).toBe(2);
  });

  it("tracks improving split efficiency across all heart-rate zones", () => {
    const runs = [
      run("a", "2026-06-01T00:00:00.000Z", 450, [160, 161, 162, 163, 164]),
      run("b", "2026-06-08T00:00:00.000Z", 440, [160, 161, 162, 163, 164]),
      run("c", "2026-06-15T00:00:00.000Z", 425, [160, 161, 162, 163, 164]),
      run("d", "2026-06-22T00:00:00.000Z", 415, [160, 161, 162, 163, 164])
    ];
    const analytics = buildSplitAnalytics(runs);
    expect(analytics.runs).toHaveLength(4);
    expect(analytics.runs.at(-1)?.paceSecPerKm).toBe(415);
    expect(analytics.cardioEfficiencyChangePercent).toBeGreaterThan(0);
    expect(analytics.powerEfficiencyChangePercent).toBe(0);
  });

  it("keeps cadence and power evidence from high-heart-rate splits", () => {
    const highHeartRateRun = run("high-heart-rate", "2026-06-29T00:00:00.000Z", 450, [168, 169, 170, 171, 172], 8);
    const analytics = buildSplitAnalytics([highHeartRateRun]);
    expect(analytics.runs).toHaveLength(1);
    expect(analytics.runs[0].powerEfficiency).toBeGreaterThan(0);
    expect(analytics.runs[0].cadenceSpm).toBe(170);
  });

  it("ignores stored manual and observed maximum heart rates", () => {
    const baseline = buildHeartRateBaseline(
      profile,
      [run("observed", "2026-06-29T00:00:00.000Z", 450, [194, 195, 196, 197, 198])],
      new Date("2026-07-15T00:00:00.000Z")
    );
    expect(baseline.effectiveMaxHeartRateBpm).toBe(183);
    expect(baseline.observedHighHeartRateBpm).toBe(198);
    expect(baseline.maxHeartRateSource).toBe("age-estimate");
    expect(baseline.confidence).toBe("low");
  });

  it("computes positive cardiac drift for a long aerobic run", () => {
    const longRun = run("long", "2026-07-01T00:00:00.000Z", 450, [112, 114, 116, 118, 121, 123, 125, 127]);
    longRun.durationSec = 3600;
    const analytics = buildSplitAnalytics([longRun]);
    expect(analytics.runs).toHaveLength(1);
    expect(analytics.runs[0].driftPercent).toBeGreaterThan(0);
  });
});
