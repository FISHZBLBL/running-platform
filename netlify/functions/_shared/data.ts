import { keepKey, profileKey, runKey, runsPrefix, weightKey, weightsPrefix } from "../../../shared/cosKeys";
import type { RunningRecord, UserProfile, WeightRecord } from "../../../shared/types";
import { storage } from "./storage";

async function readJson<T>(key: string): Promise<T | null> {
  const text = await storage().getText(key);
  return text ? (JSON.parse(text) as T) : null;
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await storage().putText(key, JSON.stringify(value, null, 2));
}

export async function getProfile(username: string): Promise<UserProfile | null> {
  return readJson<UserProfile>(profileKey(username));
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  await writeJson(profileKey(profile.username), profile);
  await storage().putText(keepKey(profile.username), "");
}

export async function listRuns(username: string): Promise<RunningRecord[]> {
  const keys = (await storage().list(runsPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<RunningRecord>(key)));
  return records
    .filter((record): record is RunningRecord => Boolean(record))
    .sort((a, b) => new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime());
}

export async function getRun(username: string, runId: string): Promise<RunningRecord | null> {
  return readJson<RunningRecord>(runKey(username, runId));
}

export async function saveRun(username: string, run: RunningRecord): Promise<void> {
  await writeJson(runKey(username, run.id), run);
}

export async function deleteRun(username: string, runId: string): Promise<void> {
  await storage().delete(runKey(username, runId));
}

export async function listWeights(username: string): Promise<WeightRecord[]> {
  const keys = (await storage().list(weightsPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<WeightRecord>(key)));
  return records
    .filter((record): record is WeightRecord => Boolean(record))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function getWeight(username: string, date: string): Promise<WeightRecord | null> {
  return readJson<WeightRecord>(weightKey(username, date));
}

export async function saveWeight(username: string, weight: WeightRecord): Promise<void> {
  await writeJson(weightKey(username, weight.date), weight);
}
