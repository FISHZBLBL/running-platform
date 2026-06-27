import type { RunningRecord } from "./types";

export type VdotDistanceKey = "1500m" | "3km" | "5km" | "10km" | "半马" | "全马";
export type TrainingPaceKey = "E" | "M" | "T" | "I" | "R";

export type VdotDistance = {
  key: VdotDistanceKey;
  label: string;
  distanceKm: number;
  pbMinKm: number;
  pbMaxKm: number;
};

export type VdotPersonalBest = {
  key: VdotDistanceKey;
  label: string;
  distanceKm: number;
  sourceRunId: string;
  sourceDate: string;
  sourceDistanceKm: number;
  estimatedDurationSec: number;
  paceSecPerKm: number;
  vdot: number;
};

export type VdotTableRow = {
  vdot: number;
  racePaces: Record<VdotDistanceKey, { durationSec: number; paceSecPerKm: number }>;
  trainingPaces: Record<TrainingPaceKey, number>;
  highlighted: boolean;
};

export type VdotModel = {
  personalBests: VdotPersonalBest[];
  range: { min: number; max: number } | null;
  conservativeVdot: number | null;
  table: VdotTableRow[];
};

export const VDOT_DISTANCES: VdotDistance[] = [
  { key: "1500m", label: "1500m", distanceKm: 1.5, pbMinKm: 1.5, pbMaxKm: 1.6 },
  { key: "3km", label: "3km", distanceKm: 3, pbMinKm: 3, pbMaxKm: 3.5 },
  { key: "5km", label: "5km", distanceKm: 5, pbMinKm: 5, pbMaxKm: 6 },
  { key: "10km", label: "10km", distanceKm: 10, pbMinKm: 10, pbMaxKm: 11 },
  { key: "半马", label: "半马", distanceKm: 21.0975, pbMinKm: 21.0975, pbMaxKm: 22 },
  { key: "全马", label: "全马", distanceKm: 42.195, pbMinKm: 42.195, pbMaxKm: 43.5 }
];

export const TRAINING_PACE_LABELS: Record<TrainingPaceKey, string> = {
  E: "轻松跑 E",
  M: "马拉松 M",
  T: "阈值跑 T",
  I: "间歇跑 I",
  R: "重复跑 R"
};

const TRAINING_INTENSITY: Record<TrainingPaceKey, number> = {
  E: 0.7,
  M: 0.82,
  T: 0.88,
  I: 1,
  R: 1.08
};

function oxygenCost(velocityMetersPerMinute: number): number {
  return -4.6 + 0.182258 * velocityMetersPerMinute + 0.000104 * velocityMetersPerMinute ** 2;
}

function raceFractionOfVdot(minutes: number): number {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) + 0.2989558 * Math.exp(-0.1932605 * minutes);
}

function velocityForOxygenCost(targetCost: number): number {
  let low = 60;
  let high = 420;
  for (let index = 0; index < 50; index += 1) {
    const middle = (low + high) / 2;
    if (oxygenCost(middle) < targetCost) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

export function vdotFromPerformance(distanceKm: number, durationSec: number): number {
  const minutes = durationSec / 60;
  const velocity = (distanceKm * 1000) / minutes;
  return oxygenCost(velocity) / raceFractionOfVdot(minutes);
}

export function predictDurationFromVdot(vdot: number, distanceKm: number): number {
  let low = Math.max(120, distanceKm * 140);
  let high = Math.max(low + 60, distanceKm * 900);
  for (let index = 0; index < 70; index += 1) {
    const middle = (low + high) / 2;
    const middleVdot = vdotFromPerformance(distanceKm, middle);
    if (middleVdot > vdot) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

export function trainingPacesFromVdot(vdot: number): Record<TrainingPaceKey, number> {
  return Object.fromEntries(
    Object.entries(TRAINING_INTENSITY).map(([key, intensity]) => {
      const velocity = velocityForOxygenCost(vdot * intensity);
      return [key, 1000 / velocity * 60];
    })
  ) as Record<TrainingPaceKey, number>;
}

function bestPerformanceForDistance(runs: RunningRecord[], distance: VdotDistance): VdotPersonalBest | null {
  const candidates = runs
    .filter((run) => run.distanceKm >= distance.pbMinKm && run.distanceKm < distance.pbMaxKm)
    .map((run) => {
      const estimatedDurationSec = run.avgPaceSecPerKm * distance.distanceKm;
      return {
        key: distance.key,
        label: distance.label,
        distanceKm: distance.distanceKm,
        sourceRunId: run.id,
        sourceDate: run.dateTime.slice(0, 10),
        sourceDistanceKm: run.distanceKm,
        estimatedDurationSec,
        paceSecPerKm: estimatedDurationSec / distance.distanceKm,
        vdot: vdotFromPerformance(distance.distanceKm, estimatedDurationSec)
      };
    })
    .sort((a, b) => a.estimatedDurationSec - b.estimatedDurationSec);
  return candidates[0] ?? null;
}

export function buildVdotTable(range: { min: number; max: number } | null): VdotTableRow[] {
  const highlightMin = range ? Math.floor(range.min) : null;
  const highlightMax = range ? Math.ceil(range.max) : null;
  return Array.from({ length: 66 }, (_value, index) => {
    const vdot = index + 20;
    return {
      vdot,
      racePaces: Object.fromEntries(
        VDOT_DISTANCES.map((distance) => {
          const durationSec = predictDurationFromVdot(vdot, distance.distanceKm);
          return [distance.key, { durationSec, paceSecPerKm: durationSec / distance.distanceKm }];
        })
      ) as Record<VdotDistanceKey, { durationSec: number; paceSecPerKm: number }>,
      trainingPaces: trainingPacesFromVdot(vdot),
      highlighted: highlightMin !== null && highlightMax !== null && vdot >= highlightMin && vdot <= highlightMax
    };
  });
}

export function buildVdotModel(runs: RunningRecord[]): VdotModel {
  const personalBests = VDOT_DISTANCES.map((distance) => bestPerformanceForDistance(runs, distance)).filter(
    (item): item is VdotPersonalBest => Boolean(item)
  );
  const vdots = personalBests.map((pb) => pb.vdot);
  const range = vdots.length ? { min: Math.min(...vdots), max: Math.max(...vdots) } : null;
  return {
    personalBests,
    range,
    conservativeVdot: range ? range.min : null,
    table: buildVdotTable(range)
  };
}

export function requiredVdotForGoal(distanceKm: number, durationSec: number): number {
  return vdotFromPerformance(distanceKm, durationSec);
}
