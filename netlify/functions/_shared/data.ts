import {
  keepKey,
  profileKey,
  runKey,
  runsIndexKey,
  runsPrefix,
  shoeKey,
  shoesIndexKey,
  shoesPrefix,
  weightKey,
  weightsIndexKey,
  weightsPrefix
} from "../../../shared/cosKeys";
import type { RunningRecord, RunningShoe, UserProfile, WeightRecord } from "../../../shared/types";
import { storage } from "./storage";

async function readJson<T>(key: string): Promise<T | null> {
  const text = await storage().getText(key);
  return text ? (JSON.parse(text) as T) : null;
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await storage().putText(key, JSON.stringify(value, null, 2));
}

function sortRuns(records: RunningRecord[]): RunningRecord[] {
  return [...records].sort((a, b) => new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime());
}

function sortShoes(records: RunningShoe[]): RunningShoe[] {
  return [...records].sort((a, b) => a.name.localeCompare(b.name));
}

function sortWeights(records: WeightRecord[]): WeightRecord[] {
  return [...records].sort((a, b) => b.date.localeCompare(a.date));
}

async function readListIndex<T>(key: string): Promise<T[] | null> {
  const index = await readJson<unknown>(key);
  return Array.isArray(index) ? (index as T[]) : null;
}

async function writeRunsIndex(username: string, records: RunningRecord[]): Promise<void> {
  await writeJson(runsIndexKey(username), sortRuns(records));
}

async function writeShoesIndex(username: string, records: RunningShoe[]): Promise<void> {
  await writeJson(shoesIndexKey(username), sortShoes(records));
}

async function writeWeightsIndex(username: string, records: WeightRecord[]): Promise<void> {
  await writeJson(weightsIndexKey(username), sortWeights(records));
}

export async function getProfile(username: string): Promise<UserProfile | null> {
  return readJson<UserProfile>(profileKey(username));
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  await writeJson(profileKey(profile.username), profile);
  await storage().putText(keepKey(profile.username), "");
}

export async function listRuns(username: string): Promise<RunningRecord[]> {
  const indexed = await readListIndex<RunningRecord>(runsIndexKey(username));
  if (indexed) {
    return sortRuns(indexed);
  }
  const keys = (await storage().list(runsPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<RunningRecord>(key)));
  const sorted = sortRuns(records.filter((record): record is RunningRecord => Boolean(record)));
  await writeRunsIndex(username, sorted);
  return sorted;
}

export async function getRun(username: string, runId: string): Promise<RunningRecord | null> {
  return readJson<RunningRecord>(runKey(username, runId));
}

export async function saveRun(username: string, run: RunningRecord): Promise<void> {
  await writeJson(runKey(username, run.id), run);
  const records = await listRuns(username);
  await writeRunsIndex(username, [run, ...records.filter((record) => record.id !== run.id)]);
}

export async function deleteRun(username: string, runId: string): Promise<void> {
  await storage().delete(runKey(username, runId));
  const records = await listRuns(username);
  await writeRunsIndex(
    username,
    records.filter((record) => record.id !== runId)
  );
}

export async function listShoes(username: string): Promise<RunningShoe[]> {
  const indexed = await readListIndex<RunningShoe>(shoesIndexKey(username));
  if (indexed) {
    return sortShoes(indexed);
  }
  const keys = (await storage().list(shoesPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<RunningShoe>(key)));
  const sorted = sortShoes(records.filter((record): record is RunningShoe => Boolean(record)));
  await writeShoesIndex(username, sorted);
  return sorted;
}

export async function getShoe(username: string, shoeId: string): Promise<RunningShoe | null> {
  return readJson<RunningShoe>(shoeKey(username, shoeId));
}

export async function saveShoe(username: string, shoe: RunningShoe): Promise<void> {
  await writeJson(shoeKey(username, shoe.id), shoe);
  const records = await listShoes(username);
  await writeShoesIndex(username, [shoe, ...records.filter((record) => record.id !== shoe.id)]);
}

export async function deleteShoe(username: string, shoeId: string): Promise<void> {
  await storage().delete(shoeKey(username, shoeId));
  const records = await listShoes(username);
  await writeShoesIndex(
    username,
    records.filter((record) => record.id !== shoeId)
  );
  const runs = await listRuns(username);
  const now = new Date().toISOString();
  const updatedRuns = runs.map((run) => (run.shoeId === shoeId ? { ...run, shoeId: null, updatedAt: now } : run));
  const changedRuns = updatedRuns.filter((run, index) => run !== runs[index]);
  await Promise.all(changedRuns.map((run) => writeJson(runKey(username, run.id), run)));
  if (changedRuns.length > 0) {
    await writeRunsIndex(username, updatedRuns);
  }
}

export async function listWeights(username: string): Promise<WeightRecord[]> {
  const indexed = await readListIndex<WeightRecord>(weightsIndexKey(username));
  if (indexed) {
    return sortWeights(indexed);
  }
  const keys = (await storage().list(weightsPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<WeightRecord>(key)));
  const sorted = sortWeights(records.filter((record): record is WeightRecord => Boolean(record)));
  await writeWeightsIndex(username, sorted);
  return sorted;
}

export async function getWeight(username: string, date: string): Promise<WeightRecord | null> {
  return readJson<WeightRecord>(weightKey(username, date));
}

export async function saveWeight(username: string, weight: WeightRecord): Promise<void> {
  await writeJson(weightKey(username, weight.date), weight);
  const records = await listWeights(username);
  await writeWeightsIndex(username, [weight, ...records.filter((record) => record.date !== weight.date)]);
}

export async function deleteWeight(username: string, date: string): Promise<void> {
  await storage().delete(weightKey(username, date));
  const records = await listWeights(username);
  await writeWeightsIndex(
    username,
    records.filter((record) => record.date !== date)
  );
}
