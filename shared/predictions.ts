import type {
  PredictionBacktestEntry,
  PredictionBacktestMetrics,
  PredictionBacktestResult,
  PredictionResult,
  PersonalPredictionWeights,
  RunnerProfile,
  RunningRecord,
  SmartPredictionComponents,
  TrendLine,
  WeightRecord
} from "./types";
import {
  buildSmartPrediction,
  DEFAULT_PERSONAL_PREDICTION_WEIGHTS,
  type SmartPredictionCalibration
} from "./smartPrediction";
import {
  buildVdotModel,
  isWithinStandardDistanceTolerance,
  predictDurationFromVdot,
  requiredVdotForGoal,
  standardDistancePerformancesForRun
} from "./vdot";

type Point = { x: number; y: number };

type PredictionOptions = {
  targetFinishSec?: number | null;
  targetDate?: string | null;
  runnerProfile?: RunnerProfile | null;
};

type BacktestTarget = {
  run: RunningRecord;
  runIndex: number;
  distanceKm: number;
  durationSec: number;
  benchmarkType: "pb" | "race";
  benchmarkLabel: string;
};

function buildBacktestTargets(sortedRuns: RunningRecord[]): BacktestTarget[] {
  const bestDurationByDistance = new Map<string, number>();
  const targets: BacktestTarget[] = [];

  sortedRuns.forEach((run, runIndex) => {
    const performances = standardDistancePerformancesForRun(run);
    const improvedPerformances = performances.filter((performance) => {
      const previousBest = bestDurationByDistance.get(performance.key);
      return previousBest === undefined || performance.estimatedDurationSec < previousBest - 0.5;
    });
    for (const performance of performances) {
      const previousBest = bestDurationByDistance.get(performance.key);
      if (previousBest === undefined || performance.estimatedDurationSec < previousBest) {
        bestDurationByDistance.set(performance.key, performance.estimatedDurationSec);
      }
    }

    if (run.performanceType === "race") {
      const normalizedRace = performances
        .filter((performance) => isWithinStandardDistanceTolerance(run.distanceKm, performance.distanceKm))
        .sort((a, b) => Math.abs(a.distanceKm - run.distanceKm) - Math.abs(b.distanceKm - run.distanceKm))[0];
      const durationSec = normalizedRace?.estimatedDurationSec
        ?? (run.durationSec > 0 ? run.durationSec : run.avgPaceSecPerKm * run.distanceKm);
      const raceDistanceKm = normalizedRace?.distanceKm ?? run.distanceKm;
      if (raceDistanceKm >= 1.5 && Number.isFinite(durationSec) && durationSec > 0) {
        targets.push({
          run,
          runIndex,
          distanceKm: raceDistanceKm,
          durationSec,
          benchmarkType: "race",
          benchmarkLabel: normalizedRace ? `${normalizedRace.label}比赛` : "比赛"
        });
      }
      return;
    }

    const primaryPb = improvedPerformances
      .sort((a, b) => Math.abs(a.distanceKm - run.distanceKm) - Math.abs(b.distanceKm - run.distanceKm))[0];
    if (primaryPb) {
      targets.push({
        run,
        runIndex,
        distanceKm: primaryPb.distanceKm,
        durationSec: primaryPb.estimatedDurationSec,
        benchmarkType: "pb",
        benchmarkLabel: `${primaryPb.label} PB`
      });
    }
  });

  return targets;
}

function linearRegression(points: Point[]): TrendLine | null {
  if (points.length < 2) {
    return null;
  }
  const n = points.length;
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) {
    return null;
  }
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  const ssTotal = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  const ssResidual = points.reduce((sum, point) => sum + (point.y - (slope * point.x + intercept)) ** 2, 0);
  const r2 = ssTotal === 0 ? 1 : 1 - ssResidual / ssTotal;
  return { slope, intercept, r2 };
}

function pearson(points: Point[]): number | null {
  if (points.length < 3) {
    return null;
  }
  const n = points.length;
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x ** 2, 0);
  const sumYY = points.reduce((sum, point) => sum + point.y ** 2, 0);
  const denominator = Math.sqrt((n * sumXX - sumX ** 2) * (n * sumYY - sumY ** 2));
  if (denominator === 0) {
    return null;
  }
  return (n * sumXY - sumX * sumY) / denominator;
}

function dayIndex(dateTime: string, startMs: number): number {
  return Math.max(0, (new Date(dateTime).getTime() - startMs) / 86_400_000);
}

function dateFromDay(startMs: number, day: number): string {
  return new Date(startMs + day * 86_400_000).toISOString().slice(0, 10);
}

function addDays(dateTime: string, days: number): string {
  return new Date(new Date(dateTime).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function progressiveDistanceDate(sortedRuns: RunningRecord[], targetDistanceKm: number): string | null {
  const longestRun = sortedRuns.reduce<RunningRecord | null>((best, run) => (!best || run.distanceKm > best.distanceKm ? run : best), null);
  if (!longestRun || targetDistanceKm <= longestRun.distanceKm) {
    return longestRun?.dateTime.slice(0, 10) ?? null;
  }

  const distanceGapRatio = targetDistanceKm / longestRun.distanceKm;
  if (distanceGapRatio > 2.25) {
    return null;
  }

  const weeklyIncrease = distanceGapRatio <= 1.2 ? 1.08 : 1.06;
  const weeks = Math.max(1, Math.ceil(Math.log(distanceGapRatio) / Math.log(weeklyIncrease)));
  return addDays(longestRun.dateTime, weeks * 7);
}

function nearestWeight(runDate: string, weights: WeightRecord[]): WeightRecord | null {
  const runMs = new Date(runDate).getTime();
  let best: { record: WeightRecord; delta: number } | null = null;
  for (const weight of weights) {
    const delta = Math.abs(new Date(`${weight.date}T00:00:00`).getTime() - runMs);
    if (delta <= 3 * 86_400_000 && (!best || delta < best.delta)) {
      best = { record: weight, delta };
    }
  }
  return best?.record ?? null;
}

export function buildPrediction(
  runs: RunningRecord[],
  weights: WeightRecord[],
  targetDistanceKm = 21.0975,
  options: PredictionOptions = {}
): PredictionResult {
  const sortedRuns = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
  const longestDistanceKm = sortedRuns.reduce((max, run) => Math.max(max, run.distanceKm), 0);
  const achievedRun = sortedRuns.find((run) => run.distanceKm >= targetDistanceKm);
  const achievedTargetDate = achievedRun?.dateTime.slice(0, 10) ?? null;
  const vdotModel = buildVdotModel(sortedRuns);
  if (sortedRuns.length < 3) {
    return {
      status: "insufficient-data",
      runCount: sortedRuns.length,
      targetDistanceKm,
      targetFinishSec: options.targetFinishSec ?? null,
      targetDate: options.targetDate ?? null,
      longestDistanceKm,
      achievedTargetDate,
      paceTrend: null,
      distanceTrend: null,
      heartRateTrend: null,
      weightPaceCorrelation: null,
      predictedTargetFinishSec: null,
      predictedTargetDate: achievedTargetDate,
      predictedDistanceDate: achievedTargetDate,
      predictedGoalFinishDate: null,
      predictedFinishSecAtTargetDate: null,
      distanceProjectionBasis: achievedTargetDate ? "achieved" : "insufficient",
      vdotModel,
      vdotPredictedFinishRangeSec: null,
      smartPrediction: null,
      requiredVdotForTargetFinish: null,
      warnings: achievedTargetDate ? [`已经在 ${achievedTargetDate} 完成过 ${targetDistanceKm.toFixed(2)} km。`] : [],
      recommendations: ["至少记录 3 次跑步后再生成趋势预测。"]
    };
  }

  const startMs = new Date(sortedRuns[0].dateTime).getTime();
  const performanceRunIds = new Set([
    ...vdotModel.personalBests.map((personalBest) => personalBest.sourceRunId),
    ...sortedRuns.filter((run) => run.performanceType === "race").map((run) => run.id)
  ]);
  const performanceRuns = sortedRuns.filter((run) => performanceRunIds.has(run.id));
  const paceSourceRuns = performanceRuns.length >= 3 ? performanceRuns : sortedRuns;
  const pacePoints = paceSourceRuns.map((run) => ({ x: dayIndex(run.dateTime, startMs), y: run.avgPaceSecPerKm }));
  const distancePoints = sortedRuns.map((run) => ({ x: dayIndex(run.dateTime, startMs), y: run.distanceKm }));
  const heartRatePoints = sortedRuns.map((run) => ({ x: dayIndex(run.dateTime, startMs), y: run.avgHeartRateBpm }));
  const paceTrend = linearRegression(pacePoints);
  const distanceTrend = linearRegression(distancePoints);
  const heartRateTrend = linearRegression(heartRatePoints);

  const latestRunDate = sortedRuns[sortedRuns.length - 1].dateTime.slice(0, 10);
  const vdotPredictedFinishRangeSec =
    vdotModel.range && vdotModel.conservativeVdot
      ? {
          conservative: predictDurationFromVdot(vdotModel.conservativeVdot, targetDistanceKm),
          fastest: predictDurationFromVdot(vdotModel.range.max, targetDistanceKm)
        }
      : null;
  const calibration = buildSmartCalibration(sortedRuns, options.runnerProfile ?? null, targetDistanceKm);
  const smartPrediction = buildSmartPrediction(sortedRuns, targetDistanceKm, {
    runnerProfile: options.runnerProfile,
    calibration
  });
  const predictedTargetFinishSec = smartPrediction?.predictedFinishSec ?? vdotPredictedFinishRangeSec?.conservative ?? null;

  let distanceProjectionBasis: PredictionResult["distanceProjectionBasis"] = achievedTargetDate ? "achieved" : "insufficient";
  let predictedDistanceDate: string | null = achievedTargetDate;
  if (!achievedTargetDate) {
    const progressiveDate = progressiveDistanceDate(sortedRuns, targetDistanceKm);
    if (progressiveDate) {
      distanceProjectionBasis = "long-run-progression";
      predictedDistanceDate = progressiveDate;
    }
  }

  let predictedGoalFinishDate: string | null = null;
  const targetFinishSec = options.targetFinishSec ?? null;
  const requiredVdotForTargetFinish = targetFinishSec && targetFinishSec > 0 ? requiredVdotForGoal(targetDistanceKm, targetFinishSec) : null;
  if (
    requiredVdotForTargetFinish !== null &&
    vdotModel.range &&
    requiredVdotForTargetFinish <= vdotModel.range.max &&
    (achievedTargetDate || predictedDistanceDate)
  ) {
    predictedGoalFinishDate = achievedTargetDate ?? predictedDistanceDate;
  }

  let predictedFinishSecAtTargetDate: number | null = null;
  const targetDate = options.targetDate ?? null;
  if (targetDate && vdotModel.range) {
    const canUseTargetDate = !predictedDistanceDate || new Date(targetDate).getTime() >= new Date(predictedDistanceDate).getTime();
    if (canUseTargetDate) {
      predictedFinishSecAtTargetDate = smartPrediction?.predictedFinishSec ?? predictDurationFromVdot(vdotModel.range.max, targetDistanceKm);
    }
  }

  const correlationPoints = sortedRuns
    .map((run) => {
      const weight = nearestWeight(run.dateTime, weights);
      return weight ? { x: weight.weightKg, y: run.avgPaceSecPerKm } : null;
    })
    .filter((point): point is Point => Boolean(point));
  const weightPaceCorrelation = pearson(correlationPoints);

  const recommendations: string[] = [];
  if (vdotModel.range) {
    recommendations.push(
      `当前 PB 折算 VDOT 约为 ${vdotModel.range.min.toFixed(1)}-${vdotModel.range.max.toFixed(1)}。短距离跑力不一定能完整迁移到长距离，预测默认采用保守跑力值估算。`
    );
  }
  if (performanceRuns.length > 0 && performanceRuns.length < 3) {
    recommendations.push("目前只有少量 PB 或比赛记录，配速趋势仍会使用全部历史作为后备；随着 PB 和比赛数据增加，普通跑步对成绩趋势的干扰会进一步减少。");
  }
  if (smartPrediction) {
    const confidenceLabel = smartPrediction.confidence === "high" ? "高" : smartPrediction.confidence === "medium" ? "中" : "低";
    recommendations.push(
      `智能模型可信度为${confidenceLabel}（${smartPrediction.confidenceScore}/100），使用 ${smartPrediction.performanceSampleCount} 条表现记录和 ${smartPrediction.calibrationSampleCount} 条历史回测样本。`
    );
  }
  if (vdotModel.personalBests.length >= 2 && vdotModel.range && vdotModel.range.max - vdotModel.range.min > 2) {
    recommendations.push("不同距离 PB 的 VDOT 差异较大：说明短距离速度、长距离耐力或当天状态存在差别，建议把长距离预测优先参考相近或更长距离 PB。");
  }
  if (paceTrend && paceTrend.slope < -0.5) {
    recommendations.push("配速趋势正在改善：可以维持当前训练频率，每周安排 1 次轻量节奏跑，例如热身 10 分钟后跑 2-4 km，强度控制在“能说短句但不能轻松聊天”，结束后慢跑或步行放松。");
  } else {
    recommendations.push("配速改善不明显：建议每周安排 1 次短距离节奏跑，例如 1 km 热身后做 3-5 组 3 分钟稍快跑 + 2 分钟慢跑恢复；稍快跑不是冲刺，应比日常轻松跑快一些但能稳定完成。");
  }
  if (distanceTrend && distanceTrend.slope > 0.03) {
    recommendations.push("单次距离呈上升趋势：长距离训练可以继续小幅递增，优先把最长单次跑稳定在目标距离的 70%-85%，再考虑提高配速。");
  } else {
    recommendations.push("若目标是延长距离：先稳定每周跑量，再把最长单次跑逐步增加 5%-10%；每增加 2-3 周后安排 1 周回落，减少疲劳累积。");
  }
  if (heartRateTrend && heartRateTrend.slope > 0.2) {
    recommendations.push("同等趋势下心率偏上升：建议提高低强度跑比例，至少保留 1-2 天恢复或休息；如果同样配速下心率持续升高，先减少强度再观察。");
  }
  if (weightPaceCorrelation !== null && Math.abs(weightPaceCorrelation) > 0.45) {
    recommendations.push("体重与配速存在可观察相关性：这只说明两组记录在当前样本里同步变化，不能直接说明体重导致配速变化；后续可同时记录睡眠、疲劳、饮食和天气再判断原因。");
  }
  const warnings: string[] = [];
  if (achievedTargetDate) {
    warnings.push(`已经在 ${achievedTargetDate} 完成过 ${targetDistanceKm.toFixed(2)} km，距离目标不需要再预测到未来。`);
  } else if (!predictedDistanceDate) {
    warnings.push("当前单次距离趋势不足以推算达成日期，建议增加更多长距离记录后再判断。");
  } else if (distanceProjectionBasis === "long-run-progression") {
    warnings.push("距离日期按历史最长距离和保守长跑递增估算，不代表比赛日能力或医疗建议。");
  }
  if (targetDate && targetDate < latestRunDate) {
    warnings.push("目标日期早于最近一次跑步记录，指定日期预测只作历史趋势参考。");
  }
  if (targetFinishSec && !predictedGoalFinishDate) {
    warnings.push("当前 VDOT 跑力范围或距离基础不足以支持目标用时，建议增加相近距离 PB 或降低目标用时。");
  }
  if (vdotPredictedFinishRangeSec && targetDistanceKm > longestDistanceKm * 1.5) {
    warnings.push("目标距离明显长于当前最长跑，VDOT 只能说明速度能力，长距离完赛还需要单次距离和周跑量支撑。");
  }

  return {
    status: "ready",
    runCount: sortedRuns.length,
    targetDistanceKm,
    targetFinishSec,
    targetDate,
    longestDistanceKm,
    achievedTargetDate,
    paceTrend,
    distanceTrend,
    heartRateTrend,
    weightPaceCorrelation,
    predictedTargetFinishSec,
    predictedTargetDate: predictedDistanceDate,
    predictedDistanceDate,
    predictedGoalFinishDate,
    predictedFinishSecAtTargetDate,
    distanceProjectionBasis,
    vdotModel,
    vdotPredictedFinishRangeSec,
    smartPrediction,
    requiredVdotForTargetFinish,
    warnings,
    recommendations
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(1, fraction)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

type PersonalWeightObservation = {
  runIndex: number;
  distanceKm: number;
  timeMs: number;
  defaultPredictedFinishSec: number;
  actualFinishSec: number;
  components: SmartPredictionComponents;
  features: number[];
  targetLogPercent: number;
  logRatio: number;
};

type WeightedPersonalWeightObservation = PersonalWeightObservation & {
  weight: number;
};

function solveLinearSystem(matrix: number[][], values: number[]): number[] | null {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-9) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const multiplier = augmented[row][column];
      for (let index = column; index <= size; index += 1) {
        augmented[row][index] -= multiplier * augmented[column][index];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function fitPersonalParameters(observations: WeightedPersonalWeightObservation[]): { biasLogPercent: number; weights: PersonalPredictionWeights } {
  const priors = [0, 1, 1, 1, 1, 1];
  const priorStrengths = [4, 18, 24, 24, 18, 20];
  let robustWeights = observations.map((observation) => observation.weight);
  let parameters = [...priors];

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const matrix = Array.from({ length: priors.length }, () => Array(priors.length).fill(0));
    const values = Array(priors.length).fill(0);
    for (let index = 0; index < priors.length; index += 1) {
      matrix[index][index] += priorStrengths[index];
      values[index] += priorStrengths[index] * priors[index];
    }
    observations.forEach((observation, observationIndex) => {
      const weight = robustWeights[observationIndex];
      observation.features.forEach((left, row) => {
        values[row] += weight * left * observation.targetLogPercent;
        observation.features.forEach((right, column) => {
          matrix[row][column] += weight * left * right;
        });
      });
    });
    parameters = solveLinearSystem(matrix, values) ?? parameters;
    robustWeights = observations.map((observation) => {
      const fitted = observation.features.reduce((sum, feature, index) => sum + feature * parameters[index], 0);
      const residual = Math.abs(observation.targetLogPercent - fitted);
      return observation.weight * Math.min(1, 6 / Math.max(6, residual));
    });
  }

  return {
    biasLogPercent: Math.max(100 * Math.log(0.92), Math.min(100 * Math.log(1.08), parameters[0])),
    weights: {
      longRun: Math.max(0.35, Math.min(1.75, parameters[1])),
      aerobic: Math.max(0, Math.min(2, parameters[2])),
      power: Math.max(0, Math.min(2, parameters[3])),
      endurance: Math.max(0.35, Math.min(1.75, parameters[4])),
      trainingLoad: Math.max(0, Math.min(2, parameters[5]))
    }
  };
}

function predictFromPersonalComponents(
  components: SmartPredictionComponents,
  weights: PersonalPredictionWeights,
  finishTimeAdjustmentPercent: number
): number {
  const impacts = components.factorImpactsPercent;
  const longRunMultiplier = 1 + impacts.longRun * weights.longRun / 100;
  const otherImpact = Math.max(-5, Math.min(18,
    impacts.aerobic * weights.aerobic +
    impacts.power * weights.power +
    impacts.endurance * weights.endurance +
    impacts.trainingLoad * weights.trainingLoad
  ));
  return components.performanceBaselineSec * longRunMultiplier * (1 + otherImpact / 100) * (1 + finishTimeAdjustmentPercent / 100);
}

function emptySmartCalibration(): SmartPredictionCalibration {
  return {
    sampleCount: 0,
    absoluteErrorPercentile: null,
    finishTimeAdjustmentPercent: 0,
    rawBiasPercent: null,
    strengthPercent: 0,
    factorWeights: { ...DEFAULT_PERSONAL_PREDICTION_WEIGHTS }
  };
}

function buildPersonalWeightObservations(
  sortedRuns: RunningRecord[],
  runnerProfile: RunnerProfile | null
): PersonalWeightObservation[] {
  const observations: PersonalWeightObservation[] = [];
  for (const target of buildBacktestTargets(sortedRuns)) {
    const priorRuns = sortedRuns.slice(0, target.runIndex);
    if (priorRuns.length < 3) continue;
    const estimate = buildSmartPrediction(priorRuns, target.distanceKm, {
      runnerProfile,
      referenceDate: new Date(target.run.dateTime)
    });
    if (!estimate) continue;
    const targetTimeMs = new Date(target.run.dateTime).getTime();
    const ratio = target.durationSec / estimate.predictedFinishSec;
    const impacts = estimate.components.factorImpactsPercent;
    observations.push({
      runIndex: target.runIndex,
      distanceKm: target.distanceKm,
      timeMs: Number.isFinite(targetTimeMs) ? targetTimeMs : 0,
      defaultPredictedFinishSec: estimate.predictedFinishSec,
      actualFinishSec: target.durationSec,
      components: estimate.components,
      features: [1, impacts.longRun, impacts.aerobic, impacts.power, impacts.endurance, impacts.trainingLoad],
      targetLogPercent: Math.max(-25, Math.min(25, Math.log(target.durationSec / estimate.components.performanceBaselineSec) * 100)),
      logRatio: Math.max(Math.log(0.85), Math.min(Math.log(1.15), Math.log(ratio)))
    });
  }
  return observations;
}

function calibrationFromObservations(
  sourceObservations: PersonalWeightObservation[],
  targetDistanceKm: number,
  referenceTimeMs: number
): SmartPredictionCalibration {
  const observations: WeightedPersonalWeightObservation[] = sourceObservations.map((observation) => {
    const daysOld = observation.timeMs > 0 && referenceTimeMs > 0
      ? Math.max(0, (referenceTimeMs - observation.timeMs) / 86_400_000)
      : 0;
    const distanceWeight = Math.max(0.15, Math.exp(-1.2 * Math.abs(Math.log(observation.distanceKm / targetDistanceKm))));
    const recencyWeight = Math.max(0.35, Math.exp(-daysOld / 365));
    return { ...observation, weight: distanceWeight * recencyWeight };
  });
  if (observations.length === 0) {
    return emptySmartCalibration();
  }

  const effectiveWeight = observations.reduce((sum, observation) => sum + observation.weight, 0);
  const weightedLogBias = observations.reduce(
    (sum, observation) => sum + observation.logRatio * observation.weight,
    0
  ) / effectiveWeight;
  const strength = effectiveWeight / (effectiveWeight + 4);
  const fitted = fitPersonalParameters(observations);
  const longestBenchmarkDistanceKm = observations.reduce(
    (longest, observation) => Math.max(longest, observation.distanceKm),
    0
  );
  const longDistanceTransfer = Math.min(1, longestBenchmarkDistanceKm / targetDistanceKm) ** 2;
  const factorWeights: PersonalPredictionWeights = {
    ...fitted.weights,
    longRun: 1 + (fitted.weights.longRun - 1) * longDistanceTransfer,
    endurance: 1 + (fitted.weights.endurance - 1) * longDistanceTransfer
  };
  const finishTimeAdjustmentPercent = (Math.exp(fitted.biasLogPercent / 100) - 1) * 100;
  const absoluteErrors = observations.map((observation) =>
    Math.abs(predictFromPersonalComponents(observation.components, factorWeights, finishTimeAdjustmentPercent) - observation.actualFinishSec) /
      observation.actualFinishSec * 100
  );

  return {
    sampleCount: observations.length,
    absoluteErrorPercentile: percentile(absoluteErrors, 0.8),
    finishTimeAdjustmentPercent,
    rawBiasPercent: (Math.exp(weightedLogBias) - 1) * 100,
    strengthPercent: strength * 100,
    factorWeights
  };
}

function buildSmartCalibration(
  runs: RunningRecord[],
  runnerProfile: RunnerProfile | null,
  targetDistanceKm: number
): SmartPredictionCalibration {
  const sortedRuns = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
  const latestTimeMs = sortedRuns.reduce((latest, run) => Math.max(latest, new Date(run.dateTime).getTime()), 0);
  return calibrationFromObservations(
    buildPersonalWeightObservations(sortedRuns, runnerProfile),
    targetDistanceKm,
    latestTimeMs
  );
}

function backtestMetrics(entries: PredictionBacktestEntry[], model: "vdot" | "smart"): PredictionBacktestMetrics {
  const errors = entries.map((entry) => model === "vdot" ? entry.vdotErrorSec : entry.smartErrorSec);
  return {
    meanAbsoluteErrorSec: errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length,
    meanAbsolutePercentageError: entries.reduce((sum, entry, index) => sum + Math.abs(errors[index]) / entry.actualFinishSec * 100, 0) / entries.length,
    meanBiasSec: errors.reduce((sum, error) => sum + error, 0) / errors.length
  };
}

export function buildPredictionBacktest(
  runs: RunningRecord[],
  _weights: WeightRecord[],
  options: { runnerProfile?: RunnerProfile | null } = {}
): PredictionBacktestResult {
  const sortedRuns = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
  const entries: PredictionBacktestEntry[] = [];
  const calibrationObservations = buildPersonalWeightObservations(sortedRuns, options.runnerProfile ?? null);

  for (const target of buildBacktestTargets(sortedRuns)) {
    const priorRuns = sortedRuns.slice(0, target.runIndex);
    if (priorRuns.length < 3) continue;
    const vdotModel = buildVdotModel(priorRuns);
    const vdotPredictedFinishSec = vdotModel.conservativeVdot
      ? predictDurationFromVdot(vdotModel.conservativeVdot, target.distanceKm)
      : null;
    const targetTimeMs = new Date(target.run.dateTime).getTime();
    const calibration = calibrationFromObservations(
      calibrationObservations.filter((observation) => observation.runIndex < target.runIndex),
      target.distanceKm,
      Number.isFinite(targetTimeMs) ? targetTimeMs : 0
    );
    const smartPrediction = buildSmartPrediction(priorRuns, target.distanceKm, {
      runnerProfile: options.runnerProfile,
      referenceDate: new Date(target.run.dateTime),
      calibration
    });
    if (!vdotPredictedFinishSec || !smartPrediction) continue;
    entries.push({
      runId: target.run.id,
      date: target.run.dateTime.slice(0, 10),
      distanceKm: target.distanceKm,
      benchmarkType: target.benchmarkType,
      benchmarkLabel: target.benchmarkLabel,
      vdotPredictedFinishSec,
      smartPredictedFinishSec: smartPrediction.predictedFinishSec,
      actualFinishSec: target.durationSec,
      vdotErrorSec: vdotPredictedFinishSec - target.durationSec,
      smartErrorSec: smartPrediction.predictedFinishSec - target.durationSec
    });
  }

  if (entries.length === 0) {
    return {
      status: "insufficient-data",
      sampleCount: 0,
      vdotMetrics: null,
      smartMetrics: null,
      smartImprovementPercent: null,
      entries: []
    };
  }

  const vdotMetrics = backtestMetrics(entries, "vdot");
  const smartMetrics = backtestMetrics(entries, "smart");

  return {
    status: "ready",
    sampleCount: entries.length,
    vdotMetrics,
    smartMetrics,
    smartImprovementPercent: vdotMetrics.meanAbsoluteErrorSec > 0
      ? (vdotMetrics.meanAbsoluteErrorSec - smartMetrics.meanAbsoluteErrorSec) / vdotMetrics.meanAbsoluteErrorSec * 100
      : null,
    entries
  };
}
