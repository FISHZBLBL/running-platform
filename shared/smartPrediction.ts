import type {
  NearTargetLongRunPrediction,
  PersonalPredictionWeights,
  PredictionConfidence,
  RunnerProfile,
  RunningRecord,
  SmartPredictionFactor,
  SmartPredictionSummary
} from "./types";
import { analyzeRunSplits, buildHeartRateBaseline, buildSplitAnalytics } from "./physiology";
import {
  buildVdotModel,
  isWithinStandardDistanceTolerance,
  predictDurationFromVdot,
  standardDistancePerformancesForRun,
  vdotFromPerformance
} from "./vdot";

const DAY_MS = 86_400_000;

export type SmartPredictionCalibration = {
  sampleCount: number;
  absoluteErrorPercentile: number | null;
  finishTimeAdjustmentPercent: number;
  rawBiasPercent: number | null;
  strengthPercent: number;
  factorWeights: PersonalPredictionWeights;
};

export const DEFAULT_PERSONAL_PREDICTION_WEIGHTS: PersonalPredictionWeights = {
  longRun: 1,
  aerobic: 1,
  power: 1,
  endurance: 1,
  trainingLoad: 1
};

type PerformanceCandidate = {
  run: RunningRecord;
  projectedFinishSec: number;
  weight: number;
  distanceWeight: number;
  daysOld: number;
  weatherWeight: number;
  role: "pb-or-race" | "fallback";
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizedPersonalWeights(weights: PersonalPredictionWeights | null | undefined): PersonalPredictionWeights {
  return {
    longRun: clamp(weights?.longRun ?? 1, 0.35, 1.75),
    aerobic: clamp(weights?.aerobic ?? 1, 0, 2),
    power: clamp(weights?.power ?? 1, 0, 2),
    endurance: clamp(weights?.endurance ?? 1, 0.35, 1.75),
    trainingLoad: clamp(weights?.trainingLoad ?? 1, 0, 2)
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function quantile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(percentile, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function weightedQuantile(candidates: PerformanceCandidate[], percentile: number): number | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => a.projectedFinishSec - b.projectedFinishSec);
  const totalWeight = sorted.reduce((sum, candidate) => sum + candidate.weight, 0);
  if (totalWeight <= 0) return median(sorted.map((candidate) => candidate.projectedFinishSec));
  const target = totalWeight * clamp(percentile, 0, 1);
  let cumulative = 0;
  for (const candidate of sorted) {
    cumulative += candidate.weight;
    if (cumulative >= target) return candidate.projectedFinishSec;
  }
  return sorted.at(-1)?.projectedFinishSec ?? null;
}

function runTimeMs(run: RunningRecord): number | null {
  const value = new Date(run.dateTime).getTime();
  return Number.isFinite(value) ? value : null;
}

function validRunDuration(run: RunningRecord): number | null {
  if (Number.isFinite(run.durationSec) && run.durationSec > 0) return run.durationSec;
  const estimated = run.avgPaceSecPerKm * run.distanceKm;
  return Number.isFinite(estimated) && estimated > 0 ? estimated : null;
}

function effortWeight(score: number | null | undefined): number {
  if (score === null || score === undefined) return 0.48;
  return clamp(0.5 + (score - 7) * 0.16, 0.5, 1);
}

function weatherReliability(run: RunningRecord): number {
  const { temperatureC, humidityPct, aqi } = run.weather;
  let weight = 1;
  if (temperatureC !== null) {
    if (temperatureC >= 32 || temperatureC <= -5) weight *= 0.68;
    else if (temperatureC >= 27 || temperatureC <= 0) weight *= 0.8;
    else if (temperatureC >= 23) weight *= 0.9;
  }
  if (temperatureC !== null && humidityPct !== null && temperatureC >= 20 && humidityPct >= 80) weight *= 0.88;
  if (aqi !== null) {
    if (aqi >= 150) weight *= 0.78;
    else if (aqi >= 100) weight *= 0.9;
  }
  return clamp(weight, 0.5, 1);
}

function elevationReliability(run: RunningRecord): number {
  if (run.elevationGainM === null || run.elevationGainM === undefined || run.distanceKm <= 0) return 1;
  const metersPerKm = run.elevationGainM / run.distanceKm;
  if (metersPerKm >= 45) return 0.7;
  if (metersPerKm >= 25) return 0.82;
  if (metersPerKm >= 12) return 0.92;
  return 1;
}

function buildPerformanceCandidates(
  runs: RunningRecord[],
  targetDistanceKm: number,
  referenceDate: Date
): PerformanceCandidate[] {
  const valid = runs.flatMap((run) => {
    const durationSec = validRunDuration(run);
    const timeMs = runTimeMs(run);
    if (durationSec === null || timeMs === null || run.distanceKm < 1.45 || timeMs > referenceDate.getTime() + DAY_MS) return [];
    const vdot = vdotFromPerformance(run.distanceKm, durationSec);
    if (!Number.isFinite(vdot) || vdot <= 0) return [];
    return [{ run, durationSec, timeMs, vdot }];
  });
  const validRunIds = new Set(valid.map(({ run }) => run.id));
  const validRuns = valid.map(({ run }) => run);
  const directPerformances = new Map<string, { run: RunningRecord; distanceKm: number; durationSec: number; vdot: number }>();
  for (const personalBest of buildVdotModel(validRuns).personalBests) {
    const sourceRun = validRuns.find((run) => run.id === personalBest.sourceRunId);
    if (!sourceRun) continue;
    directPerformances.set(`${sourceRun.id}:${personalBest.distanceKm}`, {
      run: sourceRun,
      distanceKm: personalBest.distanceKm,
      durationSec: personalBest.estimatedDurationSec,
      vdot: personalBest.vdot
    });
  }
  for (const run of validRuns.filter((item) => item.performanceType === "race")) {
    const standardPerformance = standardDistancePerformancesForRun(run)
      .filter((performance) => isWithinStandardDistanceTolerance(run.distanceKm, performance.distanceKm))
      .sort((a, b) => Math.abs(a.distanceKm - run.distanceKm) - Math.abs(b.distanceKm - run.distanceKm))[0];
    const distanceKm = standardPerformance?.distanceKm ?? run.distanceKm;
    const durationSec = standardPerformance?.estimatedDurationSec ?? validRunDuration(run);
    if (durationSec === null || distanceKm < 1.5) continue;
    directPerformances.set(`${run.id}:${distanceKm}`, {
      run,
      distanceKm,
      durationSec,
      vdot: vdotFromPerformance(distanceKm, durationSec)
    });
  }

  const unlabeledThreshold = quantile(valid.map((item) => item.vdot), 0.7) ?? Number.POSITIVE_INFINITY;
  const sourceCandidates = directPerformances.size > 0
    ? [...directPerformances.values()].map((item) => ({ ...item, role: "pb-or-race" as const }))
    : valid
        .filter(({ run, vdot }) => validRunIds.has(run.id) && vdot >= unlabeledThreshold)
        .map(({ run, durationSec, vdot }) => ({ run, distanceKm: run.distanceKm, durationSec, vdot, role: "fallback" as const }));

  return sourceCandidates.flatMap(({ run, distanceKm, vdot, role }) => {
    const timeMs = runTimeMs(run);
    if (timeMs === null) return [];
    const score = run.effortScore;
    const daysOld = Math.max(0, (referenceDate.getTime() - timeMs) / DAY_MS);
    const recencyWeight = Math.max(0.12, Math.exp(-daysOld / 180));
    const distanceWeight = Math.max(0.15, Math.exp(-1.55 * Math.abs(Math.log(distanceKm / targetDistanceKm))));
    const weatherWeight = weatherReliability(run);
    const powerCoverage = run.splits.length > 0
      ? run.splits.filter((split) => split.powerW > 0).length / run.splits.length
      : run.avgPowerW > 0 ? 1 : 0;
    const powerWeight = powerCoverage >= 0.5 ? 1.08 : 1;
    const cadenceValues = run.splits.map((split) => split.cadenceSpm).filter((value) => value > 0);
    const cadenceCoverage = run.splits.length > 0 ? cadenceValues.length / run.splits.length : run.avgCadenceSpm > 0 ? 1 : 0;
    const cadenceMean = cadenceValues.length > 0 ? cadenceValues.reduce((sum, value) => sum + value, 0) / cadenceValues.length : null;
    const cadenceVariation = cadenceMean && cadenceValues.length >= 2
      ? Math.sqrt(cadenceValues.reduce((sum, value) => sum + (value - cadenceMean) ** 2, 0) / cadenceValues.length) / cadenceMean
      : null;
    const cadenceWeight = cadenceCoverage >= 0.5 ? cadenceVariation !== null && cadenceVariation > 0.1 ? 0.94 : 1.03 : 1;
    const roleWeight = role === "pb-or-race" ? 1 : 0.22;
    return [{
      run,
      projectedFinishSec: predictDurationFromVdot(vdot, targetDistanceKm),
      weight: recencyWeight * distanceWeight * effortWeight(score) * weatherWeight * powerWeight * cadenceWeight * roleWeight * elevationReliability(run),
      distanceWeight,
      daysOld,
      weatherWeight,
      role
    }];
  });
}

function targetWeeklyDistance(targetDistanceKm: number): number {
  if (targetDistanceKm <= 5) return 15;
  if (targetDistanceKm <= 10) return 24;
  if (targetDistanceKm <= 21.2) return 32;
  return 40;
}

function weeklyVolumeImpact(targetDistanceKm: number, weeklyDistanceKm: number): { impactPercent: number; reference: string } {
  // These are continuous evidence mappings, not eligibility thresholds or training prescriptions.
  // Fokkema et al. (2020) reported faster half-marathon outcomes above 32 km/week;
  // for marathons, <40 km/week was slower and >65 km/week was faster.
  if (targetDistanceKm <= 10) {
    const referenceDistance = targetWeeklyDistance(targetDistanceKm);
    const ratio = weeklyDistanceKm / referenceDistance;
    const penalty = ratio >= 1 ? 0 : clamp((1 - ratio) * 3, 0, 3);
    const credit = ratio <= 1 ? 0 : clamp((ratio - 1) * 2, 0, 1.5);
    return { impactPercent: penalty - credit, reference: `${referenceDistance} km/周参考线` };
  }

  if (targetDistanceKm <= 21.2) {
    const penalty = weeklyDistanceKm >= 32 ? 0 : clamp((1 - weeklyDistanceKm / 32) * 4, 0, 4);
    const credit = weeklyDistanceKm <= 32 ? 0 : clamp(((weeklyDistanceKm - 32) / 32) * 1.5, 0, 1.5);
    return { impactPercent: penalty - credit, reference: "32 km/周群体参考线" };
  }

  const penalty = weeklyDistanceKm >= 40 ? 0 : clamp((1 - weeklyDistanceKm / 40) * 6, 0, 6);
  const credit = weeklyDistanceKm <= 65 ? 0 : clamp(((weeklyDistanceKm - 65) / 65) * 2, 0, 2);
  return { impactPercent: penalty - credit, reference: "40-65 km/周群体参考区间" };
}

function energyScoreProjectionAdjustment(score: number | null | undefined): number {
  if (score === null || score === undefined) return 0;
  if (score <= 4) return -1.5;
  if (score === 5) return -1;
  if (score === 6) return -0.5;
  if (score === 7) return 0;
  if (score === 8) return 0.3;
  if (score === 9) return 0.7;
  return 1;
}

function buildNearTargetLongRunPrediction(
  runs: RunningRecord[],
  targetDistanceKm: number,
  referenceDate: Date,
  performanceBaselineSec: number
): NearTargetLongRunPrediction | null {
  if (targetDistanceKm < 5) return null;
  const cutoff = referenceDate.getTime() - 120 * DAY_MS;
  const minimumCoverage = targetDistanceKm <= 10 ? 0.7 : targetDistanceKm <= 21.2 ? 0.65 : 0.6;
  const candidates = runs.flatMap((run) => {
    const timeMs = runTimeMs(run);
    if (timeMs === null || timeMs < cutoff || timeMs > referenceDate.getTime() + DAY_MS) return [];
    const coverage = run.distanceKm / targetDistanceKm;
    if (coverage < minimumCoverage || coverage >= 0.98) return [];

    const splitProfile = analyzeRunSplits(run);
    const splitCoverage = splitProfile && run.distanceKm > 0
      ? clamp(splitProfile.coveredDistanceKm / run.distanceKm, 0, 1)
      : 0;
    const paceSecPerKm = splitProfile && splitCoverage >= 0.75
      ? splitProfile.averagePaceSecPerKm
      : run.avgPaceSecPerKm;
    if (!Number.isFinite(paceSecPerKm) || paceSecPerKm <= 0) return [];

    const observedDurationSec = paceSecPerKm * run.distanceKm;
    const riegelProjectionSec = observedDurationSec * (targetDistanceKm / run.distanceKm) ** 1.06;
    const paceFadeAdjustment = splitProfile?.secondHalfPaceChangePercent === null || splitProfile?.secondHalfPaceChangePercent === undefined
      ? 0
      : clamp(splitProfile.secondHalfPaceChangePercent * 0.22, -1, 3);
    const driftAdjustment = splitProfile?.cardioDriftPercent === null || splitProfile?.cardioDriftPercent === undefined
      ? 0
      : clamp((splitProfile.cardioDriftPercent - 5) * 0.12, 0, 2.5);
    const powerAdjustment = splitProfile?.powerChangePercent !== null && splitProfile?.powerChangePercent !== undefined
      ? clamp(-splitProfile.powerChangePercent * 0.06, -0.4, 1.2)
      : 0;
    const cadenceAdjustment = splitProfile?.cadenceChangePercent !== null && splitProfile?.cadenceChangePercent !== undefined
      ? clamp(-splitProfile.cadenceChangePercent * 0.08, -0.4, 1.2)
      : 0;
    const stabilityAdjustment =
      clamp(((splitProfile?.powerVariationPercent ?? 0) - 8) * 0.04, 0, 0.8) +
      clamp(((splitProfile?.cadenceVariationPercent ?? 0) - 5) * 0.08, 0, 0.8);
    const projectionAdjustment = clamp(
      paceFadeAdjustment + driftAdjustment + powerAdjustment + cadenceAdjustment + stabilityAdjustment +
        energyScoreProjectionAdjustment(run.effortScore),
      -2.5,
      7
    );
    const projectedFinishSec = riegelProjectionSec * (1 + projectionAdjustment / 100);
    const appliedFinishSec = clamp(
      projectedFinishSec,
      performanceBaselineSec * 0.94,
      performanceBaselineSec * 1.15
    );

    const coverageQuality = clamp((coverage - minimumCoverage) / (1 - minimumCoverage), 0, 1);
    const splitQuality = splitProfile
      ? clamp(splitProfile.splitCount / 8, 0, 1) * splitCoverage
      : 0;
    const daysOld = Math.max(0, (referenceDate.getTime() - timeMs) / DAY_MS);
    const recencyWeight = Math.exp(-daysOld / 120);
    const reliability = weatherReliability(run) * elevationReliability(run);
    let blendWeight = clamp((0.18 + coverageQuality * 0.3 + splitQuality * 0.15) * recencyWeight * reliability, 0.12, 0.6);
    if (!splitProfile) blendWeight = Math.min(blendWeight, 0.3);

    return [{
      evidenceScore: blendWeight * coverage,
      prediction: {
        sourceRunId: run.id,
        sourceDate: run.dateTime.slice(0, 10),
        sourceDistanceKm: run.distanceKm,
        supportingRunCount: 1,
        coveragePercent: coverage * 100,
        projectedFinishSec,
        appliedFinishSec,
        blendWeightPercent: blendWeight * 100,
        splitCount: splitProfile?.splitCount ?? 0,
        splitCoveragePercent: splitCoverage * 100,
        secondHalfPaceChangePercent: splitProfile?.secondHalfPaceChangePercent ?? null,
        cardioDriftPercent: splitProfile?.cardioDriftPercent ?? null,
        powerChangePercent: splitProfile?.powerChangePercent ?? null,
        cadenceChangePercent: splitProfile?.cadenceChangePercent ?? null,
        energyScore: run.effortScore ?? null
      } satisfies NearTargetLongRunPrediction
    }];
  });

  candidates.sort((a, b) => b.evidenceScore - a.evidenceScore);
  const primary = candidates[0]?.prediction;
  if (!primary) return null;

  const supportingCandidates = candidates.slice(0, 3);
  const totalEvidence = supportingCandidates.reduce((sum, candidate) => sum + candidate.evidenceScore, 0);
  const weightedValue = (selector: (prediction: NearTargetLongRunPrediction) => number) =>
    supportingCandidates.reduce((sum, candidate) => sum + selector(candidate.prediction) * candidate.evidenceScore, 0) / totalEvidence;
  const projectedFinishSec = weightedValue((prediction) => prediction.projectedFinishSec);
  const appliedFinishSec = weightedValue((prediction) => prediction.appliedFinishSec);
  const maximumDisagreement = supportingCandidates.reduce(
    (maximum, candidate) => Math.max(maximum, Math.abs(candidate.prediction.projectedFinishSec - projectedFinishSec) / projectedFinishSec),
    0
  );
  const consistencyBonus = maximumDisagreement <= 0.06
    ? Math.min(0.1, (supportingCandidates.length - 1) * 0.04)
    : 0;
  const allWithoutSplits = supportingCandidates.every((candidate) => candidate.prediction.splitCount === 0);
  const blendCap = allWithoutSplits ? 0.3 : 0.65;

  return {
    ...primary,
    supportingRunCount: supportingCandidates.length,
    projectedFinishSec,
    appliedFinishSec,
    blendWeightPercent: Math.min(blendCap, primary.blendWeightPercent / 100 + consistencyBonus) * 100
  };
}

function compactDuration(durationSec: number): string {
  const totalMinutes = Math.round(durationSec / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}小时${minutes}分` : `${minutes}分`;
}

function longRunDetail(prediction: NearTargetLongRunPrediction): string {
  const splitDetails: string[] = [];
  if (prediction.secondHalfPaceChangePercent !== null) {
    splitDetails.push(`后半程配速${prediction.secondHalfPaceChangePercent > 0 ? "变慢" : "加快"}${Math.abs(prediction.secondHalfPaceChangePercent).toFixed(1)}%`);
  }
  if (prediction.cardioDriftPercent !== null) splitDetails.push(`心率效率漂移 ${prediction.cardioDriftPercent.toFixed(1)}%`);
  if (prediction.powerChangePercent !== null) splitDetails.push(`功率变化 ${prediction.powerChangePercent > 0 ? "+" : ""}${prediction.powerChangePercent.toFixed(1)}%`);
  if (prediction.cadenceChangePercent !== null) splitDetails.push(`步频变化 ${prediction.cadenceChangePercent > 0 ? "+" : ""}${prediction.cadenceChangePercent.toFixed(1)}%`);
  const splitText = splitDetails.length > 0 ? splitDetails.join("，") : "未录入足够分段，按平均配速低权重参与";
  const energyText = prediction.energyScore === null ? "未录入耗能评分" : `耗能评分 ${prediction.energyScore}`;
  const supportText = prediction.supportingRunCount > 1 ? `，另有 ${prediction.supportingRunCount - 1} 次相近长跑共同支撑` : "";
  return `${prediction.sourceDate} 的 ${prediction.sourceDistanceKm.toFixed(1)} km 覆盖目标 ${Math.round(prediction.coveragePercent)}%${supportText}，独立推算 ${compactDuration(prediction.projectedFinishSec)}；${splitText}，${energyText}。以 ${Math.round(prediction.blendWeightPercent)}% 权重与 PB/比赛基线融合。`;
}

function enduranceAdjustment(
  runs: RunningRecord[],
  targetDistanceKm: number,
  referenceDate: Date
): { impactPercent: number; distancePenalty: number; volumeImpact: number; detail: string; coverage: number } {
  const cutoff120 = referenceDate.getTime() - 120 * DAY_MS;
  const cutoff42 = referenceDate.getTime() - 42 * DAY_MS;
  const recentRuns = runs.filter((run) => {
    const time = runTimeMs(run);
    return time !== null && time >= cutoff120 && time <= referenceDate.getTime() + DAY_MS;
  });
  const longest = recentRuns.reduce((max, run) => Math.max(max, run.distanceKm), 0);
  const coverage = targetDistanceKm > 0 ? longest / targetDistanceKm : 0;
  const requiredCoverage = targetDistanceKm <= 5 ? 0.8 : targetDistanceKm <= 10 ? 0.75 : targetDistanceKm <= 21.2 ? 0.85 : 0.6;
  const distancePenalty = coverage >= requiredCoverage ? 0 : clamp((requiredCoverage - coverage) * 24, 0, 12);
  const sixWeekDistance = runs.reduce((sum, run) => {
    const time = runTimeMs(run);
    return time !== null && time >= cutoff42 && time <= referenceDate.getTime() + DAY_MS ? sum + run.distanceKm : sum;
  }, 0);
  const weeklyDistance = sixWeekDistance / 6;
  const volumeEvidence = weeklyVolumeImpact(targetDistanceKm, weeklyDistance);
  const volumeImpact = volumeEvidence.impactPercent;
  const impactPercent = distancePenalty + volumeImpact;
  return {
    impactPercent,
    distancePenalty,
    volumeImpact,
    coverage,
    detail: `近 120 天最长 ${longest.toFixed(1)} km（目标覆盖 ${Math.round(coverage * 100)}%），近 6 周周均 ${weeklyDistance.toFixed(1)} km；${volumeEvidence.reference}仅作连续修正，不是参与门槛。`
  };
}

function inferredExertion(run: RunningRecord, effectiveMaxHeartRateBpm: number | null): number {
  if (run.effortScore !== null && run.effortScore !== undefined) return run.effortScore;
  if (effectiveMaxHeartRateBpm && run.avgHeartRateBpm > 0) {
    const fraction = run.avgHeartRateBpm / effectiveMaxHeartRateBpm;
    return clamp(Math.round(2 + (fraction - 0.55) * 16), 2, 9);
  }
  return 4;
}

function trainingLoadAdjustment(
  runs: RunningRecord[],
  effectiveMaxHeartRateBpm: number | null,
  referenceDate: Date
): { impactPercent: number; detail: string } {
  let acute = 0;
  let prior = 0;
  let latestRunDays = Number.POSITIVE_INFINITY;
  for (const run of runs) {
    const time = runTimeMs(run);
    if (time === null || time > referenceDate.getTime() + DAY_MS) continue;
    const daysOld = Math.max(0, (referenceDate.getTime() - time) / DAY_MS);
    latestRunDays = Math.min(latestRunDays, daysOld);
    const durationMin = (validRunDuration(run) ?? 0) / 60;
    const load = durationMin * inferredExertion(run, effectiveMaxHeartRateBpm);
    if (daysOld <= 7) acute += load;
    else if (daysOld <= 35) prior += load;
  }
  const chronicWeekly = prior / 4;
  const ratio = chronicWeekly > 0 ? acute / chronicWeekly : null;
  let impactPercent = 0;
  if (ratio !== null && ratio > 1.35) impactPercent += clamp((ratio - 1.35) * 3.5, 0, 3.5);
  if (latestRunDays > 14) impactPercent += clamp((latestRunDays - 14) * 0.12, 0, 3);
  const ratioText = ratio === null ? "暂无稳定基线" : ratio.toFixed(2);
  return {
    impactPercent,
    detail: `最近 7 天负荷 ${Math.round(acute)}，此前 4 周周均 ${Math.round(chronicWeekly)}，负荷比 ${ratioText}。`
  };
}

function confidenceFromScore(score: number): PredictionConfidence {
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  return "low";
}

export function buildSmartPrediction(
  runs: RunningRecord[],
  targetDistanceKm: number,
  options: {
    runnerProfile?: RunnerProfile | null;
    referenceDate?: Date;
    calibration?: SmartPredictionCalibration | null;
  } = {}
): SmartPredictionSummary | null {
  if (!Number.isFinite(targetDistanceKm) || targetDistanceKm <= 0) return null;
  const referenceDate = options.referenceDate ?? new Date();
  const usableRuns = runs.filter((run) => {
    const time = runTimeMs(run);
    return time !== null && time <= referenceDate.getTime() + DAY_MS;
  });
  const candidates = buildPerformanceCandidates(usableRuns, targetDistanceKm, referenceDate);
  const basePrediction = weightedQuantile(candidates, 0.5);
  if (basePrediction === null) return null;

  const nearTargetLongRun = buildNearTargetLongRunPrediction(
    usableRuns,
    targetDistanceKm,
    referenceDate,
    basePrediction
  );
  const longRunBlendWeight = (nearTargetLongRun?.blendWeightPercent ?? 0) / 100;
  const defaultBlendedBasePrediction = nearTargetLongRun
    ? basePrediction * (1 - longRunBlendWeight) + nearTargetLongRun.appliedFinishSec * longRunBlendWeight
    : basePrediction;
  const rawLongRunImpactPercent = (defaultBlendedBasePrediction / basePrediction - 1) * 100;
  const personalWeights = normalizedPersonalWeights(options.calibration?.factorWeights);
  const longRunImpactPercent = rawLongRunImpactPercent * personalWeights.longRun;
  const blendedBasePrediction = basePrediction * (1 + longRunImpactPercent / 100);

  const baseline = buildHeartRateBaseline(options.runnerProfile ?? null, usableRuns, referenceDate);
  const splitAnalytics = buildSplitAnalytics(usableRuns);
  const aerobicChange = splitAnalytics.cardioEfficiencyChangePercent;
  const driftPenalty = splitAnalytics.medianDriftPercent === null
    ? 0
    : clamp((splitAnalytics.medianDriftPercent - 5) * 0.15, 0, 2);
  const rawAerobicImpact = (aerobicChange === null ? 0 : -clamp(aerobicChange * 0.2, -2, 2)) + driftPenalty;
  const aerobicImpact = rawAerobicImpact * personalWeights.aerobic;
  const powerChange = splitAnalytics.powerEfficiencyChangePercent;
  const rawPowerImpact = powerChange === null ? 0 : -clamp(powerChange * 0.15, -1.5, 1.5);
  const powerImpact = rawPowerImpact * personalWeights.power;
  const endurance = enduranceAdjustment(usableRuns, targetDistanceKm, referenceDate);
  const rawEnduranceImpact = nearTargetLongRun
    ? endurance.volumeImpact
    : endurance.impactPercent;
  const enduranceImpact = rawEnduranceImpact * personalWeights.endurance;
  const trainingLoad = trainingLoadAdjustment(usableRuns, baseline.effectiveMaxHeartRateBpm, referenceDate);
  const trainingLoadImpact = trainingLoad.impactPercent * personalWeights.trainingLoad;
  const totalImpact = clamp(aerobicImpact + powerImpact + enduranceImpact + trainingLoadImpact, -5, 18);
  const modelPredictionSec = blendedBasePrediction * (1 + totalImpact / 100);
  const calibrationImpact = clamp(options.calibration?.finishTimeAdjustmentPercent ?? 0, -8, 8);
  const calibrationMultiplier = 1 + calibrationImpact / 100;
  const predictedFinishSec = modelPredictionSec * calibrationMultiplier;

  const comparableCandidates = candidates.filter((candidate) => candidate.distanceWeight >= 0.5 && candidate.daysOld <= 180);
  const latestCandidateDays = candidates.reduce((min, candidate) => Math.min(min, candidate.daysOld), Number.POSITIVE_INFINITY);
  const calibrationCount = options.calibration?.sampleCount ?? 0;
  let confidenceScore = Math.min(25, candidates.length * 6);
  confidenceScore += Math.min(25, comparableCandidates.length * 9);
  confidenceScore += latestCandidateDays <= 30 ? 15 : latestCandidateDays <= 90 ? 10 : latestCandidateDays <= 180 ? 5 : 0;
  confidenceScore += Math.min(15, endurance.coverage * 15);
  confidenceScore += splitAnalytics.runs.length >= 4 ? 8 : splitAnalytics.runs.length > 0 ? 4 : 0;
  if (nearTargetLongRun) {
    confidenceScore += Math.min(10, nearTargetLongRun.blendWeightPercent / 5);
    if (nearTargetLongRun.splitCount >= 6 && nearTargetLongRun.splitCoveragePercent >= 75) confidenceScore += 4;
  }
  confidenceScore += Math.min(12, calibrationCount * 3);
  if (targetDistanceKm > 21.2 && endurance.coverage < 0.5) {
    confidenceScore = Math.min(confidenceScore, 44);
  }
  confidenceScore = Math.round(clamp(confidenceScore, 0, 100));
  const confidence = confidenceFromScore(confidenceScore);

  const lowCandidate = weightedQuantile(candidates, 0.2) ?? basePrediction;
  const highCandidate = weightedQuantile(candidates, 0.8) ?? basePrediction;
  const defaultAdjustedLowBase = nearTargetLongRun
    ? lowCandidate * (1 - longRunBlendWeight) + nearTargetLongRun.appliedFinishSec * longRunBlendWeight
    : lowCandidate;
  const defaultAdjustedHighBase = nearTargetLongRun
    ? highCandidate * (1 - longRunBlendWeight) + nearTargetLongRun.appliedFinishSec * longRunBlendWeight
    : highCandidate;
  const adjustedLowBase = lowCandidate * (1 + ((defaultAdjustedLowBase / lowCandidate - 1) * personalWeights.longRun));
  const adjustedHighBase = highCandidate * (1 + ((defaultAdjustedHighBase / highCandidate - 1) * personalWeights.longRun));
  const adjustedLow = adjustedLowBase * (1 + totalImpact / 100) * calibrationMultiplier;
  const adjustedHigh = adjustedHighBase * (1 + totalImpact / 100) * calibrationMultiplier;
  const sampleSpread = Math.max(Math.abs(predictedFinishSec - adjustedLow), Math.abs(adjustedHigh - predictedFinishSec));
  const longRunDisagreement = nearTargetLongRun
    ? Math.abs(blendedBasePrediction - basePrediction)
    : 0;
  const defaultRangePercent = confidence === "high" ? 0.04 : confidence === "medium" ? 0.075 : 0.12;
  const calibratedRange = options.calibration?.absoluteErrorPercentile
    ? predictedFinishSec * options.calibration.absoluteErrorPercentile / 100
    : 0;
  const halfRange = Math.max(predictedFinishSec * defaultRangePercent, sampleSpread, calibratedRange, longRunDisagreement);
  const weatherDownweighted = candidates.filter((candidate) => candidate.weatherWeight < 0.95).length;
  const directCount = candidates.filter((candidate) => candidate.role === "pb-or-race").length;
  const fallbackCount = candidates.filter((candidate) => candidate.role === "fallback").length;

  const factors: SmartPredictionFactor[] = [
    {
      key: "performance",
      label: "PB 与比赛成绩",
      impactPercent: 0,
      detail: fallbackCount > 0
        ? `暂无标准距离 PB 或比赛记录，暂用 ${fallbackCount} 条较快记录低权重估算。`
        : `${directCount} 条 PB/比赛成绩参与，${comparableCandidates.length} 条与目标距离和时效较接近。`
    },
    {
      key: "long-run",
      label: "接近目标长跑",
      impactPercent: longRunImpactPercent,
      detail: nearTargetLongRun
        ? `${longRunDetail(nearTargetLongRun)} 个人权重 ${personalWeights.longRun.toFixed(2)}x。`
        : `最近 120 天没有可用于目标外推的长跑记录，本项暂不参与成绩融合；个人权重 ${personalWeights.longRun.toFixed(2)}x。`
    },
    {
      key: "aerobic",
      label: "分段心率效率",
      impactPercent: aerobicImpact,
      detail: aerobicChange === null
        ? `至少需要 4 次含完整分段的记录，暂未调整；个人权重 ${personalWeights.aerobic.toFixed(2)}x。`
        : `全部心率区间的近期速度/心率效率变化 ${aerobicChange > 0 ? "+" : ""}${aerobicChange.toFixed(1)}%${splitAnalytics.medianDriftPercent === null ? "。" : `，近期分段效率漂移中位数 ${splitAnalytics.medianDriftPercent.toFixed(1)}%。`} 个人权重 ${personalWeights.aerobic.toFixed(2)}x。`
    },
    {
      key: "power",
      label: "分段功率效率",
      impactPercent: powerImpact,
      detail: powerChange === null ? `可比分段功率记录不足，功率完整度只用于调整记录可靠性；个人权重 ${personalWeights.power.toFixed(2)}x。` : `全部心率区间的近期功率/心率效率变化 ${powerChange > 0 ? "+" : ""}${powerChange.toFixed(1)}%；个人权重 ${personalWeights.power.toFixed(2)}x。`
    },
    {
      key: "cadence",
      label: "分段步频稳定性",
      impactPercent: 0,
      detail: splitAnalytics.cadenceChangePercent === null
        ? "可比分段步频记录不足，目前只用于判断记录稳定性。"
        : `近期平均步频变化 ${splitAnalytics.cadenceChangePercent > 0 ? "+" : ""}${splitAnalytics.cadenceChangePercent.toFixed(1)}%，不把更高步频直接视为更好成绩。`
    },
    {
      key: "endurance",
      label: "距离与跑量支撑",
      impactPercent: enduranceImpact,
      detail: nearTargetLongRun
        ? `${endurance.detail} 接近目标长跑已直接参与成绩融合，因此不再重复叠加“距离不足”修正；个人权重 ${personalWeights.endurance.toFixed(2)}x。`
        : `${endurance.detail} 个人权重 ${personalWeights.endurance.toFixed(2)}x。`
    },
    {
      key: "training-load",
      label: "近期训练负荷",
      impactPercent: trainingLoadImpact,
      detail: `${trainingLoad.detail} 个人权重 ${personalWeights.trainingLoad.toFixed(2)}x。`
    },
    {
      key: "calibration",
      label: "个人权重优化",
      impactPercent: calibrationImpact,
      detail: calibrationCount === 0 || options.calibration?.rawBiasPercent === null || options.calibration?.rawBiasPercent === undefined
        ? "尚无可用的时间前推回测样本，五项因素暂时保持默认 1.00x 权重。"
        : `根据 ${calibrationCount} 条历史回测，模型原始结果整体${options.calibration.rawBiasPercent >= 0 ? "偏快" : "偏慢"} ${Math.abs(options.calibration.rawBiasPercent).toFixed(1)}%，当前按 ${Math.round(options.calibration.strengthPercent)}% 强度学习；长跑 ${personalWeights.longRun.toFixed(2)}x、心率效率 ${personalWeights.aerobic.toFixed(2)}x、功率 ${personalWeights.power.toFixed(2)}x、耐力 ${personalWeights.endurance.toFixed(2)}x、近期负荷 ${personalWeights.trainingLoad.toFixed(2)}x，并对最终时间应用 ${calibrationImpact >= 0 ? "+" : ""}${calibrationImpact.toFixed(1)}% 偏差修正。`
    },
    {
      key: "weather",
      label: "天气可靠性",
      impactPercent: 0,
      detail: weatherDownweighted > 0 ? `${weatherDownweighted} 条高温、高湿或空气质量较差的记录已降低权重。` : "参与预测的记录未触发明显天气降权。"
    }
  ];

  return {
    modelVersion: "smart-v6",
    predictedFinishSec,
    rangeSec: {
      optimistic: Math.max(60, predictedFinishSec - halfRange),
      conservative: predictedFinishSec + halfRange
    },
    confidence,
    confidenceScore,
    performanceSampleCount: candidates.length,
    calibrationSampleCount: calibrationCount,
    calibrationAdjustmentPercent: calibrationImpact,
    calibrationRawBiasPercent: options.calibration?.rawBiasPercent ?? null,
    calibrationStrengthPercent: options.calibration?.strengthPercent ?? 0,
    personalWeights,
    components: {
      performanceBaselineSec: basePrediction,
      factorImpactsPercent: {
        longRun: rawLongRunImpactPercent,
        aerobic: rawAerobicImpact,
        power: rawPowerImpact,
        endurance: rawEnduranceImpact,
        trainingLoad: trainingLoad.impactPercent
      }
    },
    nearTargetLongRun,
    factors
  };
}
