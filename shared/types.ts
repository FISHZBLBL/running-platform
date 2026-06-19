export type Weather = {
  temperatureC: number | null;
  humidityPct: number | null;
  aqi: number | null;
};

export type RunSplit = {
  index: number;
  distanceKm: number;
  paceSecPerKm: number;
  heartRateBpm: number;
  powerW: number;
  cadenceSpm: number;
};

export type RunningRecord = {
  id: string;
  dateTime: string;
  distanceKm: number;
  durationSec: number;
  avgPaceSecPerKm: number;
  avgPowerW: number;
  avgCadenceSpm: number;
  avgHeartRateBpm: number;
  weather: Weather;
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

export type UserProfile = {
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicUser = {
  username: string;
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
  warnings: string[];
  recommendations: string[];
};
