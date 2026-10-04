import { isCalendarDate } from "./calendarDates";

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const OBJECT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export class StorageKeyError extends Error {
  status = 400;
}

export function validateObjectId(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    throw new StorageKeyError(`${label} must contain only letters, numbers, underscores or hyphens (1–128 characters).`);
  }
  return value;
}

export function validateStorageKey(key: string, { prefix = false } = {}): void {
  const normalized = prefix && key.endsWith("/") ? key.slice(0, -1) : key;
  if (!normalized || !/^[a-zA-Z0-9_./-]+$/.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new StorageKeyError("Storage key is invalid.");
  }
}

export function normalizeUsername(username: string): string {
  return username.trim();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export function userPrefix(username: string): string {
  const normalized = normalizeUsername(username);
  if (!isValidUsername(normalized)) throw new StorageKeyError("Username is invalid.");
  return `users/${normalized}/`;
}

export function profileKey(username: string): string {
  return `${userPrefix(username)}profile.json`;
}

export function runnerProfileKey(username: string): string {
  return `${userPrefix(username)}runner-profile.json`;
}

export function deepseekSecretKey(username: string): string {
  return `${userPrefix(username)}secrets/deepseek.json`;
}

export function deepseekPreferencesKey(username: string): string {
  return `${userPrefix(username)}ai/deepseek-preferences.json`;
}

export function aiPredictionLatestKey(username: string, targetHash: string): string {
  return `${userPrefix(username)}ai/predictions/${validateObjectId(targetHash, "targetHash")}/latest.json`;
}

export function aiPredictionHistoryKey(username: string, targetHash: string): string {
  return `${userPrefix(username)}ai/predictions/${validateObjectId(targetHash, "targetHash")}/history.json`;
}

export function aiDeepAnalysisKey(username: string, targetHash: string): string {
  return `${userPrefix(username)}ai/predictions/${validateObjectId(targetHash, "targetHash")}/deep.json`;
}

export function keepKey(username: string): string {
  return `${userPrefix(username)}.keep`;
}

export function runsIndexKey(username: string): string {
  return `${userPrefix(username)}index/runs.json`;
}

export function shoesIndexKey(username: string): string {
  return `${userPrefix(username)}index/shoes.json`;
}

export function weightsIndexKey(username: string): string {
  return `${userPrefix(username)}index/weights.json`;
}

export function runKey(username: string, runId: string): string {
  return `${userPrefix(username)}runs/${validateObjectId(runId, "runId")}.json`;
}

export function runsPrefix(username: string): string {
  return `${userPrefix(username)}runs/`;
}

export function screenshotKey(username: string, runId: string, fileId: string, extension: string): string {
  const safeExt = extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
  return `${userPrefix(username)}runs/${validateObjectId(runId, "runId")}/screenshots/${validateObjectId(fileId, "fileId")}.${safeExt}`;
}

export function shoeKey(username: string, shoeId: string): string {
  return `${userPrefix(username)}shoes/${validateObjectId(shoeId, "shoeId")}.json`;
}

export function shoesPrefix(username: string): string {
  return `${userPrefix(username)}shoes/`;
}

export function shoePhotoKey(username: string, shoeId: string, fileId: string, extension: string): string {
  const safeExt = extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "jpg";
  return `${userPrefix(username)}shoes/${validateObjectId(shoeId, "shoeId")}/photos/${validateObjectId(fileId, "fileId")}.${safeExt}`;
}

export function isUserShoePhotoKey(username: string, key: string, shoeId?: string): boolean {
  const prefix = shoesPrefix(username);
  if (!key.startsWith(prefix)) return false;
  const parts = key.slice(prefix.length).split("/");
  return parts.length === 3 && OBJECT_ID_PATTERN.test(parts[0]) && (!shoeId || parts[0] === shoeId)
    && parts[1] === "photos" && /^[a-zA-Z0-9_-]{1,128}\.[a-zA-Z0-9]+$/.test(parts[2]);
}

export function isUserScreenshotKey(username: string, runId: string, key: string): boolean {
  const prefix = `${runsPrefix(username)}${validateObjectId(runId, "runId")}/screenshots/`;
  return key.startsWith(prefix) && /^[a-zA-Z0-9_-]{1,128}\.[a-zA-Z0-9]+$/.test(key.slice(prefix.length));
}

export function weightKey(username: string, date: string): string {
  if (!isCalendarDate(date)) throw new StorageKeyError("Weight date must be a valid calendar date using YYYY-MM-DD.");
  return `${userPrefix(username)}weights/${date}.json`;
}

export function weightsPrefix(username: string): string {
  return `${userPrefix(username)}weights/`;
}
