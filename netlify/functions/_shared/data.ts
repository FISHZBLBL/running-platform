import { randomUUID } from "node:crypto";
import {
  keepKey,
  aiDeepAnalysisKey,
  aiPredictionHistoryKey,
  aiPredictionLatestKey,
  deepseekSecretKey,
  deepseekPreferencesKey,
  profileKey,
  runnerProfileKey,
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
import type {
  AiDeepAnalysis,
  AiPredictionAnalysis,
  AiPredictionSnapshot,
  RunnerProfile,
  RunningRecord,
  RunningShoe,
  UserProfile,
  WeightRecord
} from "../../../shared/types";
import { storage } from "./storage";
import type { EncryptedSecret } from "./secrets";

const INDEX_LOCK_STALE_MS = 90_000;
const INDEX_LOCK_ATTEMPTS = 20;

type LockOptions = {
  attempts?: number;
  staleMs?: number;
  heartbeatMs?: number;
};

type LockRecord = {
  owner: string;
  acquiredAt: number;
};

type RecordMutation<T> = {
  records: T[];
  puts: { key: string; value: unknown }[];
  deletes: string[];
};

const RECORD_LOCK_OPTIONS: LockOptions = { heartbeatMs: 2_000 };

function pendingMutationKey(indexKey: string): string {
  return `${indexKey}.pending`;
}

function consistentIndexKey(indexKey: string): string {
  return `${indexKey}.consistent-v2`;
}

// A durable intent precedes every object change. Replaying it is idempotent, so a
// different function instance can finish an interrupted write before serving data.
async function recoverRecordMutation<T>(indexKey: string): Promise<void> {
  const pending = await readJson<RecordMutation<T>>(pendingMutationKey(indexKey));
  if (!pending) return;
  for (const put of pending.puts) await writeJson(put.key, put.value);
  for (const key of pending.deletes) await storage().delete(key);
  await writeJson(indexKey, pending.records);
  await storage().putText(consistentIndexKey(indexKey), "2");
  await storage().delete(pendingMutationKey(indexKey));
}

async function currentRecords<T>(indexKey: string, readObjects: () => Promise<T[]>): Promise<T[]> {
  await recoverRecordMutation<T>(indexKey);
  const indexed = await readListIndex<T>(indexKey);
  if (indexed && await storage().getText(consistentIndexKey(indexKey))) return indexed;
  // One-time reconciliation also repairs indexes left inconsistent by older builds.
  const records = await readObjects();
  await writeJson(indexKey, records);
  await storage().putText(consistentIndexKey(indexKey), "2");
  return records;
}

async function listRecords<T>(indexKey: string, readObjects: () => Promise<T[]>): Promise<T[]> {
  const [indexed, pending, consistent] = await Promise.all([
    readListIndex<T>(indexKey), storage().getText(pendingMutationKey(indexKey)), storage().getText(consistentIndexKey(indexKey))
  ]);
  if (indexed && !pending && consistent) return indexed;
  return withIndexLock(indexKey, () => currentRecords(indexKey, readObjects), RECORD_LOCK_OPTIONS);
}

async function mutateRecords<T, R>(
  indexKey: string,
  readObjects: () => Promise<T[]>,
  prepare: (records: T[]) => { mutation: RecordMutation<T>; result: R }
): Promise<R> {
  return withIndexLock(indexKey, async () => {
    const records = await currentRecords(indexKey, readObjects);
    const { mutation, result } = prepare(records);
    await writeJson(pendingMutationKey(indexKey), mutation);
    await recoverRecordMutation<T>(indexKey);
    return result;
  }, RECORD_LOCK_OPTIONS);
}

function recordError(message: string, status: number): never {
  const error = new Error(message);
  (error as Error & { status: number }).status = status;
  throw error;
}

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

function parseLock(value: string | null): LockRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LockRecord>;
    return typeof parsed.owner === "string" && typeof parsed.acquiredAt === "number"
      ? { owner: parsed.owner, acquiredAt: parsed.acquiredAt }
      : null;
  } catch {
    return null;
  }
}

async function releaseLock(lockKey: string, owner: string): Promise<void> {
  const current = parseLock(await storage().getText(lockKey));
  if (current?.owner === owner) {
    await storage().delete(lockKey);
  }
}

async function withIndexLock<T>(indexKey: string, task: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lockKey = `${indexKey}.lock`;
  const owner = randomUUID();
  const attempts = options.attempts ?? INDEX_LOCK_ATTEMPTS;
  const staleMs = options.staleMs ?? INDEX_LOCK_STALE_MS;
  const heartbeatMs = options.heartbeatMs;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lock: LockRecord = { owner, acquiredAt: Date.now() };
    if (await storage().putTextIfAbsent(lockKey, JSON.stringify(lock))) {
      const heartbeatKey = `${lockKey}.heartbeat.${owner}`;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      try {
        if (heartbeatMs) {
          const heartbeat = async () => storage().putText(heartbeatKey, String(Date.now()));
          await heartbeat();
          heartbeatTimer = setInterval(() => {
            void heartbeat().catch((error) => {
              console.error("[index-lock-heartbeat-error]", { lockKey, owner, error });
            });
          }, heartbeatMs);
        }
        return await task();
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        await releaseLock(lockKey, owner).catch((error) => {
          console.error("[index-lock-release-error]", { lockKey, owner, error });
        });
        if (heartbeatMs) {
          await storage().delete(heartbeatKey).catch((error) => {
            console.error("[index-lock-heartbeat-cleanup-error]", { lockKey, owner, error });
          });
        }
      }
    }

    const firstText = await storage().getText(lockKey);
    const existing = parseLock(firstText);
    let lastSeenAt = existing?.acquiredAt ?? 0;
    if (existing && heartbeatMs) {
      const heartbeatText = await storage().getText(`${lockKey}.heartbeat.${existing.owner}`);
      const heartbeatAt = Number(heartbeatText);
      if (Number.isFinite(heartbeatAt)) lastSeenAt = Math.max(lastSeenAt, heartbeatAt);
    }
    if (!existing || Date.now() - lastSeenAt > staleMs) {
      const confirmedText = await storage().getText(lockKey);
      if (confirmedText === firstText) {
        await storage().delete(lockKey);
        if (existing && heartbeatMs) {
          await storage().delete(`${lockKey}.heartbeat.${existing.owner}`);
        }
      }
    }
    await delay(100 + Math.floor(Math.random() * 150));
  }

  const error = new Error("数据正在被另一个设备或标签页更新，请稍后重试。");
  (error as Error & { status: number }).status = 409;
  throw error;
}

async function readRunsFromObjects(username: string): Promise<RunningRecord[]> {
  const keys = (await storage().list(runsPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<RunningRecord>(key)));
  return sortRuns(records.filter((record): record is RunningRecord => Boolean(record)));
}

async function readShoesFromObjects(username: string): Promise<RunningShoe[]> {
  const keys = (await storage().list(shoesPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<RunningShoe>(key)));
  return sortShoes(records.filter((record): record is RunningShoe => Boolean(record)));
}

async function readWeightsFromObjects(username: string): Promise<WeightRecord[]> {
  const keys = (await storage().list(weightsPrefix(username))).filter((key) => key.endsWith(".json"));
  const records = await Promise.all(keys.map((key) => readJson<WeightRecord>(key)));
  return sortWeights(records.filter((record): record is WeightRecord => Boolean(record)));
}

export async function getProfile(username: string): Promise<UserProfile | null> {
  return readJson<UserProfile>(profileKey(username));
}

export async function createProfile(profile: UserProfile): Promise<boolean> {
  const created = await storage().putTextIfAbsent(profileKey(profile.username), JSON.stringify(profile, null, 2));
  if (created) {
    await storage().putText(keepKey(profile.username), "").catch((error) => {
      console.error("[profile-marker-error]", error);
    });
  }
  return created;
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  await writeJson(profileKey(profile.username), profile);
  await storage().putText(keepKey(profile.username), "");
}

export async function getRunnerProfile(username: string): Promise<RunnerProfile | null> {
  return readJson<RunnerProfile>(runnerProfileKey(username));
}

export async function saveRunnerProfile(username: string, profile: RunnerProfile): Promise<void> {
  await updateRunnerProfile(username, () => profile);
}

export async function updateRunnerProfile(
  username: string,
  update: (existing: RunnerProfile | null) => RunnerProfile
): Promise<RunnerProfile> {
  return withIndexLock(runnerProfileKey(username), async () => {
    const profile = update(await getRunnerProfile(username));
    await writeJson(runnerProfileKey(username), profile);
    return profile;
  }, RECORD_LOCK_OPTIONS);
}

export async function getDeepseekSecret(username: string): Promise<EncryptedSecret | null> {
  return readJson<EncryptedSecret>(deepseekSecretKey(username));
}

export async function saveDeepseekSecret(username: string, secret: EncryptedSecret): Promise<void> {
  await writeJson(deepseekSecretKey(username), secret);
}

export async function deleteDeepseekSecret(username: string): Promise<void> {
  await storage().delete(deepseekSecretKey(username));
}

export async function getDeepseekCustomPrompt(username: string): Promise<string> {
  const preferences = await readJson<{ customPrompt?: unknown }>(deepseekPreferencesKey(username));
  return typeof preferences?.customPrompt === "string" ? preferences.customPrompt : "";
}

export async function saveDeepseekCustomPrompt(username: string, customPrompt: string): Promise<void> {
  await writeJson(deepseekPreferencesKey(username), {
    customPrompt,
    updatedAt: new Date().toISOString()
  });
}

export async function getAiPrediction(username: string, targetHash: string): Promise<AiPredictionAnalysis | null> {
  return readJson<AiPredictionAnalysis>(aiPredictionLatestKey(username, targetHash));
}

export async function saveAiPrediction(
  username: string,
  targetHash: string,
  analysis: AiPredictionAnalysis,
  snapshot: AiPredictionSnapshot
): Promise<void> {
  const historyKey = aiPredictionHistoryKey(username, targetHash);
  const history = (await readJson<AiPredictionSnapshot[]>(historyKey)) ?? [];
  const compactHistory = [snapshot, ...history.filter((item) => item.dataFingerprint !== snapshot.dataFingerprint)].slice(0, 50);
  await Promise.all([
    writeJson(aiPredictionLatestKey(username, targetHash), analysis),
    writeJson(historyKey, compactHistory)
  ]);
}

export async function getAiDeepAnalysis(username: string, targetHash: string): Promise<AiDeepAnalysis | null> {
  return readJson<AiDeepAnalysis>(aiDeepAnalysisKey(username, targetHash));
}

export async function saveAiDeepAnalysis(username: string, targetHash: string, analysis: AiDeepAnalysis): Promise<void> {
  await writeJson(aiDeepAnalysisKey(username, targetHash), analysis);
}

export async function withAiPredictionLock<T>(username: string, targetHash: string, task: () => Promise<T>): Promise<T> {
  return withIndexLock(`${aiPredictionLatestKey(username, targetHash)}.generation`, task, {
    attempts: 80,
    staleMs: 10_000,
    heartbeatMs: 2_000
  });
}

export async function listRuns(username: string): Promise<RunningRecord[]> {
  return sortRuns(await listRecords(runsIndexKey(username), () => readRunsFromObjects(username)));
}

export async function getRun(username: string, runId: string): Promise<RunningRecord | null> {
  runKey(username, runId);
  return (await listRuns(username)).find(run => run.id === runId) ?? null;
}

export async function saveRun(username: string, run: RunningRecord): Promise<void> {
  const key = runKey(username, run.id);
  await mutateRecords(runsIndexKey(username), () => readRunsFromObjects(username), records => ({
    mutation: { records: sortRuns([run, ...records.filter(record => record.id !== run.id)]), puts: [{ key, value: run }], deletes: [] }, result: undefined
  }));
}

export async function deleteRun(username: string, runId: string): Promise<void> {
  const key = runKey(username, runId);
  await mutateRecords(runsIndexKey(username), () => readRunsFromObjects(username), records => ({
    mutation: { records: records.filter(record => record.id !== runId), puts: [], deletes: [key] }, result: undefined
  }));
}

export async function listShoes(username: string): Promise<RunningShoe[]> {
  return sortShoes(await listRecords(shoesIndexKey(username), () => readShoesFromObjects(username)));
}

export async function getShoe(username: string, shoeId: string): Promise<RunningShoe | null> {
  shoeKey(username, shoeId);
  return (await listShoes(username)).find(shoe => shoe.id === shoeId) ?? null;
}

export async function saveShoe(username: string, shoe: RunningShoe): Promise<void> {
  const key = shoeKey(username, shoe.id);
  await mutateRecords(shoesIndexKey(username), () => readShoesFromObjects(username), records => ({
    mutation: { records: sortShoes([shoe, ...records.filter(record => record.id !== shoe.id)]), puts: [{ key, value: shoe }], deletes: [] }, result: undefined
  }));
}

export async function deleteShoe(username: string, shoeId: string): Promise<void> {
  const key = shoeKey(username, shoeId);
  // Finish unlinking first; an interrupted cascade must not remove the shoe while
  // leaving the already indexed runs permanently attached to it.
  await mutateRecords(runsIndexKey(username), () => readRunsFromObjects(username), runs => {
    const now = new Date().toISOString();
    const updatedRuns = runs.map((run) => (run.shoeId === shoeId ? { ...run, shoeId: null, updatedAt: now } : run));
    const changedRuns = updatedRuns.filter((run, index) => run !== runs[index]);
    return { mutation: { records: sortRuns(updatedRuns), puts: changedRuns.map(run => ({ key: runKey(username, run.id), value: run })), deletes: [] }, result: undefined };
  });
  await mutateRecords(shoesIndexKey(username), () => readShoesFromObjects(username), records => ({
    mutation: { records: records.filter(record => record.id !== shoeId), puts: [], deletes: [key] }, result: undefined
  }));
}

export async function listWeights(username: string): Promise<WeightRecord[]> {
  return sortWeights(await listRecords(weightsIndexKey(username), () => readWeightsFromObjects(username)));
}

export async function getWeight(username: string, date: string): Promise<WeightRecord | null> {
  weightKey(username, date);
  return (await listWeights(username)).find(weight => weight.date === date) ?? null;
}

export async function saveWeight(username: string, weight: WeightRecord, previousDate?: string): Promise<WeightRecord> {
  const key = weightKey(username, weight.date);
  const previousKey = previousDate === undefined ? null : weightKey(username, previousDate);
  return mutateRecords(weightsIndexKey(username), () => readWeightsFromObjects(username), records => {
    const existing = records.find(record => record.date === weight.date);
    const source = previousDate === undefined ? undefined : records.find(record => record.date === previousDate);
    if (previousDate !== undefined && !source) recordError("原日期的体重记录不存在，请刷新后重试。", 404);
    if (existing && previousDate !== weight.date) recordError("该日期已有体重记录，请选择其他日期或编辑已有记录。", 409);
    const saved = { ...weight, createdAt: source?.createdAt ?? weight.createdAt };
    return {
      mutation: {
        records: sortWeights([saved, ...records.filter(record => record.date !== weight.date && record.date !== previousDate)]),
        puts: [{ key, value: saved }],
        deletes: previousKey && previousDate !== weight.date ? [previousKey] : []
      }, result: saved
    };
  });
}

export async function deleteWeight(username: string, date: string): Promise<void> {
  const key = weightKey(username, date);
  await mutateRecords(weightsIndexKey(username), () => readWeightsFromObjects(username), records => ({
    mutation: { records: records.filter(record => record.date !== date), puts: [], deletes: [key] }, result: undefined
  }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
