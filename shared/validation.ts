import type { RunningRecord, RunSplit, Weather, WeightRecord } from "./types";

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

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} is required.`);
  }
  return value.trim();
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
  const now = new Date().toISOString();
  const distanceKm = finiteNumber(payload.distanceKm, "distanceKm", 0.01);
  const durationSec = finiteNumber(payload.durationSec, "durationSec", 1);
  const avgPaceSecPerKm = payload.avgPaceSecPerKm
    ? finiteNumber(payload.avgPaceSecPerKm, "avgPaceSecPerKm", 1)
    : durationSec / distanceKm;

  return {
    id: stringValue(payload.id ?? existing?.id ?? crypto.randomUUID(), "id"),
    dateTime: validateDateTime(payload.dateTime),
    distanceKm,
    durationSec,
    avgPaceSecPerKm,
    avgPowerW: finiteNumber(payload.avgPowerW, "avgPowerW", 0),
    avgCadenceSpm: finiteNumber(payload.avgCadenceSpm, "avgCadenceSpm", 1),
    avgHeartRateBpm: finiteNumber(payload.avgHeartRateBpm, "avgHeartRateBpm", 1),
    weather: validateWeather(payload.weather),
    splits: Array.isArray(payload.splits) ? payload.splits.map(validateSplit) : [],
    screenshotKeys: Array.isArray(payload.screenshotKeys) ? payload.screenshotKeys.filter((key) => typeof key === "string") : [],
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
