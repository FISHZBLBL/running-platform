import type { RunnerProfile, RunningRecord, RunSplit } from "./types";
import { runLocalDate } from "./runDates";

const DAY_MS = 86_400_000;
const OBSERVATION_WINDOW_DAYS = 365;

export type HeartRateZone = {
  zone: 1 | 2 | 3 | 4 | 5;
  minBpm: number;
  maxBpm: number;
};

export type HeartRateBaseline = {
  age: number | null;
  estimatedMaxHeartRateBpm: number | null;
  observedHighHeartRateBpm: number | null;
  effectiveMaxHeartRateBpm: number | null;
  restingHeartRateBpm: number | null;
  maxHeartRateSource: "measured" | "observed" | "age-estimate" | "unavailable";
  zoneMethod: "heart-rate-reserve" | "max-heart-rate" | "unavailable";
  confidence: "high" | "medium" | "low";
  zones: HeartRateZone[];
};

export type SplitRunPoint = {
  runId: string;
  date: string;
  distanceKm: number;
  splitCount: number;
  paceSecPerKm: number;
  heartRateBpm: number;
  cardioEfficiency: number;
  powerEfficiency: number | null;
  cadenceSpm: number | null;
  cadenceVariationPercent: number | null;
  driftPercent: number | null;
};

export type SplitAnalytics = {
  runs: SplitRunPoint[];
  cardioEfficiencyChangePercent: number | null;
  powerEfficiencyChangePercent: number | null;
  cadenceChangePercent: number | null;
  medianDriftPercent: number | null;
};

export type RunSplitProfile = {
  splitCount: number;
  coveredDistanceKm: number;
  averagePaceSecPerKm: number;
  secondHalfPaceChangePercent: number | null;
  cardioDriftPercent: number | null;
  powerChangePercent: number | null;
  cadenceChangePercent: number | null;
  powerVariationPercent: number | null;
  cadenceVariationPercent: number | null;
};

type ComparableSplit = Pick<RunSplit, "distanceKm" | "paceSecPerKm" | "heartRateBpm" | "powerW" | "cadenceSpm">;

function validDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ageOnDate(birthDate: string | null | undefined, referenceDate: Date): number | null {
  if (!birthDate) return null;
  const birth = validDate(`${birthDate}T00:00:00Z`);
  if (!birth || birth.getTime() > referenceDate.getTime()) return null;
  let age = referenceDate.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = referenceDate.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && referenceDate.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

function validHeartRate(value: number): boolean {
  return Number.isFinite(value) && value >= 40 && value <= 240;
}

function recentObservedHigh(runs: RunningRecord[], referenceDate: Date): number | null {
  const cutoff = referenceDate.getTime() - OBSERVATION_WINDOW_DAYS * DAY_MS;
  let highest = 0;
  for (const run of runs) {
    const runDate = validDate(run.dateTime);
    if (!runDate || runDate.getTime() < cutoff || runDate.getTime() > referenceDate.getTime() + DAY_MS) continue;
    if (validHeartRate(run.avgHeartRateBpm)) highest = Math.max(highest, run.avgHeartRateBpm);
    for (const split of run.splits ?? []) {
      if (validHeartRate(split.heartRateBpm)) highest = Math.max(highest, split.heartRateBpm);
    }
  }
  return highest > 0 ? Math.round(highest) : null;
}

function zoneBoundary(maxHeartRate: number, restingHeartRate: number | null, fraction: number): number {
  if (restingHeartRate !== null) {
    return Math.round(restingHeartRate + (maxHeartRate - restingHeartRate) * fraction);
  }
  return Math.round(maxHeartRate * fraction);
}

function buildZones(maxHeartRate: number | null, restingHeartRate: number | null): HeartRateZone[] {
  if (!maxHeartRate || (restingHeartRate !== null && maxHeartRate - restingHeartRate < 30)) return [];
  const fractions = [0.5, 0.6, 0.7, 0.8, 0.9, 1];
  return fractions.slice(0, -1).map((fraction, index) => ({
    zone: (index + 1) as HeartRateZone["zone"],
    minBpm: zoneBoundary(maxHeartRate, restingHeartRate, fraction),
    maxBpm: index === 4 ? maxHeartRate : zoneBoundary(maxHeartRate, restingHeartRate, fractions[index + 1]) - 1
  }));
}

export function buildHeartRateBaseline(
  profile: RunnerProfile | null,
  runs: RunningRecord[],
  referenceDate = new Date()
): HeartRateBaseline {
  const age = ageOnDate(profile?.birthDate, referenceDate);
  const estimatedMaxHeartRateBpm = age === null ? null : Math.round(208 - 0.7 * age);
  const observedHighHeartRateBpm = recentObservedHigh(runs, referenceDate);
  const restingHeartRateBpm = null;
  const effectiveMaxHeartRateBpm = estimatedMaxHeartRateBpm;
  const maxHeartRateSource: HeartRateBaseline["maxHeartRateSource"] = estimatedMaxHeartRateBpm === null
    ? "unavailable"
    : "age-estimate";
  const zones = buildZones(effectiveMaxHeartRateBpm, null);
  return {
    age,
    estimatedMaxHeartRateBpm,
    observedHighHeartRateBpm,
    effectiveMaxHeartRateBpm,
    restingHeartRateBpm,
    maxHeartRateSource,
    zoneMethod: zones.length === 0 ? "unavailable" : "max-heart-rate",
    confidence: "low",
    zones
  };
}

export function heartRateZoneForBpm(heartRateBpm: number, baseline: HeartRateBaseline): HeartRateZone["zone"] | null {
  const zone = baseline.zones.find((item) => heartRateBpm >= item.minBpm && heartRateBpm <= item.maxBpm);
  return zone?.zone ?? null;
}

function comparableSplits(run: RunningRecord): ComparableSplit[] {
  return (run.splits ?? []).filter(
    (split) => split.distanceKm > 0 && split.paceSecPerKm > 0 && validHeartRate(split.heartRateBpm)
  );
}

function weightedAverage(values: Array<{ value: number; weight: number }>): number | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const item of values) {
    if (!Number.isFinite(item.value) || !Number.isFinite(item.weight) || item.weight <= 0) continue;
    weighted += item.value * item.weight;
    totalWeight += item.weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function averageEfficiency(splits: ComparableSplit[]): number | null {
  const durationSec = splits.reduce((sum, split) => sum + split.paceSecPerKm * split.distanceKm, 0);
  const distanceKm = splits.reduce((sum, split) => sum + split.distanceKm, 0);
  const averageHeartRate = weightedAverage(
    splits.map((split) => ({ value: split.heartRateBpm, weight: split.paceSecPerKm * split.distanceKm }))
  );
  if (durationSec <= 0 || distanceKm <= 0 || !averageHeartRate) return null;
  const speedMetersPerMinute = (distanceKm * 1000) / (durationSec / 60);
  return speedMetersPerMinute / averageHeartRate;
}

function cadenceVariation(splits: ComparableSplit[], averageCadence: number | null): number | null {
  const cadenceValues = splits.filter((split) => split.cadenceSpm > 0);
  if (!averageCadence || cadenceValues.length < 2) return null;
  const totalDistance = cadenceValues.reduce((sum, split) => sum + split.distanceKm, 0);
  if (totalDistance <= 0) return null;
  const variance = cadenceValues.reduce(
    (sum, split) => sum + (split.cadenceSpm - averageCadence) ** 2 * split.distanceKm,
    0
  ) / totalDistance;
  return Math.sqrt(variance) / averageCadence * 100;
}

function weightedMetric(
  splits: ComparableSplit[],
  select: (split: ComparableSplit) => number
): number | null {
  return weightedAverage(
    splits
      .map((split) => ({ value: select(split), weight: split.distanceKm }))
      .filter((item) => Number.isFinite(item.value) && item.value > 0)
  );
}

function percentChange(first: number | null, second: number | null): number | null {
  if (first === null || second === null || first <= 0) return null;
  return (second - first) / first * 100;
}

function metricVariationPercent(
  splits: ComparableSplit[],
  select: (split: ComparableSplit) => number
): number | null {
  const valid = splits.filter((split) => {
    const value = select(split);
    return Number.isFinite(value) && value > 0;
  });
  const average = weightedMetric(valid, select);
  const totalDistance = valid.reduce((sum, split) => sum + split.distanceKm, 0);
  if (average === null || totalDistance <= 0 || valid.length < 2) return null;
  const variance = valid.reduce(
    (sum, split) => sum + (select(split) - average) ** 2 * split.distanceKm,
    0
  ) / totalDistance;
  return Math.sqrt(variance) / average * 100;
}

export function analyzeRunSplits(run: RunningRecord): RunSplitProfile | null {
  const valid = (run.splits ?? []).filter(
    (split) => split.distanceKm > 0 && split.paceSecPerKm > 0 && Number.isFinite(split.paceSecPerKm)
  );
  if (valid.length < 2) return null;
  const coveredDistanceKm = valid.reduce((sum, split) => sum + split.distanceKm, 0);
  const averagePaceSecPerKm = weightedMetric(valid, (split) => split.paceSecPerKm);
  if (coveredDistanceKm <= 0 || averagePaceSecPerKm === null) return null;

  const comparison = valid.length >= 8 ? valid.slice(1, -1) : valid;
  const midpoint = Math.floor(comparison.length / 2);
  const firstHalf = comparison.slice(0, midpoint);
  const secondHalf = comparison.slice(midpoint);
  const firstPace = weightedMetric(firstHalf, (split) => split.paceSecPerKm);
  const secondPace = weightedMetric(secondHalf, (split) => split.paceSecPerKm);
  const firstEfficiency = averageEfficiency(firstHalf.filter((split) => validHeartRate(split.heartRateBpm)));
  const secondEfficiency = averageEfficiency(secondHalf.filter((split) => validHeartRate(split.heartRateBpm)));
  const cardioDriftPercent = firstEfficiency && secondEfficiency
    ? (firstEfficiency - secondEfficiency) / firstEfficiency * 100
    : null;

  return {
    splitCount: valid.length,
    coveredDistanceKm,
    averagePaceSecPerKm,
    secondHalfPaceChangePercent: percentChange(firstPace, secondPace),
    cardioDriftPercent,
    powerChangePercent: percentChange(
      weightedMetric(firstHalf, (split) => split.powerW),
      weightedMetric(secondHalf, (split) => split.powerW)
    ),
    cadenceChangePercent: percentChange(
      weightedMetric(firstHalf, (split) => split.cadenceSpm),
      weightedMetric(secondHalf, (split) => split.cadenceSpm)
    ),
    powerVariationPercent: metricVariationPercent(comparison, (split) => split.powerW),
    cadenceVariationPercent: metricVariationPercent(comparison, (split) => split.cadenceSpm)
  };
}

function recentChange(values: number[], lowerIsBetter: boolean): number | null {
  if (values.length < 4) return null;
  const recentCount = Math.min(3, Math.floor(values.length / 2));
  const recent = median(values.slice(-recentCount));
  const previous = median(values.slice(-recentCount * 2, -recentCount));
  if (recent === null || previous === null || previous === 0) return null;
  const raw = ((recent - previous) / previous) * 100;
  return lowerIsBetter ? -raw : raw;
}

export function buildSplitAnalytics(runs: RunningRecord[]): SplitAnalytics {
  const sortedRuns = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
  const splitRuns: SplitRunPoint[] = [];

  for (const run of sortedRuns) {
    const splits = comparableSplits(run);
    if (splits.length < 2) continue;
    const totalDistance = splits.reduce((sum, split) => sum + split.distanceKm, 0);
    const totalDuration = splits.reduce((sum, split) => sum + split.paceSecPerKm * split.distanceKm, 0);
    const heartRateBpm = weightedAverage(
      splits.map((split) => ({ value: split.heartRateBpm, weight: split.paceSecPerKm * split.distanceKm }))
    );
    const cardioEfficiency = averageEfficiency(splits);
    if (totalDistance <= 0 || totalDuration <= 0 || !heartRateBpm || !cardioEfficiency) continue;
    const powerEfficiency = weightedAverage(
      splits
        .filter((split) => split.powerW > 0)
        .map((split) => ({ value: split.powerW / split.heartRateBpm, weight: split.distanceKm }))
    );
    const cadenceSpm = weightedAverage(
      splits
        .filter((split) => split.cadenceSpm > 0)
        .map((split) => ({ value: split.cadenceSpm, weight: split.distanceKm }))
    );
    let driftPercent: number | null = null;
    if (run.durationSec >= 2700 && splits.length >= 6) {
      const trimmed = splits.length >= 8 ? splits.slice(1, -1) : splits;
      const midpoint = Math.floor(trimmed.length / 2);
      const firstEfficiency = averageEfficiency(trimmed.slice(0, midpoint));
      const secondEfficiency = averageEfficiency(trimmed.slice(midpoint));
      if (firstEfficiency && secondEfficiency) {
        driftPercent = ((firstEfficiency - secondEfficiency) / firstEfficiency) * 100;
      }
    }
    splitRuns.push({
      runId: run.id,
      date: runLocalDate(run),
      distanceKm: totalDistance,
      splitCount: splits.length,
      paceSecPerKm: totalDuration / totalDistance,
      heartRateBpm,
      cardioEfficiency,
      powerEfficiency,
      cadenceSpm,
      cadenceVariationPercent: cadenceVariation(splits, cadenceSpm),
      driftPercent
    });
  }

  return {
    runs: splitRuns,
    cardioEfficiencyChangePercent: recentChange(splitRuns.map((item) => item.cardioEfficiency), false),
    powerEfficiencyChangePercent: recentChange(
      splitRuns.flatMap((item) => item.powerEfficiency === null ? [] : [item.powerEfficiency]),
      false
    ),
    cadenceChangePercent: recentChange(
      splitRuns.flatMap((item) => item.cadenceSpm === null ? [] : [item.cadenceSpm]),
      false
    ),
    medianDriftPercent: median(
      splitRuns.slice(-5).flatMap((item) => item.driftPercent === null ? [] : [item.driftPercent])
    )
  };
}
