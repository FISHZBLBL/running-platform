import type { VdotModel } from "./vdot";

export type Weather = {
  temperatureC: number | null;
  humidityPct: number | null;
  aqi: number | null;
};

export type RunSplit = {
  index: number;
  kind?: "tail";
  durationSec?: number;
  distanceKm: number;
  paceSecPerKm: number;
  heartRateBpm: number;
  powerW: number;
  cadenceSpm: number;
};

export type RunningRecord = {
  id: string;
  dateTime: string;
  localDate?: string | null;
  shoeId: string | null;
  distanceKm: number;
  durationSec: number;
  avgPaceSecPerKm: number;
  avgPowerW: number;
  avgCadenceSpm: number;
  avgHeartRateBpm: number;
  effortScore?: number | null;
  effortSource?: "apple-watch" | "manual" | null;
  performanceType?: "race" | "time-trial" | null;
  elevationGainM?: number | null;
  weather: Weather;
  notes: string;
  splits: RunSplit[];
  screenshotKeys: string[];
  createdAt: string;
  updatedAt: string;
};

export type WeightRecord = {
  date: string;
  weightKg: number;
  createdAt: string;
  updatedAt: string;
};

export type RunningShoe = {
  id: string;
  name: string;
  photoKey: string | null;
  photoUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UserProfile = {
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicUser = {
  username: string;
};

export type DeepseekKeyStatus = {
  configured: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
  customPrompt: string;
};

export type AiEvidenceItem = {
  metric: string;
  value: string;
  impact: string;
};

export type AiInsightItem = {
  title: string;
  detail: string;
  severity?: "info" | "warning" | "critical";
  evidence?: string;
};

export type AiTrainingWeek = {
  label: string;
  startDate: string;
  endDate: string;
  weeklyDistanceKm: { min: number; max: number };
  sessionsPerWeek: number;
  longRunKm: { min: number; max: number };
  keySession: string;
  easyRunFocus: string;
  recovery: string;
  adjustmentReason: string;
};

export type AiPredictionAnalysis = {
  kind: "standard";
  model: "deepseek-v4-flash";
  generatedAt: string;
  cached: boolean;
  dataFingerprint: string;
  algorithmPredictionSec: number;
  aiPredictionSec: number;
  requestedAdjustmentPercent: number;
  appliedAdjustmentPercent: number;
  adjustmentStatus: "accepted" | "rejected-outside-range" | "no-adjustment";
  dynamicRangeSec: { optimistic: number; conservative: number };
  summary: string;
  predictionExplanation: string;
  recentTrend: string;
  anomalies: AiInsightItem[];
  risks: AiInsightItem[];
  recommendations: AiInsightItem[];
  evidence: AiEvidenceItem[];
};

export type AiDeepAnalysis = {
  kind: "deep";
  model: "deepseek-v4-flash";
  generatedAt: string;
  cached: boolean;
  dataFingerprint: string;
  flashPredictionSec: number;
  aiPredictionSec: number;
  requestedAdjustmentPercent: number;
  appliedAdjustmentPercent: number;
  adjustmentStatus: "accepted" | "rejected-outside-range" | "no-adjustment";
  dynamicRangeSec: { optimistic: number; conservative: number };
  predictionExplanation: string;
  evidence: AiEvidenceItem[];
  overview: string;
  capabilityEvolution: string;
  metricConflicts: AiInsightItem[];
  riskCauses: AiInsightItem[];
  trainingPlan: AiTrainingWeek[];
  trainingPlanStartDate: string | null;
  trainingPlanTargetDate: string | null;
  trainingPlanDaysRemaining: number | null;
};

export type AiPredictionSnapshot = {
  generatedAt: string;
  dataFingerprint: string;
  targetDistanceKm: number;
  targetFinishSec: number | null;
  targetDate: string | null;
  algorithmPredictionSec: number;
  aiPredictionSec: number;
  adjustmentPercent: number;
  confidenceScore: number;
  model: "deepseek-v4-flash";
};

export type RunnerSex = "female" | "male" | "other" | "prefer-not-to-say";

export type PredictionMode = "distance-date" | "finish-date" | "date-finish";

export type PredictionTargetConfig = {
  mode: PredictionMode;
  targetDistanceKm: number;
  targetFinishSec: number | null;
  targetDate: string | null;
};

export type RunnerProfile = {
  birthDate: string | null;
  sex: RunnerSex | null;
  heightCm: number | null;
  restingHeartRateBpm: number | null;
  measuredMaxHeartRateBpm: number | null;
  predictionTarget?: PredictionTargetConfig | null;
  createdAt: string;
  updatedAt: string;
};

export type TrendLine = {
  slope: number;
  intercept: number;
  r2: number;
};

export type PredictionResult = {
  status: "insufficient-data" | "ready";
  runCount: number;
  targetDistanceKm: number;
  targetFinishSec: number | null;
  targetDate: string | null;
  longestDistanceKm: number;
  achievedTargetDate: string | null;
  paceTrend: TrendLine | null;
  distanceTrend: TrendLine | null;
  heartRateTrend: TrendLine | null;
  weightPaceCorrelation: number | null;
  predictedTargetFinishSec: number | null;
  predictedTargetDate: string | null;
  predictedDistanceDate: string | null;
  predictedGoalFinishDate: string | null;
  predictedFinishSecAtTargetDate: number | null;
  distanceProjectionBasis: "achieved" | "long-run-progression" | "trend" | "insufficient";
  vdotModel: VdotModel;
  vdotPredictedFinishRangeSec: { fastest: number; conservative: number } | null;
  smartPrediction: SmartPredictionSummary | null;
  requiredVdotForTargetFinish: number | null;
  warnings: string[];
  recommendations: string[];
};

export type PredictionConfidence = "low" | "medium" | "high";

export type PersonalPredictionWeightKey = "longRun" | "aerobic" | "power" | "endurance" | "trainingLoad";

export type PersonalPredictionWeights = Record<PersonalPredictionWeightKey, number>;

export type SmartPredictionComponents = {
  performanceBaselineSec: number;
  factorImpactsPercent: PersonalPredictionWeights;
};

export type SmartPredictionFactor = {
  key: "performance" | "long-run" | "aerobic" | "power" | "cadence" | "endurance" | "training-load" | "calibration" | "weather";
  label: string;
  impactPercent: number;
  detail: string;
};

export type NearTargetLongRunPrediction = {
  sourceRunId: string;
  sourceDate: string;
  sourceDistanceKm: number;
  supportingRunCount: number;
  coveragePercent: number;
  projectedFinishSec: number;
  appliedFinishSec: number;
  blendWeightPercent: number;
  splitCount: number;
  splitCoveragePercent: number;
  secondHalfPaceChangePercent: number | null;
  cardioDriftPercent: number | null;
  powerChangePercent: number | null;
  cadenceChangePercent: number | null;
  energyScore: number | null;
};

export type SmartPredictionSummary = {
  modelVersion: "smart-v6";
  predictedFinishSec: number;
  rangeSec: { optimistic: number; conservative: number };
  confidence: PredictionConfidence;
  confidenceScore: number;
  performanceSampleCount: number;
  calibrationSampleCount: number;
  calibrationAdjustmentPercent: number;
  calibrationRawBiasPercent: number | null;
  calibrationStrengthPercent: number;
  personalWeights: PersonalPredictionWeights;
  components: SmartPredictionComponents;
  nearTargetLongRun: NearTargetLongRunPrediction | null;
  factors: SmartPredictionFactor[];
};

export type PredictionBacktestEntry = {
  runId: string;
  date: string;
  distanceKm: number;
  benchmarkType: "pb" | "race";
  benchmarkLabel: string;
  inputRunCount: number;
  performanceSampleCount: number;
  calibrationSampleCount: number;
  smartConfidenceScore: number;
  vdotPredictedFinishSec: number;
  smartPredictedFinishSec: number;
  actualFinishSec: number;
  vdotErrorSec: number;
  smartErrorSec: number;
};

export type PredictionBacktestMetrics = {
  meanAbsoluteErrorSec: number;
  meanAbsolutePercentageError: number;
  meanBiasSec: number;
};

export type PredictionBacktestResult = {
  status: "insufficient-data" | "ready";
  sampleCount: number;
  vdotMetrics: PredictionBacktestMetrics | null;
  smartMetrics: PredictionBacktestMetrics | null;
  smartImprovementPercent: number | null;
  entries: PredictionBacktestEntry[];
};
