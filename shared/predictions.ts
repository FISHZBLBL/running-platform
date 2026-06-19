import type { PredictionResult, RunningRecord, TrendLine, WeightRecord } from "./types";

type Point = { x: number; y: number };

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
  options: { targetFinishSec?: number | null; targetDate?: string | null } = {}
): PredictionResult {
  const sortedRuns = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
  const longestDistanceKm = sortedRuns.reduce((max, run) => Math.max(max, run.distanceKm), 0);
  const achievedRun = sortedRuns.find((run) => run.distanceKm >= targetDistanceKm);
  const achievedTargetDate = achievedRun?.dateTime.slice(0, 10) ?? null;
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
      warnings: achievedTargetDate ? [`已经在 ${achievedTargetDate} 完成过 ${targetDistanceKm.toFixed(2)} km。`] : [],
      recommendations: ["至少记录 3 次跑步后再生成趋势预测。"]
    };
  }

  const startMs = new Date(sortedRuns[0].dateTime).getTime();
  const pacePoints = sortedRuns.map((run) => ({ x: dayIndex(run.dateTime, startMs), y: run.avgPaceSecPerKm }));
  const distancePoints = sortedRuns.map((run) => ({ x: dayIndex(run.dateTime, startMs), y: run.distanceKm }));
  const heartRatePoints = sortedRuns.map((run) => ({ x: dayIndex(run.dateTime, startMs), y: run.avgHeartRateBpm }));
  const paceTrend = linearRegression(pacePoints);
  const distanceTrend = linearRegression(distancePoints);
  const heartRateTrend = linearRegression(heartRatePoints);

  const latestRunDay = pacePoints[pacePoints.length - 1].x;
  const latestRunDate = sortedRuns[sortedRuns.length - 1].dateTime.slice(0, 10);
  const predictedPace = paceTrend ? Math.max(1, paceTrend.slope * latestRunDay + paceTrend.intercept) : sortedRuns.at(-1)!.avgPaceSecPerKm;
  const predictedTargetFinishSec = predictedPace * targetDistanceKm;

  let distanceProjectionBasis: PredictionResult["distanceProjectionBasis"] = achievedTargetDate ? "achieved" : "insufficient";
  let predictedDistanceDate: string | null = achievedTargetDate;
  if (!achievedTargetDate && distanceTrend && distanceTrend.slope > 0) {
    const dayToTarget = (targetDistanceKm - distanceTrend.intercept) / distanceTrend.slope;
    if (Number.isFinite(dayToTarget) && dayToTarget >= latestRunDay) {
      predictedDistanceDate = dateFromDay(startMs, dayToTarget);
      distanceProjectionBasis = "trend";
    }
  }
  if (!achievedTargetDate) {
    const progressiveDate = progressiveDistanceDate(sortedRuns, targetDistanceKm);
    if (progressiveDate) {
      distanceProjectionBasis = "long-run-progression";
      if (!predictedDistanceDate || new Date(progressiveDate).getTime() < new Date(predictedDistanceDate).getTime()) {
        predictedDistanceDate = progressiveDate;
      }
    }
  }

  let predictedGoalFinishDate: string | null = null;
  const targetFinishSec = options.targetFinishSec ?? null;
  if (targetFinishSec && targetFinishSec > 0 && paceTrend) {
    const targetPace = targetFinishSec / targetDistanceKm;
    let paceDay: number | null = null;
    const currentProjectedPace = paceTrend.slope * latestRunDay + paceTrend.intercept;
    if (currentProjectedPace <= targetPace) {
      paceDay = latestRunDay;
    } else if (paceTrend.slope < 0) {
      const day = (targetPace - paceTrend.intercept) / paceTrend.slope;
      if (Number.isFinite(day) && day >= latestRunDay) {
        paceDay = day;
      }
    }

    let distanceDay: number | null = achievedTargetDate ? latestRunDay : null;
    if (!achievedTargetDate && predictedDistanceDate) {
      const day = dayIndex(`${predictedDistanceDate}T00:00:00.000Z`, startMs);
      if (day >= latestRunDay) {
        distanceDay = day;
      }
    }

    if (paceDay !== null && distanceDay !== null) {
      predictedGoalFinishDate = dateFromDay(startMs, Math.max(paceDay, distanceDay));
    }
  }

  let predictedFinishSecAtTargetDate: number | null = null;
  const targetDate = options.targetDate ?? null;
  if (targetDate && paceTrend) {
    const targetDay = dayIndex(`${targetDate}T00:00:00.000Z`, startMs);
    if (targetDay >= 0) {
      predictedFinishSecAtTargetDate = Math.max(1, paceTrend.slope * targetDay + paceTrend.intercept) * targetDistanceKm;
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
    warnings.push("当前配速或距离趋势不足以推算目标用时达成日期。");
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
    warnings,
    recommendations
  };
}
