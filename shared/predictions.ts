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

export function buildPrediction(runs: RunningRecord[], weights: WeightRecord[], targetDistanceKm = 21.0975): PredictionResult {
  const sortedRuns = [...runs].sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());
  if (sortedRuns.length < 3) {
    return {
      status: "insufficient-data",
      runCount: sortedRuns.length,
      targetDistanceKm,
      paceTrend: null,
      distanceTrend: null,
      heartRateTrend: null,
      weightPaceCorrelation: null,
      predictedTargetFinishSec: null,
      predictedTargetDate: null,
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
  const predictedPace = paceTrend ? Math.max(1, paceTrend.slope * latestRunDay + paceTrend.intercept) : sortedRuns.at(-1)!.avgPaceSecPerKm;
  const predictedTargetFinishSec = predictedPace * targetDistanceKm;

  let predictedTargetDate: string | null = null;
  if (distanceTrend && distanceTrend.slope > 0) {
    const dayToTarget = (targetDistanceKm - distanceTrend.intercept) / distanceTrend.slope;
    if (Number.isFinite(dayToTarget) && dayToTarget >= latestRunDay) {
      predictedTargetDate = new Date(startMs + dayToTarget * 86_400_000).toISOString().slice(0, 10);
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
    recommendations.push("配速趋势正在改善，可以维持当前训练频率，并加入轻量节奏跑巩固速度。");
  } else {
    recommendations.push("配速改善不明显，建议每周安排一次短距离节奏跑，其他跑保持轻松强度。");
  }
  if (distanceTrend && distanceTrend.slope > 0.03) {
    recommendations.push("单次距离呈上升趋势，长距离训练可继续每周小幅递增。");
  } else {
    recommendations.push("若目标是延长距离，建议先稳定周跑量，再把最长单次跑逐步增加 5%-10%。");
  }
  if (heartRateTrend && heartRateTrend.slope > 0.2) {
    recommendations.push("同等趋势下心率偏上升，注意恢复和低强度训练比例。");
  }
  if (weightPaceCorrelation !== null && Math.abs(weightPaceCorrelation) > 0.45) {
    recommendations.push("体重与配速存在可观察相关性，后续可结合饮食和恢复记录进一步判断原因。");
  }

  return {
    status: "ready",
    runCount: sortedRuns.length,
    targetDistanceKm,
    paceTrend,
    distanceTrend,
    heartRateTrend,
    weightPaceCorrelation,
    predictedTargetFinishSec,
    predictedTargetDate,
    recommendations
  };
}
