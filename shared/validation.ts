import type { RunnerProfile, RunnerSex, RunningRecord, RunningShoe, RunSplit, Weather, WeightRecord } from "./types";

export class ValidationError extends Error {
  status = 400;
}

function finiteNumber(value: unknown, label: string, min = 0): number {
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue) || numberValue < min) {
    throw new ValidationError(`${label} must be a number greater than or equal to ${min}.`);
  }
  return numberValue;
}

function nullableNumber(value: unknown, label: string, min = 0): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return finiteNumber(value, label, min);
}

function boundedNullableNumber(value: unknown, label: string, min: number, max: number): number | null {
  const numberValue = nullableNumber(value, label, min);
  if (numberValue !== null && numberValue > max) {
    throw new ValidationError(`${label} must be less than or equal to ${max}.`);
  }
  return numberValue;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} is required.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, maxLength = 2000): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be text.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new ValidationError(`${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be text.`);
  }
  return value.trim() || null;
}

function validateDateTime(value: unknown): string {
  const text = stringValue(value, "dateTime");
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError("dateTime must be a valid date.");
  }
  return text;
}

function validateDate(value: unknown): string {
  const text = stringValue(value, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ValidationError("date must use YYYY-MM-DD.");
  }
  return text;
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${label} must use YYYY-MM-DD.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now()) {
    throw new ValidationError(`${label} must be a valid date that is not in the future.`);
  }
  return value;
}

function runnerSex(value: unknown): RunnerSex | null {
  if (value === undefined || value === null || value === "") return null;
  const allowed: RunnerSex[] = ["female", "male", "other", "prefer-not-to-say"];
  if (typeof value !== "string" || !allowed.includes(value as RunnerSex)) {
    throw new ValidationError("sex is not supported.");
  }
  return value as RunnerSex;
}

function validateWeather(input: unknown): Weather {
  const weather = (input ?? {}) as Partial<Weather>;
  return {
    temperatureC: nullableNumber(weather.temperatureC, "temperatureC", -80),
    humidityPct: nullableNumber(weather.humidityPct, "humidityPct", 0),
    aqi: nullableNumber(weather.aqi, "aqi", 0)
  };
}

function validateSplit(input: unknown, fallbackIndex: number): RunSplit {
  const split = input as Partial<RunSplit>;
  return {
    index: Math.round(finiteNumber(split.index ?? fallbackIndex, "split.index", 1)),
    distanceKm: finiteNumber(split.distanceKm, "split.distanceKm", 0.01),
    paceSecPerKm: finiteNumber(split.paceSecPerKm, "split.paceSecPerKm", 1),
    heartRateBpm: finiteNumber(split.heartRateBpm, "split.heartRateBpm", 1),
    powerW: finiteNumber(split.powerW, "split.powerW", 0),
    cadenceSpm: finiteNumber(split.cadenceSpm, "split.cadenceSpm", 1)
  };
}

export function validateRunPayload(input: unknown, existing?: RunningRecord): RunningRecord {
  const payload = input as Partial<RunningRecord>;
  const provided = (key: keyof RunningRecord) => Object.prototype.hasOwnProperty.call(payload, key);
  const now = new Date().toISOString();
  const distanceKm = finiteNumber(payload.distanceKm, "distanceKm", 0.01);
  const durationSec = finiteNumber(payload.durationSec, "durationSec", 1);
  const avgPaceSecPerKm = payload.avgPaceSecPerKm
    ? finiteNumber(payload.avgPaceSecPerKm, "avgPaceSecPerKm", 1)
    : durationSec / distanceKm;
  const effortScoreValue = boundedNullableNumber(provided("effortScore") ? payload.effortScore : existing?.effortScore, "effortScore", 1, 10);
  const effortSourceValue = optionalString(provided("effortSource") ? payload.effortSource : existing?.effortSource, "effortSource");
  if (effortSourceValue && effortSourceValue !== "apple-watch" && effortSourceValue !== "manual") {
    throw new ValidationError("effortSource is not supported.");
  }
  const performanceTypeValue = optionalString(provided("performanceType") ? payload.performanceType : existing?.performanceType, "performanceType");
  if (performanceTypeValue && performanceTypeValue !== "race" && performanceTypeValue !== "time-trial") {
    throw new ValidationError("performanceType is not supported.");
  }

  return {
    id: stringValue(payload.id ?? existing?.id ?? crypto.randomUUID(), "id"),
    dateTime: validateDateTime(payload.dateTime),
    shoeId: optionalString(payload.shoeId, "shoeId"),
    distanceKm,
    durationSec,
    avgPaceSecPerKm,
    avgPowerW: finiteNumber(payload.avgPowerW, "avgPowerW", 0),
    avgCadenceSpm: finiteNumber(payload.avgCadenceSpm, "avgCadenceSpm", 1),
    avgHeartRateBpm: finiteNumber(payload.avgHeartRateBpm, "avgHeartRateBpm", 1),
    effortScore: effortScoreValue === null ? null : Math.round(effortScoreValue),
    effortSource: effortScoreValue === null ? null : ((effortSourceValue as RunningRecord["effortSource"]) ?? "apple-watch"),
    performanceType: (performanceTypeValue as RunningRecord["performanceType"]) ?? null,
    elevationGainM: nullableNumber(provided("elevationGainM") ? payload.elevationGainM : existing?.elevationGainM, "elevationGainM", 0),
    weather: validateWeather(payload.weather),
    notes: optionalText(payload.notes, "notes"),
    splits: Array.isArray(payload.splits) ? payload.splits.map(validateSplit) : [],
    screenshotKeys: Array.isArray(payload.screenshotKeys) ? payload.screenshotKeys.filter((key) => typeof key === "string") : [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

export function validateRunnerProfilePayload(input: unknown, existing?: RunnerProfile): RunnerProfile {
  const payload = input as Partial<RunnerProfile>;
  const now = new Date().toISOString();
  return {
    birthDate: optionalDate(payload.birthDate, "birthDate"),
    sex: runnerSex(payload.sex),
    heightCm: boundedNullableNumber(payload.heightCm, "heightCm", 100, 250),
    restingHeartRateBpm: boundedNullableNumber(payload.restingHeartRateBpm, "restingHeartRateBpm", 30, 120),
    measuredMaxHeartRateBpm: boundedNullableNumber(payload.measuredMaxHeartRateBpm, "measuredMaxHeartRateBpm", 100, 240),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

export function validateShoePayload(input: unknown, existing?: RunningShoe): RunningShoe {
  const payload = input as Partial<RunningShoe>;
  const now = new Date().toISOString();
  const name = stringValue(payload.name, "name");
  if (name.length > 80) {
    throw new ValidationError("name must be 80 characters or fewer.");
  }
  return {
    id: stringValue(payload.id ?? existing?.id ?? crypto.randomUUID(), "id"),
    name,
    photoKey: optionalString(payload.photoKey, "photoKey"),
    photoUrl: optionalString(payload.photoUrl, "photoUrl"),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

export function validateWeightPayload(input: unknown, existing?: WeightRecord): WeightRecord {
  const payload = input as Partial<WeightRecord>;
  const now = new Date().toISOString();
  return {
    date: validateDate(payload.date),
    weightKg: finiteNumber(payload.weightKg, "weightKg", 20),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}
